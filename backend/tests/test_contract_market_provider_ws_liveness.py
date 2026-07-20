from __future__ import annotations

import asyncio

import pytest

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
