from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.spot_kline_realtime import (  # noqa: E402
    SUPPORTED_SPOT_KLINE_INTERVALS,
    apply_trade_to_spot_kline_item,
    build_spot_kline_update_message,
    spot_kline_bucket_bounds,
)
from app.services.market_kline_cache import interval_ms  # noqa: E402


def test_spot_kline_bucket_floor_uses_interval_milliseconds():
    open_time, close_time = spot_kline_bucket_bounds(1710000075123, "1m")

    assert open_time == 1710000060000
    assert close_time == 1710000120000


def test_spot_kline_new_bucket_uses_trade_price_for_ohlc():
    item = apply_trade_to_spot_kline_item(
        None,
        interval="1m",
        trade_price="100.25",
        trade_amount="2.5",
        trade_ts_ms=1710000075123,
    )

    assert item["open"] == Decimal("100.25")
    assert item["high"] == Decimal("100.25")
    assert item["low"] == Decimal("100.25")
    assert item["close"] == Decimal("100.25")
    assert item["volume"] == Decimal("2.5")
    assert item["quote_volume"] == Decimal("250.625")


def test_spot_kline_existing_bucket_updates_close_and_totals():
    existing = {
        "open_time": 1710000060000,
        "close_time": 1710000120000,
        "open": Decimal("100"),
        "high": Decimal("105"),
        "low": Decimal("99"),
        "close": Decimal("101"),
        "volume": Decimal("2"),
        "quote_volume": Decimal("202"),
    }

    item = apply_trade_to_spot_kline_item(
        existing,
        interval="1m",
        trade_price="98",
        trade_amount="3",
        trade_ts_ms=1710000075123,
    )

    assert item["open"] == Decimal("100")
    assert item["high"] == Decimal("105")
    assert item["low"] == Decimal("98")
    assert item["close"] == Decimal("98")
    assert item["volume"] == Decimal("5")
    assert item["quote_volume"] == Decimal("496")


def test_spot_kline_generates_supported_intervals():
    for interval in SUPPORTED_SPOT_KLINE_INTERVALS:
        open_time, close_time = spot_kline_bucket_bounds(1710000075123, interval)

        assert close_time - open_time == interval_ms(interval)
        assert open_time % interval_ms(interval) == 0


def test_spot_kline_update_message_serializes_public_payload():
    item = apply_trade_to_spot_kline_item(
        None,
        interval="5m",
        trade_price="10",
        trade_amount="4",
        trade_ts_ms=1710000075123,
    )

    message = build_spot_kline_update_message(
        symbol="btcusdt",
        interval="5m",
        kline=item,
        updated_at="2026-07-03T00:00:00",
    )

    assert message["type"] == "spot_kline_update"
    assert message["symbol"] == "BTCUSDT"
    assert message["interval"] == "5m"
    assert message["source"] == "INTERNAL_TRADE"
    assert message["updated_at"] == "2026-07-03T00:00:00"
    assert message["kline"] == {
        "open_time": 1710000000000,
        "close_time": 1710000300000,
        "open": "10",
        "high": "10",
        "low": "10",
        "close": "10",
        "volume": "4",
        "quote_volume": "40",
    }
