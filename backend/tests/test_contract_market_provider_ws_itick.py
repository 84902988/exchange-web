from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from decimal import Decimal
import time


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def _load_provider_ws_module():
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))

    config_module = types.ModuleType("app.core.config")

    class SettingsStub:
        CONTRACT_PROVIDER_WS_ENABLED = True
        CONTRACT_PROVIDER_WS_TICKER_ENABLED = True
        CONTRACT_PROVIDER_WS_KLINE_ENABLED = True
        CONTRACT_PROVIDER_WS_TRADES_ENABLED = True
        CONTRACT_PROVIDER_WS_ITICK_ENABLED = True
        CONTRACT_PROVIDER_WS_ITICK_KLINE_ENABLED = True
        CONTRACT_PROVIDER_WS_ITICK_TRADES_ENABLED = True
        CONTRACT_PROVIDER_WS_KLINE_MAX_AGE_MS = 1500
        CONTRACT_PROVIDER_WS_ITICK_KLINE_MAX_AGE_MS = 90000
        CONTRACT_PROVIDER_WS_ITICK_KLINE_BROADCAST_INTERVAL_MS = 1000
        CONTRACT_PROVIDER_WS_ITICK_URL = "wss://api.itick.org"
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
    spec.loader.exec_module(module)
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
    assert payload["source"] == "LIVE_WS"
    assert payload["quote_source"] == "LIVE_WS"
    assert payload["is_realtime"] is True
    assert payload["market_status"] == "OPEN"


def test_itick_ticker_normalizer_synthesizes_bbo_from_last_price():
    module = _load_provider_ws_module()
    service = module.ContractMarketProviderWsService()
    subscription = module.ProviderTickerSubscription(
        local_symbol="AAPLUSDT_PERP",
        provider=module.PROVIDER_ITICK,
        provider_symbol="AAPL",
        ws_symbol="AAPL",
    )

    payload = service._normalize_itick_ticker(subscription, {"p": "200", "t": 1717000000})

    assert payload is not None
    assert payload["bid_price"] == Decimal("199.9000")
    assert payload["ask_price"] == Decimal("200.1000")
    assert payload["last_price"] == Decimal("200")


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


def _load_gateway_module(provider_payload):
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())

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
    provider_ws_module.force_stop_provider_ws_subscriptions_for_symbol = lambda symbol: {}
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
    sys.modules["app.services.contract_market_provider_ws"] = provider_ws_module

    module_path = BACKEND / "app" / "services" / "contract_market_gateway.py"
    spec = importlib.util.spec_from_file_location("contract_market_gateway_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
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
    assert payload["source"] == "REST"


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
    state = {"symbol": symbol, "display_price": "100"}
    kline = {"symbol": symbol, "interval": "1M", "close": "101"}

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
    gateway._set_latest(module.CONTRACT_MARKET_CACHE_KLINE, symbol, kline, interval="1M")

    market_payload = gateway.market_snapshot_message(symbol)
    assert market_payload["domain"] == "market"
    assert set(market_payload["data"]) == {"quote", "depth", "trades", "market_state", "status"}
    assert "klines" not in market_payload["data"]

    kline_payload = gateway.kline_snapshot_message(symbol, "1M")
    assert kline_payload["domain"] == "kline"
    assert kline_payload["interval"] == "1M"
    assert kline_payload["kline"] == kline
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
        kline = {"symbol": request_symbol, "interval": interval, "close": "100"}
        gateway._set_latest(module.CONTRACT_MARKET_CACHE_KLINE, request_symbol, kline, interval=interval)
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


def test_gateway_market_state_builder_ignores_kline_domain_cache():
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
    module.build_contract_market_view = build_market_view_stub
    gateway._set_latest(module.CONTRACT_MARKET_CACHE_QUOTE, symbol, {"symbol": symbol})
    gateway._set_latest(
        module.CONTRACT_MARKET_CACHE_KLINE,
        symbol,
        {"symbol": symbol, "interval": "1M", "close": "999"},
        interval="1M",
    )

    state = gateway._build_market_state_from_latest(symbol)

    assert captured["latest_kline"] is None
    assert state == {"symbol": symbol, "display_price": "100"}


if __name__ == "__main__":
    test_itick_quote_subscription_symbol_by_category()
    test_itick_ticker_normalizer_uses_quote_fields_and_live_source()
    test_itick_ticker_normalizer_synthesizes_bbo_from_last_price()
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
    test_gateway_market_state_builder_ignores_kline_domain_cache()
