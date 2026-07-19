from decimal import Decimal
from types import SimpleNamespace

from app.db.models.contract_position import ContractPosition
from app.db.models.contract_trade import ContractTrade
from app.services import contract_position_service, contract_tp_sl_service


class _PolicyQuery:
    def __init__(self, trigger_price_type: str):
        self.trigger_price_type = trigger_price_type

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return (self.trigger_price_type,)


class _PolicyDb:
    def __init__(self, trigger_price_type: str):
        self.trigger_price_type = trigger_price_type

    def query(self, *_args, **_kwargs):
        return _PolicyQuery(self.trigger_price_type)


def _position(**overrides):
    values = {
        "id": 7,
        "symbol": "BTCUSDT_PERP",
        "side": "LONG",
        "quantity": Decimal("1"),
        "mark_price": Decimal("100"),
        "take_profit_price": Decimal("110"),
        "stop_loss_price": Decimal("95"),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_last_price_policy_is_shared_by_editor_validation_and_scanner(monkeypatch):
    db = _PolicyDb("LAST_PRICE")
    position = _position()
    quote = {
        "mark_price": "100",
        "last_price": "105",
        "bid_price": "104.9",
        "ask_price": "105.1",
    }
    monkeypatch.setattr(contract_position_service, "get_contract_quote", lambda *_args, **_kwargs: quote)

    validation_reference, mark_price = contract_position_service._get_tp_sl_reference_snapshot(db, position)
    scanner_reference, scanner_mark, trigger_type = contract_tp_sl_service.resolve_position_tp_sl_trigger_reference(
        db,
        position,
        quote,
    )

    assert trigger_type == "LAST_PRICE"
    assert validation_reference == scanner_reference == Decimal("105")
    assert mark_price == scanner_mark == Decimal("100")


def test_mark_price_policy_remains_mark_authoritative(monkeypatch):
    db = _PolicyDb("MARK_PRICE")
    position = _position()
    quote = {
        "mark_price": "100",
        "last_price": "105",
        "bid_price": "104.9",
        "ask_price": "105.1",
    }
    monkeypatch.setattr(contract_position_service, "get_contract_quote", lambda *_args, **_kwargs: quote)

    validation_reference, mark_price = contract_position_service._get_tp_sl_reference_snapshot(db, position)

    assert validation_reference == Decimal("100")
    assert mark_price == Decimal("100")


def test_long_stop_loss_trigger_uses_the_resolved_reference():
    position = _position(stop_loss_price=Decimal("95"))

    assert contract_tp_sl_service._detect_tp_sl_trigger(position, Decimal("96")) is None
    assert contract_tp_sl_service._detect_tp_sl_trigger(position, Decimal("95")) == "STOP_LOSS"


class _ExecutionQuery:
    def __init__(self, row):
        self.row = row

    def filter(self, *_args, **_kwargs):
        return self

    def with_for_update(self):
        return self

    def order_by(self, *_args, **_kwargs):
        return self

    def first(self):
        return self.row


class _ExecutionDb:
    def __init__(self, position, trade):
        self.position = position
        self.trade = trade

    def query(self, entity, *_args):
        if entity is ContractPosition:
            return _ExecutionQuery(self.position)
        if entity is ContractTrade:
            return _ExecutionQuery(self.trade)
        return _ExecutionQuery(None)


def test_trigger_hit_enters_market_close_and_publishes_private_refresh(monkeypatch):
    position = _position(
        user_id=42,
        status="OPEN",
        stop_loss_price=Decimal("95"),
        take_profit_price=Decimal("110"),
    )
    trade = SimpleNamespace(id=91)
    db = _ExecutionDb(position, trade)
    close_calls = []
    refresh_calls = []

    monkeypatch.setattr(
        contract_tp_sl_service,
        "_risk_from_mark_price",
        lambda *_args, **_kwargs: SimpleNamespace(is_liquidatable=False),
    )

    def close_position(_db, user_id, request, *, close_reason, quote_override):
        close_calls.append((user_id, request.position_id, request.order_type, close_reason, quote_override))
        return SimpleNamespace(order_id=81, status="FILLED")

    monkeypatch.setattr(contract_tp_sl_service, "close_contract_position", close_position)
    monkeypatch.setattr(
        contract_tp_sl_service,
        "publish_contract_user_updates",
        lambda **kwargs: refresh_calls.append(kwargs),
    )

    quote = {
        "mark_price": "100",
        "last_price": "95",
        "bid_price": "94.9",
        "ask_price": "95.1",
        "source": "PROVIDER_WS",
        "quote_freshness": "LIVE",
    }
    result = contract_tp_sl_service.execute_contract_tp_sl(
        db,
        position.id,
        quote_override=quote,
        trigger_price_type_override="LAST_PRICE",
    )

    assert result.trigger_type == "STOP_LOSS"
    assert result.order_id == 81
    assert result.status == "FILLED"
    assert close_calls == [(42, 7, "MARKET", "STOP_LOSS", quote)]
    assert refresh_calls == [{
        "user_id": 42,
        "symbols": ["BTCUSDT_PERP"],
        "position_ids": [7],
        "order_ids": [81],
        "trade_ids": [91],
        "include_account": True,
    }]
