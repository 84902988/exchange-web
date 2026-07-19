from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.db.models.order import Order
from app.db.models.trading_pair import TradingPair
from app.services import spot_query


def _order(*, order_id: int, amount: str, filled_amount: str, status: str):
    return SimpleNamespace(
        id=order_id,
        side="BUY",
        order_type="LIMIT",
        price=Decimal("0.016"),
        amount=Decimal(amount),
        filled_amount=Decimal(filled_amount),
        executed_quote_amount=Decimal("0.016"),
        avg_price=Decimal("0.016"),
        fee_amount=Decimal("0.000064"),
        fee_asset_id=None,
        fee_asset_symbol="USDT",
        fee_asset=None,
        status=status,
        created_at=datetime(2026, 7, 20, 0, 0, 0),
        updated_at=datetime(2026, 7, 20, 0, 0, 1),
    )


def _db_with_rows(rows):
    pair = SimpleNamespace(id=11, symbol="MFCUSDT")
    pair_query = MagicMock()
    pair_query.filter.return_value.first.return_value = pair

    order_query = MagicMock()
    order_query.options.return_value.filter.return_value.order_by.return_value.limit.return_value.all.return_value = rows

    db = MagicMock()

    def query(model):
        if model is TradingPair:
            return pair_query
        if model is Order:
            return order_query
        raise AssertionError(f"unexpected query model: {model}")

    db.query.side_effect = query
    return db


def test_current_orders_fail_closed_when_open_status_has_no_remaining_amount() -> None:
    active = _order(order_id=2, amount="2", filled_amount="1", status="PARTIALLY_FILLED")
    stale_terminal = _order(order_id=1, amount="1", filled_amount="1", status="PARTIALLY_FILLED")

    result = spot_query.get_current_orders(
        _db_with_rows([active, stale_terminal]),
        user_id=5,
        symbol="MFCUSDT",
    )

    assert result["total"] == 1
    assert result["items"][0]["id"] == 2
    assert result["items"][0]["remaining_amount"] == "1"


def test_history_exposes_zero_remaining_open_status_as_effectively_filled() -> None:
    stale_terminal = _order(order_id=1, amount="1", filled_amount="1", status="PARTIALLY_FILLED")

    result = spot_query.get_history_orders(
        _db_with_rows([stale_terminal]),
        user_id=5,
        symbol="MFCUSDT",
    )

    assert result["total"] == 1
    assert result["items"][0]["remaining_amount"] == "0"
    assert result["items"][0]["status"] == "FILLED"
