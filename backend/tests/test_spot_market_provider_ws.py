from __future__ import annotations

import asyncio
import inspect
import json
import threading
from datetime import datetime, timezone
from unittest.mock import patch

from app.services import spot_market_domain_cache as domain_cache
from app.services import spot_market_provider_ws as provider_ws


def _activate_provider_trades(
    service: provider_ws.SpotMarketProviderWsService,
    symbol: str = "BTCUSDT",
    *,
    provider: str = provider_ws.PROVIDER_BITGET_SPOT,
) -> None:
    with service._lock:
        service._trades_generations[(provider, symbol)] = 1


def _activate_provider_kline(
    service: provider_ws.SpotMarketProviderWsService,
    symbol: str = "BTCUSDT",
    interval: str = "1m",
    *,
    provider: str = provider_ws.PROVIDER_BITGET_SPOT,
) -> None:
    with service._lock:
        service._kline_stops[(provider, symbol, interval)] = threading.Event()
        service._kline_generations[(provider, symbol, interval)] = 1


def _handle_trades(
    service: provider_ws.SpotMarketProviderWsService,
    trades: list[dict],
    *,
    symbol: str = "BTCUSDT",
) -> None:
    subscription = provider_ws.SpotTradesSubscription(
        local_symbol=symbol,
        provider=provider_ws.PROVIDER_BITGET_SPOT,
        provider_symbol=symbol,
        trades_limit=30,
    )
    service._handle_bitget_trades_message(
        subscription,
        json.dumps(
            {
                "arg": {"instType": "SPOT", "channel": "trade", "instId": symbol},
                "action": "update",
                "data": trades,
            }
        ),
        1,
    )


def _handle_okx_trades(
    service: provider_ws.SpotMarketProviderWsService,
    trades: list[dict],
    *,
    symbol: str = "BTCUSDT",
    provider_symbol: str = "BTC-USDT",
) -> None:
    subscription = provider_ws.SpotTradesSubscription(
        local_symbol=symbol,
        provider=provider_ws.PROVIDER_OKX_SPOT,
        provider_symbol=provider_symbol,
        trades_limit=30,
        channel=provider_ws.OKX_SPOT_TRADES_CHANNEL,
    )
    service._handle_okx_trades_message(
        subscription,
        json.dumps(
            {
                "arg": {"channel": "trades", "instId": provider_symbol},
                "data": trades,
            }
        ),
        1,
    )


def _cache_trade(
    *,
    identity: str | None = None,
    event_time_ms: int | None,
    received_at_ms: int,
    price: str = "100",
    amount: str = "1",
    side: str = "BUY",
    provider: str = provider_ws.PROVIDER_BITGET_SPOT,
    provider_symbol: str = "BTCUSDT",
) -> dict:
    trade = {
        "price": price,
        "amount": amount,
        "side": side,
        "ts": event_time_ms if event_time_ms is not None else received_at_ms,
        "event_time_ms": event_time_ms,
        "received_at_ms": received_at_ms,
        "time_origin": "PROVIDER",
        "provider": provider,
        "provider_symbol": provider_symbol,
        "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
    }
    if identity is not None:
        trade.update(id=identity, trade_id=identity, provider_trade_id=identity)
    return trade


def _store_cached_trades(
    service: provider_ws.SpotMarketProviderWsService,
    trades: list[dict],
    *,
    received_at_ms: int,
    trades_limit: int = 30,
    provider: str = provider_ws.PROVIDER_BITGET_SPOT,
    provider_symbol: str = "BTCUSDT",
    generation: int = 1,
) -> dict:
    subscription = provider_ws.SpotTradesSubscription(
        local_symbol="BTCUSDT",
        provider=provider,
        provider_symbol=provider_symbol,
        trades_limit=trades_limit,
    )
    key = (provider, "BTCUSDT")
    with service._lock:
        service._trades_generations.setdefault(key, generation)
        service._store_trades_record_locked(
            subscription,
            {
                "symbol": "BTCUSDT",
                "provider": provider,
                "provider_symbol": provider_symbol,
                "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
                "freshness": "LIVE",
                "trades": trades,
                "received_at_ms": received_at_ms,
                "updated_at_ms": received_at_ms,
            },
            generation,
        )
        return service._trades_cache[key]


def _handle_bitget_klines(
    service: provider_ws.SpotMarketProviderWsService,
    rows: list[list[str]],
    *,
    symbol: str = "BTCUSDT",
    interval: str = "1m",
    generation: int = 1,
    kline_limit: int = 30,
) -> None:
    subscription = provider_ws.SpotKlineSubscription(
        local_symbol=symbol,
        provider=provider_ws.PROVIDER_BITGET_SPOT,
        provider_symbol=symbol,
        interval=interval,
        channel=provider_ws.bitget_spot_kline_channel(interval),
        kline_limit=kline_limit,
    )
    service._handle_bitget_kline_message(
        subscription,
        json.dumps(
            {
                "arg": {
                    "instType": "SPOT",
                    "channel": provider_ws.bitget_spot_kline_channel(interval),
                    "instId": symbol,
                },
                "action": "update",
                "data": rows,
            }
        ),
        generation,
    )


def _handle_okx_klines(
    service: provider_ws.SpotMarketProviderWsService,
    rows: list[list[str]],
    *,
    symbol: str = "BTCUSDT",
    provider_symbol: str = "BTC-USDT",
    interval: str = "1m",
    generation: int = 1,
    kline_limit: int = 30,
) -> None:
    subscription = provider_ws.SpotKlineSubscription(
        local_symbol=symbol,
        provider=provider_ws.PROVIDER_OKX_SPOT,
        provider_symbol=provider_symbol,
        interval=interval,
        channel=provider_ws.okx_spot_kline_channel(interval),
        kline_limit=kline_limit,
    )
    service._handle_okx_kline_message(
        subscription,
        json.dumps(
            {
                "arg": {
                    "channel": provider_ws.okx_spot_kline_channel(interval),
                    "instId": provider_symbol,
                },
                "data": rows,
            }
        ),
        generation,
    )


def test_normalize_spot_ws_symbol() -> None:
    assert provider_ws.normalize_spot_ws_symbol("BTC/USDT") == "BTCUSDT"
    assert provider_ws.normalize_spot_ws_symbol("btcusdt") == "BTCUSDT"


def test_spot_provider_ws_supported_provider_gate() -> None:
    assert provider_ws.spot_provider_ws_supports_provider(provider_ws.PROVIDER_BITGET_SPOT)
    assert provider_ws.spot_provider_ws_supports_provider(provider_ws.PROVIDER_OKX_SPOT)
    assert provider_ws.spot_provider_ws_supports_provider(provider_ws.PROVIDER_OKX_SPOT, domain="depth")
    assert provider_ws.spot_provider_ws_supports_provider(provider_ws.PROVIDER_OKX_SPOT, domain="ticker")
    assert provider_ws.spot_provider_ws_supports_provider(provider_ws.PROVIDER_OKX_SPOT, domain="trades")
    assert provider_ws.spot_provider_ws_supports_provider(provider_ws.PROVIDER_OKX_SPOT, domain="kline")

    service = provider_ws.SpotMarketProviderWsService()
    service.set_ticker_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "last_price": "1",
            "open_24h": "1",
            "price_change_24h": "0",
            "price_change_percent": "0",
            "high_24h": "1",
            "low_24h": "1",
            "base_volume_24h": "1",
            "quote_volume_24h": "1",
        }
    )

    assert service.get_fresh_ticker("BTCUSDT", provider=provider_ws.PROVIDER_BITGET_SPOT) is not None
    assert service.get_fresh_ticker("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT) is None

    ensure_calls: list[tuple[str, str, str | None]] = []
    service._ensure_depth_symbol = lambda symbol, provider=None: ensure_calls.append(("depth", symbol, provider))
    service._ensure_ticker_symbol = lambda symbol, provider=None: ensure_calls.append(("ticker", symbol, provider))
    service._ensure_trades_symbol = lambda symbol, provider=None: ensure_calls.append(("trades", symbol, provider))
    service._ensure_kline_symbol = lambda symbol, interval, provider=None: ensure_calls.append(("kline", symbol, interval, provider))

    service.ensure_symbol("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_kline("BTCUSDT", "1m", provider=provider_ws.PROVIDER_OKX_SPOT)

    assert ensure_calls == [
        ("depth", "BTCUSDT", provider_ws.PROVIDER_OKX_SPOT),
        ("ticker", "BTCUSDT", provider_ws.PROVIDER_OKX_SPOT),
        ("trades", "BTCUSDT", provider_ws.PROVIDER_OKX_SPOT),
        ("kline", "BTCUSDT", "1m", provider_ws.PROVIDER_OKX_SPOT),
    ]


def test_okx_spot_kline_utc_channels_are_mapped() -> None:
    assert provider_ws.normalize_spot_ws_kline_interval("1Dutc") == "1Dutc"
    assert provider_ws.normalize_spot_ws_kline_interval("1dutc") == "1Dutc"
    assert provider_ws.normalize_spot_ws_kline_interval("1Wutc") == "1Wutc"
    assert provider_ws.normalize_spot_ws_kline_interval("1wutc") == "1Wutc"
    assert provider_ws.normalize_spot_ws_kline_interval("1Mutc") == "1Mutc"
    assert provider_ws.normalize_spot_ws_kline_interval("1mutc") == "1Mutc"
    assert provider_ws.okx_spot_kline_channel("1Dutc") == "candle1Dutc"
    assert provider_ws.okx_spot_kline_channel("1Wutc") == "candle1Wutc"
    assert provider_ws.okx_spot_kline_channel("1Mutc") == "candle1Mutc"

    service = provider_ws.SpotMarketProviderWsService()
    ensure_calls: list[tuple[str, str, str | None]] = []
    service._ensure_kline_symbol = lambda symbol, interval, provider=None: ensure_calls.append(
        (symbol, interval, provider)
    )

    service.ensure_kline("BTCUSDT", "1Dutc", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_kline("BTCUSDT", "1wutc", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_kline("BTCUSDT", "1mutc", provider=provider_ws.PROVIDER_OKX_SPOT)

    assert ensure_calls == [
        ("BTCUSDT", "1Dutc", provider_ws.PROVIDER_OKX_SPOT),
        ("BTCUSDT", "1Wutc", provider_ws.PROVIDER_OKX_SPOT),
        ("BTCUSDT", "1Mutc", provider_ws.PROVIDER_OKX_SPOT),
    ]


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


def test_provider_ws_shutdown_noise_detection() -> None:
    assert provider_ws._is_provider_ws_shutdown_noise(
        RuntimeError("cannot schedule new futures after shutdown")
    )
    assert provider_ws._is_provider_ws_shutdown_noise(RuntimeError("Event loop is closed"))
    assert provider_ws._is_provider_ws_shutdown_noise(RuntimeError("executor shutdown"))
    assert not provider_ws._is_provider_ws_shutdown_noise(RuntimeError("some provider error"))
    assert not provider_ws._is_provider_ws_shutdown_noise(OSError("getaddrinfo failed"))

    stop_event = threading.Event()
    stop_event.set()
    assert provider_ws._is_provider_ws_shutdown_noise(RuntimeError("some provider error"), stop_event)


def test_provider_ws_loop_exits_on_shutdown_noise_without_retry() -> None:
    async def run() -> None:
        service = provider_ws.SpotMarketProviderWsService()
        calls = 0

        async def fail_with_shutdown(*args, **kwargs) -> None:
            nonlocal calls
            calls += 1
            raise RuntimeError("cannot schedule new futures after shutdown")

        service._run_bitget_ticker_ws = fail_with_shutdown
        subscription = provider_ws.SpotTickerSubscription(
            local_symbol="BTCUSDT",
            provider=provider_ws.PROVIDER_BITGET_SPOT,
            provider_symbol="BTCUSDT",
        )

        await service._ticker_loop(subscription, threading.Event(), 1)
        assert calls == 1

    asyncio.run(run())


def test_provider_ws_loop_exits_without_connect_when_stop_event_is_set() -> None:
    async def run() -> None:
        service = provider_ws.SpotMarketProviderWsService()
        calls = 0

        async def fail_if_called(*args, **kwargs) -> None:
            nonlocal calls
            calls += 1
            raise AssertionError("provider ws should not reconnect after stop")

        service._run_bitget_ticker_ws = fail_if_called
        stop_event = threading.Event()
        stop_event.set()
        subscription = provider_ws.SpotTickerSubscription(
            local_symbol="BTCUSDT",
            provider=provider_ws.PROVIDER_BITGET_SPOT,
            provider_symbol="BTCUSDT",
        )

        await service._ticker_loop(subscription, stop_event, 1)
        assert calls == 0

    asyncio.run(run())


def test_provider_ws_recoverable_disconnect_logs_without_traceback(caplog) -> None:
    async def run() -> None:
        service = provider_ws.SpotMarketProviderWsService()
        stop_event = threading.Event()
        calls = 0

        async def fail_then_stop(*args, **kwargs) -> None:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ConnectionResetError("peer reset")
            stop_event.set()

        service._run_bitget_ticker_ws = fail_then_stop
        subscription = provider_ws.SpotTickerSubscription(
            local_symbol="LOGTESTUSDT",
            provider=provider_ws.PROVIDER_BITGET_SPOT,
            provider_symbol="LOGTESTUSDT",
        )

        await service._ticker_loop(subscription, stop_event, 1)
        assert calls == 2

    with caplog.at_level("WARNING"):
        asyncio.run(run())

    records = [
        record
        for record in caplog.records
        if "spot_provider_ws_ticker_disconnected" in record.getMessage()
    ]
    assert len(records) == 1
    assert "reason=ConnectionResetError" in records[0].getMessage()
    assert records[0].exc_info is None


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


def test_okx_depth_message_normalize_and_cache() -> None:
    record = provider_ws.normalize_okx_depth_message(
        {
            "arg": {"channel": "books5", "instId": "BTC-USDT"},
            "action": "snapshot",
            "data": [
                {
                    "bids": [["2", "1.5", "0", "1"], ["1", "3", "0", "1"], ["0.5", "9", "0", "1"]],
                    "asks": [["3", "2", "0", "1"], ["2.5", "4", "0", "1"], ["4", "1", "0", "1"]],
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTC-USDT",
        depth_limit=2,
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_OKX_SPOT
    assert record["provider_symbol"] == "BTC-USDT"
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["quote_source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["freshness"] == "LIVE"
    assert record["market_status"] == "OPEN"
    assert record["bids"] == [
        {"price": "2", "amount": "1.5"},
        {"price": "1", "amount": "3"},
    ]
    assert record["asks"] == [
        {"price": "2.5", "amount": "4"},
        {"price": "3", "amount": "2"},
    ]

    service = provider_ws.SpotMarketProviderWsService()
    service.set_depth_cache_for_tests(record)
    depth = service.get_fresh_depth("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT, limit=2)
    assert depth is not None
    assert depth.provider == provider_ws.PROVIDER_OKX_SPOT
    assert depth.source == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert depth.bids[0].price == "2"
    assert service.get_fresh_depth("BTCUSDT", provider=provider_ws.PROVIDER_BITGET_SPOT) is None


def test_okx_ticker_message_normalize_and_cache() -> None:
    record = provider_ws.normalize_okx_ticker_message(
        {
            "arg": {"channel": "tickers", "instId": "BTC-USDT"},
            "data": [
                {
                    "instId": "BTC-USDT",
                    "last": "102",
                    "lastSz": "0.5",
                    "askPx": "102.1",
                    "askSz": "1.2",
                    "bidPx": "101.9",
                    "bidSz": "1.1",
                    "open24h": "100",
                    "high24h": "105",
                    "low24h": "95",
                    "vol24h": "10",
                    "volCcy24h": "1000",
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTC-USDT",
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_OKX_SPOT
    assert record["provider_symbol"] == "BTC-USDT"
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["quote_source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["freshness"] == "LIVE"
    assert record["last_price"] == "102"
    assert record["display_price"] == "102"
    assert record["bid_price"] == "101.9"
    assert record["ask_price"] == "102.1"
    assert record["open_24h"] == "100"
    assert record["price_change_24h"] == "2"
    assert record["price_change_percent"] == "2"
    assert record["price_change_percent_24h"] == "2"
    assert record["base_volume_24h"] == "10"
    assert record["quote_volume_24h"] == "1000"
    assert record["quote_freshness"] == "LIVE"
    assert record["market_status"] == "OPEN"
    assert record["event_time_ms"] == 1000
    assert record["received_at_ms"] == record["updated_at_ms"]

    service = provider_ws.SpotMarketProviderWsService()
    service.set_ticker_cache_for_tests(record)
    ticker = service.get_fresh_ticker("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)
    assert ticker is not None
    assert ticker["provider"] == provider_ws.PROVIDER_OKX_SPOT
    assert ticker["last_price"] == "102"
    assert service.get_fresh_ticker("BTCUSDT", provider=provider_ws.PROVIDER_BITGET_SPOT) is None


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
    assert record["event_time_ms"] == 1000
    assert record["received_at_ms"] == record["updated_at_ms"]


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
    assert record["trades"][0]["event_time_ms"] == 1695709835823
    assert record["trades"][1]["event_time_ms"] == 1695709835822
    assert record["trades"][0]["received_at_ms"] == record["updated_at_ms"]
    assert record["trades"][1]["received_at_ms"] == record["updated_at_ms"]
    assert record["trades"][0]["time_origin"] == "PROVIDER"
    assert record["trades"][0]["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert record["trades"][0]["provider_symbol"] == "BTCUSDT"


def test_okx_trade_message_normalize_cache_and_dedupe() -> None:
    record = provider_ws.normalize_okx_trade_message(
        {
            "arg": {"channel": "trades", "instId": "BTC-USDT"},
            "data": [
                {
                    "instId": "BTC-USDT",
                    "tradeId": "1000000000",
                    "px": "26293.4",
                    "sz": "0.0013",
                    "side": "buy",
                    "ts": "1695709835822",
                },
                {
                    "instId": "BTC-USDT",
                    "tradeId": "1000000001",
                    "px": "26294.1",
                    "sz": "0.002",
                    "side": "sell",
                    "ts": "1695709835823",
                },
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTC-USDT",
        trades_limit=2,
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_OKX_SPOT
    assert record["provider_symbol"] == "BTC-USDT"
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["freshness"] == "LIVE"
    assert record["trades"][0]["id"] == "1000000001"
    assert record["trades"][0]["trade_id"] == "1000000001"
    assert record["trades"][0]["provider_trade_id"] == "1000000001"
    assert record["trades"][0]["price"] == "26294.1"
    assert record["trades"][0]["amount"] == "0.002"
    assert record["trades"][0]["side"] == "SELL"
    assert record["trades"][1]["id"] == "1000000000"
    assert record["trades"][1]["side"] == "BUY"
    assert record["trades"][0]["raw_trade"]["instId"] == "BTC-USDT"
    assert record["trades"][0]["event_time_ms"] == 1695709835823
    assert record["trades"][1]["event_time_ms"] == 1695709835822
    assert record["trades"][0]["received_at_ms"] == record["updated_at_ms"]
    assert record["trades"][1]["received_at_ms"] == record["updated_at_ms"]
    assert record["trades"][0]["time_origin"] == "PROVIDER"
    assert record["trades"][0]["provider"] == provider_ws.PROVIDER_OKX_SPOT
    assert record["trades"][0]["provider_symbol"] == "BTC-USDT"

    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service, provider=provider_ws.PROVIDER_OKX_SPOT)
    _handle_okx_trades(
        service,
        [
            {"tradeId": "t1", "px": "100", "sz": "1", "side": "buy", "ts": "1000"},
            {"tradeId": "t1", "px": "100", "sz": "1", "side": "buy", "ts": "1000"},
        ],
    )

    trades = service.get_fresh_trades("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)
    assert trades is not None
    assert trades.provider == provider_ws.PROVIDER_OKX_SPOT
    assert trades.source == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert trades.freshness == "LIVE"
    assert len(trades.trades) == 1
    assert trades.trades[0].id == "t1"
    assert trades.trades[0].trade_id == "t1"
    assert trades.trades[0].provider_trade_id == "t1"
    assert trades.trades[0].price == "100"
    assert trades.provider_symbol == "BTC-USDT"
    assert service.get_fresh_trades("BTCUSDT", provider=provider_ws.PROVIDER_BITGET_SPOT) is None


def test_ws_trade_message_without_provider_time_is_explicitly_untimed_and_captures_once() -> None:
    with patch.object(provider_ws, "_now_ms", return_value=9_000) as clock:
        record = provider_ws.normalize_bitget_trade_message(
            {
                "arg": {"instType": "SPOT", "channel": "trade", "instId": "BTCUSDT"},
                "action": "update",
                "data": [
                    {"tradeId": "timed", "ts": "1000", "price": "100", "size": "1", "side": "buy"},
                    {"tradeId": "untimed", "price": "99", "size": "2", "side": "sell"},
                ],
            },
            local_symbol="BTCUSDT",
            provider_symbol="BTCUSDT",
            trades_limit=2,
        )

    assert clock.call_count == 1
    assert record is not None
    assert record["received_at_ms"] == 9_000
    assert {item["received_at_ms"] for item in record["trades"]} == {9_000}
    timed = next(item for item in record["trades"] if item["id"] == "timed")
    untimed = next(item for item in record["trades"] if item["id"] == "untimed")
    assert timed["event_time_ms"] == 1_000
    assert timed["created_at"] == datetime.utcfromtimestamp(1).isoformat()
    assert untimed["event_time_ms"] is None
    assert untimed["ts"] == 9_000
    assert untimed["created_at"] is None
    assert untimed["time_origin"] == "PROVIDER"


def test_trade_identity_prefers_provider_trade_id_then_trade_id_then_id_and_includes_provider() -> None:
    full = {
        "provider": provider_ws.PROVIDER_OKX_SPOT,
        "provider_trade_id": "provider-id",
        "trade_id": "trade-id",
        "id": "item-id",
    }
    without_provider_id = dict(full, provider_trade_id=None)
    without_trade_id = dict(without_provider_id, trade_id=None)

    assert provider_ws.spot_trade_strong_identity(full) == "provider:OKX_SPOT|trade:provider-id"
    assert provider_ws.spot_trade_strong_identity(without_provider_id) == "provider:OKX_SPOT|trade:trade-id"
    assert provider_ws.spot_trade_strong_identity(without_trade_id) == "provider:OKX_SPOT|trade:item-id"
    assert provider_ws.spot_trade_strong_identity(full) != provider_ws.spot_trade_strong_identity(
        dict(full, provider=provider_ws.PROVIDER_BITGET_SPOT)
    )


def test_trades_cache_strong_identity_dedupes_and_prefers_more_complete_newer_item() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    existing = _cache_trade(identity="same", event_time_ms=1_000, received_at_ms=2_000)
    existing["id"] = "existing-item"
    existing["trade_id"] = "existing-trade"
    _store_cached_trades(service, [existing], received_at_ms=2_000)

    incoming = _cache_trade(
        identity="same",
        event_time_ms=1_000,
        received_at_ms=3_000,
        price="101",
    )
    incoming["id"] = "incoming-item"
    incoming["trade_id"] = "incoming-trade"
    incoming["created_at"] = datetime.utcfromtimestamp(1).isoformat()
    record = _store_cached_trades(service, [incoming], received_at_ms=3_000)

    assert len(record["trades"]) == 1
    assert record["trades"][0]["provider_trade_id"] == "same"
    assert record["trades"][0]["price"] == "101"
    assert record["trades"][0]["received_at_ms"] == 3_000


def test_trades_cache_weak_fingerprint_uses_collision_aware_multiset_counts() -> None:
    service = provider_ws.SpotMarketProviderWsService()

    weak_two = [
        _cache_trade(event_time_ms=1_000, received_at_ms=2_000),
        _cache_trade(event_time_ms=1_000, received_at_ms=2_000),
    ]
    record = _store_cached_trades(service, weak_two, received_at_ms=2_000)
    assert len(record["trades"]) == 2

    replay = [
        _cache_trade(event_time_ms=1_000, received_at_ms=3_000),
        _cache_trade(event_time_ms=1_000, received_at_ms=3_000),
    ]
    record = _store_cached_trades(service, replay, received_at_ms=3_000)
    assert len(record["trades"]) == 2

    weak_three = [
        _cache_trade(event_time_ms=1_000, received_at_ms=4_000),
        _cache_trade(event_time_ms=1_000, received_at_ms=4_000),
        _cache_trade(event_time_ms=1_000, received_at_ms=4_000),
    ]
    record = _store_cached_trades(service, weak_three, received_at_ms=4_000)
    assert len(record["trades"]) == 3

    record = _store_cached_trades(
        service,
        [_cache_trade(event_time_ms=1_000, received_at_ms=5_000)],
        received_at_ms=5_000,
    )
    assert len(record["trades"]) == 3


def test_trades_cache_sorts_globally_before_limit_and_late_trade_cannot_evict_newer_events() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _store_cached_trades(
        service,
        [
            _cache_trade(identity="event-3000", event_time_ms=3_000, received_at_ms=4_000),
            _cache_trade(identity="event-2000", event_time_ms=2_000, received_at_ms=4_000),
        ],
        received_at_ms=4_000,
        trades_limit=2,
    )
    record = _store_cached_trades(
        service,
        [_cache_trade(identity="event-1000", event_time_ms=1_000, received_at_ms=99_999)],
        received_at_ms=99_999,
        trades_limit=2,
    )

    assert [trade["event_time_ms"] for trade in record["trades"]] == [3_000, 2_000]
    assert record["received_at_ms"] == 99_999
    assert record["updated_at_ms"] == 99_999
    assert record["ts"] == 3_000


def test_trades_cache_places_timed_before_untimed_and_only_sorts_untimed_by_received_time() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    record = _store_cached_trades(
        service,
        [
            _cache_trade(identity="untimed-new", event_time_ms=None, received_at_ms=99_999),
            _cache_trade(identity="timed", event_time_ms=1_000, received_at_ms=2_000),
            _cache_trade(identity="untimed-old", event_time_ms=None, received_at_ms=3_000),
        ],
        received_at_ms=99_999,
    )

    assert [trade["provider_trade_id"] for trade in record["trades"]] == [
        "timed",
        "untimed-new",
        "untimed-old",
    ]
    assert record["ts"] == 1_000

    untimed_service = provider_ws.SpotMarketProviderWsService()
    untimed_record = _store_cached_trades(
        untimed_service,
        [
            _cache_trade(identity="received-100", event_time_ms=None, received_at_ms=100),
            _cache_trade(identity="received-300", event_time_ms=None, received_at_ms=300),
            _cache_trade(identity="received-200", event_time_ms=None, received_at_ms=200),
        ],
        received_at_ms=300,
    )
    assert [trade["received_at_ms"] for trade in untimed_record["trades"]] == [300, 200, 100]
    assert untimed_record["ts"] == 300


def test_okx_trades_do_not_drive_provider_kline_cache() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service, provider=provider_ws.PROVIDER_OKX_SPOT)
    _activate_provider_kline(service, provider=provider_ws.PROVIDER_OKX_SPOT)

    _handle_okx_trades(
        service,
        [{"tradeId": "t1", "px": "100", "sz": "1", "side": "buy", "ts": "1695709835822"}],
    )

    assert service.get_fresh_trades("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT) is not None
    assert service.get_fresh_klines("BTCUSDT", "1m", provider=provider_ws.PROVIDER_OKX_SPOT) is None
    assert service.get_fresh_klines("BTCUSDT", "1m", provider=provider_ws.PROVIDER_BITGET_SPOT) is None


def test_bitget_kline_channel_mapping() -> None:
    assert provider_ws.bitget_spot_kline_channel("1m") == "candle1m"
    assert provider_ws.bitget_spot_kline_channel("5m") == "candle5m"
    assert provider_ws.bitget_spot_kline_channel("15m") == "candle15"
    assert provider_ws.bitget_spot_kline_channel("1h") == "candle1H"
    assert provider_ws.bitget_spot_kline_channel("4h") == "candle4H"
    assert provider_ws.bitget_spot_kline_channel("1d") == "candle1D"
    assert provider_ws.bitget_spot_kline_channel("1Dutc") == "candle1Dutc"
    assert provider_ws.bitget_spot_kline_channel("1w") == "candle1W"
    assert provider_ws.bitget_spot_kline_channel("1Wutc") == "candle1Wutc"
    assert provider_ws.bitget_spot_kline_channel("1M") == "candle1M"
    assert provider_ws.bitget_spot_kline_channel("1Mutc") == "candle1Mutc"

    for interval in ("1m", "5m", "15m", "1h", "4h", "1Dutc", "1Wutc", "1Mutc"):
        assert provider_ws.spot_provider_ws_supports_kline_interval(
            provider_ws.PROVIDER_BITGET_SPOT,
            interval,
        )


def _assert_bitget_native_utc_kline_anchor(
    *,
    interval: str,
    channel: str,
    utc_anchor_ms: int,
) -> datetime:
    anchor = datetime.fromtimestamp(utc_anchor_ms / 1000, tz=timezone.utc)
    record = provider_ws.normalize_bitget_kline_message(
        {
            "arg": {"instType": "SPOT", "channel": channel, "instId": "BTCUSDT"},
            "action": "update",
            "data": [
                [
                    str(utc_anchor_ms),
                    "100",
                    "110",
                    "90",
                    "105",
                    "1",
                    "105",
                    "105",
                ]
            ],
        },
        local_symbol="BTCUSDT",
        provider_symbol="BTCUSDT",
        interval=interval,
        kline_limit=10,
    )
    assert record is not None
    assert record["interval"] == interval
    assert record["items"][0]["open_time"] == utc_anchor_ms
    return anchor


def test_bitget_native_1dutc_anchor_is_utc_midnight() -> None:
    anchor = _assert_bitget_native_utc_kline_anchor(
        interval="1Dutc",
        channel="candle1Dutc",
        utc_anchor_ms=1704153600000,
    )
    assert anchor == datetime(2024, 1, 2, 0, 0, tzinfo=timezone.utc)


def test_bitget_native_1wutc_anchor_is_utc_monday() -> None:
    anchor = _assert_bitget_native_utc_kline_anchor(
        interval="1Wutc",
        channel="candle1Wutc",
        utc_anchor_ms=1704672000000,
    )
    assert anchor == datetime(2024, 1, 8, 0, 0, tzinfo=timezone.utc)
    assert anchor.weekday() == 0


def test_bitget_native_1mutc_anchor_is_utc_month_start() -> None:
    anchor = _assert_bitget_native_utc_kline_anchor(
        interval="1Mutc",
        channel="candle1Mutc",
        utc_anchor_ms=1706745600000,
    )
    assert anchor == datetime(2024, 2, 1, 0, 0, tzinfo=timezone.utc)
    assert anchor.day == 1


def test_unsupported_kline_capability_does_not_start_thread_or_reconnect() -> None:
    original_capabilities = provider_ws.SPOT_PROVIDER_WS_KLINE_CHANNELS[
        provider_ws.PROVIDER_BITGET_SPOT
    ]
    provider_ws.SPOT_PROVIDER_WS_KLINE_CHANNELS[provider_ws.PROVIDER_BITGET_SPOT] = {
        key: value for key, value in original_capabilities.items() if key != "1Dutc"
    }
    try:
        service = provider_ws.SpotMarketProviderWsService()
        service.ensure_kline("BTCUSDT", "1Dutc", provider=provider_ws.PROVIDER_BITGET_SPOT)

        key = (provider_ws.PROVIDER_BITGET_SPOT, "BTCUSDT", "1Dutc")
        metric_key = ("kline", *key)
        assert provider_ws.bitget_spot_kline_channel("1Dutc") is None
        assert not provider_ws.spot_provider_ws_supports_kline_interval(
            provider_ws.PROVIDER_BITGET_SPOT,
            "1Dutc",
        )
        assert key not in service._kline_tasks
        assert key not in service._kline_stops
        assert key not in service._kline_connections
        assert key not in service._kline_generations
        assert metric_key not in service._task_started_at_ms
        assert metric_key not in service._task_reconnect_counts
        assert service.get_fresh_klines(
            "BTCUSDT",
            "1Dutc",
            provider=provider_ws.PROVIDER_BITGET_SPOT,
        ) is None
        assert provider_ws.spot_provider_ws_supports_provider(
            provider_ws.PROVIDER_BITGET_SPOT,
            domain="depth",
        )
        assert provider_ws.spot_provider_ws_supports_provider(
            provider_ws.PROVIDER_BITGET_SPOT,
            domain="ticker",
        )
        assert provider_ws.spot_provider_ws_supports_provider(
            provider_ws.PROVIDER_BITGET_SPOT,
            domain="trades",
        )
    finally:
        provider_ws.SPOT_PROVIDER_WS_KLINE_CHANNELS[
            provider_ws.PROVIDER_BITGET_SPOT
        ] = original_capabilities


def test_bitget_utc_kline_ensure_is_idempotent_and_release_does_not_leak() -> None:
    original_thread = provider_ws.threading.Thread

    class FakeThread:
        def __init__(self, *, target, args, name, daemon):
            self.target = target
            self.args = args
            self.name = name
            self.daemon = daemon
            self.alive = False

        def start(self) -> None:
            self.alive = True

        def is_alive(self) -> bool:
            return self.alive

        def join(self, timeout=None) -> None:
            self.alive = False

    try:
        provider_ws.threading.Thread = FakeThread
        service = provider_ws.SpotMarketProviderWsService()
        intervals = ("1Dutc", "1Wutc", "1Mutc")
        for interval in intervals:
            service.ensure_kline("BTCUSDT", interval, provider=provider_ws.PROVIDER_BITGET_SPOT)
            service.ensure_kline("BTCUSDT", interval, provider=provider_ws.PROVIDER_BITGET_SPOT)

        keys = {
            (provider_ws.PROVIDER_BITGET_SPOT, "BTCUSDT", interval)
            for interval in intervals
        }
        assert set(service._kline_tasks) == keys
        assert set(service._kline_stops) == keys
        assert {key: service._kline_generations[key] for key in keys} == {
            key: 1 for key in keys
        }
        assert {
            key[2]: service._kline_tasks[key].args[0].channel for key in keys
        } == {
            "1Dutc": "candle1Dutc",
            "1Wutc": "candle1Wutc",
            "1Mutc": "candle1Mutc",
        }

        for interval in intervals:
            service.release_kline("BTCUSDT", interval, provider=provider_ws.PROVIDER_BITGET_SPOT)

        assert service._kline_tasks == {}
        assert service._kline_stops == {}
        assert service._kline_connections == {}
        assert {key: service._kline_generations[key] for key in keys} == {
            key: 2 for key in keys
        }
    finally:
        provider_ws.threading.Thread = original_thread


def test_okx_kline_channel_mapping() -> None:
    assert provider_ws.okx_spot_kline_channel("1m") == "candle1m"
    assert provider_ws.okx_spot_kline_channel("5m") == "candle5m"
    assert provider_ws.okx_spot_kline_channel("15m") == "candle15m"
    assert provider_ws.okx_spot_kline_channel("1h") == "candle1H"
    assert provider_ws.okx_spot_kline_channel("4h") == "candle4H"
    assert provider_ws.okx_spot_kline_channel("1d") == "candle1D"
    assert provider_ws.okx_spot_kline_channel("1w") == "candle1W"
    assert provider_ws.okx_spot_kline_channel("1M") == "candle1M"


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


def test_okx_kline_message_normalize_and_cache() -> None:
    record = provider_ws.normalize_okx_kline_message(
        {
            "arg": {"channel": "candle1m", "instId": "BTC-USDT"},
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
                    "1",
                ]
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTC-USDT",
        interval="1m",
        kline_limit=10,
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_OKX_SPOT
    assert record["provider_symbol"] == "BTC-USDT"
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["freshness"] == "LIVE"
    assert record["interval"] == "1m"
    assert record["items"][0]["open_time"] == 1695709800000
    assert record["items"][0]["open_time_ms"] == 1695709800000
    assert record["items"][0]["close_time"] == 1695709860000
    assert record["items"][0]["open"] == "26290"
    assert record["items"][0]["high"] == "26300"
    assert record["items"][0]["low"] == "26280"
    assert record["items"][0]["close"] == "26295"
    assert record["items"][0]["volume"] == "1.23"
    assert record["items"][0]["quote_volume"] == "32343.2"
    assert record["items"][0]["confirm"] == "1"
    assert record["items"][0]["is_closed"] is True

    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_kline(service, provider=provider_ws.PROVIDER_OKX_SPOT)
    subscription = provider_ws.SpotKlineSubscription(
        local_symbol="BTCUSDT",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        provider_symbol="BTC-USDT",
        interval="1m",
        channel=provider_ws.okx_spot_kline_channel("1m"),
        kline_limit=10,
    )
    service._handle_okx_kline_message(
        subscription,
        json.dumps(
            {
                "arg": {"channel": "candle1m", "instId": "BTC-USDT"},
                "data": [[str(1695709800000), "26290", "26300", "26280", "26295", "1.23", "32343.2", "32343.2", "0"]],
            }
        ),
        1,
    )
    fresh = service.get_fresh_klines("BTCUSDT", "1m", provider=provider_ws.PROVIDER_OKX_SPOT, max_age_ms=1000)
    assert fresh is not None
    assert fresh["provider"] == provider_ws.PROVIDER_OKX_SPOT
    assert fresh["items"][-1]["close"] == "26295"
    assert service.get_fresh_klines("BTCUSDT", "1m", provider=provider_ws.PROVIDER_BITGET_SPOT) is None


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


def test_bitget_provider_trades_do_not_create_current_kline_bucket() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service)
    _activate_provider_kline(service, interval="1m")
    open_time = 1_695_709_800_000

    _handle_trades(
        service,
        [
            {"tradeId": "t2", "ts": str(open_time + 2_000), "price": "105", "size": "2", "side": "sell"},
            {"tradeId": "t1", "ts": str(open_time + 1_000), "price": "100", "size": "1", "side": "buy"},
            {"tradeId": "t3", "ts": str(open_time + 3_000), "price": "99", "size": "3", "side": "buy"},
        ],
    )

    assert service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000) is None
    trades = service.get_fresh_trades("BTCUSDT", max_age_ms=1000)
    assert trades is not None
    assert len(trades.trades) == 3


def test_okx_provider_trades_do_not_create_current_kline_bucket() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service, provider=provider_ws.PROVIDER_OKX_SPOT)
    _activate_provider_kline(service, interval="1m", provider=provider_ws.PROVIDER_OKX_SPOT)
    open_time = 1_695_709_800_000

    _handle_okx_trades(
        service,
        [
            {"tradeId": "t1", "ts": str(open_time + 1_000), "px": "100", "sz": "1", "side": "buy"},
            {"tradeId": "t2", "ts": str(open_time + 2_000), "px": "105", "sz": "2", "side": "sell"},
        ],
    )

    assert service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    ) is None
    trades = service.get_fresh_trades(
        "BTCUSDT",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    )
    assert trades is not None
    assert len(trades.trades) == 2


def test_bitget_provider_trade_does_not_change_existing_native_candle() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service)
    _activate_provider_kline(service, interval="1m")
    open_time = 1_695_709_800_000
    _handle_bitget_klines(
        service,
        [[str(open_time), "100", "110", "95", "105", "10", "1025", "1025"]],
    )
    before = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000)
    assert before is not None

    _handle_trades(
        service,
        [{"tradeId": "outside", "ts": str(open_time + 50_000), "price": "999", "size": "7", "side": "buy"}],
    )

    assert service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000) == before


def test_okx_provider_trade_does_not_change_existing_native_candle() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service, provider=provider_ws.PROVIDER_OKX_SPOT)
    _activate_provider_kline(service, interval="1m", provider=provider_ws.PROVIDER_OKX_SPOT)
    open_time = 1_695_709_800_000
    _handle_okx_klines(
        service,
        [[str(open_time), "100", "110", "95", "105", "10", "1025", "1025", "0"]],
    )
    before = service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    )
    assert before is not None

    _handle_okx_trades(
        service,
        [{"tradeId": "outside", "ts": str(open_time + 50_000), "px": "999", "sz": "7", "side": "buy"}],
    )

    assert service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    ) == before


def test_bitget_trade_before_provider_candle_ends_with_exact_native_candle() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service)
    _activate_provider_kline(service, interval="1m")
    open_time = 1_695_709_800_000
    _handle_trades(
        service,
        [{"tradeId": "first", "ts": str(open_time + 50_000), "price": "999", "size": "7", "side": "buy"}],
    )
    assert service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000) is None

    rows = [[str(open_time), "100", "121", "95", "110", "10", "1000", "1000"]]
    expected = provider_ws.normalize_bitget_kline_message(
        {"data": rows},
        local_symbol="BTCUSDT",
        provider_symbol="BTCUSDT",
        interval="1m",
        kline_limit=30,
    )
    assert expected is not None
    _handle_bitget_klines(service, rows)

    fresh = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000)
    assert fresh is not None
    assert fresh["items"] == expected["items"]


def test_okx_trade_before_provider_candle_ends_with_exact_native_candle() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service, provider=provider_ws.PROVIDER_OKX_SPOT)
    _activate_provider_kline(service, interval="1m", provider=provider_ws.PROVIDER_OKX_SPOT)
    open_time = 1_695_709_800_000
    _handle_okx_trades(
        service,
        [{"tradeId": "first", "ts": str(open_time + 50_000), "px": "999", "sz": "7", "side": "buy"}],
    )
    assert service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    ) is None

    rows = [[str(open_time), "100", "121", "95", "110", "10", "1000", "1000", "0"]]
    expected = provider_ws.normalize_okx_kline_message(
        {"data": rows},
        local_symbol="BTCUSDT",
        provider_symbol="BTC-USDT",
        interval="1m",
        kline_limit=30,
    )
    assert expected is not None
    _handle_okx_klines(service, rows)

    fresh = service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    )
    assert fresh is not None
    assert fresh["items"] == expected["items"]


def test_provider_candle_replaces_legacy_trade_derived_same_bucket() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_kline(service, interval="1m")
    earlier_open_time = 1_695_709_740_000
    open_time = 1_695_709_800_000
    service.set_kline_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "interval": "1m",
            "items": [
                {
                    "open_time": earlier_open_time,
                    "close_time": earlier_open_time + 60_000,
                    "open": "80",
                    "high": "90",
                    "low": "70",
                    "close": "85",
                    "volume": "5",
                    "quote_volume": "400",
                    "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
                    "freshness": "LIVE",
                    "provider": provider_ws.PROVIDER_BITGET_SPOT,
                },
                {
                    "open_time": open_time,
                    "close_time": open_time + 60_000,
                    "open": "999",
                    "high": "999",
                    "low": "999",
                    "close": "999",
                    "volume": "7",
                    "quote_volume": "6993",
                    "_first_trade_ts_ms": open_time + 1_000,
                    "_last_trade_ts_ms": open_time + 50_000,
                    "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
                    "freshness": "LIVE",
                    "provider": provider_ws.PROVIDER_BITGET_SPOT,
                },
            ],
        }
    )

    rows = [[str(open_time), "100", "121", "95", "110", "10", "1000", "1000"]]
    expected = provider_ws.normalize_bitget_kline_message(
        {"data": rows},
        local_symbol="BTCUSDT",
        provider_symbol="BTCUSDT",
        interval="1m",
        kline_limit=30,
    )
    assert expected is not None
    _handle_bitget_klines(service, rows)

    fresh = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000)
    assert fresh is not None
    assert [item["open_time"] for item in fresh["items"]] == [earlier_open_time, open_time]
    assert fresh["items"][-1] == expected["items"][0]
    assert "_first_trade_ts_ms" not in fresh["items"][-1]
    assert "_last_trade_ts_ms" not in fresh["items"][-1]


def test_provider_kline_buckets_remain_sorted_and_limited() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_kline(service, interval="1m")
    open_time = 1_695_709_800_000
    rows = [
        [str(open_time + offset), str(price), str(price + 2), str(price - 2), str(price + 1), "1", str(price)]
        for offset, price in ((120_000, 120), (0, 100), (180_000, 130), (60_000, 110))
    ]

    _handle_bitget_klines(service, rows, kline_limit=3)

    fresh = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000, limit=10)
    assert fresh is not None
    assert [item["open_time"] for item in fresh["items"]] == [
        open_time + 60_000,
        open_time + 120_000,
        open_time + 180_000,
    ]
    assert len(fresh["items"]) == 3


def test_provider_switch_isolated_and_late_old_generation_candle_is_dropped() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    open_time = 1_695_709_800_000
    _activate_provider_kline(service, interval="1m", provider=provider_ws.PROVIDER_OKX_SPOT)
    _handle_okx_klines(
        service,
        [[str(open_time), "100", "110", "95", "105", "10", "1025", "1025", "0"]],
    )
    okx_before = service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    )
    assert okx_before is not None

    _activate_provider_kline(service, interval="1m", provider=provider_ws.PROVIDER_BITGET_SPOT)
    _handle_bitget_klines(
        service,
        [[str(open_time), "200", "210", "195", "205", "20", "4050", "4050"]],
    )
    bitget = service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_BITGET_SPOT,
        max_age_ms=1000,
    )
    assert bitget is not None
    assert bitget["items"][-1]["close"] == "205"

    with service._lock:
        service._kline_generations[(provider_ws.PROVIDER_OKX_SPOT, "BTCUSDT", "1m")] = 2
    _handle_okx_klines(
        service,
        [[str(open_time), "900", "910", "895", "905", "90", "81000", "81000", "0"]],
        generation=1,
    )

    assert service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_OKX_SPOT,
        max_age_ms=1000,
    ) == okx_before
    assert service.get_fresh_klines(
        "BTCUSDT",
        "1m",
        provider=provider_ws.PROVIDER_BITGET_SPOT,
        max_age_ms=1000,
    ) == bitget


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


def test_depth_response_does_not_impersonate_received_time_as_provider_event_time() -> None:
    response = provider_ws._depth_response_from_record(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_OKX_SPOT,
            "provider_symbol": "BTC-USDT",
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "freshness": "LIVE",
            "bids": [{"price": "100", "amount": "1"}],
            "asks": [{"price": "101", "amount": "1"}],
            "updated_at_ms": 2000,
        }
    )
    assert response.ts == 0
    assert response.event_time_ms is None
    assert response.received_at_ms == 2000
    assert response.fetched_at == 2000
    assert response.freshness is None


def test_depth_response_exposes_record_event_and_receive_times_without_changing_depth_contract() -> None:
    response = provider_ws._depth_response_from_record(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_OKX_SPOT,
            "provider_symbol": "BTC-USDT",
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "freshness": "LIVE",
            "bids": [{"price": "100", "amount": "1"}],
            "asks": [{"price": "101", "amount": "2"}],
            "ts": 1000,
            "updated_at_ms": 2000,
        }
    )

    assert response.event_time_ms == 1000
    assert response.received_at_ms == 2000
    assert response.ts == 1000
    assert response.fetched_at == 2000
    assert response.provider == provider_ws.PROVIDER_OKX_SPOT
    assert response.source == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert response.freshness is None
    assert [(item.price, item.amount) for item in response.bids] == [("100", "1")]
    assert [(item.price, item.amount) for item in response.asks] == [("101", "2")]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            if inspect.signature(fn).parameters:
                continue
            fn()
    print("spot_market_provider_ws tests passed")
