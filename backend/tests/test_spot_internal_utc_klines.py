from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.services import market
from app.services.market_kline_cache import (
    KLINE_CACHE_ORIGIN_REST_FETCH,
    KLINE_CACHE_STATUS_MISS,
    KlineCacheResult,
)


def _ms(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp() * 1000)


def _dt(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


def _trade(row_id: int, created_at: datetime, price: str, amount: str):
    price_decimal = Decimal(price)
    amount_decimal = Decimal(amount)
    return SimpleNamespace(
        id=row_id,
        created_at=created_at,
        price=price_decimal,
        amount=amount_decimal,
        quote_amount=price_decimal * amount_decimal,
    )


def _kline(open_time: int, open_: str, high: str, low: str, close: str, volume: str):
    return SimpleNamespace(
        open_time=open_time,
        open=Decimal(open_),
        high=Decimal(high),
        low=Decimal(low),
        close=Decimal(close),
        volume=Decimal(volume),
        quote_volume=Decimal(close) * Decimal(volume),
    )


def test_internal_1dutc_aggregates_real_trades_into_one_bucket() -> None:
    rows = [
        _trade(1, _dt(2026, 7, 8, 1), "10", "2"),
        _trade(2, _dt(2026, 7, 8, 6), "12", "3"),
        _trade(3, _dt(2026, 7, 8, 23, 59), "11", "1"),
    ]

    items = market._aggregate_internal_utc_trade_rows(rows, interval="1Dutc", limit=10, end_time_ms=None)

    assert items == [
        {
            "open_time": _ms(2026, 7, 8),
            "close_time": _ms(2026, 7, 9),
            "open": "10",
            "high": "12",
            "low": "10",
            "close": "11",
            "volume": "6",
            "quote_volume": "67",
        }
    ]


def test_internal_1dutc_splits_on_utc_day_boundary() -> None:
    rows = [
        _trade(1, _dt(2026, 7, 7, 23, 59), "1", "1"),
        _trade(2, _dt(2026, 7, 8, 0, 0), "2", "1"),
    ]

    items = market._aggregate_internal_utc_trade_rows(rows, interval="1Dutc", limit=10, end_time_ms=None)

    assert [item["open_time"] for item in items] == [_ms(2026, 7, 7), _ms(2026, 7, 8)]
    assert [item["close"] for item in items] == ["1", "2"]


def test_internal_1wutc_aggregates_by_utc_monday_boundary() -> None:
    rows = [
        _trade(1, _dt(2026, 7, 5, 12), "3", "1"),
        _trade(2, _dt(2026, 7, 6, 0), "4", "2"),
    ]

    items = market._aggregate_internal_utc_trade_rows(rows, interval="1Wutc", limit=10, end_time_ms=None)

    assert [item["open_time"] for item in items] == [_ms(2026, 6, 29), _ms(2026, 7, 6)]
    assert [item["volume"] for item in items] == ["1", "2"]


def test_internal_1mutc_aggregates_by_utc_month_boundary() -> None:
    rows = [
        _trade(1, _dt(2026, 6, 30, 23, 59), "5", "1"),
        _trade(2, _dt(2026, 7, 1, 0), "6", "1"),
    ]

    items = market._aggregate_internal_utc_trade_rows(rows, interval="1Mutc", limit=10, end_time_ms=None)

    assert [item["open_time"] for item in items] == [_ms(2026, 6, 1), _ms(2026, 7, 1)]
    assert items[0]["close_time"] == _ms(2026, 7, 1)
    assert items[1]["close_time"] == _ms(2026, 8, 1)


def test_internal_utc_market_kline_aggregation_ignores_zero_volume_gap_rows() -> None:
    rows = [
        _kline(_ms(2026, 7, 8, 0, 0), "9", "9", "9", "9", "0"),
        _kline(_ms(2026, 7, 8, 0, 1), "10", "12", "10", "11", "2"),
    ]

    items = market._aggregate_internal_utc_market_kline_rows(rows, interval="1Dutc", limit=10, end_time_ms=None)

    assert len(items) == 1
    assert items[0]["open"] == "10"
    assert items[0]["high"] == "12"
    assert items[0]["low"] == "10"
    assert items[0]["close"] == "11"
    assert items[0]["volume"] == "2"


def test_internal_utc_empty_does_not_create_price_only_kline() -> None:
    rows = [_kline(_ms(2026, 7, 8), "99", "99", "99", "99", "0")]

    items = market._aggregate_internal_utc_market_kline_rows(rows, interval="1Dutc", limit=10, end_time_ms=None)

    assert items == []


def test_internal_utc_get_klines_uses_distinct_interval_cache_key(monkeypatch) -> None:
    class Pair:
        id = 1
        symbol = "MFCUSDT"
        data_source = market.DATA_SOURCE_INTERNAL

    def fake_cache_first(*args, **kwargs):
        assert kwargs["interval"] == "1Dutc"
        assert kwargs["source"] == market.SPOT_KLINE_SOURCE_INTERNAL_TRADE
        return KlineCacheResult(
            kwargs["fetch_external"](kwargs["limit"], kwargs.get("end_time_ms")),
            origin=KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status=KLINE_CACHE_STATUS_MISS,
        )

    monkeypatch.setattr(market, "_get_active_pair", lambda db, symbol: Pair())
    monkeypatch.setattr(market, "get_klines_cache_first", fake_cache_first)
    monkeypatch.setattr(
        market,
        "_get_internal_klines",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("1Dutc must not use legacy 1d aggregation")),
    )
    monkeypatch.setattr(
        market,
        "_get_internal_utc_aggregate_klines",
        lambda *args, **kwargs: {
            "symbol": "MFCUSDT",
            "interval": "1Dutc",
            "items": [
                {
                    "open_time": _ms(2026, 7, 8),
                    "close_time": _ms(2026, 7, 9),
                    "open": "1",
                    "high": "1",
                    "low": "1",
                    "close": "1",
                    "volume": "1",
                    "quote_volume": "1",
                }
            ],
        },
    )

    result = market.get_klines(None, "MFCUSDT", "1Dutc", limit=10, force_rest=True)

    assert result["interval"] == "1Dutc"
    assert result["source"] == "INTERNAL"
    assert result["freshness"] == "RECENT"
    assert result["items"][0]["open_time"] == _ms(2026, 7, 8)


def test_external_utc_get_klines_stays_on_external_provider_path(monkeypatch) -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE

    def fake_cache_first(*args, **kwargs):
        assert kwargs["source"] == "EXTERNAL_SPOT"
        assert kwargs["interval"] == "1Dutc"
        return KlineCacheResult(
            [
                {
                    "open_time": _ms(2026, 7, 8),
                    "close_time": _ms(2026, 7, 9),
                    "open": "100",
                    "high": "110",
                    "low": "90",
                    "close": "105",
                    "volume": "2",
                    "quote_volume": "210",
                }
            ],
            origin=KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status=KLINE_CACHE_STATUS_MISS,
        )

    monkeypatch.setattr(market, "_get_active_pair", lambda db, symbol: Pair())
    monkeypatch.setattr(market, "_enabled_spot_market_providers_for_pair", lambda db, pair: [])
    monkeypatch.setattr(market, "get_klines_cache_first", fake_cache_first)
    monkeypatch.setattr(
        market,
        "_get_internal_utc_aggregate_klines",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("external spot must not use internal aggregation")),
    )

    result = market.get_klines(None, "BTCUSDT", "1Dutc", limit=10, force_rest=True)

    assert result["symbol"] == "BTCUSDT"
    assert result["interval"] == "1Dutc"
    assert result["source"] == "REST_SNAPSHOT"
    assert result["items"][0]["close"] == "105"
