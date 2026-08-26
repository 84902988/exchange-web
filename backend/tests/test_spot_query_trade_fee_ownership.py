from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair
from app.services import spot_query


def _trade(trade_id: int = 141205) -> SimpleNamespace:
    return SimpleNamespace(
        id=trade_id,
        buyer_user_id=100000029,
        seller_user_id=992000018,
        buy_order_id=141264,
        sell_order_id=141263,
        maker_order_id=141263,
        taker_order_id=141264,
        price=Decimal("0.108"),
        amount=Decimal("15"),
        quote_amount=Decimal("1.62"),
        buyer_fee_amount=Decimal("0.001296"),
        buyer_fee_asset_symbol="USDT",
        seller_fee_amount=Decimal("0.00648"),
        seller_fee_asset_symbol="USDT",
        created_at=datetime(2026, 7, 21, 15, 55, 15),
    )


def _db_with_trade(row: SimpleNamespace, *extra_rows: SimpleNamespace) -> MagicMock:
    pair = SimpleNamespace(id=11, symbol="MFCUSDT")
    pair_query = MagicMock()
    pair_query.filter.return_value.first.return_value = pair

    trade_query = MagicMock()
    filtered_trade_query = trade_query.filter.return_value
    filtered_trade_query.filter.return_value = filtered_trade_query
    filtered_trade_query.order_by.return_value.limit.return_value.all.return_value = [
        row,
        *extra_rows,
    ]

    db = MagicMock()

    def query(model):
        if model is TradingPair:
            return pair_query
        if model is Trade:
            return trade_query
        raise AssertionError(f"unexpected query model: {model}")

    db.query.side_effect = query
    db.filtered_trade_query = filtered_trade_query
    return db


def test_buyer_string_user_id_receives_buyer_fee_snapshot() -> None:
    result = spot_query.get_my_trades(
        _db_with_trade(_trade()),
        user_id="100000029",
        symbol="MFCUSDT",
    )

    item = result["items"][0]
    assert item["side"] == "BUY"
    assert item["role"] == "TAKER"
    assert item["fee_amount"] == "0.001296"
    assert item["fee_asset_symbol"] == "USDT"


def test_seller_string_user_id_receives_seller_fee_snapshot() -> None:
    result = spot_query.get_my_trades(
        _db_with_trade(_trade()),
        user_id="992000018",
        symbol="MFCUSDT",
    )

    item = result["items"][0]
    assert item["side"] == "SELL"
    assert item["role"] == "MAKER"
    assert item["fee_amount"] == "0.00648"
    assert item["fee_asset_symbol"] == "USDT"


def test_my_trades_exposes_stable_cursor_metadata() -> None:
    db = _db_with_trade(_trade(141205), _trade(141204))

    result = spot_query.get_my_trades(
        db,
        user_id="100000029",
        symbol="MFCUSDT",
        limit=1,
        before_id=141206,
    )

    assert result["total"] == 1
    assert result["items"][0]["trade_id"] == 141205
    assert result["has_more"] is True
    assert result["next_cursor"] == 141205
    db.filtered_trade_query.filter.assert_called_once()
