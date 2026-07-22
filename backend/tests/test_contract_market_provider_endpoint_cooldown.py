from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import contract_market_provider_service as service


class DbStub:
    def execute(self, *_args, **_kwargs):
        return None

    def flush(self):
        return None


@pytest.fixture(autouse=True)
def _clear_provider_cooldowns():
    with service._provider_cooldown_lock:
        service._provider_cooldown_until.clear()
    yield
    with service._provider_cooldown_lock:
        service._provider_cooldown_until.clear()


def _provider() -> service.MarketDataProviderConfig:
    return service.MarketDataProviderConfig(
        provider_code=service.PROVIDER_OKX_SWAP,
        provider_name="OKX Swap",
        market_type=service.MARKET_TYPE_CONTRACT,
        enabled=True,
        priority=10,
        base_url="https://www.okx.com",
        timeout_ms=3000,
        cooldown_seconds=60,
    )


def test_kline_failure_does_not_cool_down_depth_or_ticker(monkeypatch):
    calls = []
    response = SimpleNamespace(status_code=200, text="", json=lambda: {"code": "0", "data": []})
    monkeypatch.setattr(
        service,
        "_http_session",
        SimpleNamespace(get=lambda url, params, timeout: calls.append((url, params, timeout)) or response),
    )
    provider = _provider()

    service.mark_contract_market_provider_failure(
        DbStub(),
        provider.provider_code,
        RuntimeError("kline failed"),
        cooldown_seconds=60,
        endpoint_type="kline",
    )

    with pytest.raises(service.ProviderCooldownError):
        service.request_contract_market_provider_json(
            provider,
            "kline_history",
            "BTC-USDT-SWAP",
        )

    service.request_contract_market_provider_json(provider, "depth", "BTC-USDT-SWAP")
    service.request_contract_market_provider_json(provider, "ticker", "BTC-USDT-SWAP")

    assert len(calls) == 2
    assert service.is_contract_market_provider_in_cooldown(provider.provider_code, "kline") is True
    assert service.is_contract_market_provider_in_cooldown(provider.provider_code, "depth") is False
    assert service.is_contract_market_provider_in_cooldown(provider.provider_code, "ticker") is False


def test_endpoint_success_only_clears_its_own_circuit_breaker():
    provider = _provider()
    db = DbStub()
    for endpoint in ("depth", "kline"):
        service.mark_contract_market_provider_failure(
            db,
            provider.provider_code,
            RuntimeError(f"{endpoint} failed"),
            cooldown_seconds=60,
            endpoint_type=endpoint,
        )

    service.mark_contract_market_provider_success(
        db,
        provider.provider_code,
        endpoint_type="depth",
    )

    assert service.is_contract_market_provider_in_cooldown(provider.provider_code, "depth") is False
    assert service.is_contract_market_provider_in_cooldown(provider.provider_code, "kline") is True


def test_provider_wide_cooldown_remains_available_for_full_health_checks():
    provider = _provider()
    db = DbStub()
    service.mark_contract_market_provider_failure(
        db,
        provider.provider_code,
        RuntimeError("provider health check failed"),
        cooldown_seconds=60,
    )

    assert service.is_contract_market_provider_in_cooldown(provider.provider_code, "depth") is True
    assert service.is_contract_market_provider_in_cooldown(provider.provider_code, "kline") is True

    service.mark_contract_market_provider_success(db, provider.provider_code)

    assert service.is_contract_market_provider_in_cooldown(provider.provider_code) is False
