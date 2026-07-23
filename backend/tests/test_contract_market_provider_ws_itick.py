from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path
from decimal import Decimal
import time

import pytest


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def _load_provider_ws_module():
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))

    overridden_module_names = (
        "app.core.config",
        "app.services.contract_market_provider_service",
        "websockets",
        "sqlalchemy",
        "sqlalchemy.orm",
        "app.db.models.contract_symbol",
    )
    previous_modules = {
        name: sys.modules.get(name)
        for name in overridden_module_names
    }

    config_module = types.ModuleType("app.core.config")

    class SettingsStub:
        CONTRACT_PROVIDER_WS_ENABLED = True
        CONTRACT_PROVIDER_WS_DEPTH_ENABLED = True
        CONTRACT_PROVIDER_WS_TICKER_ENABLED = True
        CONTRACT_PROVIDER_WS_KLINE_ENABLED = True
        CONTRACT_PROVIDER_WS_TRADES_ENABLED = True
        CONTRACT_PROVIDER_WS_KLINE_MAX_AGE_MS = 1500
        CONTRACT_PROVIDER_WS_ITICK_KLINE_MAX_AGE_MS = 90000
        CONTRACT_PROVIDER_WS_ITICK_KLINE_BROADCAST_INTERVAL_MS = 1000
        CONTRACT_PROVIDER_WS_ITICK_URL = "wss://api.itick.org"
        CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL = "wss://ws.okx.com:8443/ws/v5/public"
        CONTRACT_PROVIDER_WS_OKX_BUSINESS_URL = "wss://ws.okx.com:8443/ws/v5/business"
        ITICK_API_TOKEN = "test-token"
        ITICK_API_KEY = None

    config_module.settings = SettingsStub()
    sys.modules["app.core.config"] = config_module

    provider_service_module = types.ModuleType("app.services.contract_market_provider_service")
    provider_service_module.PROVIDER_BITGET_USDT_FUTURES = "BITGET_USDT_FUTURES"
    provider_service_module.PROVIDER_OKX_SWAP = "OKX_SWAP"
    provider_service_module.enabled_contract_market_providers = lambda db: ()
    provider_service_module.is_contract_market_provider_in_cooldown = lambda provider_code: False
    provider_service_module.resolve_contract_provider_symbol = lambda db, provider_code, local_symbol: local_symbol
    sys.modules["app.services.contract_market_provider_service"] = provider_service_module

    websockets_module = types.ModuleType("websockets")
    websockets_module.connect = lambda *args, **kwargs: None
    sys.modules["websockets"] = websockets_module

    sqlalchemy_module = types.ModuleType("sqlalchemy")
    sqlalchemy_orm_module = types.ModuleType("sqlalchemy.orm")
    sqlalchemy_orm_module.Session = object
    sys.modules["sqlalchemy"] = sqlalchemy_module
    sys.modules["sqlalchemy.orm"] = sqlalchemy_orm_module

    contract_symbol_module = types.ModuleType("app.db.models.contract_symbol")

    class ContractSymbolStub:
        symbol = "symbol"
        status = "status"

    contract_symbol_module.ContractSymbol = ContractSymbolStub
    sys.modules["app.db.models.contract_symbol"] = contract_symbol_module

    module_path = BACKEND / "app" / "services" / "contract_market_provider_ws.py"
    spec = importlib.util.spec_from_file_location("provider_ws_itick_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        for name, previous in previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
    return module


def test_itick_quote_subscription_symbol_by_category():
    module = _load_provider_ws_module()

    assert module._normalize_interval("1m") == "1m"
    assert module._normalize_interval("1M") == "1M"
    assert module._itick_quote_subscription_symbol("AAPL", "STOCK") == "AAPL$US"
    assert module._itick_quote_subscription_symbol("SPX", "INDEX") == "SPX$GB"
    assert module._itick_quote_subscription_symbol("SPX$GB", "INDEX") == "SPX$GB"
    assert module._itick_quote_subscription_symbol("XAUUSD", "GOLD") == "XAUUSD$GB"
    assert module._itick_quote_subscription_symbol("USOIL", "FUTURES") == "USOIL$GB"
    assert module._itick_ws_url_for_category("wss://api.itick.org", "STOCK") == "wss://api.itick.org/stock"
    assert module._itick_ws_url_for_category("wss://api.itick.org", "FOREX") == "wss://api.itick.org/forex"
    assert module._itick_ws_url_for_category("wss://api.itick.org", "INDEX") == "wss://api.itick.org/indices"
    assert module._itick_ws_url_for_category("wss://api.itick.org", "UNKNOWN") == "wss://api.itick.org/future"
    assert module._itick_kline_channel("1m") == "kline@1"
    assert module._itick_kline_channel("5m") is None
    assert module._okx_kline_channel("1M") is None


def test_itick_ticker_normalizer_uses_quote_fields_and_live_source():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="XAUUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="XAUUSD",
        ws_symbol="XAUUSD",
    )

    payload = service._normalize_itick_ticker(
        subscription,
        {
            "s": "XAUUSD",
            "ld": "2365.12",
            "o": "2400",
            "change": "-34.88",
            "rate": "-1.4533333333",
            "bp": "2365.00",
            "ap": "2365.24",
            "t": 1717000000000,
            "market_status": "OPEN",
        },
    )

    assert payload is not None
    assert payload["provider"] == "ITICK"
    assert payload["provider_symbol"] == "XAUUSD"
    assert payload["bid_price"] == Decimal("2365.00")
    assert payload["ask_price"] == Decimal("2365.24")
    assert payload["last_price"] == Decimal("2365.12")
    assert payload["mark_price"] == Decimal("2365.12")
    assert payload["open_24h"] == Decimal("2400")
    assert payload["price_change_24h"] == Decimal("-34.88")
    assert payload["price_change_percent_24h"] == Decimal("-1.453333333333333333333333333")
    assert payload["source"] == "LIVE_WS"
    assert payload["quote_source"] == "LIVE_WS"
    assert payload["is_realtime"] is True
    assert payload["market_status"] == "OPEN"


def test_itick_ticker_normalizer_uses_official_event_time_and_native_status():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="NAS100USDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="NAS100",
        ws_symbol="NAS100$GB",
    )

    payload = service._normalize_itick_ticker(
        subscription,
        {
            "s": "NAS100",
            "ld": "28825.34",
            "t": 1_784_621_729_000,
            "ts": 0,
        },
    )

    assert payload is not None
    assert payload["provider_trading_status"] == 0
    assert payload["provider_market_status"] == "OPEN"
    assert payload["market_status"] == "OPEN"
    assert payload["exchange_ts"] == 1_784_621_729_000
    assert int(payload["ts"].timestamp() * 1000) == 1_784_621_729_000


@pytest.mark.parametrize("provider_status", [1, 2, 3])
def test_itick_ticker_normalizer_maps_non_normal_native_status_to_closed(provider_status):
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="EURUSD",
        ws_symbol="EURUSD$GB",
    )

    payload = service._normalize_itick_ticker(
        subscription,
        {"ld": "1.14182", "t": 1_784_621_729_000, "ts": provider_status},
    )

    assert payload is not None
    assert payload["provider_trading_status"] == provider_status
    assert payload["provider_market_status"] == "CLOSED"
    assert payload["market_status"] == "CLOSED"


def test_itick_shared_ticker_registration_routes_without_starting_legacy_symbol_thread():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    notified = []
    service._itick_transport.notify = lambda market: notified.append(market)

    service.ensure_ticker_subscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="EURUSD",
        ws_symbol="EURUSD$GB",
        ws_url="wss://api.itick.org/forex",
    )

    assert service._ticker_tasks == {}
    assert service._itick_router.registered_count() == 1
    assert service._itick_plan.market_plan("forex").symbols_for("quote") == ("EURUSD$GB",)
    assert notified == ["forex"]

    dispatched = service._itick_router.dispatch(
        "forex",
        '{"code":1,"data":{"s":"EURUSD","type":"quote","ld":1.1429,"p":1.1428,"t":1717000000000}}',
    )
    assert dispatched == 1
    assert service._ticker_cache[(module.PROVIDER_ITICK, "EURUSD_PERP")]["source"] == "LIVE_WS"

    service.stop_ticker_subscription(local_symbol="EURUSD_PERP", provider=module.PROVIDER_ITICK)
    assert service._itick_router.registered_count() == 0
    assert service._itick_plan.market_plan("forex").symbols_for("quote") == ()
    assert notified == ["forex", "forex"]


def test_itick_shared_kline_registration_owns_stable_generation_and_routes_it():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    notified = []
    service._itick_transport.notify = lambda market: notified.append(market)
    key = (module.PROVIDER_ITICK, "EURUSD_PERP", "1m")

    ensure_args = {
        "local_symbol": "EURUSD_PERP",
        "provider": module.PROVIDER_ITICK,
        "provider_symbol": "EURUSD",
        "interval": "1m",
        "ws_symbol": "EURUSD$GB",
        "ws_url": "wss://api.itick.org/forex",
    }
    service.ensure_kline_subscription(**ensure_args)
    generation = service.get_kline_generation("EURUSD_PERP", "1m", provider=module.PROVIDER_ITICK)
    service.ensure_kline_subscription(**ensure_args)

    assert generation == 1
    assert service._kline_generations[key] == generation
    assert notified == ["forex", "forex"]
    assert service._itick_router.dispatch(
        "forex",
        '{"o":1.14025,"h":1.14029,"l":1.14021,"c":1.14024,"v":291.8,"tu":332.725565,"t":1782889500000,"s":"eurusd","type":"kline@1"}',
    ) == 1
    assert service._kline_cache[key]["provider_generation"] == generation

    service.stop_kline_subscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        interval="1m",
    )
    assert service._kline_generations[key] == generation + 1


def test_stop_all_clears_shared_itick_routes_and_logical_subscriptions():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    service._itick_transport.notify = lambda _market: None
    stopped = []
    service._itick_transport.stop_all = lambda: stopped.append(True)

    service.ensure_ticker_subscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="EURUSD",
        ws_symbol="EURUSD$GB",
        ws_url="wss://api.itick.org/forex",
    )
    service.ensure_kline_subscription(
        local_symbol="XAUUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="XAUUSD",
        interval="1m",
        ws_symbol="XAUUSD$GB",
        ws_url="wss://api.itick.org/forex",
    )

    service.stop_all()

    assert stopped == [True]
    assert service._itick_registrations == {}
    assert service._itick_router.registered_count() == 0
    assert service._itick_plan.active_markets() == frozenset()


def test_okx_ticker_normalizer_emits_complete_change_evidence():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="BTCUSDT_PERP",
        provider="OKX_SWAP",
        provider_symbol="BTC-USDT-SWAP",
    )

    payload = service._normalize_okx_ticker(
        subscription,
        {
            "bidPx": "104.9",
            "askPx": "105.1",
            "last": "105",
            "open24h": "100",
            "high24h": "110",
            "low24h": "90",
            "vol24h": "12",
            "volCcy24h": "1260",
            "ts": "1717000000000",
        },
    )

    assert payload is not None
    assert payload["open_24h"] == Decimal("100")
    assert payload["price_change_24h"] == Decimal("5")
    assert payload["price_change_percent_24h"] == Decimal("5.00")


def test_itick_ticker_normalizer_does_not_synthesize_executable_bbo_from_last_price():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="AAPLUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="AAPL",
        ws_symbol="AAPL",
    )

    payload = service._normalize_itick_ticker(subscription, {"ld": "200", "t": 1717000000})

    assert payload is not None
    assert payload["bid_price"] is None
    assert payload["ask_price"] is None
    assert payload["last_price"] == Decimal("200")
    assert payload["mark_price"] == Decimal("200")
    assert "executable" not in payload


def test_itick_ticker_normalizer_replaces_missing_provider_time_with_normalized_time(monkeypatch):
    module = _load_provider_ws_module()
    monkeypatch.setattr(module.time, "time", lambda: 1_720_000_000.123)
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="EURUSD",
        ws_symbol="EURUSD$GB",
    )

    payload = service._normalize_itick_ticker(subscription, {"ld": "1.14250", "t": 0})

    assert payload is not None
    assert payload["exchange_ts"] == 1_720_000_000_123
    assert int(payload["ts"].timestamp() * 1000) == 1_720_000_000_123


def test_itick_ticker_normalizer_keeps_latest_price_and_previous_close_distinct():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="AAPLUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="AAPL",
        ws_symbol="AAPL",
    )

    payload = service._normalize_itick_ticker(
        subscription,
        {
            "ld": "202.50",
            "p": "200.00",
            "t": 1_717_000_000_000,
        },
    )

    assert payload is not None
    assert payload["last_price"] == Decimal("202.50")
    assert payload["price_field"] == "ld"
    assert payload["open_24h"] == Decimal("200.00")
    assert payload["price_change_24h"] == Decimal("2.50")
    assert payload["price_change_percent_24h"] == Decimal("1.2500")


def test_itick_ticker_normalizer_does_not_promote_previous_close_to_latest_price():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="AAPLUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="AAPL",
        ws_symbol="AAPL",
    )

    assert service._normalize_itick_ticker(
        subscription,
        {"p": "200.00", "t": 1_717_000_000_000},
    ) is None


def test_itick_kline_subscription_resolver_uses_category_endpoint_and_kline_type():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()

    class Contract:
        symbol = "XAUUSDT_PERP"
        status = 1
        provider = "ITICK"
        provider_symbol = "XAUUSD"
        category = "METAL"

    class Query:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return Contract()

    class Db:
        def query(self, _model):
            return Query()

    subscription = service._itick_kline_subscription_for_symbol(Db(), "XAUUSDT_PERP", "1m")

    assert subscription is not None
    assert subscription.provider == module.PROVIDER_ITICK
    assert subscription.provider_symbol == "XAUUSD"
    assert subscription.ws_symbol == "XAUUSD$GB"
    assert subscription.ws_url == "wss://api.itick.org/forex"
    assert subscription.channel == "kline@1"


def test_itick_trades_subscription_resolver_uses_stock_tick_endpoint():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()

    class Contract:
        symbol = "AAPLUSDT_PERP"
        status = 1
        provider = "ITICK"
        provider_symbol = "AAPL"
        category = "STOCK"

    class Query:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return Contract()

    class Db:
        def query(self, _model):
            return Query()

    subscription = service._itick_trades_subscription_for_symbol(Db(), "AAPLUSDT_PERP")

    assert subscription is not None
    assert subscription.provider == module.PROVIDER_ITICK
    assert subscription.provider_symbol == "AAPL"
    assert subscription.ws_symbol == "AAPL$US"
    assert subscription.ws_url == "wss://api.itick.org/stock"


def test_itick_cfd_depth_and_tick_resolvers_use_shared_forex_endpoint():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()

    class Contract:
        symbol = "EURUSD_PERP"
        status = 1
        provider = "ITICK"
        provider_symbol = "EURUSD"
        category = "FOREX"

    class Query:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return Contract()

    class Db:
        def query(self, _model):
            return Query()

    depth = service._itick_depth_subscription_for_symbol(Db(), "EURUSD_PERP")
    trades = service._itick_trades_subscription_for_symbol(Db(), "EURUSD_PERP")

    assert depth is not None and trades is not None
    assert depth.ws_symbol == "EURUSD$GB"
    assert trades.ws_symbol == "EURUSD$GB"
    assert depth.ws_url == trades.ws_url == "wss://api.itick.org/forex"


def test_itick_one_level_depth_is_truthfully_cached_as_bbo_only():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderDepthSubscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="EURUSD",
        depth_limit=20,
        ws_symbol="EURUSD$GB",
    )

    service._handle_itick_depth_message(
        subscription,
        '{"code":1,"data":{"s":"EURUSD","type":"depth","t":1717000000000,"a":[{"p":1.143,"v":0,"o":1}],"b":[{"p":1.1428,"v":0,"o":1}]}}',
    )

    payload = service._depth_cache[(module.PROVIDER_ITICK, "EURUSD_PERP")]
    assert payload["depth_mode"] == "BBO_ONLY"
    assert len(payload["asks"]) == len(payload["bids"]) == 1
    assert payload["asks"][0][1] == Decimal("0")
    assert payload["bids"][0][1] == Decimal("0")


def test_itick_stock_multi_level_depth_preserves_provider_levels():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderDepthSubscription(
        local_symbol="AAPLUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="AAPL",
        depth_limit=20,
        ws_symbol="AAPL$US",
        ws_url="wss://api.itick.org/stock",
    )
    asks = [{"po": level, "p": 330 + level / 100, "v": level * 10, "o": level} for level in range(1, 11)]
    bids = [{"po": level, "p": 330 - level / 100, "v": level * 10, "o": level} for level in range(1, 11)]

    service._handle_itick_depth_message(
        subscription,
        json.dumps({"code": 1, "data": {"s": "AAPL", "type": "depth", "a": asks, "b": bids}}),
    )

    payload = service._depth_cache[(module.PROVIDER_ITICK, "AAPLUSDT_PERP")]
    assert payload["depth_mode"] == "FULL_DEPTH"
    assert len(payload["asks"]) == len(payload["bids"]) == 10
    assert payload["best_bid"] == Decimal("329.99")
    assert payload["best_ask"] == Decimal("330.01")


def test_itick_trade_normalizer_marks_live_trade_tick_source():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTradesSubscription(
        local_symbol="AAPLUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="AAPL",
        trades_limit=30,
        ws_symbol="AAPL$US",
        ws_url="wss://api.itick.org/stock",
    )

    payload = service._normalize_itick_trade(
        subscription,
        {"ld": "213.55", "v": "100", "t": 1782889680000, "d": "2", "s": "AAPL", "r": "US"},
    )

    assert payload is not None
    assert payload["provider"] == "ITICK"
    assert payload["provider_symbol"] == "AAPL"
    assert payload["ws_symbol"] == "AAPL$US"
    assert payload["price_field"] == "ld"
    assert payload["price"] == "213.55"
    assert payload["qty"] == "100"
    assert payload["source"] == "LIVE_WS"
    assert payload["quote_source"] == "LIVE_WS"
    assert payload["price_source"] == "TRADE_TICK"
    assert payload["side"] == "BUY"


def test_okx_trade_normalizer_marks_live_trade_tick_source():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTradesSubscription(
        local_symbol="BTCUSDT_PERP",
        provider="OKX_SWAP",
        provider_symbol="BTC-USDT-SWAP",
        trades_limit=30,
    )

    payload = service._normalize_okx_trade(
        subscription,
        {
            "tradeId": "trade-1",
            "px": "60000.5",
            "sz": "0.01",
            "ts": "1720000000000",
            "side": "sell",
        },
    )

    assert payload is not None
    assert payload["provider"] == "OKX_SWAP"
    assert payload["provider_symbol"] == "BTC-USDT-SWAP"
    assert payload["source"] == "LIVE_WS"
    assert payload["quote_freshness"] == "LIVE"
    assert payload["price_source"] == "TRADE_TICK"
    assert payload["side"] == "SELL"


def test_itick_kline_normalizer_maps_verified_payload_without_millisecond_double_multiply():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderKlineSubscription(
        local_symbol="XAUUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="XAUUSD",
        interval="1m",
        channel="kline@1",
        ws_symbol="XAUUSD$GB",
        ws_url="wss://api.itick.org/forex",
    )

    payload = service._normalize_itick_kline(
        subscription,
        {
            "o": 3961.812,
            "h": 3963.242,
            "l": 3960.435,
            "c": 3961.81,
            "v": 1860.4,
            "tu": 7370551.6574,
            "t": 1782889680000,
            "s": "xauusd",
            "type": "kline@1",
        },
    )

    assert payload is not None
    assert payload["provider"] == "ITICK"
    assert payload["provider_symbol"] == "XAUUSD"
    assert payload["open_time_ms"] == 1782889680000
    assert payload["open_time"] == 1782889680000
    assert payload["time"] == 1782889680
    assert payload["open"] == "3961.812"
    assert payload["high"] == "3963.242"
    assert payload["low"] == "3960.435"
    assert payload["close"] == "3961.81"
    assert payload["volume"] == "1860.4"
    assert payload["quote_volume"] == "7370551.6574"
    assert payload["turnover"] == "7370551.6574"
    assert payload["source"] == "LIVE_WS"
    assert payload["quote_source"] == "LIVE_WS"
    assert payload["is_final"] is False


def test_itick_kline_handler_writes_existing_kline_cache_shape():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderKlineSubscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="EURUSD",
        interval="1m",
        channel="kline@1",
        ws_symbol="EURUSD$GB",
    )

    service._handle_itick_kline_message(
        subscription,
        '{"o":1.14025,"h":1.14029,"l":1.14021,"c":1.14024,"v":291.8,"tu":332.725565,"t":1782889500000,"s":"eurusd","type":"kline@1"}',
    )

    cached = service.get_fresh_provider_ws_kline("EURUSD_PERP", "1m", "ITICK", max_age_ms=90000)
    assert cached is not None
    assert cached["close"] == "1.14024"
    assert cached["volume"] == "291.8"
    assert cached["quote_volume"] == "332.725565"


def test_itick_kline_freshness_uses_itick_max_age_in_provider_selection():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()

    class Contract:
        symbol = "EURUSD_PERP"
        status = 1
        provider = "ITICK"
        provider_symbol = "EURUSD"
        category = "FOREX"

    class Query:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return Contract()

    class Db:
        def query(self, _model):
            return Query()

    service._kline_cache[(module.PROVIDER_ITICK, "EURUSD_PERP", "1m")] = {
        "symbol": "EURUSD_PERP",
        "provider": module.PROVIDER_ITICK,
        "close": "1.14024",
        "updated_at_ms": int(time.time() * 1000) - 60_000,
    }

    assert service.get_fresh_provider_ws_kline("EURUSD_PERP", "1m", "ITICK") is None
    selected = service.select_fresh_kline_for_enabled_providers(Db(), "EURUSD_PERP", "1m")
    assert selected is not None
    assert selected["close"] == "1.14024"


def test_itick_event_driven_depth_stays_live_while_shared_transport_is_live(monkeypatch):
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    now_ms = 1_720_000_010_000
    monkeypatch.setattr(module.time, "time", lambda: now_ms / 1000)
    monkeypatch.setattr(
        service._itick_transport,
        "market_state",
        lambda _market: {
            "connected": True,
            "connection_generation": 7,
            "last_message_at_ms": now_ms - 250,
        },
    )
    key = (module.PROVIDER_ITICK, "EURUSD_PERP")
    service._depth_cache[key] = {
        "symbol": "EURUSD_PERP",
        "provider": module.PROVIDER_ITICK,
        "bids": [["1.14190", "1"]],
        "asks": [["1.14205", "1"]],
        "updated_at_ms": now_ms - 2_000,
        "itick_market": "forex",
        "transport_generation": 7,
    }

    assert service.get_fresh_provider_ws_depth(
        "EURUSD_PERP",
        module.PROVIDER_ITICK,
        max_age_ms=1_500,
    ) is not None

    service._depth_cache[key]["received_at_ms"] = now_ms - 5_001
    service._depth_cache[key]["updated_at_ms"] = now_ms - 5_001
    freshened = service.get_fresh_provider_ws_depth(
        "EURUSD_PERP",
        module.PROVIDER_ITICK,
        max_age_ms=1_500,
    )
    assert freshened is not None
    assert freshened["depth_frame_received_at_ms"] == now_ms - 5_001
    assert freshened["received_at_ms"] == now_ms - 250
    assert freshened["freshness_basis"] == "TRANSPORT_LIVENESS"


def test_itick_event_driven_depth_fails_closed_when_transport_is_not_live(monkeypatch):
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    now_ms = 1_720_000_010_000
    monkeypatch.setattr(module.time, "time", lambda: now_ms / 1000)
    key = (module.PROVIDER_ITICK, "EURUSD_PERP")
    service._depth_cache[key] = {
        "symbol": "EURUSD_PERP",
        "provider": module.PROVIDER_ITICK,
        "bids": [["1.14190", "1"]],
        "asks": [["1.14205", "1"]],
        "updated_at_ms": now_ms - 5_001,
        "itick_market": "forex",
        "transport_generation": 7,
    }

    states = (
        {
            "connected": False,
            "connection_generation": 7,
            "last_message_at_ms": now_ms - 250,
        },
        {
            "connected": True,
            "connection_generation": 8,
            "last_message_at_ms": now_ms - 250,
        },
        {
            "connected": True,
            "connection_generation": 7,
            "last_message_at_ms": now_ms - module.ITICK_SHARED_TRANSPORT_MAX_IDLE_MS - 1,
        },
    )
    for state in states:
        monkeypatch.setattr(
            service._itick_transport,
            "market_state",
            lambda _market, current=state: current,
        )
        assert service.get_fresh_provider_ws_depth(
            "EURUSD_PERP",
            module.PROVIDER_ITICK,
            max_age_ms=1_500,
        ) is None


def test_itick_depth_cache_records_shared_transport_generation(monkeypatch):
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    key = (module.PROVIDER_ITICK, "EURUSD_PERP")
    service._depth_generations[key] = 11
    monkeypatch.setattr(
        service._itick_transport,
        "market_state",
        lambda market: {
            "connected": True,
            "connection_generation": 4,
            "last_message_at_ms": 1_720_000_010_000,
            "market": market,
        },
    )
    subscription = module.ProviderDepthSubscription(
        local_symbol="EURUSD_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="EURUSD",
        depth_limit=20,
        ws_symbol="EURUSD$GB",
        ws_url="wss://api.itick.org/forex",
    )

    service._set_depth_cache(
        subscription,
        bids={"1.14190": module.Decimal("1")},
        asks={"1.14205": module.Decimal("1")},
        generation=11,
    )

    assert service._depth_cache[key]["itick_market"] == "forex"
    assert service._depth_cache[key]["transport_generation"] == 4


def test_non_itick_depth_keeps_requested_freshness_limit(monkeypatch):
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    now_ms = 1_720_000_010_000
    monkeypatch.setattr(module.time, "time", lambda: now_ms / 1000)
    service._depth_cache[(module.PROVIDER_OKX_SWAP, "BTCUSDT_PERP")] = {
        "symbol": "BTCUSDT_PERP",
        "provider": module.PROVIDER_OKX_SWAP,
        "bids": [["66000", "1"]],
        "asks": [["66001", "1"]],
        "updated_at_ms": now_ms - 2_000,
    }

    assert service.get_fresh_provider_ws_depth(
        "BTCUSDT_PERP",
        module.PROVIDER_OKX_SWAP,
        max_age_ms=1_500,
    ) is None


def test_okx_kline_channel_and_normalizer_still_work():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderKlineSubscription(
        local_symbol="BTCUSDT_PERP",
        provider=module.PROVIDER_OKX_SWAP,
        provider_symbol="BTC-USDT-SWAP",
        interval="1m",
        channel=module._okx_kline_channel("1m"),
    )

    payload = service._normalize_okx_kline(
        subscription,
        ["1717000000000", "68000", "68100", "67900", "68050", "12.5", "0", "850625", "1"],
    )

    assert subscription.channel == "candle1m"
    assert payload is not None
    assert payload["provider"] == module.PROVIDER_OKX_SWAP
    assert payload["open_time_ms"] == 1717000000000
    assert payload["quote_volume"] == "850625"
    assert payload["is_final"] is True


def test_okx_trades_channel_uses_public_websocket_endpoint():
    module = _load_provider_ws_module()

    assert module._okx_trades_ws_url() == "wss://ws.okx.com:8443/ws/v5/public"


def test_recoverable_provider_disconnect_is_throttled_without_traceback(caplog):
    module = _load_provider_ws_module()
    module._PROVIDER_WS_DISCONNECT_LOG_LAST_AT.clear()
    subscription = module.ProviderKlineSubscription(
        local_symbol="BTCUSDT_PERP",
        provider=module.PROVIDER_OKX_SWAP,
        provider_symbol="BTC-USDT-SWAP",
        interval="1m",
        channel="candle1m",
    )

    with caplog.at_level("WARNING"):
        module._log_provider_ws_disconnected(
            "kline",
            subscription,
            ConnectionResetError("peer reset"),
            retry_in=1.0,
        )
        module._log_provider_ws_disconnected(
            "kline",
            subscription,
            ConnectionResetError("peer reset again"),
            retry_in=2.0,
        )

    records = [
        record
        for record in caplog.records
        if "contract_provider_ws_kline_disconnected" in record.getMessage()
    ]
    assert len(records) == 1
    assert "reason=ConnectionResetError" in records[0].getMessage()
    assert "retry_in=1.0s" in records[0].getMessage()
    assert records[0].exc_info is None


def test_kline_cache_notifies_only_the_current_provider_generation():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderKlineSubscription(
        local_symbol="BTCUSDT_PERP",
        provider=module.PROVIDER_OKX_SWAP,
        provider_symbol="BTC-USDT-SWAP",
        interval="1m",
        channel="candle1m",
    )
    key = (module.PROVIDER_OKX_SWAP, "BTCUSDT_PERP", "1m")
    service._kline_generations[key] = 3
    accepted = []
    service.set_kline_revision_listener(accepted.append)
    payload = {
        "symbol": "BTCUSDT_PERP",
        "provider": module.PROVIDER_OKX_SWAP,
        "provider_symbol": "BTC-USDT-SWAP",
        "interval": "1m",
        "open_time": 1_720_000_020_000,
        "open": "100",
        "high": "102",
        "low": "99",
        "close": "101",
        "volume": "50",
        "quote_volume": "5050",
        "is_closed": False,
    }

    service._set_kline_cache(subscription, payload, generation=2)
    assert accepted == []
    service._set_kline_cache(subscription, payload, generation=3)

    assert len(accepted) == 1
    assert accepted[0].provider == module.PROVIDER_OKX_SWAP
    assert accepted[0].symbol == "BTCUSDT_PERP"
    assert accepted[0].interval == "1m"
    assert accepted[0].generation == 3
    assert accepted[0].open_time == 1_720_000_020_000
    assert accepted[0].revision == (3, 1)
    assert service.get_kline_generation(
        "BTCUSDT_PERP",
        "1m",
        provider=module.PROVIDER_OKX_SWAP,
    ) == 3


def test_force_stop_symbol_releases_shared_itick_routes_plan_and_caches():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    service._itick_transport.notify = lambda _market: None
    local_symbol = "EURUSD_PERP"
    market = "forex"
    provider_symbol = "EURUSD"

    for stream in ("depth", "tick", "quote", "kline@1"):
        interval = "1m" if stream == "kline@1" else ""
        key = (stream, local_symbol, interval)
        consumer_id = ":".join(part for part in key if part)
        service._itick_router.register(
            market=market,
            provider_symbol=provider_symbol,
            stream=stream,
            consumer_id=consumer_id,
            handler=lambda _raw: None,
        )
        service._itick_plan.acquire(market=market, symbol=provider_symbol, stream=stream)
        service._itick_registrations[key] = (market, provider_symbol, consumer_id)

    service._depth_cache[(module.PROVIDER_ITICK, local_symbol)] = {"value": 1}
    service._trades_cache[(module.PROVIDER_ITICK, local_symbol)] = {"value": 1}
    service._ticker_cache[(module.PROVIDER_ITICK, local_symbol)] = {"value": 1}
    service._kline_cache[(module.PROVIDER_ITICK, local_symbol, "1m")] = {"value": 1}

    report = service.force_stop_depth_subscriptions_for_symbol(local_symbol)

    assert report["shared_registration_count"] == 4
    assert service._itick_registrations == {}
    assert service._itick_plan.market_plan(market).symbols_by_stream == ()
    assert service._depth_cache == {}
    assert service._trades_cache == {}
    assert service._ticker_cache == {}
    assert service._kline_cache == {}


def _load_gateway_module(provider_payload):
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())

    overridden_module_names = (
        "app.core.config",
        "app.db.session",
        "app.schemas.contract_market",
        "app.services.contract_market_service",
        "app.services.contract_market_ws",
        "app.services.contract_market_provider_ws",
    )
    previous_modules = {
        name: sys.modules.get(name)
        for name in overridden_module_names
    }

    config_module = types.ModuleType("app.core.config")

    class SettingsStub:
        CONTRACT_PROVIDER_WS_KLINE_MAX_AGE_MS = 1500
        CONTRACT_PROVIDER_WS_ITICK_KLINE_BROADCAST_INTERVAL_MS = 1000

    config_module.settings = SettingsStub()
    sys.modules["app.core.config"] = config_module

    db_session_module = types.ModuleType("app.db.session")
    db_session_module.SessionLocal = lambda: object()
    sys.modules["app.db.session"] = db_session_module

    schemas_module = types.ModuleType("app.schemas.contract_market")
    schemas_module.ContractDepthResponse = object
    schemas_module.ContractMarketViewDetail = object
    schemas_module.ContractQuoteResponse = object
    sys.modules["app.schemas.contract_market"] = schemas_module

    service_module = types.ModuleType("app.services.contract_market_service")
    service_module.ContractMarketError = RuntimeError
    service_module.ContractSymbolNotFound = LookupError
    service_module._contract_depth_with_status = lambda *args, **kwargs: None
    service_module._quote_from_depth = lambda *args, **kwargs: {}
    service_module._contract_quote_with_status = lambda *args, **kwargs: None
    service_module._load_contract_symbol = lambda *args, **kwargs: None
    service_module._market_status_for_contract_symbol = lambda *args, **kwargs: None
    service_module.contract_depth_to_response = lambda item: item
    service_module.contract_quote_to_response = lambda item: item
    service_module.get_contract_depth = lambda *args, **kwargs: {}
    service_module.get_contract_quote = lambda *args, **kwargs: {}
    service_module.get_contract_recent_trades = lambda *args, **kwargs: []
    service_module.get_contract_klines = lambda *args, **kwargs: [
        {
            "symbol": kwargs.get("symbol"),
            "open_time": 1717000000000,
            "open": "1",
            "high": "2",
            "low": "0.5",
            "close": "1.5",
            "volume": "10",
            "source": "REST",
        }
    ]
    sys.modules["app.services.contract_market_service"] = service_module

    ws_module = types.ModuleType("app.services.contract_market_ws")
    ws_module.contract_market_ws_manager = object()
    ws_module.normalize_contract_ws_interval = lambda value: (
        "1M"
        if str(value or "1m").strip() == "1M"
        else str(value or "1m").strip().lower() or "1m"
    )
    ws_module.normalize_contract_ws_symbol = lambda value: str(value or "").strip().upper()
    sys.modules["app.services.contract_market_ws"] = ws_module

    provider_ws_module = types.ModuleType("app.services.contract_market_provider_ws")
    calls = []
    provider_ws_module.ContractProviderKlineRevisionAccepted = type(
        "ContractProviderKlineRevisionAccepted",
        (),
        {},
    )
    provider_ws_module.force_stop_provider_ws_subscriptions_for_symbol = lambda symbol: {}
    provider_ws_module.get_contract_provider_ws_kline_generation = lambda *args, **kwargs: 0
    provider_ws_module.provider_ws_depth_enabled = lambda: False
    provider_ws_module.provider_ws_kline_enabled = lambda: True
    provider_ws_module.provider_ws_ticker_enabled = lambda: False
    provider_ws_module.provider_ws_trades_enabled = lambda: False

    def select_fresh_provider_ws_kline(*args, **kwargs):
        calls.append(kwargs)
        return provider_payload

    provider_ws_module.select_fresh_provider_ws_depth = lambda *args, **kwargs: None
    provider_ws_module.select_fresh_provider_ws_kline = select_fresh_provider_ws_kline
    provider_ws_module.select_fresh_provider_ws_ticker = lambda *args, **kwargs: None
    provider_ws_module.select_fresh_provider_ws_trades = lambda *args, **kwargs: None
    provider_ws_module.set_contract_provider_ws_kline_revision_listener = lambda listener: None
    sys.modules["app.services.contract_market_provider_ws"] = provider_ws_module

    module_path = BACKEND / "app" / "services" / "contract_market_gateway.py"
    spec = importlib.util.spec_from_file_location("contract_market_gateway_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        for name, previous in previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
    module._provider_ws_calls = calls
    return module


def test_gateway_kline_prefers_provider_ws_and_delegates_provider_specific_max_age():
    live_payload = {
        "symbol": "EURUSD_PERP",
        "open_time": 1782889500000,
        "open": "1.14025",
        "high": "1.14029",
        "low": "1.14021",
        "close": "1.14024",
        "volume": "291.8",
        "source": "LIVE_WS",
    }
    module = _load_gateway_module(live_payload)
    gateway = module.ContractMarketGateway()

    payload = gateway._load_kline_payload(
        object(),
        "EURUSD_PERP",
        interval="1m",
        allow_provider_ws=True,
        ensure_provider_ws=True,
    )

    assert payload == live_payload
    assert module._provider_ws_calls == [{"ensure_subscription": True}]


def test_gateway_kline_falls_back_to_rest_when_provider_ws_missing():
    module = _load_gateway_module(None)
    gateway = module.ContractMarketGateway()

    payload = gateway._load_kline_payload(
        object(),
        "EURUSD_PERP",
        interval="1m",
        allow_provider_ws=True,
        ensure_provider_ws=True,
    )

    assert payload is not None
    assert payload["source"] == "PROVIDER_REST"
    assert payload["fallback_reason"] == "WS_MISS"
    assert payload["received_at_ms"] > 0


def test_gateway_snapshot_preserves_monthly_interval():
    module = _load_gateway_module(None)
    gateway = module.ContractMarketGateway()

    payload = gateway.snapshot_message("BTCUSDT_PERP", "1M")

    assert payload["interval"] == "1M"
    assert set(payload["data"]["klines"]) == {"1M"}


def test_gateway_domain_snapshots_keep_market_and_kline_payloads_separate():
    module = _load_gateway_module(None)
    gateway = module.ContractMarketGateway()
    symbol = "BTCUSDT_PERP"
    now_ms = module._utc_ms()
    state = {"symbol": symbol, "display_price": "100"}
    kline = {
        "symbol": symbol,
        "interval": "1M",
        "open_time": now_ms - 60_000,
        "open": "100",
        "high": "102",
        "low": "99",
        "close": "101",
        "volume": "8",
    }
    kline_authority = {
        **kline,
        "source": "LIVE_WS",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": now_ms,
        "provider_generation": 1,
        "revision_epoch": 1,
        "revision_sequence": 1,
    }

    gateway._set_latest(module.CONTRACT_MARKET_CACHE_QUOTE, symbol, {"symbol": symbol})
    gateway._set_latest(module.CONTRACT_MARKET_CACHE_DEPTH, symbol, {"symbol": symbol})
    gateway._set_latest(
        module.CONTRACT_MARKET_CACHE_TRADES,
        symbol,
        [
            {
                "id": "trade-1",
                "symbol": symbol,
                "price": "100",
                "qty": "1",
                "time": module._utc_ms(),
                "source": "PROVIDER_WS",
                "quote_source": "PROVIDER_WS",
                "quote_freshness": "LIVE",
                "price_source": "TRADE_TICK",
                "provider": "OKX_SWAP",
                "provider_symbol": "BTC-USDT-SWAP",
                "synthetic": False,
            }
        ],
    )
    gateway._set_latest(module.CONTRACT_MARKET_CACHE_STATE, symbol, state)
    gateway._set_latest(
        module.CONTRACT_MARKET_CACHE_KLINE,
        symbol,
        kline,
        interval="1M",
        authority_payload=kline_authority,
    )

    market_payload = gateway.market_snapshot_message(symbol)
    assert market_payload["domain"] == "market"
    assert set(market_payload["data"]) == {"quote", "depth", "trades", "market_state", "status"}
    assert "klines" not in market_payload["data"]

    kline_payload = gateway.kline_snapshot_message(symbol, "1M")
    assert kline_payload["domain"] == "kline"
    assert kline_payload["interval"] == "1M"
    assert kline_payload["kline"]["close"] == "101"
    assert kline_payload["kline"]["volume"] == "8"
    assert kline_payload["source"] == "LIVE_WS"
    assert kline_payload["provider_generation"] == 1
    assert "quote" not in kline_payload
    assert "depth" not in kline_payload
    assert "market_state" not in kline_payload


def test_gateway_kline_snapshot_does_not_refresh_market_domain():
    module = _load_gateway_module(None)
    gateway = module.ContractMarketGateway()
    symbol = "BTCUSDT_PERP"

    def fail_market_refresh(*_args, **_kwargs):
        raise AssertionError("kline snapshot must not refresh the market domain")

    def seed_kline(request_symbol, interval, *_args, **_kwargs):
        now_ms = module._utc_ms()
        kline = {
            "symbol": request_symbol,
            "interval": interval,
            "open_time": now_ms - 60_000,
            "open": "99",
            "high": "101",
            "low": "98",
            "close": "100",
            "volume": "5",
        }
        gateway._set_latest(
            module.CONTRACT_MARKET_CACHE_KLINE,
            request_symbol,
            kline,
            interval=interval,
            authority_payload={
                **kline,
                "source": "LIVE_WS",
                "provider": "OKX_SWAP",
                "provider_symbol": "BTC-USDT-SWAP",
                "received_at_ms": now_ms,
                "provider_generation": 1,
                "revision_epoch": 1,
                "revision_sequence": 1,
            },
        )
        return kline

    gateway._refresh_market_once = fail_market_refresh
    gateway._refresh_kline_once = seed_kline

    payload = asyncio.run(gateway.kline_snapshot(symbol, "1M"))

    assert payload["domain"] == "kline"
    assert payload["interval"] == "1M"
    assert payload["kline"]["close"] == "100"


def test_gateway_market_state_cache_is_symbol_scoped():
    module = _load_gateway_module(None)
    gateway = module.ContractMarketGateway()
    symbol = "BTCUSDT_PERP"
    state = {"symbol": symbol, "display_price": "100"}

    gateway._set_latest(module.CONTRACT_MARKET_CACHE_STATE, symbol, state)

    monthly = gateway.snapshot_message(symbol, "1M")["data"]["market_state"]
    five_minutes = gateway.snapshot_message(symbol, "5m")["data"]["market_state"]
    state_message = gateway._state_message(symbol, state)

    assert monthly == state
    assert five_minutes == state
    assert state_message["domain"] == "market"
    assert "interval" not in state_message
    assert "kline_current_candle" not in state_message["data"]


def test_gateway_market_state_builder_uses_only_matching_domain_snapshots():
    module = _load_gateway_module(None)
    gateway = module.ContractMarketGateway()
    symbol = "AAPLUSDT_PERP"
    captured = {}

    class MarketViewModelStub:
        def __init__(self, **payload):
            self.payload = payload

        def model_dump(self):
            return dict(self.payload)

    def build_market_view_stub(_symbol, **kwargs):
        captured.update(kwargs)
        return {
            "symbol": symbol,
            "display_price": "100",
            "kline_current_candle": {"close": "999"},
        }

    module.ContractMarketViewDetail = MarketViewModelStub
    module.build_contract_market_view_v2 = build_market_view_stub
    gateway._set_latest(module.CONTRACT_MARKET_CACHE_QUOTE, symbol, {"symbol": symbol})
    gateway._set_latest(
        module.CONTRACT_MARKET_CACHE_KLINE,
        symbol,
        {"symbol": symbol, "interval": "1M", "close": "999"},
        interval="1M",
    )

    state = gateway._build_market_state_from_latest(symbol)

    assert captured["kline_snapshot"] is None
    assert captured["ticker_snapshot"] is not None
    assert captured["ticker_snapshot"].metadata.symbol == symbol
    assert state == {"symbol": symbol, "display_price": "100"}


if __name__ == "__main__":
    test_itick_quote_subscription_symbol_by_category()
    test_itick_ticker_normalizer_uses_quote_fields_and_live_source()
    test_itick_ticker_normalizer_does_not_synthesize_executable_bbo_from_last_price()
    test_itick_kline_subscription_resolver_uses_category_endpoint_and_kline_type()
    test_itick_trades_subscription_resolver_uses_stock_tick_endpoint()
    test_itick_trade_normalizer_marks_live_trade_tick_source()
    test_itick_kline_normalizer_maps_verified_payload_without_millisecond_double_multiply()
    test_itick_kline_handler_writes_existing_kline_cache_shape()
    test_itick_kline_freshness_uses_itick_max_age_in_provider_selection()
    test_okx_kline_channel_and_normalizer_still_work()
    test_gateway_kline_prefers_provider_ws_and_delegates_provider_specific_max_age()
    test_gateway_kline_falls_back_to_rest_when_provider_ws_missing()
    test_gateway_snapshot_preserves_monthly_interval()
    test_gateway_domain_snapshots_keep_market_and_kline_payloads_separate()
    test_gateway_kline_snapshot_does_not_refresh_market_domain()
    test_gateway_market_state_cache_is_symbol_scoped()
    test_gateway_market_state_builder_uses_only_matching_domain_snapshots()
