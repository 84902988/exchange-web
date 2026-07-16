from __future__ import annotations

import asyncio
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.db.models.contract_account import ContractAccount
from app.db.models.contract_position import ContractPosition
from app.services import contract_account_service as account_service
from app.services import contract_private_ws as private_ws
from app.services import contract_query_service as query_service


class _Query:
    def __init__(self, rows):
        self._rows = list(rows)

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)


class _Session:
    def __init__(self, account, positions):
        self.account = account
        self.positions = list(positions)
        self.closed = False

    def query(self, model):
        if model is ContractAccount:
            return _Query([self.account] if self.account is not None else [])
        if model is ContractPosition:
            return _Query(self.positions)
        raise AssertionError(f"unexpected query model: {model}")

    def close(self):
        self.closed = True


class _WebSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)


def _account(**overrides):
    values = {
        "user_id": 42,
        "margin_asset": "USDT",
        "available_margin": Decimal("10"),
        "frozen_margin": Decimal("2"),
        "position_margin": Decimal("3"),
        "realized_pnl": Decimal("999"),
        "unrealized_pnl": Decimal("-888"),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _position(
    *,
    symbol="BTCUSDT_PERP",
    side="LONG",
    entry_price="100",
    quantity="2",
    mark_price="101",
    unrealized_pnl="777",
):
    return SimpleNamespace(
        symbol=symbol,
        side=side,
        status="OPEN",
        entry_price=Decimal(entry_price),
        quantity=Decimal(quantity),
        mark_price=Decimal(mark_price),
        unrealized_pnl=Decimal(unrealized_pnl),
    )


def _quote(mark_price, *, freshness="LIVE", source="PROVIDER_WS"):
    return {
        "mark_price": Decimal(str(mark_price)),
        "quote_freshness": freshness,
        "source": source,
        "is_realtime": freshness == "LIVE",
    }


def test_position_pnl_snapshot_uses_live_mark_and_provenance(monkeypatch):
    db = _Session(_account(), [])
    position = _position(mark_price="95")
    monkeypatch.setattr(
        query_service,
        "get_contract_quote",
        lambda _db, _symbol: _quote("110", source="ITICK_WS"),
    )

    snapshot = query_service.resolve_contract_position_pnl(db, position)

    assert snapshot.mark_price == Decimal("110")
    assert snapshot.unrealized_pnl == Decimal("20")
    assert snapshot.source == "ITICK_WS"
    assert snapshot.freshness == "LIVE"
    assert snapshot.usable is True


def test_position_pnl_snapshot_labels_stored_mark_fallback_stale(monkeypatch):
    db = _Session(_account(), [])
    position = _position(mark_price="105", unrealized_pnl="999")

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(query_service, "get_contract_quote", unavailable)

    snapshot = query_service.resolve_contract_position_pnl(db, position)

    assert snapshot.mark_price == Decimal("105")
    assert snapshot.unrealized_pnl == Decimal("10")
    assert snapshot.source == "POSITION_STORED_MARK"
    assert snapshot.freshness == "STALE"
    assert snapshot.usable is False


@pytest.mark.parametrize(
    ("side", "mark_price", "expected_pnl"),
    [
        ("LONG", "110", "20"),
        ("SHORT", "90", "20"),
    ],
)
def test_account_summary_derives_long_and_short_upnl(
    monkeypatch,
    side,
    mark_price,
    expected_pnl,
):
    db = _Session(_account(), [_position(side=side)])
    monkeypatch.setattr(
        query_service,
        "get_contract_quote",
        lambda _db, _symbol: _quote(mark_price),
    )

    summary = account_service.get_contract_account_summary(db, 42)

    assert summary.unrealized_pnl == expected_pnl
    assert summary.equity == str(Decimal("15") + Decimal(expected_pnl))
    assert summary.realized_pnl == "999"
    assert summary.equity_state == "LIVE"
    assert summary.equity_usable is True


def test_account_summary_aggregates_multiple_open_positions(monkeypatch):
    positions = [
        _position(symbol="BTCUSDT_PERP", side="LONG", quantity="2"),
        _position(symbol="ETHUSDT_PERP", side="SHORT", entry_price="50", quantity="3"),
    ]
    marks = {"BTCUSDT_PERP": "110", "ETHUSDT_PERP": "40"}
    db = _Session(_account(), positions)
    monkeypatch.setattr(
        query_service,
        "get_contract_quote",
        lambda _db, symbol: _quote(marks[symbol]),
    )

    summary = account_service.get_contract_account_summary(db, 42)

    assert summary.unrealized_pnl == "50"
    assert summary.equity == "65"
    assert summary.equity_source == "OPEN_POSITION_MARK_TO_MARKET"


def test_account_summary_exposes_stale_mark_without_claiming_realtime(monkeypatch):
    db = _Session(_account(), [_position(mark_price="105")])

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(query_service, "get_contract_quote", unavailable)

    summary = account_service.get_contract_account_summary(db, 42)

    assert summary.unrealized_pnl == "10"
    assert summary.equity == "25"
    assert summary.equity_state == "STALE"
    assert summary.equity_usable is False


def test_account_summary_fails_closed_when_mark_is_unavailable(monkeypatch):
    db = _Session(_account(), [_position(mark_price="0")])

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(query_service, "get_contract_quote", unavailable)

    summary = account_service.get_contract_account_summary(db, 42)

    assert summary.unrealized_pnl is None
    assert summary.equity is None
    assert summary.equity_state == "UNAVAILABLE"
    assert summary.equity_usable is False


def test_private_ws_snapshot_account_matches_rest(monkeypatch):
    db = _Session(_account(), [_position()])
    monkeypatch.setattr(
        query_service,
        "get_contract_quote",
        lambda _db, _symbol: _quote("110"),
    )
    empty_items = SimpleNamespace(model_dump=lambda: {"items": []})
    monkeypatch.setattr(private_ws, "get_user_contract_positions", lambda *args, **kwargs: empty_items)
    monkeypatch.setattr(
        private_ws,
        "get_user_contract_position_summaries",
        lambda *args, **kwargs: empty_items,
    )
    monkeypatch.setattr(private_ws, "get_user_contract_orders", lambda *args, **kwargs: empty_items)
    monkeypatch.setattr(private_ws, "get_user_contract_trades", lambda *args, **kwargs: empty_items)
    expected = account_service.get_contract_account_summary(db, 42).model_dump()
    websocket = _WebSocket()

    async def scenario():
        manager = private_ws.ContractPrivateWsManager()
        await manager.send_snapshot_to_one(websocket, db, 42, "BTCUSDT_PERP")

    asyncio.run(scenario())

    assert websocket.messages[0]["account"] == expected


def test_private_ws_mark_refresh_is_throttled_by_value_signature(monkeypatch):
    mark = {"value": "110"}
    db = _Session(_account(), [_position()])
    monkeypatch.setattr(
        query_service,
        "get_contract_quote",
        lambda _db, _symbol: _quote(mark["value"]),
    )
    monkeypatch.setattr(private_ws, "SessionLocal", lambda: db)
    empty_items = SimpleNamespace(model_dump=lambda: {"items": []})
    monkeypatch.setattr(private_ws, "get_user_contract_positions", lambda *args, **kwargs: empty_items)
    monkeypatch.setattr(
        private_ws,
        "get_user_contract_position_summaries",
        lambda *args, **kwargs: empty_items,
    )
    websocket = _WebSocket()

    async def scenario():
        manager = private_ws.ContractPrivateWsManager()
        manager._connections[42].add(websocket)
        initial = private_ws._account_payload(db, 42)
        await manager._remember_account_signature(42, initial)
        manager._position_signatures[42] = private_ws._position_signature({
            "positions": [],
            "position_summaries": [],
            "mark_only": True,
        })

        assert await manager._refresh_account_if_changed(42) is False
        mark["value"] = "115"
        assert await manager._refresh_account_if_changed(42) is True
        assert await manager._refresh_account_if_changed(42) is False

    asyncio.run(scenario())

    assert len(websocket.messages) == 1
    assert websocket.messages[0]["account"]["unrealized_pnl"] == "30"
    assert websocket.messages[0]["account"]["equity"] == "45"


def test_private_ws_suppresses_duplicate_published_account_updates():
    websocket = _WebSocket()

    async def scenario():
        manager = private_ws.ContractPrivateWsManager()
        manager._connections[42].add(websocket)
        account = {
            "user_id": 42,
            "unrealized_pnl": "20",
            "equity": "35",
            "equity_state": "LIVE",
            "equity_usable": True,
        }
        message = manager._message(
            "contract_user_account_update",
            {"account": account},
            user_id=42,
        )

        await manager.dispatch_published_event(message)
        await manager.dispatch_published_event(message)

    asyncio.run(scenario())

    assert len(websocket.messages) == 1
