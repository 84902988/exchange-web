from __future__ import annotations

from app.services.contract_itick_ws_subscription_plan import (
    ItickWsMarketPlan,
    ItickWsSubscriptionPlan,
)
from app.services.contract_itick_ws_transport import (
    ItickSharedWsTransport,
    build_itick_transport_commands,
    itick_reconnect_delay_seconds,
)


def _plan(market: str, revision: int, **streams: tuple[str, ...]) -> ItickWsMarketPlan:
    return ItickWsMarketPlan(
        market=market,
        revision=revision,
        symbols_by_stream=tuple(sorted((stream, tuple(sorted(symbols))) for stream, symbols in streams.items())),
    )


def test_transport_diff_batches_additions_and_removals_per_stream():
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
        {"ac": "unsubscribe", "params": "GBPUSD$GB", "types": "quote"},
        {"ac": "subscribe", "params": "XAUUSD$GB", "types": "quote"},
    ]


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
