import threading

import pytest

from app.services.okx_shared_ws_transport import OkxSharedWsTransport, OkxWsSubscription


def test_shared_transport_starts_one_thread_per_endpoint(monkeypatch):
    starts = []

    class ThreadStub:
        def __init__(self, *, name, **_kwargs):
            self.name = name
            self.alive = False

        def start(self):
            self.alive = True
            starts.append(self.name)

        def is_alive(self):
            return self.alive

    monkeypatch.setattr("app.services.okx_shared_ws_transport.threading.Thread", ThreadStub)
    transport = OkxSharedWsTransport(urls={"public": "wss://public", "business": "wss://business"})
    transport.acquire(OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP"), "btc", lambda _: None)
    transport.acquire(OkxWsSubscription("public", "books", "ETH-USDT-SWAP"), "eth", lambda _: None)
    transport.acquire(OkxWsSubscription("business", "candle1m", "BTC-USDT-SWAP"), "btc-k", lambda _: None)

    assert starts == ["okx-shared-ws-public", "okx-shared-ws-business"]
    assert transport.debug_state()["logical_subscription_count"] == 3


def test_ensure_running_replaces_a_dead_owner_thread(monkeypatch):
    starts = []

    class ThreadStub:
        def __init__(self, *, name, **_kwargs):
            self.name = name
            self.alive = False

        def start(self):
            self.alive = True
            starts.append(self)

        def is_alive(self):
            return self.alive

    monkeypatch.setattr("app.services.okx_shared_ws_transport.threading.Thread", ThreadStub)
    transport = OkxSharedWsTransport(urls={"public": "wss://public"})
    subscription = OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP")
    transport.acquire(subscription, "btc", lambda _: None)
    starts[0].alive = False

    assert transport.ensure_running(subscription) is True
    assert len(starts) == 2
    assert starts[1] is transport._threads["public"]


def test_shared_transport_routes_only_matching_channel_and_instrument():
    transport = OkxSharedWsTransport(urls={"public": "wss://public"})
    received = []
    btc = OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP")
    eth = OkxWsSubscription("public", "tickers", "ETH-USDT-SWAP")
    with transport._lock:
        transport._handlers[btc] = {"btc": received.append}
        transport._handlers[eth] = {"eth": lambda _: received.append("wrong")}

    raw = '{"arg":{"channel":"tickers","instId":"BTC-USDT-SWAP"},"data":[{}]}'
    transport._dispatch("public", raw)

    assert received == [raw]


def test_release_removes_only_requested_consumer(monkeypatch):
    transport = OkxSharedWsTransport(urls={"public": "wss://public"})
    subscription = OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP")
    monkeypatch.setattr(transport, "_ensure_thread_locked", lambda _endpoint: None)
    with transport._lock:
        transport._handlers[subscription] = {"a": lambda _: None, "b": lambda _: None}
    transport.release(subscription, "a")
    with transport._lock:
        assert list(transport._handlers[subscription]) == ["b"]


def test_required_route_idle_is_not_masked_by_other_route_traffic():
    transport = OkxSharedWsTransport(
        urls={"public": "wss://public"},
        idle_timeout_seconds=5.0,
        route_idle_timeout_seconds=5.0,
    )
    books = OkxWsSubscription("public", "books", "BTC-USDT-SWAP")
    trades = OkxWsSubscription("public", "trades", "BTC-USDT-SWAP")

    with pytest.raises(TimeoutError, match="channel=books"):
        transport._raise_if_required_route_stale(
            frozenset({books, trades}),
            route_started_at={books: 100.0, trades: 100.0},
            route_last_data_at={trades: 106.0},
            now=106.0,
        )


def test_route_idle_watchdog_defaults_to_transport_idle_timeout_for_ticker():
    transport = OkxSharedWsTransport(urls={"public": "wss://public"}, idle_timeout_seconds=5.0)
    ticker = OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP")

    transport._raise_if_required_route_stale(
        frozenset({ticker}),
        route_started_at={ticker: 100.0},
        route_last_data_at={},
        now=104.9,
    )
    with pytest.raises(TimeoutError, match="channel=tickers"):
        transport._raise_if_required_route_stale(
            frozenset({ticker}),
            route_started_at={ticker: 100.0},
            route_last_data_at={},
            now=105.0,
        )


def test_trade_route_can_remain_quiet_without_forcing_reconnect():
    transport = OkxSharedWsTransport(
        urls={"public": "wss://public"},
        idle_timeout_seconds=5.0,
        route_idle_timeout_seconds=5.0,
    )
    trades = OkxWsSubscription("public", "trades", "BTC-USDT-SWAP")

    transport._raise_if_required_route_stale(
        frozenset({trades}),
        route_started_at={trades: 100.0},
        route_last_data_at={},
        now=200.0,
    )


def test_candle_route_uses_interval_safe_idle_window():
    transport = OkxSharedWsTransport(
        urls={"business": "wss://business"},
        idle_timeout_seconds=5.0,
        route_idle_timeout_seconds=5.0,
    )
    candle = OkxWsSubscription("business", "candle1m", "BTC-USDT-SWAP")

    transport._raise_if_required_route_stale(
        frozenset({candle}),
        route_started_at={candle: 100.0},
        route_last_data_at={},
        now=129.9,
    )
    with pytest.raises(TimeoutError, match="channel=candle1m"):
        transport._raise_if_required_route_stale(
            frozenset({candle}),
            route_started_at={candle: 100.0},
            route_last_data_at={},
            now=130.0,
        )


def test_worker_finalizer_restarts_when_routes_are_still_registered(monkeypatch):
    transport = OkxSharedWsTransport(urls={"public": "wss://public"})
    subscription = OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP")
    stop = threading.Event()
    wake = threading.Event()
    restarted = []

    async def finish_immediately(_endpoint, _stop, _wake):
        return None

    monkeypatch.setattr(transport, "_run", finish_immediately)
    monkeypatch.setattr(transport, "_ensure_thread_locked", restarted.append)
    with transport._lock:
        transport._handlers[subscription] = {"consumer": lambda _: None}
        transport._threads["public"] = threading.current_thread()
        transport._stops["public"] = stop

    transport._thread_main("public", stop, wake)

    assert restarted == ["public"]
    assert transport.debug_state()["restart_counts"] == {"public": 1}


def test_stop_all_clears_routes_so_finalizer_cannot_restart():
    transport = OkxSharedWsTransport(urls={"public": "wss://public"})
    subscription = OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP")
    with transport._lock:
        transport._handlers[subscription] = {"consumer": lambda _: None}

    transport.stop_all()

    with transport._lock:
        assert transport._handlers == {}
        assert transport._last_data_at == {}
