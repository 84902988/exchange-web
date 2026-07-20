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


def test_release_removes_only_requested_consumer():
    transport = OkxSharedWsTransport(urls={"public": "wss://public"})
    subscription = OkxWsSubscription("public", "tickers", "BTC-USDT-SWAP")
    with transport._lock:
        transport._handlers[subscription] = {"a": lambda _: None, "b": lambda _: None}
    transport.release(subscription, "a")
    with transport._lock:
        assert list(transport._handlers[subscription]) == ["b"]
