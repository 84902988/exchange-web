from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.services import market, market_kline_cache
from app.services.market_kline_cache import (
    KLINE_CACHE_ORIGIN_EMPTY,
    KLINE_CACHE_ORIGIN_REST_FETCH,
    KLINE_CACHE_STATUS_HISTORY_BOUNDARY,
    KLINE_CACHE_STATUS_MISS,
    KLINE_TERMINAL_REASON_INTERNAL_HISTORY_BOUNDARY,
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


class _FirstRowQuery:
    def __init__(self, row) -> None:
        self.row = row

    def filter(self, *_args, **_kwargs):
        return self

    def order_by(self, *_args, **_kwargs):
        return self

    def first(self):
        return self.row


class _InternalBoundaryDb:
    def __init__(self, *, trade_row=None, market_kline_row=None) -> None:
        self.trade_row = trade_row
        self.market_kline_row = market_kline_row

    def query(self, model):
        if model is market.Trade:
            return _FirstRowQuery(self.trade_row)
        if model is market.MarketKline:
            return _FirstRowQuery(self.market_kline_row)
        raise AssertionError(f"unexpected model: {model}")


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


def test_internal_utc_boundary_uses_earliest_real_trade_or_internal_kline() -> None:
    trade_row = _trade(1, _dt(2026, 7, 8, 12), "10", "1")
    market_kline_row = _kline(_ms(2026, 7, 1, 6), "9", "9", "9", "9", "2")
    db = _InternalBoundaryDb(trade_row=trade_row, market_kline_row=market_kline_row)
    pair = SimpleNamespace(id=7, symbol="MFCUSDT")

    earliest = market._resolve_earliest_internal_kline_boundary_ms(db, pair, "1Dutc")

    assert earliest == _ms(2026, 7, 1)
    assert market._resolve_earliest_internal_kline_boundary_ms(db, pair, "1Wutc") == _ms(2026, 6, 29)
    assert market._resolve_earliest_internal_kline_boundary_ms(db, pair, "1Mutc") == _ms(2026, 7, 1)


def test_internal_utc_boundary_rejects_zero_fill_market_kline() -> None:
    trade_row = _trade(1, _dt(2026, 7, 8, 12), "10", "1")
    zero_fill_row = _kline(_ms(2026, 7, 1, 6), "9", "9", "9", "9", "0")
    db = _InternalBoundaryDb(trade_row=trade_row, market_kline_row=zero_fill_row)
    pair = SimpleNamespace(id=7, symbol="MFCUSDT")

    earliest = market._resolve_earliest_internal_kline_boundary_ms(db, pair, "1Dutc")

    assert earliest == _ms(2026, 7, 8)


def test_internal_boundary_cache_isolated_from_provider_boundary(monkeypatch) -> None:
    stored: dict[str, dict] = {}
    writes: list[tuple[str, dict, int, int]] = []
    monkeypatch.setattr(market_kline_cache, "cache_get_json", lambda key: stored.get(key))

    def cache_set_json(key, value, ttl_seconds, *, last_good_ttl_seconds):
        stored[key] = dict(value)
        writes.append((key, dict(value), ttl_seconds, last_good_ttl_seconds))

    monkeypatch.setattr(market_kline_cache, "cache_set_json", cache_set_json)
    earliest = _ms(2026, 7, 1)

    result = market_kline_cache.remember_internal_kline_history_boundary(
        market_type="spot",
        symbol="MFCUSDT",
        interval="1Dutc",
        earliest_available_time=earliest,
        end_time_ms=earliest,
    )

    assert result is not None
    assert result.origin == KLINE_CACHE_ORIGIN_EMPTY
    assert result.cache_status == KLINE_CACHE_STATUS_HISTORY_BOUNDARY
    assert result.history_terminal is True
    assert result.terminal_reason == KLINE_TERMINAL_REASON_INTERNAL_HISTORY_BOUNDARY
    assert result.earliest_available_time == earliest
    provider_key = market_kline_cache._kline_history_boundary_cache_key(
        market_type="spot",
        symbol="MFCUSDT",
        interval="1Dutc",
    )
    internal_key = market_kline_cache._kline_history_boundary_cache_key(
        market_type="spot",
        symbol="MFCUSDT",
        interval="1Dutc",
        boundary_scope=market_kline_cache.KLINE_HISTORY_BOUNDARY_SCOPE_INTERNAL,
    )
    assert provider_key != internal_key
    assert provider_key not in stored
    assert stored[internal_key]["boundary_scope"] == "INTERNAL"
    assert writes[0][2:] == (24 * 60 * 60, 24 * 60 * 60)
    cached_result = market_kline_cache.get_cached_internal_kline_history_boundary_result(
        market_type="spot",
        symbol="MFCUSDT",
        interval="1Dutc",
        end_time_ms=earliest - 1,
    )
    assert cached_result is not None
    assert cached_result.terminal_reason == KLINE_TERMINAL_REASON_INTERNAL_HISTORY_BOUNDARY
    assert cached_result.earliest_available_time == earliest


def test_internal_utc_get_klines_uses_distinct_interval_cache_key(monkeypatch) -> None:
    class Pair:
        id = 1
        symbol = "MFCUSDT"
        data_source = market.DATA_SOURCE_INTERNAL

    def fake_cache_first(*args, **kwargs):
        assert kwargs["interval"] == "1Dutc"
        assert kwargs["source"] == market.SPOT_KLINE_SOURCE_INTERNAL_TRADE
        assert kwargs["history_boundary_scope"] == market_kline_cache.KLINE_HISTORY_BOUNDARY_SCOPE_INTERNAL
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
    assert result["history_terminal"] is None
    assert result["terminal_reason"] is None
    assert result["earliest_available_time"] is None


def test_internal_utc_history_returns_terminal_at_real_boundary(monkeypatch) -> None:
    class Pair:
        id = 1
        symbol = "MFCUSDT"
        data_source = market.DATA_SOURCE_INTERNAL

    earliest = _ms(2026, 7, 1)
    monkeypatch.setattr(market, "_get_active_pair", lambda db, symbol: Pair())
    monkeypatch.setattr(
        market,
        "_resolve_earliest_internal_kline_boundary_ms",
        lambda db, pair, interval: earliest,
    )
    monkeypatch.setattr(market_kline_cache, "cache_get_json", lambda _key: None)
    monkeypatch.setattr(
        market_kline_cache,
        "cache_set_json",
        lambda _key, _value, _ttl_seconds, *, last_good_ttl_seconds: None,
    )
    monkeypatch.setattr(
        market,
        "get_klines_cache_first",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("boundary must bypass history fetch")),
    )

    result = market.get_klines(None, "MFCUSDT", "1Dutc", limit=30, end_time_ms=earliest)

    assert result["items"] == []
    assert result["history_incomplete"] is False
    assert result["history_terminal"] is True
    assert result["terminal_reason"] == KLINE_TERMINAL_REASON_INTERNAL_HISTORY_BOUNDARY
    assert result["earliest_available_time"] == earliest


def test_internal_utc_history_middle_page_remains_non_terminal(monkeypatch) -> None:
    class Pair:
        id = 1
        symbol = "MFCUSDT"
        data_source = market.DATA_SOURCE_INTERNAL

    earliest = _ms(2026, 7, 1)
    end_time = _ms(2026, 7, 10)
    item = {
        "open_time": _ms(2026, 7, 8),
        "close_time": _ms(2026, 7, 9),
        "open": "1",
        "high": "1",
        "low": "1",
        "close": "1",
        "volume": "1",
        "quote_volume": "1",
    }
    monkeypatch.setattr(market, "_get_active_pair", lambda db, symbol: Pair())
    monkeypatch.setattr(
        market,
        "_resolve_earliest_internal_kline_boundary_ms",
        lambda db, pair, interval: earliest,
    )
    monkeypatch.setattr(market_kline_cache, "cache_get_json", lambda _key: None)
    monkeypatch.setattr(
        market_kline_cache,
        "cache_set_json",
        lambda _key, _value, _ttl_seconds, *, last_good_ttl_seconds: None,
    )
    def fake_cache_first(*args, **kwargs):
        assert kwargs["history_boundary_scope"] == market_kline_cache.KLINE_HISTORY_BOUNDARY_SCOPE_INTERNAL
        return KlineCacheResult(
            [item],
            origin=KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status=KLINE_CACHE_STATUS_MISS,
        )

    monkeypatch.setattr(market, "get_klines_cache_first", fake_cache_first)

    result = market.get_klines(None, "MFCUSDT", "1Dutc", limit=30, end_time_ms=end_time)

    assert result["items"] == [item]
    assert result["history_terminal"] is False
    assert result["terminal_reason"] is None
    assert result["earliest_available_time"] is None


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
    monkeypatch.setattr(
        market,
        "_resolve_earliest_internal_kline_boundary_ms",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("external spot must not resolve internal boundary")),
    )

    result = market.get_klines(
        None,
        "BTCUSDT",
        "1Dutc",
        limit=10,
        end_time_ms=_ms(2026, 7, 9),
        force_rest=True,
    )

    assert result["symbol"] == "BTCUSDT"
    assert result["interval"] == "1Dutc"
    assert result["source"] == "REST_HISTORY"
    assert result["items"][0]["close"] == "105"
    assert result["history_terminal"] is False
