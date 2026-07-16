from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
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

    def order_by(self, *args, **kwargs):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)


class _Session:
    def __init__(self, account=None, positions=None):
        self.account = account
        self.positions = list(positions or [])
        self.closed = False

    def query(self, *entities):
        if len(entities) == 1 and entities[0] is ContractAccount:
            return _Query([self.account] if self.account is not None else [])
        if len(entities) == 1 and entities[0] is ContractPosition:
            return _Query(self.positions)
        return _Query([])

    def close(self):
        self.closed = True


class _WebSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)


def _account(user_id=42):
    return SimpleNamespace(
        user_id=user_id,
        margin_asset="USDT",
        available_margin=Decimal("100"),
        frozen_margin=Decimal("5"),
        position_margin=Decimal("20"),
        realized_pnl=Decimal("0"),
        unrealized_pnl=Decimal("999"),
    )


def _position(
    *,
    position_id=1,
    user_id=42,
    symbol="BTCUSDT_PERP",
    side="LONG",
    entry_price="100",
    quantity="2",
    mark_price="101",
    liquidation_price="80",
):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=position_id,
        user_id=user_id,
        symbol=symbol,
        side=side,
        leverage=10,
        quantity=Decimal(quantity),
        entry_price=Decimal(entry_price),
        mark_price=Decimal(mark_price),
        margin_amount=Decimal("20"),
        open_fee=Decimal("0.1"),
        unrealized_pnl=Decimal("999"),
        realized_pnl=Decimal("0"),
        liquidation_price=Decimal(liquidation_price),
        warning_price=Decimal("82"),
        take_profit_price=None,
        stop_loss_price=None,
        close_reason=None,
        status="OPEN",
        opened_at=now,
        closed_at=None,
        created_at=now,
        updated_at=now,
    )


def _quote(mark_price, freshness="LIVE", source="PROVIDER_WS"):
    return {
        "mark_price": Decimal(str(mark_price)),
        "quote_freshness": freshness,
        "source": source,
        "is_realtime": freshness == "LIVE",
    }


def _prepare_position_query(monkeypatch):
    monkeypatch.setattr(query_service, "_symbol_liquidation_thresholds", lambda *_args: {})
    monkeypatch.setattr(query_service, "_position_trade_summaries", lambda *_args: {})


@pytest.mark.parametrize(
    ("side", "mark_price", "expected_pnl"),
    [("LONG", "110", "20"), ("SHORT", "90", "20")],
)
def test_position_response_refreshes_long_and_short_upnl(monkeypatch, side, mark_price, expected_pnl):
    position = _position(side=side, liquidation_price="80" if side == "LONG" else "120")
    db = _Session(positions=[position])
    _prepare_position_query(monkeypatch)
    monkeypatch.setattr(query_service, "get_contract_quote", lambda *_args: _quote(mark_price))

    item = query_service.get_user_contract_positions(db, 42).items[0]

    assert item.unrealized_pnl == expected_pnl
    assert item.mark_source == "PROVIDER_WS"
    assert item.mark_freshness == "LIVE"
    assert item.mark_usable is True
    assert item.unrealized_pnl_state == "LIVE"


def test_position_response_refreshes_margin_ratio_and_liquidation_distance(monkeypatch):
    db = _Session(positions=[_position()])
    _prepare_position_query(monkeypatch)
    monkeypatch.setattr(query_service, "get_contract_quote", lambda *_args: _quote("110"))

    item = query_service.get_user_contract_positions(db, 42).items[0]

    assert Decimal(item.margin_ratio) == Decimal("20") / Decimal("220") * Decimal("100")
    assert item.liquidation_distance == "30"
    assert Decimal(item.liquidation_distance_rate) == Decimal("30") / Decimal("110") * Decimal("100")


def test_hedge_positions_share_one_symbol_mark_snapshot(monkeypatch):
    positions = [
        _position(position_id=1, side="LONG"),
        _position(position_id=2, side="SHORT", liquidation_price="120"),
    ]
    db = _Session(positions=positions)
    calls = []
    _prepare_position_query(monkeypatch)

    def quote(_db, symbol):
        calls.append(symbol)
        return _quote("110")

    monkeypatch.setattr(query_service, "get_contract_quote", quote)

    items = query_service.get_user_contract_positions(db, 42).items

    assert calls == ["BTCUSDT_PERP"]
    assert {item.side: item.unrealized_pnl for item in items} == {"LONG": "20", "SHORT": "-20"}
    assert {item.mark_price for item in items} == {"110"}


def test_position_response_labels_stale_and_unavailable_marks(monkeypatch):
    _prepare_position_query(monkeypatch)

    def unavailable(*_args):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(query_service, "get_contract_quote", unavailable)
    stale = query_service.get_user_contract_positions(
        _Session(positions=[_position(mark_price="105")]),
        42,
    ).items[0]
    missing = query_service.get_user_contract_positions(
        _Session(positions=[_position(mark_price="0")]),
        42,
    ).items[0]

    assert (stale.mark_freshness, stale.mark_usable, stale.unrealized_pnl_state) == ("STALE", False, "STALE")
    assert stale.unrealized_pnl == "10"
    assert missing.mark_price is None
    assert missing.unrealized_pnl is None
    assert missing.mark_freshness == "UNAVAILABLE"
    assert missing.mark_usable is False
    assert missing.margin_ratio is None
    assert missing.liquidation_distance is None


def test_account_and_position_share_one_mark_evidence(monkeypatch):
    position = _position()
    db = _Session(account=_account(), positions=[position])
    calls = []

    def quote(_db, symbol):
        calls.append(symbol)
        return _quote("110")

    monkeypatch.setattr(query_service, "get_contract_quote", quote)

    with query_service.contract_position_mark_evidence_scope():
        account = account_service.get_contract_account_summary(db, 42)
        position_snapshot = query_service.resolve_contract_position_pnl(db, position)

    assert calls == ["BTCUSDT_PERP"]
    assert account.unrealized_pnl == "20"
    assert position_snapshot.unrealized_pnl == Decimal("20")
    assert account.equity_state == position_snapshot.freshness == "LIVE"


def _mark_snapshot(user_id, positions, *, equity="100"):
    return {
        "account": {"user_id": user_id, "equity": equity},
        "positions": positions,
        "position_summaries": [],
    }


def _position_payload(position_id, side, *, symbol="BTCUSDT_PERP", mark="110", pnl="20", freshness="LIVE"):
    return {
        "id": position_id,
        "symbol": symbol,
        "side": side,
        "mark_price": mark,
        "mark_freshness": freshness,
        "mark_usable": freshness in {"LIVE", "RECENT"},
        "unrealized_pnl": pnl,
        "unrealized_pnl_state": freshness,
        "margin_ratio": "9.09",
        "liquidation_distance": "30",
    }


def test_private_ws_position_signature_dedupes_and_updates_hedge_positions(monkeypatch):
    state = {
        "snapshot": _mark_snapshot(
            42,
            [
                _position_payload(1, "LONG"),
                _position_payload(2, "SHORT", pnl="-20"),
                _position_payload(3, "LONG", symbol="ETHUSDT_PERP", mark="50", pnl="5"),
            ],
        )
    }
    monkeypatch.setattr(private_ws, "_load_mark_to_market_payload", lambda _user_id: deepcopy(state["snapshot"]))
    websocket = _WebSocket()

    async def scenario():
        manager = private_ws.ContractPrivateWsManager()
        manager._connections[42].add(websocket)
        assert await manager._refresh_account_if_changed(42) is True
        assert await manager._refresh_account_if_changed(42) is False
        state["snapshot"]["positions"][0]["mark_price"] = "115"
        state["snapshot"]["positions"][0]["unrealized_pnl"] = "30"
        state["snapshot"]["positions"][0]["margin_ratio"] = "8.70"
        state["snapshot"]["positions"][0]["liquidation_distance"] = "35"
        state["snapshot"]["positions"][1]["unrealized_pnl"] = "-30"
        assert await manager._refresh_account_if_changed(42) is True
        assert await manager._refresh_account_if_changed(42) is False

    asyncio.run(scenario())

    position_messages = [message for message in websocket.messages if message["type"] == "contract_user_position_mark_update"]
    assert len(position_messages) == 2
    assert {item["side"] for item in position_messages[-1]["positions"] if item["symbol"] == "BTCUSDT_PERP"} == {"LONG", "SHORT"}
    assert {item["symbol"] for item in position_messages[-1]["positions"]} == {"BTCUSDT_PERP", "ETHUSDT_PERP"}
    assert position_messages[-1]["positions"][0]["margin_ratio"] == "8.70"
    assert position_messages[-1]["positions"][0]["liquidation_distance"] == "35"
    assert position_messages[-1]["mark_only"] is True


def test_private_ws_mark_refresh_isolated_by_user(monkeypatch):
    states = {
        1: _mark_snapshot(1, [_position_payload(1, "LONG")]),
        2: _mark_snapshot(2, [_position_payload(2, "SHORT")]),
    }
    monkeypatch.setattr(private_ws, "_load_mark_to_market_payload", lambda user_id: deepcopy(states[user_id]))
    sockets = {1: _WebSocket(), 2: _WebSocket()}

    async def scenario():
        manager = private_ws.ContractPrivateWsManager()
        for user_id, websocket in sockets.items():
            manager._connections[user_id].add(websocket)
            assert await manager._refresh_account_if_changed(user_id) is True
        for websocket in sockets.values():
            websocket.messages.clear()
        states[1]["positions"][0]["unrealized_pnl"] = "25"
        assert await manager._refresh_account_if_changed(1) is True
        assert await manager._refresh_account_if_changed(2) is False

    asyncio.run(scenario())

    assert len(sockets[1].messages) == 1
    assert sockets[1].messages[0]["type"] == "contract_user_position_mark_update"
    assert sockets[2].messages == []


def test_private_ws_disconnect_cleans_refresh_owner_and_signatures():
    websocket = _WebSocket()

    async def scenario():
        manager = private_ws.ContractPrivateWsManager()
        manager._connections[42].add(websocket)
        manager._account_signatures[42] = "account"
        manager._position_signatures[42] = "positions"
        refresh_task = asyncio.create_task(asyncio.Event().wait())
        manager._account_refresh_tasks[42] = refresh_task

        await manager.disconnect(42, websocket)
        await asyncio.sleep(0)

        assert 42 not in manager._connections
        assert 42 not in manager._account_signatures
        assert 42 not in manager._position_signatures
        assert 42 not in manager._account_refresh_tasks
        assert refresh_task.cancelled()

    asyncio.run(scenario())


def test_private_ws_mark_refresh_interval_is_at_most_one_second():
    assert private_ws.CONTRACT_ACCOUNT_EQUITY_REFRESH_INTERVAL_SECONDS <= 1.0
