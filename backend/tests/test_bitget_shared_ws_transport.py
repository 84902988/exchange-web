from app.services.bitget_shared_ws_transport import BitgetSharedWsTransport, BitgetWsSubscription


def test_bitget_transport_starts_only_one_thread(monkeypatch):
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

    monkeypatch.setattr("app.services.bitget_shared_ws_transport.threading.Thread", ThreadStub)
    transport = BitgetSharedWsTransport(url="wss://bitget")
    transport.acquire(BitgetWsSubscription("ticker", "BTCUSDT"), "btc", lambda _: None)
    transport.acquire(BitgetWsSubscription("books15", "ETHUSDT"), "eth", lambda _: None)

    assert starts == ["bitget-shared-ws-public"]
    assert transport.debug_state()["logical_subscription_count"] == 2


def test_bitget_transport_routes_matching_domain_and_symbol():
    transport = BitgetSharedWsTransport(url="wss://bitget")
    received = []
    key = BitgetWsSubscription("ticker", "BTCUSDT")
    with transport._lock:
        transport._handlers[key] = {"btc": received.append}
    raw = '{"arg":{"instType":"SPOT","channel":"ticker","instId":"BTCUSDT"},"data":[{}]}'

    transport._dispatch(raw)

    assert received == [raw]
