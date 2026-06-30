from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from decimal import Decimal


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def _load_provider_ws_module():
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))

    config_module = types.ModuleType("app.core.config")

    class SettingsStub:
        CONTRACT_PROVIDER_WS_ENABLED = True
        CONTRACT_PROVIDER_WS_TICKER_ENABLED = True
        CONTRACT_PROVIDER_WS_ITICK_ENABLED = True
        CONTRACT_PROVIDER_WS_ITICK_URL = "wss://api.itick.org"
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

    assert module._itick_quote_subscription_symbol("AAPL", "STOCK") == "AAPL$US"
    assert module._itick_quote_subscription_symbol("SPX", "INDEX") == "SPX$GB"
    assert module._itick_quote_subscription_symbol("SPX$GB", "INDEX") == "SPX$GB"
    assert module._itick_quote_subscription_symbol("XAUUSD", "GOLD") == "XAUUSD$GB"
    assert module._itick_quote_subscription_symbol("USOIL", "FUTURES") == "USOIL$GB"
    assert module._itick_ws_url_for_category("wss://api.itick.org", "STOCK") == "wss://api.itick.org/stock"
    assert module._itick_ws_url_for_category("wss://api.itick.org", "FOREX") == "wss://api.itick.org/forex"
    assert module._itick_ws_url_for_category("wss://api.itick.org", "INDEX") == "wss://api.itick.org/indices"


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


if __name__ == "__main__":
    test_itick_quote_subscription_symbol_by_category()
    test_itick_ticker_normalizer_uses_quote_fields_and_live_source()
    test_itick_ticker_normalizer_synthesizes_bbo_from_last_price()
