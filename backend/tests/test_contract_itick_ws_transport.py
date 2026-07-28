from __future__ import annotations

import asyncio
import json
import threading

import pytest

from app.services.contract_itick_ws_subscription_plan import (
    ItickWsMarketPlan,
    ItickWsSubscriptionPlan,
)
from app.services.contract_itick_ws_transport import (
    ItickSharedWsTransport,
    build_itick_transport_commands,
    itick_plan_requires_reconnect,
    itick_reconnect_delay_seconds,
)


def _plan(market: str, revision: int, **streams: tuple[str, ...]) -> ItickWsMarketPlan:
    return ItickWsMarketPlan(
        market=market,
        revision=revision,
        symbols_by_stream=tuple(sorted((stream, tuple(sorted(symbols))) for stream, symbols in streams.items())),
    )


def test_transport_diff_batches_additions_without_unsupported_unsubscribe():
    previous = _plan(
        "forex",
        2,
        quote=("EURUSD$GB", "GBPUSD$GB"),
        depth=("EURUSD$GB",),
    )
    current = _plan(
        "forex",
        3,
        quote=("EURUSD$GB", "XAUUSD$GB"),
        depth=("EURUSD$GB",),
        **{"kline@1": ("EURUSD$GB", "XAUUSD$GB")},
    )

    commands = build_itick_transport_commands(previous, current)
    assert [command.payload() for command in commands] == [
        {"ac": "subscribe", "params": "EURUSD$GB,XAUUSD$GB", "types": "kline@1"},
        {"ac": "subscribe", "params": "XAUUSD$GB", "types": "quote"},
    ]


def test_transport_reconnects_when_any_applied_subscription_is_removed():
    previous = _plan(
        "stock",
        2,
        quote=("AAPL$US",),
        depth=("AAPL$US",),
    )
    addition_only = _plan(
        "stock",
        3,
        quote=("AAPL$US", "MSFT$US"),
        depth=("AAPL$US",),
    )
    switched = _plan(
        "stock",
        4,
        quote=("MSFT$US",),
        depth=("MSFT$US",),
    )

    assert itick_plan_requires_reconnect(previous, addition_only) is False
    assert itick_plan_requires_reconnect(previous, switched) is True


def test_transport_diff_rejects_cross_market_state():
    try:
        build_itick_transport_commands(_plan("forex", 1), _plan("stock", 1))
    except ValueError:
        pass
    else:
        raise AssertionError("expected cross-market plans to fail closed")


def test_reconnect_backoff_is_bounded_and_jittered():
    assert itick_reconnect_delay_seconds(0) == 0.5
    assert itick_reconnect_delay_seconds(1) == 1.0
    assert itick_reconnect_delay_seconds(20) == 30.0
    assert itick_reconnect_delay_seconds(20, jitter=0.25) == 37.5
    assert itick_reconnect_delay_seconds(20, jitter=-0.25) == 22.5


def test_transport_starts_at_most_one_thread_per_market(monkeypatch):
    plan = ItickWsSubscriptionPlan()
    plan.acquire(market="forex", symbol="EURUSD$GB", stream="quote")
    transport = ItickSharedWsTransport(
        plan=plan,
        base_url="wss://api.itick.org",
        token_provider=lambda: "test-token",
        message_handler=lambda _market, _message: None,
    )
    starts: list[str] = []

    class ThreadStub:
        def __init__(self, *, name, **_kwargs):
            self.name = name
            self._alive = False

        def start(self):
            self._alive = True
            starts.append(self.name)

        def is_alive(self):
            return self._alive

    monkeypatch.setattr("app.services.contract_itick_ws_transport.threading.Thread", ThreadStub)
    transport.notify("forex")
    transport.notify("forex")

    assert starts == ["itick-ws-forex"]


def test_transport_connection_state_is_generation_scoped(monkeypatch):
    plan = ItickWsSubscriptionPlan()
    transport = ItickSharedWsTransport(
        plan=plan,
        base_url="wss://api.itick.org",
        token_provider=lambda: "test-token",
        message_handler=lambda _market, _message: None,
    )
    now_ms = 1_720_000_000_000
    monkeypatch.setattr(
        "app.services.contract_itick_ws_transport.time.time",
        lambda: now_ms / 1000,
    )

    first_generation = transport._mark_connected("forex")
    transport._mark_message_received("forex", first_generation)
    first_state = transport.market_state("forex")

    assert first_state["connected"] is True
    assert first_state["connection_generation"] == first_generation
    assert first_state["last_message_age_ms"] == 0

    transport._mark_disconnected("forex", first_generation)
    assert transport.market_state("forex")["connected"] is False

    second_generation = transport._mark_connected("forex")
    assert second_generation == first_generation + 1
    assert transport.market_state("forex")["last_message_at_ms"] is None


def test_transport_waits_for_auth_before_subscribe_and_heartbeats_on_schedule(monkeypatch):
    plan = ItickWsSubscriptionPlan()
    plan.acquire(market="stock", symbol="AAPL$US", stream="quote")
    events: list[str] = []
    stop = threading.Event()

    class WebSocketStub:
        def __init__(self):
            self.messages = iter([
                json.dumps({"code": 1, "msg": "Connected Successfully"}),
                json.dumps({"code": 1, "resAc": "auth", "msg": "authenticated"}),
            ])

        async def recv(self):
            events.append("recv")
            return next(self.messages)

        async def send(self, raw_message):
            payload = json.loads(raw_message)
            events.append(f"send:{payload['ac']}")
            if payload["ac"] == "ping":
                stop.set()

    websocket = WebSocketStub()

    class ConnectionStub:
        async def __aenter__(self):
            return websocket

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(
        "app.services.contract_itick_ws_transport.websockets.connect",
        lambda *_args, **_kwargs: ConnectionStub(),
    )
    monotonic_values = iter([100.0, 131.0])
    monkeypatch.setattr(
        "app.services.contract_itick_ws_transport._monotonic_seconds",
        lambda: next(monotonic_values),
    )
    transport = ItickSharedWsTransport(
        plan=plan,
        base_url="wss://api.itick.org",
        token_provider=lambda: "test-token",
        message_handler=lambda _market, _message: None,
    )

    asyncio.run(transport._run_connected("stock", stop, threading.Event()))

    assert events == ["recv", "recv", "send:subscribe", "send:ping"]
    assert transport.market_state("stock")["connected"] is False


def test_transport_fails_closed_when_authentication_is_rejected(monkeypatch):
    plan = ItickWsSubscriptionPlan()
    plan.acquire(market="stock", symbol="AAPL$US", stream="quote")
    sent: list[str] = []

    class WebSocketStub:
        async def recv(self):
            return json.dumps({"code": 0, "resAc": "auth", "msg": "auth failed"})

        async def send(self, raw_message):
            sent.append(raw_message)

    class ConnectionStub:
        async def __aenter__(self):
            return WebSocketStub()

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(
        "app.services.contract_itick_ws_transport.websockets.connect",
        lambda *_args, **_kwargs: ConnectionStub(),
    )
    transport = ItickSharedWsTransport(
        plan=plan,
        base_url="wss://api.itick.org",
        token_provider=lambda: "test-token",
        message_handler=lambda _market, _message: None,
    )

    with pytest.raises(ConnectionError, match="authentication failed"):
        asyncio.run(transport._run_connected("stock", threading.Event(), threading.Event()))

    assert sent == []
    assert transport.market_state("stock")["connected"] is False


def test_transport_rebuilds_connection_instead_of_sending_unsubscribe(monkeypatch):
    plan = ItickWsSubscriptionPlan()
    plan.acquire(market="stock", symbol="AAPL$US", stream="quote")
    sent: list[dict[str, str]] = []
    connection_events: list[str] = []

    class WebSocketStub:
        def __init__(self):
            self.recv_count = 0

        async def recv(self):
            self.recv_count += 1
            if self.recv_count == 1:
                return json.dumps({"code": 1, "msg": "Connected Successfully"})
            if self.recv_count == 2:
                return json.dumps({"code": 1, "resAc": "auth", "msg": "authenticated"})
            plan.release(market="stock", symbol="AAPL$US", stream="quote")
            plan.acquire(market="stock", symbol="MSFT$US", stream="quote")
            return json.dumps({"code": 1, "data": {"s": "AAPL", "type": "quote"}})

        async def send(self, raw_message):
            sent.append(json.loads(raw_message))

    class ConnectionStub:
        async def __aenter__(self):
            connection_events.append("opened")
            return WebSocketStub()

        async def __aexit__(self, *_args):
            connection_events.append("closed")
            return False

    monkeypatch.setattr(
        "app.services.contract_itick_ws_transport.websockets.connect",
        lambda *_args, **_kwargs: ConnectionStub(),
    )
    transport = ItickSharedWsTransport(
        plan=plan,
        base_url="wss://api.itick.org",
        token_provider=lambda: "test-token",
        message_handler=lambda _market, _message: None,
    )

    asyncio.run(transport._run_connected("stock", threading.Event(), threading.Event()))

    assert sent == [{"ac": "subscribe", "params": "AAPL$US", "types": "quote"}]
    assert connection_events == ["opened", "closed"]
    assert transport.market_state("stock")["connected"] is False


def test_reconnect_backoff_is_not_skipped_by_a_stale_wake_signal(monkeypatch):
    plan = ItickWsSubscriptionPlan()
    plan.acquire(market="stock", symbol="AAPL$US", stream="quote")
    stop = threading.Event()
    wake = threading.Event()
    wake.set()
    observed_wake_states: list[bool] = []
    transport = ItickSharedWsTransport(
        plan=plan,
        base_url="wss://api.itick.org",
        token_provider=lambda: "test-token",
        message_handler=lambda _market, _message: None,
    )

    async def fail_connection(*_args):
        raise ConnectionError("provider unavailable")

    async def inspect_wait(_stop, retry_wake, _seconds):
        observed_wake_states.append(retry_wake.is_set())
        stop.set()

    monkeypatch.setattr(transport, "_run_connected", fail_connection)
    monkeypatch.setattr(transport, "_wait", inspect_wait)

    asyncio.run(transport._run_market("stock", stop, wake))

    assert observed_wake_states == [False]
