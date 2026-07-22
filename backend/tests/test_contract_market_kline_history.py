from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import requests


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

    class KlineProviderHistoryBoundary(RuntimeError):
        def __init__(self, message: str, *, provider_error_provider: str | None = None):
            super().__init__(message)
            self.provider_error_provider = provider_error_provider

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
        KLINE_CACHE_POLICY_GAP_TOLERANT="gap_tolerant",
        KlineProviderHistoryBoundary=KlineProviderHistoryBoundary,
        get_klines_cache_first=lambda *_args, **_kwargs: [],
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


def _okx_provider(*, cooldown_seconds: int = 0):
    return SimpleNamespace(provider_code="OKX_SWAP", cooldown_seconds=cooldown_seconds)


def _bitget_provider(*, cooldown_seconds: int = 0):
    return SimpleNamespace(provider_code="BITGET_USDT_FUTURES", cooldown_seconds=cooldown_seconds)


def _contract_symbol():
    return SimpleNamespace(
        symbol="BTCUSDT_PERP",
        provider="BINANCE",
        provider_symbol="BTC-USDT-SWAP",
        category="CRYPTO",
    )


def _itick_contract_symbol(
    *,
    category: str,
    symbol: str = "US30_PERP",
    provider_symbol: str = "US30",
    dwm_boundary_policy: str | None = "UTC_PASSTHROUGH",
):
    return SimpleNamespace(
        symbol=symbol,
        provider="ITICK",
        provider_symbol=provider_symbol,
        category=category,
        _itick_dwm_boundary_policy=dwm_boundary_policy,
    )


def _itick_contract_symbol_with_provider_session_policy(
    *,
    category: str,
    symbol: str,
    provider_symbol: str,
):
    return SimpleNamespace(
        symbol=symbol,
        provider="ITICK",
        provider_symbol=provider_symbol,
        category=category,
    )


def _provider_rows(*open_times: int):
    return {
        "code": "0",
        "data": [
            [str(open_time), "100", "110", "90", "105", "5", "525", "525", "1"]
            for open_time in open_times
        ]
    }


class _SharedKlineCacheResult(list):
    def __init__(
        self,
        rows,
        *,
        origin: str,
        cache_status: str,
        history_incomplete: bool = False,
        history_terminal: bool = False,
        terminal_reason: str | None = None,
        earliest_available_time: int | None = None,
        coverage_complete: bool | None = None,
        provider_error_code: str | None = None,
    ):
        super().__init__(rows)
        self.origin = origin
        self.cache_status = cache_status
        self.history_incomplete = history_incomplete
        self.history_terminal = history_terminal
        self.terminal_reason = terminal_reason
        self.earliest_available_time = earliest_available_time
        self.coverage_complete = coverage_complete
        self.provider_error_code = provider_error_code


def _cache_first_fetches_provider(_db, **kwargs):
    try:
        rows = kwargs["fetch_external"](kwargs["limit"], kwargs["end_time_ms"])
    except TimeoutError:
        return _SharedKlineCacheResult(
            [],
            origin="EMPTY",
            cache_status="TIMEOUT",
            history_incomplete=kwargs["end_time_ms"] is not None,
            provider_error_code="TIMEOUT",
        )
    return _SharedKlineCacheResult(
        rows,
        origin="REST_FETCH" if rows else "EMPTY",
        cache_status="MISS" if rows else "PROVIDER_EMPTY",
        history_incomplete=not rows and kwargs["end_time_ms"] is not None,
        provider_error_code=None if rows else "EMPTY",
    )


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


def test_okx_dwm_current_and_history_use_the_same_utc_provider_bar():
    cases = (
        ("1d", "1Dutc", 1_782_864_000_000, 86_400_000),
        ("1w", "1Wutc", 1_783_296_000_000, 7 * 86_400_000),
        ("1M", "1Mutc", 1_785_542_400_000, 31 * 86_400_000),
    )

    for interval, provider_bar, current_open_time, history_step in cases:
        service = _load_contract_market_service_module()
        calls = []
        history_open_time = current_open_time - history_step
        _configure_okx_fetch(
            service,
            _provider_rows(history_open_time, current_open_time),
            calls,
        )

        current_rows = service._get_configured_contract_klines(
            object(),
            _contract_symbol(),
            interval=interval,
            limit=50,
            end_time_ms=None,
        )
        history_rows = service._get_configured_contract_klines(
            object(),
            _contract_symbol(),
            interval=interval,
            limit=50,
            end_time_ms=current_open_time,
        )

        assert current_rows[-1]["open_time"] == current_open_time
        assert history_rows[-1]["open_time"] == history_open_time
        assert calls[0]["extra_params"] == {"bar": provider_bar}
        assert calls[1]["extra_params"] == {
            "bar": provider_bar,
            "after": str(current_open_time),
        }


def test_contract_dwm_cache_identity_isolated_from_legacy_local_intervals():
    service = _load_contract_market_service_module()

    assert service._contract_kline_cache_interval("1d") == "1Dutc"
    assert service._contract_kline_cache_interval("1w") == "1Wutc"
    assert service._contract_kline_cache_interval("1M") == "1Mutc"
    assert service._contract_kline_cache_key("BTCUSDT_PERP", "1d", 50) == (
        "BTCUSDT_PERP:1Dutc:50"
    )


def test_contract_dwm_boundary_validator_enforces_utc_period_start():
    service = _load_contract_market_service_module()

    assert service._contract_dwm_open_time_is_utc_boundary(1_782_864_000_000, "1d") is True
    assert service._contract_dwm_open_time_is_utc_boundary(1_783_296_000_000, "1w") is True
    assert service._contract_dwm_open_time_is_utc_boundary(1_785_542_400_000, "1M") is True
    assert service._contract_dwm_open_time_is_utc_boundary(1_783_382_400_000, "1w") is False
    assert service._contract_dwm_open_time_is_utc_boundary(1_785_715_200_000, "1M") is False
    assert service._contract_dwm_open_time_is_utc_boundary(
        1_782_864_000_000 + 60_000,
        "1d",
    ) is False


def test_btc_monthly_current_returns_provider_rows():
    service = _load_contract_market_service_module()
    calls = []
    monthly_open_times = [
        1_767_225_600_000,
        1_769_904_000_000,
        1_772_323_200_000,
    ]
    _configure_okx_fetch(service, _provider_rows(*monthly_open_times), calls)

    rows = service._get_configured_contract_klines(
        object(),
        _contract_symbol(),
        interval="1M",
        limit=60,
        end_time_ms=None,
    )

    assert [row["open_time"] for row in rows] == monthly_open_times
    assert calls == [
        {
            "endpoint_type": "kline",
            "provider_symbol": "BTC-USDT-SWAP",
            "limit": 60,
            "extra_params": {"bar": "1Mutc"},
        }
    ]


def test_btc_monthly_history_pagination_uses_cursor():
    service = _load_contract_market_service_module()
    calls = []
    end_time_ms = 1_772_323_200_000
    previous_month = 1_769_904_000_000
    _configure_okx_fetch(
        service,
        _provider_rows(previous_month, end_time_ms),
        calls,
    )

    rows = service._get_configured_contract_klines(
        object(),
        _contract_symbol(),
        interval="1M",
        limit=240,
        end_time_ms=end_time_ms,
    )

    assert [row["open_time"] for row in rows] == [previous_month]
    assert calls == [
        {
            "endpoint_type": "kline_history",
            "provider_symbol": "BTC-USDT-SWAP",
            "limit": 240,
            "extra_params": {"bar": "1Mutc", "after": str(end_time_ms)},
        }
    ]


def test_btc_monthly_history_beyond_earliest_raises_provider_boundary():
    service = _load_contract_market_service_module()
    calls = []
    end_time_ms = 1_561_910_400_000
    _configure_okx_fetch(service, _provider_rows(), calls)

    try:
        service._get_configured_contract_klines(
            object(),
            _contract_symbol(),
            interval="1M",
            limit=300,
            end_time_ms=end_time_ms,
        )
    except service.KlineProviderHistoryBoundary as exc:
        assert exc.provider_error_provider == "OKX_SWAP"
    else:
        raise AssertionError("empty BTC 1M provider history must publish a boundary")

    assert calls == [
        {
            "endpoint_type": "kline_history",
            "provider_symbol": "BTC-USDT-SWAP",
            "limit": 300,
            "extra_params": {"bar": "1Mutc", "after": str(end_time_ms)},
        }
    ]


def test_btc_monthly_explicit_empty_fallback_repeats_without_provider_cooldown():
    service = _load_contract_market_service_module()
    providers = (
        _okx_provider(cooldown_seconds=60),
        _bitget_provider(cooldown_seconds=60),
    )
    provider_calls = []
    failure_calls = []
    service.enabled_contract_market_providers = lambda _db: providers
    service._configured_provider_symbol = lambda _db, provider, _symbol: (
        "BTC-USDT-SWAP" if provider.provider_code == "OKX_SWAP" else "BTCUSDT"
    )
    service.mark_contract_market_provider_success = lambda *_args, **_kwargs: None
    service.mark_contract_market_provider_failure = lambda *args, **kwargs: failure_calls.append(
        (args, kwargs)
    )

    def request(provider, *_args, **_kwargs):
        provider_calls.append(provider.provider_code)
        if provider.provider_code == "OKX_SWAP":
            return {"code": "0", "data": []}
        return {"code": "00000", "data": []}

    service.request_contract_market_provider_json = request

    for _attempt in range(2):
        try:
            service._get_configured_contract_klines(
                object(),
                _contract_symbol(),
                interval="1M",
                limit=245,
                end_time_ms=1_561_910_400_000,
            )
        except service.KlineProviderHistoryBoundary:
            pass
        else:
            raise AssertionError("explicit monthly history empty must remain terminal")

    assert provider_calls == [
        "OKX_SWAP",
        "BITGET_USDT_FUTURES",
        "OKX_SWAP",
        "BITGET_USDT_FUTURES",
    ]
    assert failure_calls == []


def test_btc_monthly_timeout_and_network_failures_still_trigger_cooldown():
    for provider_error in (
        TimeoutError("provider timeout"),
        ConnectionError("provider network unavailable"),
    ):
        service = _load_contract_market_service_module()
        provider = _okx_provider(cooldown_seconds=60)
        failure_calls = []
        service.enabled_contract_market_providers = lambda _db: (provider,)
        service._configured_provider_symbol = lambda *_args, **_kwargs: "BTC-USDT-SWAP"
        service.request_contract_market_provider_json = (
            lambda *_args, **_kwargs: (_ for _ in ()).throw(provider_error)
        )
        service.mark_contract_market_provider_failure = (
            lambda _db, provider_code, error, **kwargs: failure_calls.append(
                (provider_code, type(error), kwargs.get("cooldown_seconds"))
            )
        )

        try:
            service._get_configured_contract_klines(
                object(),
                _contract_symbol(),
                interval="1M",
                limit=245,
                end_time_ms=1_561_910_400_000,
            )
        except service.KlineProviderHistoryBoundary as exc:
            raise AssertionError("provider failure must not become terminal") from exc
        except service.ContractQuoteUnavailable:
            pass
        else:
            raise AssertionError("provider failure must remain unavailable")

        assert failure_calls == [
            ("OKX_SWAP", type(provider_error), 60),
        ]


def test_btc_monthly_provider_business_failure_still_triggers_cooldown():
    service = _load_contract_market_service_module()
    provider = _okx_provider(cooldown_seconds=60)
    failure_calls = []
    service.enabled_contract_market_providers = lambda _db: (provider,)
    service._configured_provider_symbol = lambda *_args, **_kwargs: "BTC-USDT-SWAP"
    service.request_contract_market_provider_json = lambda *_args, **_kwargs: {
        "code": "51000",
        "msg": "provider rejected request",
        "data": [],
    }
    service.mark_contract_market_provider_failure = (
        lambda _db, provider_code, error, **kwargs: failure_calls.append(
            (provider_code, str(error), kwargs.get("cooldown_seconds"))
        )
    )

    try:
        service._get_configured_contract_klines(
            object(),
            _contract_symbol(),
            interval="1M",
            limit=245,
            end_time_ms=1_561_910_400_000,
        )
    except service.KlineProviderHistoryBoundary as exc:
        raise AssertionError("provider business failure must not become terminal") from exc
    except service.ContractQuoteUnavailable:
        pass
    else:
        raise AssertionError("provider business failure must remain unavailable")

    assert failure_calls == [
        ("OKX_SWAP", "OKX_SWAP_KLINE_PROVIDER_ERROR", 60),
    ]


def test_btc_monthly_provider_cooldown_is_not_history_boundary():
    service = _load_contract_market_service_module()
    service.enabled_contract_market_providers = lambda _db: (_okx_provider(),)
    service._configured_provider_symbol = lambda *_args, **_kwargs: "BTC-USDT-SWAP"
    service.request_contract_market_provider_json = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        service.ProviderCooldownError("provider is in cooldown")
    )

    try:
        service._get_configured_contract_klines(
            object(),
            _contract_symbol(),
            interval="1M",
            limit=300,
            end_time_ms=1_561_910_400_000,
        )
    except service.KlineProviderHistoryBoundary as exc:
        raise AssertionError("provider cooldown must remain retryable, not terminal") from exc
    except service.ContractQuoteUnavailable:
        pass
    else:
        raise AssertionError("provider cooldown must remain unavailable")


def test_btc_monthly_provider_unavailable_remains_retryable():
    service = _load_contract_market_service_module()
    service._load_contract_symbol = lambda *_args, **_kwargs: _contract_symbol()
    service.enabled_contract_market_providers = lambda _db: (_okx_provider(),)
    service._configured_provider_symbol = lambda *_args, **_kwargs: "BTC-USDT-SWAP"
    service.mark_contract_market_provider_failure = lambda *_args, **_kwargs: None
    service.request_contract_market_provider_json = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        service.ContractQuoteUnavailable("OKX_SWAP_KLINE_UNAVAILABLE")
    )

    def cache_first(_db, **kwargs):
        try:
            kwargs["fetch_external"](kwargs["limit"], kwargs["end_time_ms"])
        except service.KlineProviderHistoryBoundary as exc:
            raise AssertionError("provider outage must not become terminal") from exc
        except service.ContractQuoteUnavailable:
            return _SharedKlineCacheResult(
                [],
                origin="EMPTY",
                cache_status="MISS",
                history_incomplete=True,
                provider_error_code="EMPTY",
            )
        raise AssertionError("provider outage must not return rows")

    service.get_klines_cache_first = cache_first
    end_time_ms = 1_561_910_400_000
    rows = service.get_contract_klines(
        object(),
        "BTCUSDT_PERP",
        interval="1M",
        limit=300,
        end_time_ms=end_time_ms,
    )
    from app.services.contract_kline_response import build_contract_kline_metadata

    metadata = build_contract_kline_metadata(rows, end_time_ms=end_time_ms)

    assert metadata["items"] == []
    assert metadata["history_terminal"] is False
    assert metadata["terminal_reason"] is None
    assert metadata["history_complete"] is False
    assert metadata["history_incomplete"] is True
    assert metadata["provider_error_code"] == "EMPTY"
    assert metadata["retryable"] is True


def test_btc_monthly_history_boundary_serializes_terminal_response():
    service = _load_contract_market_service_module()
    service._load_contract_symbol = lambda *_args, **_kwargs: _contract_symbol()
    calls = []
    _configure_okx_fetch(service, _provider_rows(), calls)
    earliest_available_time = 1_561_910_400_000

    def cache_first(_db, **kwargs):
        try:
            kwargs["fetch_external"](kwargs["limit"], kwargs["end_time_ms"])
        except service.KlineProviderHistoryBoundary:
            return _SharedKlineCacheResult(
                [],
                origin="EMPTY",
                cache_status="HISTORY_BOUNDARY",
                history_terminal=True,
                terminal_reason="PROVIDER_HISTORY_BOUNDARY",
                earliest_available_time=earliest_available_time,
                coverage_complete=True,
            )
        raise AssertionError("empty monthly provider history must raise a boundary")

    service.get_klines_cache_first = cache_first

    rows = service.get_contract_klines(
        object(),
        "BTCUSDT_PERP",
        interval="1M",
        limit=300,
        end_time_ms=earliest_available_time,
    )
    from app.services.contract_kline_response import build_contract_kline_metadata

    metadata = build_contract_kline_metadata(
        rows,
        end_time_ms=earliest_available_time,
    )

    assert metadata["items"] == []
    assert metadata["history_terminal"] is True
    assert metadata["terminal_reason"] == "PROVIDER_HISTORY_BOUNDARY"
    assert metadata["earliest_available_time"] == earliest_available_time
    assert metadata["history_complete"] is True
    assert metadata["has_more_before"] is False
    assert metadata["history_incomplete"] is False
    assert metadata["provider_error_code"] is None
    assert metadata["retryable"] is False


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
        return _SharedKlineCacheResult(
            cached_rows,
            origin="DB_CACHE",
            cache_status="HIT",
        )

    service.get_klines_cache_first = cache_first

    rows = service.get_contract_klines(
        object(),
        "BTCUSDT_PERP",
        interval="1m",
        limit=50,
        end_time_ms=end_time_ms,
    )

    assert rows == cached_rows
    assert rows.origin == "DB_CACHE"
    assert rows.cache_status == "HIT"


def test_tradfi_process_cache_path_preserves_cache_metadata():
    service = _load_contract_market_service_module()
    cached_rows = [
        {
            "open_time": 1_700_000_000_000,
            "open": "100",
            "high": "110",
            "low": "90",
            "close": "105",
            "volume": "5",
        }
    ]
    service._load_contract_symbol = lambda *_args, **_kwargs: _itick_contract_symbol(category="CFD")
    service._contract_provider_symbol = lambda *_args, **_kwargs: "US30"
    service._is_stock_contract_config = lambda *_args, **_kwargs: False
    service._get_cached_contract_klines = lambda *_args, **_kwargs: cached_rows

    rows = service.get_contract_klines(
        object(),
        "US30_PERP",
        interval="1m",
        limit=50,
    )

    assert rows == cached_rows
    assert rows.origin == "PROCESS_CACHE"
    assert rows.cache_status == "HIT"
    assert rows.provider_error_code is None


def test_index_cache_first_path_preserves_metadata_and_skips_process_cache_write():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(category="INDEX")
    provider_rows = [
        {
            "open_time": 1_700_000_000_000,
            "open": "100",
            "high": "110",
            "low": "90",
            "close": "105",
            "volume": "5",
        }
    ]
    cache_calls = []
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service._contract_provider_symbol = lambda *_args, **_kwargs: "US30"
    service._is_stock_contract_config = lambda *_args, **_kwargs: False
    service._cache_contract_klines = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("Index must not write the unread process cache")
    )

    def cache_first(_db, **kwargs):
        cache_calls.append(kwargs)
        assert kwargs["cache_policy"] == "gap_tolerant"
        assert kwargs["source"] == "ITICK"
        if kwargs["end_time_ms"] is None:
            return _SharedKlineCacheResult(
                provider_rows,
                origin="REST_FETCH" if len(cache_calls) == 1 else "DB_CACHE",
                cache_status="MISS" if len(cache_calls) == 1 else "HIT",
            )
        return _SharedKlineCacheResult(
            [],
            origin="EMPTY",
            cache_status="PROVIDER_EMPTY",
            history_incomplete=True,
            provider_error_code="EMPTY",
        )

    service.get_klines_cache_first = cache_first

    current_rows = service.get_contract_klines(
        object(),
        "US30_PERP",
        interval="1m",
        limit=50,
    )
    cached_current_rows = service.get_contract_klines(
        object(),
        "US30_PERP",
        interval="1m",
        limit=50,
    )
    history_rows = service.get_contract_klines(
        object(),
        "US30_PERP",
        interval="1m",
        limit=50,
        end_time_ms=1_700_000_060_000,
    )

    assert current_rows.origin == "REST_FETCH"
    assert current_rows.cache_status == "MISS"
    assert len(current_rows) == 1
    assert cached_current_rows.origin == "DB_CACHE"
    assert cached_current_rows.cache_status == "HIT"
    assert history_rows == []
    assert history_rows.origin == "EMPTY"
    assert history_rows.cache_status == "PROVIDER_EMPTY"
    assert history_rows.provider_error_code == "EMPTY"
    assert history_rows.history_incomplete is True
    assert history_rows.retryable is True
    assert [call["end_time_ms"] for call in cache_calls] == [None, None, 1_700_000_060_000]


def test_index_unsupported_interval_does_not_write_process_cache():
    service = _load_contract_market_service_module()
    service._load_contract_symbol = lambda *_args, **_kwargs: _itick_contract_symbol(category="INDEX")
    service._contract_provider_symbol = lambda *_args, **_kwargs: "US30"
    service._is_stock_contract_config = lambda *_args, **_kwargs: False
    service._cache_contract_klines = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("Index unsupported interval must not write the unread process cache")
    )
    service.get_klines_cache_first = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("unsupported interval must not enter cache-first fetch")
    )

    rows = service.get_contract_klines(
        object(),
        "US30_PERP",
        interval="4h",
        limit=50,
    )

    assert rows == []
    assert rows.cache_status == "UNSUPPORTED_INTERVAL"
    assert rows.retryable is False


def test_itick_dwm_unknown_boundary_policy_fails_closed_without_provider_call():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="FOREX",
        symbol="EURUSD_PERP",
        provider_symbol="EURUSD",
        dwm_boundary_policy=None,
    )
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.itick_market_service = SimpleNamespace(
        get_market_kline=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("unknown DWM policy must fail before provider IO")
        )
    )

    rows = service.get_contract_klines(
        object(),
        "EURUSD_PERP",
        interval="1d",
        limit=50,
    )

    assert rows == []
    assert rows.cache_status == "UNSUPPORTED_INTERVAL"
    assert rows.provider_error_code == "ITICK_DWM_UTC_BOUNDARY_UNAVAILABLE"
    assert rows.retryable is False


def test_itick_known_utc_policy_uses_utc_cache_identity_and_preserves_time():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="FOREX",
        symbol="EURUSD_PERP",
        provider_symbol="EURUSD",
    )
    open_time = 1_783_296_000_000
    captured = {}
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol

    def cache_first(db, **kwargs):
        captured.update(kwargs)
        return _cache_first_fetches_provider(db, **kwargs)

    service.get_klines_cache_first = cache_first
    service.itick_market_service = SimpleNamespace(
        get_market_kline=lambda *_args, **_kwargs: _provider_rows(open_time)
    )

    rows = service.get_contract_klines(
        object(),
        "EURUSD_PERP",
        interval="1w",
        limit=50,
    )

    assert [row["open_time"] for row in rows] == [open_time]
    assert captured["interval"] == "1Wutc"
    assert captured["open_time_validator"](open_time) is True


def test_itick_known_utc_policy_rejects_non_utc_boundary_without_cache_write():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="FOREX",
        symbol="EURUSD_PERP",
        provider_symbol="EURUSD",
    )
    invalid_open_time = 1_783_296_000_000 + (4 * 60 * 60 * 1000)
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider
    service.itick_market_service = SimpleNamespace(
        get_market_kline=lambda *_args, **_kwargs: _provider_rows(invalid_open_time)
    )

    rows = service.get_contract_klines(
        object(),
        "EURUSD_PERP",
        interval="1w",
        limit=50,
    )

    assert rows == []
    assert rows.cache_status == "UNSUPPORTED_INTERVAL"
    assert rows.provider_error_code == "ITICK_DWM_UTC_BOUNDARY_UNAVAILABLE"
    assert rows.retryable is False


def test_itick_provider_session_policy_normalizes_aapl_xau_and_eurusd_dwm_to_utc():
    service = _load_contract_market_service_module()
    cases = [
        ("STOCK", "AAPLUSDT_PERP", "AAPL", "1d", 1_784_174_400_000, 1_784_160_000_000),
        ("STOCK", "AAPLUSDT_PERP", "AAPL", "1w", 1_783_915_200_000, 1_783_900_800_000),
        ("STOCK", "AAPLUSDT_PERP", "AAPL", "1M", 1_782_878_400_000, 1_782_864_000_000),
        ("GOLD", "XAUUSDT_PERP", "XAUUSD", "1d", 1_784_174_400_000, 1_784_160_000_000),
        ("GOLD", "XAUUSDT_PERP", "XAUUSD", "1w", 1_783_915_200_000, 1_783_900_800_000),
        ("GOLD", "XAUUSDT_PERP", "XAUUSD", "1M", 1_782_878_400_000, 1_782_864_000_000),
        ("FOREX", "EURUSD_PERP", "EURUSD", "1d", 1_784_174_400_000, 1_784_160_000_000),
        ("FOREX", "EURUSD_PERP", "EURUSD", "1w", 1_783_915_200_000, 1_783_900_800_000),
        ("FOREX", "EURUSD_PERP", "EURUSD", "1M", 1_782_878_400_000, 1_782_864_000_000),
    ]
    expected_cache_intervals = {"1d": "1Dutc", "1w": "1Wutc", "1M": "1Mutc"}

    for category, symbol, provider_symbol, interval, provider_open_time, utc_open_time in cases:
        contract_symbol = _itick_contract_symbol_with_provider_session_policy(
            category=category,
            symbol=symbol,
            provider_symbol=provider_symbol,
        )
        captured = {}
        service._load_contract_symbol = lambda *_args, _contract=contract_symbol, **_kwargs: _contract
        service._tradfi_kline_cache.clear()

        def cache_first(db, **kwargs):
            captured.update(kwargs)
            return _cache_first_fetches_provider(db, **kwargs)

        service.get_klines_cache_first = cache_first
        service.itick_market_service = SimpleNamespace(
            get_stock_kline=lambda **_kwargs: _provider_rows(provider_open_time),
            get_market_kline=lambda *_args, **_kwargs: _provider_rows(provider_open_time),
        )

        rows = service.get_contract_klines(
            object(),
            symbol,
            interval=interval,
            limit=50,
        )

        assert [row["open_time"] for row in rows] == [utc_open_time]
        assert captured["interval"] == expected_cache_intervals[interval]
        assert captured["cache_policy"] == "gap_tolerant"
        assert captured["open_time_validator"](utc_open_time) is True


def test_itick_provider_session_policy_rejects_non_session_boundary():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol_with_provider_session_policy(
        category="STOCK",
        symbol="AAPLUSDT_PERP",
        provider_symbol="AAPL",
    )
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider
    service.itick_market_service = SimpleNamespace(
        get_stock_kline=lambda **_kwargs: _provider_rows(1_784_170_800_000)
    )

    rows = service.get_contract_klines(
        object(),
        "AAPLUSDT_PERP",
        interval="1d",
        limit=50,
    )

    assert rows == []
    assert rows.cache_status == "UNSUPPORTED_INTERVAL"
    assert rows.provider_error_code == "ITICK_DWM_UTC_BOUNDARY_UNAVAILABLE"


def test_itick_global_index_kline_uses_gb_namespace_and_utc_boundary():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol_with_provider_session_policy(
        category="INDEX",
        symbol="NAS100USDT_PERP",
        provider_symbol="NAS100",
    )
    open_time = 1_784_505_600_000
    captured_provider_call = {}
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider

    def get_market_kline(market, region, code, k_type, limit, **_kwargs):
        captured_provider_call.update(
            market=market,
            region=region,
            code=code,
            k_type=k_type,
            limit=limit,
        )
        return _provider_rows(open_time)

    service.itick_market_service = SimpleNamespace(get_market_kline=get_market_kline)

    rows = service.get_contract_klines(
        object(),
        "NAS100USDT_PERP",
        interval="1d",
        limit=50,
    )

    assert [row["open_time"] for row in rows] == [open_time]
    assert captured_provider_call == {
        "market": "indices",
        "region": "GB",
        "code": "NAS100",
        "k_type": 8,
        "limit": 50,
    }


def test_aapl_history_uses_stock_provider_evidence():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="STOCK",
        symbol="AAPLUSDT_PERP",
        provider_symbol="AAPL",
    )
    calls = []
    end_time_ms = 1_782_950_400_000
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider

    def get_stock_kline(**kwargs):
        calls.append(dict(kwargs))
        return _provider_rows(end_time_ms - 86_400_000)

    service.itick_market_service = SimpleNamespace(get_stock_kline=get_stock_kline)

    rows = service.get_contract_klines(
        object(),
        "AAPLUSDT_PERP",
        interval="1d",
        limit=300,
        end_time_ms=end_time_ms,
    )

    assert len(rows) == 1
    assert calls == [
        {
            "region": "US",
            "code": "AAPL",
            "kType": 8,
            "limit": 300,
            "end_time_ms": end_time_ms,
        }
    ]


def test_eurusd_history_uses_forex_provider_evidence():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="FOREX",
        symbol="EURUSD_PERP",
        provider_symbol="EURUSD",
    )
    calls = []
    end_time_ms = 1_783_900_800_000
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider

    def get_market_kline(*args, **kwargs):
        calls.append((args, dict(kwargs)))
        return _provider_rows(end_time_ms - 604_800_000)

    service.itick_market_service = SimpleNamespace(get_market_kline=get_market_kline)

    rows = service.get_contract_klines(
        object(),
        "EURUSD_PERP",
        interval="1w",
        limit=300,
        end_time_ms=end_time_ms,
    )

    assert len(rows) == 1
    assert calls == [
        (
            ("forex", "GB", "EURUSD", 9, 300),
            {"end_time_ms": end_time_ms, "timeout": 4},
        )
    ]


def test_xau_history_normalizes_symbol_and_uses_monthly_k_type():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="GOLD",
        symbol="XAUUSDT_PERP",
        provider_symbol="",
    )
    calls = []
    end_time_ms = 1_785_542_400_000
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider

    def get_market_kline(*args, **kwargs):
        calls.append((args, dict(kwargs)))
        return _provider_rows(end_time_ms - 2_678_400_000)

    service.itick_market_service = SimpleNamespace(get_market_kline=get_market_kline)

    rows = service.get_contract_klines(
        object(),
        "XAUUSDT_PERP",
        interval="1M",
        limit=300,
        end_time_ms=end_time_ms,
    )

    assert len(rows) == 1
    assert calls == [
        (
            ("forex", "GB", "XAUUSD", 10, 300),
            {"end_time_ms": end_time_ms, "timeout": 4},
        )
    ]


def test_xau_monthly_transport_failure_retries_once_and_settles_history():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol_with_provider_session_policy(
        category="GOLD",
        symbol="XAUUSDT_PERP",
        provider_symbol="XAUUSD",
    )
    provider_open_time = 1_782_878_400_000
    expected_utc_open_time = 1_782_864_000_000
    calls = []
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider

    def get_market_kline(*args, **kwargs):
        calls.append((args, dict(kwargs)))
        if len(calls) == 1:
            try:
                raise requests.ReadTimeout("transient iTick XAU monthly timeout")
            except requests.ReadTimeout as exc:
                raise service.ItickMarketServiceError(
                    "iTick stock market request failed"
                ) from exc
        return _provider_rows(provider_open_time)

    service.itick_market_service = SimpleNamespace(get_market_kline=get_market_kline)

    rows = service.get_contract_klines(
        object(),
        "XAUUSDT_PERP",
        interval="1M",
        limit=60,
    )

    assert [row["open_time"] for row in rows] == [expected_utc_open_time]
    assert [row["volume"] for row in rows] == ["5"]
    assert calls == [
        (
            ("forex", "GB", "XAUUSD", 10, 60),
            {"end_time_ms": None, "timeout": 4},
        ),
        (
            ("forex", "GB", "XAUUSD", 10, 60),
            {"end_time_ms": None, "timeout": 4},
        ),
    ]


def test_empty_history_response_does_not_enter_process_success_cache():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="STOCK",
        symbol="AAPLUSDT_PERP",
        provider_symbol="AAPL",
    )
    provider_calls = []
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider
    service._tradfi_kline_cache.clear()

    def get_stock_kline(**_kwargs):
        provider_calls.append(1)
        return {"data": []}

    service.itick_market_service = SimpleNamespace(get_stock_kline=get_stock_kline)

    first = service.get_contract_klines(object(), "AAPLUSDT_PERP", interval="1d", limit=100)
    second = service.get_contract_klines(object(), "AAPLUSDT_PERP", interval="1d", limit=100)

    assert first == second == []
    assert first.cache_status == second.cache_status == "PROVIDER_EMPTY"
    assert first.provider_error_code == second.provider_error_code == "EMPTY"
    assert len(provider_calls) == 2
    assert service._tradfi_kline_cache == {}


def test_timeout_history_response_does_not_enter_process_success_cache():
    service = _load_contract_market_service_module()
    contract_symbol = _itick_contract_symbol(
        category="STOCK",
        symbol="AAPLUSDT_PERP",
        provider_symbol="AAPL",
    )
    provider_calls = []
    service._load_contract_symbol = lambda *_args, **_kwargs: contract_symbol
    service.get_klines_cache_first = _cache_first_fetches_provider
    service._tradfi_kline_cache.clear()

    def get_stock_kline(**_kwargs):
        provider_calls.append(1)
        raise TimeoutError("provider timeout")

    service.itick_market_service = SimpleNamespace(get_stock_kline=get_stock_kline)

    first = service.get_contract_klines(object(), "AAPLUSDT_PERP", interval="1d", limit=100)
    second = service.get_contract_klines(object(), "AAPLUSDT_PERP", interval="1d", limit=100)

    assert first == second == []
    assert first.cache_status == second.cache_status == "TIMEOUT"
    assert first.provider_error_code == second.provider_error_code == "TIMEOUT"
    assert len(provider_calls) == 2
    assert service._tradfi_kline_cache == {}


def test_monthly_history_response_preserves_terminal_metadata():
    service = _load_contract_market_service_module()
    service._load_contract_symbol = lambda *_args, **_kwargs: _itick_contract_symbol(
        category="INDEX"
    )
    service._contract_provider_symbol = lambda *_args, **_kwargs: "US30"
    service._is_stock_contract_config = lambda *_args, **_kwargs: False
    captured = {}

    def cache_first(_db, **kwargs):
        captured.update(kwargs)
        return _SharedKlineCacheResult(
            [],
            origin="EMPTY",
            cache_status="HISTORY_BOUNDARY",
            history_terminal=True,
            terminal_reason="PROVIDER_HISTORY_BOUNDARY",
            earliest_available_time=1_514_764_800_000,
            coverage_complete=True,
        )

    service.get_klines_cache_first = cache_first
    end_time_ms = 1_514_764_800_000

    rows = service.get_contract_klines(
        object(),
        "US30_PERP",
        interval="1M",
        limit=300,
        end_time_ms=end_time_ms,
    )
    from app.services.contract_kline_response import build_contract_kline_metadata

    metadata = build_contract_kline_metadata(rows, end_time_ms=end_time_ms)

    assert captured["interval"] == "1Mutc"
    assert captured["limit"] == 300
    assert captured["end_time_ms"] == end_time_ms
    assert rows.history_terminal is True
    assert rows.terminal_reason == "PROVIDER_HISTORY_BOUNDARY"
    assert rows.earliest_available_time == 1_514_764_800_000
    assert rows.coverage_complete is True
    assert metadata["history_terminal"] is True
    assert metadata["terminal_reason"] == "PROVIDER_HISTORY_BOUNDARY"
    assert metadata["earliest_available_time"] == 1_514_764_800_000
    assert metadata["coverage_complete"] is True


if __name__ == "__main__":
    tests = [
        test_contract_ws_interval_normalization_and_subscription_preserve_monthly,
        test_okx_swap_history_endpoint_is_distinct_from_current_candles,
        test_okx_current_request_uses_candles_without_history_cursor,
        test_okx_history_request_uses_history_endpoint_after_and_strict_boundary,
        test_btc_monthly_current_returns_provider_rows,
        test_btc_monthly_history_pagination_uses_cursor,
        test_btc_monthly_history_beyond_earliest_raises_provider_boundary,
        test_btc_monthly_explicit_empty_fallback_repeats_without_provider_cooldown,
        test_btc_monthly_timeout_and_network_failures_still_trigger_cooldown,
        test_btc_monthly_provider_business_failure_still_triggers_cooldown,
        test_btc_monthly_provider_cooldown_is_not_history_boundary,
        test_btc_monthly_provider_unavailable_remains_retryable,
        test_btc_monthly_history_boundary_serializes_terminal_response,
        test_okx_latest_rows_are_not_misreported_as_history_success,
        test_contract_history_db_cache_hit_does_not_call_provider,
        test_tradfi_process_cache_path_preserves_cache_metadata,
        test_index_cache_first_path_preserves_metadata_and_skips_process_cache_write,
        test_index_unsupported_interval_does_not_write_process_cache,
        test_monthly_history_response_preserves_terminal_metadata,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} tests passed")
