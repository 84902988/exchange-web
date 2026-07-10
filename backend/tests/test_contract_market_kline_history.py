from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def _module(name: str, **attributes):
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


def _load_contract_market_ws_module():
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    module_path = BACKEND / "app" / "services" / "contract_market_ws.py"
    spec = importlib.util.spec_from_file_location("contract_market_ws_kline_under_test", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_provider_service_module():
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    module_path = BACKEND / "app" / "services" / "contract_market_provider_service.py"
    spec = importlib.util.spec_from_file_location("contract_market_provider_endpoint_under_test", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_contract_market_service_module():
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))

    class ContractSymbolStub:
        symbol = "symbol"
        status = "status"

    class ContractMarketQuoteStub:
        symbol = "symbol"

    class ServiceError(RuntimeError):
        pass

    class ProviderCooldownError(RuntimeError):
        pass

    _module(
        "app.core.config",
        settings=SimpleNamespace(BINANCE_USDM_USE_ENV_PROXY=False),
    )
    _module(
        "app.db.models.contract_market_quote",
        ContractMarketQuote=ContractMarketQuoteStub,
    )
    _module(
        "app.db.models.contract_symbol",
        ContractSymbol=ContractSymbolStub,
    )
    _module(
        "app.services.binance_market_service",
        BinanceMarketServiceError=ServiceError,
        binance_market_service=SimpleNamespace(),
    )
    _module(
        "app.services.itick_holiday_service",
        MARKET_STATUS_CLOSED="CLOSED",
        ItickMarketStatus=object,
        itick_holiday_service=SimpleNamespace(),
    )
    _module(
        "app.services.itick_market_service",
        ItickMarketServiceError=ServiceError,
        itick_market_service=SimpleNamespace(),
    )
    _module(
        "app.services.market_kline_cache",
        get_klines_cache_first=lambda *_args, **_kwargs: [],
        upsert_klines=lambda *_args, **_kwargs: 0,
    )
    _module(
        "app.services.contract_market_provider_service",
        MarketDataProviderConfig=object,
        ProviderCooldownError=ProviderCooldownError,
        contract_market_last_good_enabled=lambda _db: False,
        enabled_contract_market_providers=lambda _db: (),
        mark_contract_market_provider_failure=lambda *_args, **_kwargs: None,
        mark_contract_market_provider_success=lambda *_args, **_kwargs: None,
        request_contract_market_provider_json=lambda *_args, **_kwargs: {},
        resolve_contract_provider_symbol=lambda *_args, **_kwargs: "",
    )
    _module(
        "app.services.contract_market_guard",
        _CLOSED_MARKET_LAST_GOOD_BBO_MAX_AGE_SECONDS=300,
        executable_contract_quote_rejection_reason=lambda *_args, **_kwargs: None,
        require_executable_contract_quote=lambda *_args, **_kwargs: None,
    )

    module_path = BACKEND / "app" / "services" / "contract_market_service.py"
    spec = importlib.util.spec_from_file_location("contract_market_service_kline_under_test", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _okx_provider():
    return SimpleNamespace(provider_code="OKX_SWAP", cooldown_seconds=0)


def _contract_symbol():
    return SimpleNamespace(
        symbol="BTCUSDT_PERP",
        provider="BINANCE",
        provider_symbol="BTC-USDT-SWAP",
        category="CRYPTO",
    )


def _provider_rows(*open_times: int):
    return {
        "data": [
            [str(open_time), "100", "110", "90", "105", "5", "525", "525", "1"]
            for open_time in open_times
        ]
    }


def _configure_okx_fetch(service, payload, calls):
    service.enabled_contract_market_providers = lambda _db: (_okx_provider(),)
    service._configured_provider_symbol = lambda *_args, **_kwargs: "BTC-USDT-SWAP"
    service.mark_contract_market_provider_success = lambda *_args, **_kwargs: None
    service.mark_contract_market_provider_failure = lambda *_args, **_kwargs: None

    def request(_provider, endpoint_type, provider_symbol, **kwargs):
        calls.append(
            {
                "endpoint_type": endpoint_type,
                "provider_symbol": provider_symbol,
                "limit": kwargs.get("limit"),
                "extra_params": dict(kwargs.get("extra_params") or {}),
            }
        )
        return payload

    service.request_contract_market_provider_json = request


def test_contract_ws_interval_normalization_and_subscription_preserve_monthly():
    module = _load_contract_market_ws_module()
    assert module.normalize_contract_ws_interval("1m") == "1m"
    assert module.normalize_contract_ws_interval("1M") == "1M"

    class WebSocketStub:
        application_state = module.WebSocketState.CONNECTED
        client_state = module.WebSocketState.CONNECTED

    async def scenario():
        manager = module.ContractMarketWsManager()
        websocket = WebSocketStub()
        await manager.connect("BTCUSDT_PERP", websocket, interval="1M", accepted=True)
        assert await manager.subscribed_intervals("BTCUSDT_PERP") == ["1M"]
        await manager.disconnect(websocket)

    asyncio.run(scenario())


def test_okx_swap_history_endpoint_is_distinct_from_current_candles():
    provider_service = _load_provider_service_module()
    current_path, current_params = provider_service._endpoint_request(
        provider_service.PROVIDER_OKX_SWAP,
        "kline",
        "BTC-USDT-SWAP",
        300,
    )
    history_path, history_params = provider_service._endpoint_request(
        provider_service.PROVIDER_OKX_SWAP,
        "kline_history",
        "BTC-USDT-SWAP",
        300,
    )

    assert current_path == "/api/v5/market/candles"
    assert history_path == "/api/v5/market/history-candles"
    assert current_params["instId"] == history_params["instId"] == "BTC-USDT-SWAP"


def test_okx_current_request_uses_candles_without_history_cursor():
    service = _load_contract_market_service_module()
    calls = []
    _configure_okx_fetch(service, _provider_rows(1_700_000_000_000), calls)

    rows = service._get_configured_contract_klines(
        object(),
        _contract_symbol(),
        interval="1m",
        limit=50,
        end_time_ms=None,
    )

    assert rows
    assert calls == [
        {
            "endpoint_type": "kline",
            "provider_symbol": "BTC-USDT-SWAP",
            "limit": 50,
            "extra_params": {"bar": "1m"},
        }
    ]


def test_okx_history_request_uses_history_endpoint_after_and_strict_boundary():
    service = _load_contract_market_service_module()
    end_time_ms = 1_700_000_000_000
    calls = []
    _configure_okx_fetch(
        service,
        _provider_rows(end_time_ms - 60_000, end_time_ms, end_time_ms + 60_000),
        calls,
    )

    rows = service._get_configured_contract_klines(
        object(),
        _contract_symbol(),
        interval="1m",
        limit=50,
        end_time_ms=end_time_ms,
    )

    assert [row["open_time"] for row in rows] == [end_time_ms - 60_000]
    assert calls[0]["endpoint_type"] == "kline_history"
    assert calls[0]["extra_params"] == {"bar": "1m", "after": str(end_time_ms)}
    assert all(row["open_time"] < end_time_ms for row in rows)


def test_okx_latest_rows_are_not_misreported_as_history_success():
    service = _load_contract_market_service_module()
    end_time_ms = 1_700_000_000_000
    calls = []
    _configure_okx_fetch(
        service,
        _provider_rows(end_time_ms, end_time_ms + 60_000),
        calls,
    )

    try:
        service._get_configured_contract_klines(
            object(),
            _contract_symbol(),
            interval="1m",
            limit=50,
            end_time_ms=end_time_ms,
        )
    except service.ContractQuoteUnavailable:
        pass
    else:
        raise AssertionError("latest provider rows must not count as historical success")

    assert calls[0]["endpoint_type"] == "kline_history"


def test_contract_history_db_cache_hit_does_not_call_provider():
    service = _load_contract_market_service_module()
    end_time_ms = 1_700_000_000_000
    cached_rows = [
        {
            "open_time": end_time_ms - 60_000,
            "open": "100",
            "high": "110",
            "low": "90",
            "close": "105",
            "volume": "5",
            "source": "OKX_SWAP",
        }
    ]
    service._load_contract_symbol = lambda *_args, **_kwargs: _contract_symbol()
    service.request_contract_market_provider_json = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("DB cache hit must not call provider")
    )

    def cache_first(_db, **kwargs):
        assert kwargs["end_time_ms"] == end_time_ms
        assert kwargs["source"] == "CONFIGURED"
        return cached_rows

    service.get_klines_cache_first = cache_first

    rows = service.get_contract_klines(
        object(),
        "BTCUSDT_PERP",
        interval="1m",
        limit=50,
        end_time_ms=end_time_ms,
    )

    assert rows == cached_rows


if __name__ == "__main__":
    tests = [
        test_contract_ws_interval_normalization_and_subscription_preserve_monthly,
        test_okx_swap_history_endpoint_is_distinct_from_current_candles,
        test_okx_current_request_uses_candles_without_history_cursor,
        test_okx_history_request_uses_history_endpoint_after_and_strict_boundary,
        test_okx_latest_rows_are_not_misreported_as_history_success,
        test_contract_history_db_cache_hit_does_not_call_provider,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} tests passed")
