from __future__ import annotations

import asyncio
import json
import threading

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


def test_okx_trades_do_not_drive_provider_kline_cache() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service, provider=provider_ws.PROVIDER_OKX_SPOT)
    service._apply_provider_trades_to_active_klines_locked = lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("OKX provider trades must not update kline cache")
    )

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


def test_okx_kline_channel_mapping() -> None:
    assert provider_ws.okx_spot_kline_channel("1m") == "candle1m"
    assert provider_ws.okx_spot_kline_channel("5m") == "candle5m"
    assert provider_ws.okx_spot_kline_channel("15m") == "candle15m"
    assert provider_ws.okx_spot_kline_channel("1h") == "candle1H"
    assert provider_ws.okx_spot_kline_channel("4h") == "candle4H"
    assert provider_ws.okx_spot_kline_channel("1d") == "candle1D"


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


def test_provider_trades_drive_current_kline_bucket() -> None:
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

    fresh = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000)
    assert fresh is not None
    item = fresh["items"][-1]
    assert item["open_time"] == open_time
    assert item["close_time"] == open_time + 60_000
    assert item["open"] == "100"
    assert item["high"] == "105"
    assert item["low"] == "99"
    assert item["close"] == "99"
    assert item["volume"] == "6"
    assert item["quote_volume"] == "607"
    assert item["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert item["freshness"] == "LIVE"
    assert item["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert "_last_trade_ts_ms" not in item


def test_provider_trade_kline_dedupe_prevents_duplicate_volume() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service)
    _activate_provider_kline(service, interval="1m")
    open_time = 1_695_709_800_000
    trade = {"tradeId": "t1", "ts": str(open_time + 1_000), "price": "100", "size": "1", "side": "buy"}

    _handle_trades(service, [trade])
    _handle_trades(service, [trade])

    fresh = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000)
    assert fresh is not None
    item = fresh["items"][-1]
    assert item["volume"] == "1"
    assert item["quote_volume"] == "100"


def test_provider_trade_kline_old_trade_does_not_overwrite_new_close() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service)
    _activate_provider_kline(service, interval="1m")
    open_time = 1_695_709_800_000

    _handle_trades(
        service,
        [{"tradeId": "newer", "ts": str(open_time + 5_000), "price": "105", "size": "1", "side": "buy"}],
    )
    _handle_trades(
        service,
        [{"tradeId": "older", "ts": str(open_time + 1_000), "price": "100", "size": "1", "side": "sell"}],
    )

    fresh = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000)
    assert fresh is not None
    item = fresh["items"][-1]
    assert item["open"] == "100"
    assert item["high"] == "105"
    assert item["low"] == "100"
    assert item["close"] == "105"
    assert item["volume"] == "2"
    assert item["quote_volume"] == "205"


def test_provider_candle_does_not_overwrite_more_recent_trade_close() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service)
    _activate_provider_kline(service, interval="1m")
    open_time = 1_695_709_800_000

    _handle_trades(
        service,
        [{"tradeId": "trade-close", "ts": str(open_time + 50_000), "price": "120", "size": "1", "side": "buy"}],
    )

    subscription = provider_ws.SpotKlineSubscription(
        local_symbol="BTCUSDT",
        provider=provider_ws.PROVIDER_BITGET_SPOT,
        provider_symbol="BTCUSDT",
        interval="1m",
        channel=provider_ws.bitget_spot_kline_channel("1m"),
        kline_limit=10,
    )
    service._handle_bitget_kline_message(
        subscription,
        json.dumps(
            {
                "arg": {"instType": "SPOT", "channel": "candle1m", "instId": "BTCUSDT"},
                "action": "update",
                "data": [[str(open_time), "100", "121", "95", "110", "10", "1000", "1000"]],
            }
        ),
        1,
    )

    fresh = service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000)
    assert fresh is not None
    item = fresh["items"][-1]
    assert item["open"] == "100"
    assert item["high"] == "121"
    assert item["low"] == "95"
    assert item["close"] == "120"
    assert item["volume"] == "10"
    assert item["quote_volume"] == "1000"


def test_provider_trades_do_not_build_kline_without_active_interval() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    _activate_provider_trades(service)
    open_time = 1_695_709_800_000

    _handle_trades(
        service,
        [{"tradeId": "t1", "ts": str(open_time + 1_000), "price": "100", "size": "1", "side": "buy"}],
    )

    assert service.get_fresh_klines("BTCUSDT", "1m", max_age_ms=1000) is None


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
