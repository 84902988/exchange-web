from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.services import contract_market_provider_service as provider_service
from app.services import contract_market_provider_ws as provider_ws


@pytest.fixture(autouse=True)
def _isolate_shared_okx_transport(monkeypatch):
    monkeypatch.setattr(provider_ws.OkxSharedWsTransport, "acquire", lambda *_args: None)
    monkeypatch.setattr(provider_ws.OkxSharedWsTransport, "release", lambda *_args: None)
    monkeypatch.setattr(provider_ws.OkxSharedWsTransport, "stop_all", lambda *_args: None)


class SilentWebSocket:
    async def recv(self):
        raise asyncio.TimeoutError


class MessageWebSocket:
    async def recv(self):
        return '{"event":"subscribe"}'


def test_okx_idle_watchdog_allows_short_receive_gap(monkeypatch):
    monkeypatch.setattr(provider_ws.time, "monotonic", lambda: 105.0)

    message, last_message_at = asyncio.run(
        provider_ws._recv_okx_message_with_idle_watchdog(
            SilentWebSocket(),
            last_message_at=100.0,
            idle_timeout_seconds=10.0,
        )
    )

    assert message is None
    assert last_message_at == 100.0


def test_okx_idle_watchdog_forces_reconnect_after_business_messages_stop(monkeypatch):
    monkeypatch.setattr(provider_ws.time, "monotonic", lambda: 111.0)

    with pytest.raises(provider_ws.ContractProviderWsIdleTimeout):
        asyncio.run(
            provider_ws._recv_okx_message_with_idle_watchdog(
                SilentWebSocket(),
                last_message_at=100.0,
                idle_timeout_seconds=10.0,
            )
        )


def test_okx_idle_watchdog_refreshes_timestamp_on_any_business_message(monkeypatch):
    monkeypatch.setattr(provider_ws.time, "monotonic", lambda: 207.0)

    message, last_message_at = asyncio.run(
        provider_ws._recv_okx_message_with_idle_watchdog(
            MessageWebSocket(),
            last_message_at=100.0,
            idle_timeout_seconds=10.0,
        )
    )

    assert message == '{"event":"subscribe"}'
    assert last_message_at == 207.0


def test_contract_okx_domains_share_two_physical_transports(monkeypatch):
    service = provider_ws.ContractMarketProviderWsService()
    acquired = []

    monkeypatch.setattr(
        service._okx_transport,
        "acquire",
        lambda subscription, consumer_id, handler: acquired.append((subscription, consumer_id, handler)),
    )

    service.ensure_ticker_subscription(
        local_symbol="BTCUSDT_PERP", provider="OKX_SWAP", provider_symbol="BTC-USDT-SWAP"
    )
    service.ensure_depth_subscription(
        local_symbol="BTCUSDT_PERP", provider="OKX_SWAP", provider_symbol="BTC-USDT-SWAP", depth_limit=20
    )
    service.ensure_trades_subscription(
        local_symbol="ETHUSDT_PERP", provider="OKX_SWAP", provider_symbol="ETH-USDT-SWAP", trades_limit=30
    )
    service.ensure_kline_subscription(
        local_symbol="ETHUSDT_PERP", provider="OKX_SWAP", provider_symbol="ETH-USDT-SWAP", interval="1m"
    )

    assert [item[0].endpoint for item in acquired] == ["public", "public", "public", "business"]
    assert len(service._okx_registrations) == 4
    assert service._depth_tasks == {}
    assert service._ticker_tasks == {}
    assert service._trades_tasks == {}
    assert service._kline_tasks == {}


def test_contract_okx_duplicate_ensure_reasserts_shared_transport_liveness(monkeypatch):
    service = provider_ws.ContractMarketProviderWsService()
    acquired = []
    ensured = []
    monkeypatch.setattr(
        service._okx_transport,
        "acquire",
        lambda subscription, consumer_id, handler: acquired.append((subscription, consumer_id, handler)),
    )
    monkeypatch.setattr(service._okx_transport, "ensure_running", ensured.append)

    kwargs = {
        "local_symbol": "BTCUSDT_PERP",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
    }
    service.ensure_ticker_subscription(**kwargs)
    service.ensure_ticker_subscription(**kwargs)

    assert len(acquired) == 1
    assert ensured == [acquired[0][0]]


def test_contract_okx_reacquire_uses_a_new_consumer_owner(monkeypatch):
    service = provider_ws.ContractMarketProviderWsService(generation_floor=1_000)
    acquired = []
    released = []
    monkeypatch.setattr(
        service._okx_transport,
        "acquire",
        lambda subscription, consumer_id, handler: acquired.append(
            (subscription, consumer_id, handler)
        ),
    )
    monkeypatch.setattr(
        service._okx_transport,
        "release",
        lambda subscription, consumer_id: released.append(
            (subscription, consumer_id)
        ),
    )
    kwargs = {
        "local_symbol": "BTCUSDT_PERP",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
    }

    service.ensure_ticker_subscription(**kwargs)
    service.stop_ticker_subscription(
        local_symbol="BTCUSDT_PERP",
        provider="OKX_SWAP",
    )
    service.ensure_ticker_subscription(**kwargs)

    assert len(acquired) == 2
    assert len(released) == 1
    assert released[0][1] == acquired[0][1]
    assert acquired[1][1] != acquired[0][1]


def test_rest_circuit_breaker_does_not_disable_fresh_provider_ws_depth(monkeypatch):
    service = provider_ws.ContractMarketProviderWsService()
    ensured = []
    fresh_depth = {
        "symbol": "BTCUSDT_PERP",
        "provider": "OKX_SWAP",
        "best_bid": "66219.2",
        "best_ask": "66219.3",
    }

    monkeypatch.setattr(provider_ws, "provider_ws_depth_enabled", lambda: True)
    monkeypatch.setattr(service, "_itick_depth_subscription_for_symbol", lambda *_args: None)
    monkeypatch.setattr(
        provider_ws,
        "enabled_contract_market_providers",
        lambda _db: (SimpleNamespace(provider_code="OKX_SWAP"),),
    )
    monkeypatch.setattr(
        provider_ws,
        "resolve_contract_provider_symbol",
        lambda *_args, **_kwargs: "BTC-USDT-SWAP",
    )
    monkeypatch.setattr(
        service,
        "ensure_depth_subscription",
        lambda **kwargs: ensured.append(kwargs),
    )
    monkeypatch.setattr(
        service,
        "get_fresh_provider_ws_depth",
        lambda *_args, **_kwargs: fresh_depth,
    )

    with provider_service._provider_cooldown_lock:
        provider_service._provider_cooldown_until[("OKX_SWAP", "kline")] = (
            datetime.utcnow() + timedelta(seconds=60)
        )
    try:
        result = service.select_fresh_depth_for_enabled_providers(
            object(),
            "BTCUSDT_PERP",
            ensure_subscription=True,
        )
    finally:
        with provider_service._provider_cooldown_lock:
            provider_service._provider_cooldown_until.clear()

    assert result is fresh_depth
    assert ensured == [
        {
            "local_symbol": "BTCUSDT_PERP",
            "provider": "OKX_SWAP",
            "provider_symbol": "BTC-USDT-SWAP",
            "depth_limit": provider_ws._depth_limit(),
        }
    ]


def test_process_generation_floor_prevents_backend_restart_rollback(monkeypatch):
    monkeypatch.setattr(provider_ws, "provider_ws_kline_enabled", lambda: True)
    previous_process = provider_ws.ContractMarketProviderWsService(
        generation_floor=1_000_000
    )
    restarted_process = provider_ws.ContractMarketProviderWsService(
        generation_floor=2_000_000
    )
    kwargs = {
        "local_symbol": "BTCUSDT_PERP",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "interval": "1m",
    }

    previous_process.ensure_kline_subscription(**kwargs)
    restarted_process.ensure_kline_subscription(**kwargs)

    previous_generation = previous_process.get_kline_generation(
        "BTCUSDT_PERP",
        "1m",
        provider="OKX_SWAP",
    )
    restarted_generation = restarted_process.get_kline_generation(
        "BTCUSDT_PERP",
        "1m",
        provider="OKX_SWAP",
    )

    assert previous_generation == 1_000_001
    assert restarted_generation == 2_000_001
    assert restarted_generation > previous_generation
    assert (
        0
        < provider_ws._new_provider_generation_process_floor()
        < 9_007_199_254_740_991
    )


@pytest.mark.parametrize(
    ("stream", "subscription", "generations_name", "cache_name", "generation_key", "getter"),
    (
        (
            "depth",
            provider_ws.ProviderDepthSubscription(
                local_symbol="BTCUSDT_PERP",
                provider="OKX_SWAP",
                provider_symbol="BTC-USDT-SWAP",
                depth_limit=20,
            ),
            "_depth_generations",
            "_depth_cache",
            ("OKX_SWAP", "BTCUSDT_PERP"),
            lambda service: service.get_fresh_provider_ws_depth(
                "BTCUSDT_PERP", "OKX_SWAP", max_age_ms=1_500
            ),
        ),
        (
            "trades",
            provider_ws.ProviderTradesSubscription(
                local_symbol="BTCUSDT_PERP",
                provider="OKX_SWAP",
                provider_symbol="BTC-USDT-SWAP",
                trades_limit=30,
            ),
            "_trades_generations",
            "_trades_cache",
            ("OKX_SWAP", "BTCUSDT_PERP"),
            lambda service: service.get_fresh_provider_ws_trades(
                "BTCUSDT_PERP", "OKX_SWAP", max_age_ms=1_500
            ),
        ),
        (
            "ticker",
            provider_ws.ProviderTickerSubscription(
                local_symbol="BTCUSDT_PERP",
                provider="OKX_SWAP",
                provider_symbol="BTC-USDT-SWAP",
            ),
            "_ticker_generations",
            "_ticker_cache",
            ("OKX_SWAP", "BTCUSDT_PERP"),
            lambda service: service.get_fresh_provider_ws_ticker(
                "BTCUSDT_PERP", "OKX_SWAP", max_age_ms=1_500
            ),
        ),
        (
            "kline",
            provider_ws.ProviderKlineSubscription(
                local_symbol="BTCUSDT_PERP",
                provider="OKX_SWAP",
                provider_symbol="BTC-USDT-SWAP",
                interval="1m",
                channel="candle1m",
            ),
            "_kline_generations",
            "_kline_cache",
            ("OKX_SWAP", "BTCUSDT_PERP", "1m"),
            lambda service: service.get_fresh_provider_ws_kline(
                "BTCUSDT_PERP", "1m", "OKX_SWAP", max_age_ms=1_500
            ),
        ),
    ),
)
def test_okx_reacquire_never_reuses_retired_generation_cache(
    monkeypatch,
    stream,
    subscription,
    generations_name,
    cache_name,
    generation_key,
    getter,
):
    service = provider_ws.ContractMarketProviderWsService(generation_floor=1_000)
    now_ms = 1_720_000_010_000
    monkeypatch.setattr(provider_ws.time, "time", lambda: now_ms / 1_000)

    service._ensure_okx_shared_subscription(stream=stream, subscription=subscription)
    generations = getattr(service, generations_name)
    cache = getattr(service, cache_name)
    first_generation = generations[generation_key]
    cache[generation_key] = {
        "provider": "OKX_SWAP",
        "provider_generation": first_generation,
        "updated_at_ms": now_ms,
    }
    assert getter(service) is not None

    assert service._release_okx_shared_subscription(
        stream=stream,
        local_symbol="BTCUSDT_PERP",
        interval="1m" if stream == "kline" else "",
    ) is True
    assert generations[generation_key] == first_generation + 1
    assert getter(service) is None

    service._ensure_okx_shared_subscription(stream=stream, subscription=subscription)
    current_generation = generations[generation_key]
    assert current_generation == first_generation + 2
    assert getter(service) is None

    cache[generation_key] = {
        "provider": "OKX_SWAP",
        "provider_generation": current_generation,
        "updated_at_ms": now_ms,
    }
    assert getter(service) is not None
