from __future__ import annotations

from app.services import spot_market_domain_cache as domain_cache
from app.services import spot_market_provider_ws as provider_ws


def test_normalize_spot_ws_symbol() -> None:
    assert provider_ws.normalize_spot_ws_symbol("BTC/USDT") == "BTCUSDT"
    assert provider_ws.normalize_spot_ws_symbol("btcusdt") == "BTCUSDT"


def test_spot_provider_ws_has_no_enabled_switches() -> None:
    for name in (
        "SPOT_PROVIDER_WS_ENABLED",
        "SPOT_PROVIDER_WS_DEPTH_ENABLED",
        "SPOT_PROVIDER_WS_TICKER_ENABLED",
        "SPOT_PROVIDER_WS_TRADES_ENABLED",
        "SPOT_PROVIDER_WS_KLINE_ENABLED",
    ):
        assert not hasattr(provider_ws.settings, name)

    for name in (
        "spot_provider_ws_depth_enabled",
        "spot_provider_ws_ticker_enabled",
        "spot_provider_ws_trades_enabled",
        "spot_provider_ws_kline_enabled",
    ):
        assert not hasattr(provider_ws, name)


def test_cache_metadata_helper_fresh_stale_missing_and_defaults() -> None:
    now_ms = 10_000
    record = {
        "symbol": "BTCUSDT",
        "provider": provider_ws.PROVIDER_BITGET_SPOT,
        "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "updated_at_ms": now_ms - 100,
    }

    fresh = domain_cache.resolve_cache_metadata(record, max_age_ms=1000, now_ms=now_ms)
    assert fresh.is_fresh is True
    assert fresh.metadata.is_stale is False
    assert fresh.metadata.fallback_reason == domain_cache.FALLBACK_REASON_FRESH
    assert fresh.metadata.age_ms == 100
    assert fresh.metadata.source == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert fresh.metadata.provider == provider_ws.PROVIDER_BITGET_SPOT
    assert domain_cache.is_fresh_record(record, max_age_ms=1000, now_ms=now_ms) is True

    stale = domain_cache.resolve_cache_metadata(record, max_age_ms=50, now_ms=now_ms)
    assert stale.is_fresh is False
    assert stale.metadata.is_stale is True
    assert stale.metadata.fallback_reason == domain_cache.FALLBACK_REASON_STALE
    assert stale.metadata.age_ms == 100
    assert domain_cache.stale_reason_for(record, max_age_ms=50, now_ms=now_ms) == "stale"

    missing = domain_cache.resolve_cache_metadata(None, max_age_ms=1000, now_ms=now_ms)
    assert missing.is_fresh is False
    assert missing.metadata.fallback_reason == domain_cache.FALLBACK_REASON_MISSING

    missing_updated_at = domain_cache.resolve_cache_metadata(
        {"symbol": "BTCUSDT", "source": provider_ws.SPOT_PROVIDER_WS_SOURCE},
        max_age_ms=1000,
        now_ms=now_ms,
    )
    assert missing_updated_at.is_fresh is False
    assert missing_updated_at.metadata.fallback_reason == domain_cache.FALLBACK_REASON_MISSING_UPDATED_AT

    empty_kline = domain_cache.resolve_cache_metadata(
        {"symbol": "BTCUSDT", "items": [], "updated_at_ms": now_ms},
        max_age_ms=1000,
        now_ms=now_ms,
    )
    assert empty_kline.is_fresh is False
    assert empty_kline.metadata.fallback_reason == domain_cache.FALLBACK_REASON_EMPTY

    ticker_defaults = domain_cache.with_live_ws_defaults("ticker", {"symbol": "BTCUSDT"})
    assert ticker_defaults["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert ticker_defaults["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert ticker_defaults["quote_freshness"] == "LIVE"


def test_bitget_depth_message_normalize() -> None:
    record = provider_ws.normalize_bitget_depth_message(
        {
            "arg": {"instType": "SP", "channel": "books15", "instId": "BTCUSDT"},
            "action": "snapshot",
            "data": [
                {
                    "bids": [["2", "1.5"], ["1", "3"], ["0.5", "9"]],
                    "asks": [["3", "2"], ["2.5", "4"], ["4", "1"]],
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
        depth_limit=2,
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["bids"] == [
        {"price": "2", "amount": "1.5"},
        {"price": "1", "amount": "3"},
    ]
    assert record["asks"] == [
        {"price": "2.5", "amount": "4"},
        {"price": "3", "amount": "2"},
    ]


def test_bitget_ticker_message_normalize() -> None:
    record = provider_ws.normalize_bitget_ticker_message(
        {
            "arg": {"instType": "SP", "channel": "ticker", "instId": "BTCUSDT"},
            "data": [
                {
                    "lastPr": "102",
                    "open": "100",
                    "openUtc": "90",
                    "change24h": "0.02",
                    "high24h": "105",
                    "low24h": "95",
                    "baseVolume": "10",
                    "quoteVolume": "1000",
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["last_price"] == "102"
    assert record["open_24h"] == "100"
    assert record["price_change_24h"] == "2"
    assert record["price_change_percent"] == "2"
    assert record["quote_freshness"] == "LIVE"


def test_bitget_ticker_message_normalize_negative_change24h() -> None:
    record = provider_ws.normalize_bitget_ticker_message(
        {
            "arg": {"instType": "SP", "channel": "ticker", "instId": "BTCUSDT"},
            "data": [
                {
                    "lastPr": "99",
                    "open": "100",
                    "openUtc": "120",
                    "change24h": "-0.01",
                    "high24h": "105",
                    "low24h": "95",
                    "baseVolume": "10",
                    "quoteVolume": "1000",
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
    )

    assert record is not None
    assert record["open_24h"] == "100"
    assert record["price_change_24h"] == "-1"
    assert record["price_change_percent"] == "-1"


def test_bitget_ticker_message_normalize_zero_change24h() -> None:
    record = provider_ws.normalize_bitget_ticker_message(
        {
            "arg": {"instType": "SP", "channel": "ticker", "instId": "BTCUSDT"},
            "data": [
                {
                    "lastPr": "102",
                    "open": "100",
                    "openUtc": "80",
                    "change24h": "0",
                    "high24h": "105",
                    "low24h": "95",
                    "baseVolume": "10",
                    "quoteVolume": "1000",
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
    )

    assert record is not None
    assert record["open_24h"] == "100"
    assert record["price_change_24h"] == "0"
    assert record["price_change_percent"] == "0"


def test_bitget_ticker_message_normalize_fallback_uses_open24h_not_open_utc() -> None:
    record = provider_ws.normalize_bitget_ticker_message(
        {
            "arg": {"instType": "SP", "channel": "ticker", "instId": "BTCUSDT"},
            "data": [
                {
                    "lastPr": "110",
                    "open24h": "100",
                    "openUtc": "50",
                    "high24h": "115",
                    "low24h": "95",
                    "baseVolume": "10",
                    "quoteVolume": "1000",
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
    )

    assert record is not None
    assert record["open_24h"] == "100"
    assert record["price_change_24h"] == "10"
    assert record["price_change_percent"] == "10"


def test_bitget_trade_message_normalize() -> None:
    record = provider_ws.normalize_bitget_trade_message(
        {
            "arg": {"instType": "SPOT", "channel": "trade", "instId": "BTCUSDT"},
            "action": "update",
            "data": [
                {
                    "tradeId": "1000000000",
                    "ts": "1695709835822",
                    "price": "26293.4",
                    "size": "0.0013",
                    "side": "buy",
                },
                {
                    "tradeId": "1000000001",
                    "ts": "1695709835823",
                    "price": "26294.1",
                    "size": "0.002",
                    "side": "sell",
                },
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
        trades_limit=2,
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["freshness"] == "LIVE"
    assert record["trades"][0]["id"] == "1000000001"
    assert record["trades"][0]["price"] == "26294.1"
    assert record["trades"][0]["amount"] == "0.002"
    assert record["trades"][0]["side"] == "SELL"
    assert record["trades"][1]["id"] == "1000000000"
    assert record["trades"][1]["side"] == "BUY"


def test_bitget_kline_channel_mapping() -> None:
    assert provider_ws.bitget_spot_kline_channel("1m") == "candle1m"
    assert provider_ws.bitget_spot_kline_channel("5m") == "candle5m"
    assert provider_ws.bitget_spot_kline_channel("15m") == "candle15"
    assert provider_ws.bitget_spot_kline_channel("1h") == "candle1H"
    assert provider_ws.bitget_spot_kline_channel("4h") == "candle4H"
    assert provider_ws.bitget_spot_kline_channel("1d") == "candle1D"


def test_bitget_kline_message_normalize() -> None:
    record = provider_ws.normalize_bitget_kline_message(
        {
            "arg": {"instType": "SPOT", "channel": "candle1m", "instId": "BTCUSDT"},
            "action": "update",
            "data": [
                [
                    "1695709800000",
                    "26290",
                    "26300",
                    "26280",
                    "26295",
                    "1.23",
                    "32343.2",
                    "32343.2",
                ]
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
        interval="1m",
        kline_limit=10,
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["freshness"] == "LIVE"
    assert record["interval"] == "1m"
    assert record["items"][0]["open_time"] == 1695709800000
    assert record["items"][0]["close_time"] == 1695709860000
    assert record["items"][0]["open"] == "26290"
    assert record["items"][0]["high"] == "26300"
    assert record["items"][0]["low"] == "26280"
    assert record["items"][0]["close"] == "26295"
    assert record["items"][0]["volume"] == "1.23"
    assert record["items"][0]["quote_volume"] == "32343.2"


def test_depth_cache_fresh_and_stale() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    now_ms = provider_ws._now_ms()
    service.set_depth_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "bids": [{"price": "2", "amount": "1"}],
            "asks": [{"price": "3", "amount": "1"}],
            "updated_at_ms": now_ms,
            "ts": now_ms,
        }
    )

    fresh = service.get_fresh_depth("BTC/USDT", max_age_ms=1000)
    assert fresh is not None
    assert fresh.symbol == "BTCUSDT"
    assert fresh.provider == provider_ws.PROVIDER_BITGET_SPOT
    assert fresh.source == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert fresh.freshness is None

    service.set_depth_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "bids": [{"price": "2", "amount": "1"}],
            "asks": [{"price": "3", "amount": "1"}],
            "updated_at_ms": now_ms - 5000,
            "ts": now_ms - 5000,
        }
    )
    assert service.get_fresh_depth("btcusdt", max_age_ms=1000) is None


def test_ticker_cache_fresh_and_stale() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    now_ms = provider_ws._now_ms()
    service.set_ticker_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "last_price": "102",
            "open_24h": "100",
            "updated_at_ms": now_ms,
            "ts": now_ms,
        }
    )

    fresh = service.get_fresh_ticker("BTC/USDT", max_age_ms=1000)
    assert fresh is not None
    assert fresh["symbol"] == "BTCUSDT"
    assert fresh["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert fresh["quote_freshness"] == "LIVE"
    assert "freshness" not in fresh

    service.set_ticker_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "last_price": "102",
            "open_24h": "100",
            "updated_at_ms": now_ms - 5000,
            "ts": now_ms - 5000,
        }
    )
    assert service.get_fresh_ticker("btcusdt", max_age_ms=1000) is None


def test_trades_cache_fresh_and_stale() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    now_ms = provider_ws._now_ms()
    service.set_trades_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "freshness": "LIVE",
            "trades": [
                {
                    "id": "1000000000",
                    "price": "26293.4",
                    "amount": "0.0013",
                    "side": "BUY",
                    "ts": now_ms,
                }
            ],
            "updated_at_ms": now_ms,
            "ts": now_ms,
        }
    )

    fresh = service.get_fresh_trades("BTC/USDT", max_age_ms=1000)
    assert fresh is not None
    assert fresh.symbol == "BTCUSDT"
    assert fresh.provider == provider_ws.PROVIDER_BITGET_SPOT
    assert fresh.source == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert fresh.freshness == "LIVE"
    assert fresh.trades[0].id == "1000000000"

    service.set_trades_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "freshness": "LIVE",
            "trades": [
                {
                    "id": "1000000000",
                    "price": "26293.4",
                    "amount": "0.0013",
                    "side": "BUY",
                    "ts": now_ms - 5000,
                }
            ],
            "updated_at_ms": now_ms - 5000,
            "ts": now_ms - 5000,
        }
    )
    assert service.get_fresh_trades("btcusdt", max_age_ms=1000) is None


def test_kline_cache_fresh_and_stale() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    now_ms = provider_ws._now_ms()
    item = {
        "open_time": now_ms - 60_000,
        "close_time": now_ms,
        "open": "2",
        "high": "3",
        "low": "1",
        "close": "2.5",
        "volume": "10",
        "quote_volume": "25",
    }
    service.set_kline_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "freshness": "LIVE",
            "items": [item],
            "updated_at_ms": now_ms,
            "ts": now_ms,
        }
    )

    fresh = service.get_fresh_klines("BTC/USDT", "1m", max_age_ms=1000)
    assert fresh is not None
    assert fresh["symbol"] == "BTCUSDT"
    assert fresh["interval"] == "1m"
    assert fresh["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert fresh["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert fresh["freshness"] == "LIVE"
    assert fresh["items"][0]["close"] == "2.5"

    service.set_kline_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "freshness": "LIVE",
            "items": [item],
            "updated_at_ms": now_ms - 5000,
            "ts": now_ms - 5000,
        }
    )
    assert service.get_fresh_klines("btcusdt", "1m", max_age_ms=1000) is None


def test_cache_getters_missing_records_return_none() -> None:
    service = provider_ws.SpotMarketProviderWsService()

    assert service.get_fresh_depth("BTCUSDT", max_age_ms=1000) is None
    assert service.get_fresh_ticker("BTCUSDT", max_age_ms=1000) is None
    assert service.get_fresh_trades("BTCUSDT", max_age_ms=1000) is None
    assert service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000) is None


def test_cache_getters_missing_updated_at_and_empty_kline_return_none() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    with service._lock:
        service._ticker_cache[(provider_ws.PROVIDER_BITGET_SPOT, "BTCUSDT")] = {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "quote_freshness": "LIVE",
            "last_price": "102",
            "open_24h": "100",
            "ts": provider_ws._now_ms(),
        }

    assert service.get_fresh_ticker("BTCUSDT", max_age_ms=1000) is None

    now_ms = provider_ws._now_ms()
    empty_kline_record = {
        "symbol": "BTCUSDT",
        "interval": "1m",
        "provider": provider_ws.PROVIDER_BITGET_SPOT,
        "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "items": [],
        "updated_at_ms": now_ms,
        "ts": now_ms,
    }
    assert domain_cache.stale_reason_for(
        empty_kline_record,
        max_age_ms=1000,
        now_ms=now_ms,
    ) == domain_cache.FALLBACK_REASON_EMPTY
    service.set_kline_cache_for_tests(empty_kline_record)
    assert service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000) is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_market_provider_ws tests passed")
