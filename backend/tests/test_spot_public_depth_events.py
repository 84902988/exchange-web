from __future__ import annotations

import asyncio
import json

from app.services.spot_public_depth_events import (
    SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL,
    SPOT_PUBLIC_DEPTH_WORKER_ID,
    SpotPublicDepthEventDispatcher,
    SpotPublicDepthEventSubscriber,
    _coalesce_events_by_symbol,
    publish_spot_public_depth_refresh,
    publish_spot_public_trade,
)


class FakeSession:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeManager:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def send_depth_update(self, *, db, symbol, limit):
        assert limit == 20
        self.calls.append(("depth", symbol))

    async def send_snapshot(self, db, symbol):
        self.calls.append(("snapshot", symbol))

    async def send_trade(self, **kwargs):
        self.calls.append(("trade", kwargs["symbol"]))

    async def broadcast_provider_kline_update(self, symbol, interval, kline, **kwargs):
        self.calls.append(("kline", symbol))


class FakeSyncRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []
        self.closed = False

    def publish(self, channel: str, payload: str) -> int:
        self.published.append((channel, payload))
        return 1

    def close(self) -> None:
        self.closed = True


class CloseFailingSyncRedis(FakeSyncRedis):
    def close(self) -> None:
        self.closed = True
        raise RuntimeError("close failed")


class FakeAsyncPubSub:
    def __init__(self, messages, stop_event: asyncio.Event) -> None:
        self.messages = list(messages)
        self.stop_event = stop_event
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []
        self.closed = False

    async def subscribe(self, channel: str) -> None:
        self.subscribed.append(channel)

    async def unsubscribe(self, channel: str) -> None:
        self.unsubscribed.append(channel)

    async def get_message(self, **_kwargs):
        if self.messages:
            return self.messages.pop(0)
        self.stop_event.set()
        return None

    async def aclose(self) -> None:
        self.closed = True


class FakeAsyncRedis:
    def __init__(self, pubsub: FakeAsyncPubSub) -> None:
        self._pubsub = pubsub
        self.closed = False

    def pubsub(self) -> FakeAsyncPubSub:
        return self._pubsub

    async def aclose(self) -> None:
        self.closed = True


class RecordingDispatcher:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def dispatch(self, event):
        self.events.append(dict(event))
        return True


def test_dispatch_refreshes_depth_and_snapshot_for_each_api_worker():
    session = FakeSession()
    manager = FakeManager()
    dispatcher = SpotPublicDepthEventDispatcher(
        manager,  # type: ignore[arg-type]
        session_factory=lambda: session,
    )
    assert asyncio.run(dispatcher.dispatch({"symbol": "mfcusdt"})) is True
    assert manager.calls == [("depth", "MFCUSDT"), ("snapshot", "MFCUSDT")]
    assert session.closed is True


def test_dispatch_rejects_missing_symbol_without_opening_session():
    opened = False

    def session_factory():
        nonlocal opened
        opened = True
        return FakeSession()

    dispatcher = SpotPublicDepthEventDispatcher(
        FakeManager(),  # type: ignore[arg-type]
        session_factory=session_factory,
    )
    assert asyncio.run(dispatcher.dispatch({})) is False
    assert opened is False


def test_publish_includes_worker_identity_and_closes_redis_client():
    redis = FakeSyncRedis()

    assert publish_spot_public_depth_refresh(
        "btcusdt",
        reason="trade_matched",
        redis_factory=lambda: redis,
    ) is True

    assert redis.closed is True
    assert len(redis.published) == 1
    channel, encoded = redis.published[0]
    payload = json.loads(encoded)
    assert channel == SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL
    assert payload["symbol"] == "BTCUSDT"
    assert payload["reason"] == "trade_matched"
    assert payload["publisher_id"] == SPOT_PUBLIC_DEPTH_WORKER_ID
    assert payload["event_id"].startswith("spot-depth-")


def test_publish_factory_failure_is_fail_safe():
    def failing_factory():
        raise RuntimeError("redis unavailable")

    assert publish_spot_public_depth_refresh(
        "BTCUSDT",
        reason="order_changed",
        redis_factory=failing_factory,
    ) is False


def test_publish_trade_includes_fill_without_losing_decimal_text():
    redis = FakeSyncRedis()

    assert publish_spot_public_trade(
        "mfcusdt",
        price="1.2300",
        amount="4.5600",
        side="buy",
        ts=123456,
        trade_id=77,
        kline_updates=[{"interval": "1m", "kline": {"close": "1.2300"}}],
        redis_factory=lambda: redis,
    ) is True

    payload = json.loads(redis.published[0][1])
    assert payload["event_type"] == "trade"
    assert payload["symbol"] == "MFCUSDT"
    assert payload["price"] == "1.2300"
    assert payload["amount"] == "4.5600"
    assert payload["side"] == "BUY"
    assert payload["trade_id"] == 77
    assert payload["kline_updates"][0]["interval"] == "1m"
    assert redis.closed is True


def test_publish_result_is_not_overridden_by_close_failure():
    redis = CloseFailingSyncRedis()

    assert publish_spot_public_depth_refresh(
        "BTCUSDT",
        reason="order_changed",
        redis_factory=lambda: redis,
    ) is True
    assert redis.closed is True


def test_dispatch_skips_event_published_by_same_worker():
    opened = False

    def session_factory():
        nonlocal opened
        opened = True
        return FakeSession()

    dispatcher = SpotPublicDepthEventDispatcher(
        FakeManager(),  # type: ignore[arg-type]
        session_factory=session_factory,
        local_worker_id="worker-a",
    )

    assert asyncio.run(
        dispatcher.dispatch(
            {
                "event_id": "depth-1",
                "symbol": "BTCUSDT",
                "publisher_id": "worker-a",
            }
        )
    ) is False
    assert opened is False


def test_dispatches_local_trade_on_api_event_loop_before_market_refresh():
    session = FakeSession()
    manager = FakeManager()
    dispatcher = SpotPublicDepthEventDispatcher(
        manager,  # type: ignore[arg-type]
        session_factory=lambda: session,
        local_worker_id="worker-a",
    )

    event = {
        "event_id": "trade-1",
        "event_type": "trade",
        "symbol": "mfcusdt",
        "publisher_id": "worker-a",
        "price": "1.23",
        "amount": "4.56",
        "side": "BUY",
        "ts": 123456,
        "trade_id": 77,
        "kline_updates": [{"interval": "1m", "kline": {"close": "1.23"}}],
    }
    assert asyncio.run(dispatcher.dispatch(event)) is True
    assert manager.calls == [
        ("trade", "MFCUSDT"),
        ("kline", "MFCUSDT"),
        ("depth", "MFCUSDT"),
        ("snapshot", "MFCUSDT"),
    ]
    assert session.closed is True


def test_dispatch_rejects_duplicate_event_id():
    sessions: list[FakeSession] = []

    def session_factory():
        session = FakeSession()
        sessions.append(session)
        return session

    manager = FakeManager()
    dispatcher = SpotPublicDepthEventDispatcher(
        manager,  # type: ignore[arg-type]
        session_factory=session_factory,
        local_worker_id="worker-a",
    )
    event = {
        "event_id": "depth-duplicate",
        "symbol": "BTCUSDT",
        "publisher_id": "worker-b",
    }

    assert asyncio.run(dispatcher.dispatch(event)) is True
    assert asyncio.run(dispatcher.dispatch(event)) is False
    assert manager.calls == [("depth", "BTCUSDT"), ("snapshot", "BTCUSDT")]
    assert len(sessions) == 1
    assert sessions[0].closed is True


def test_coalesce_events_keeps_latest_event_per_symbol():
    events = _coalesce_events_by_symbol(
        [
            {"event_id": "btc-1", "symbol": "btcusdt"},
            {"event_id": "eth-1", "symbol": "ETHUSDT"},
            {"event_id": "btc-2", "symbol": "BTCUSDT"},
            {"event_id": "missing"},
        ]
    )

    assert [event["event_id"] for event in events] == ["btc-2", "eth-1"]


def test_coalesce_never_drops_trade_events_or_their_order():
    events = _coalesce_events_by_symbol(
        [
            {"event_id": "depth-1", "symbol": "MFCUSDT"},
            {"event_id": "trade-1", "event_type": "trade", "symbol": "MFCUSDT"},
            {"event_id": "trade-2", "event_type": "trade", "symbol": "mfcusdt"},
            {"event_id": "depth-2", "symbol": "MFCUSDT"},
        ]
    )

    assert [event["event_id"] for event in events] == ["trade-1", "trade-2", "depth-2"]


def test_subscriber_coalesces_queued_symbols_and_closes_resources():
    async def run():
        stop_event = asyncio.Event()
        pubsub = FakeAsyncPubSub(
            [
                {"data": json.dumps({"event_id": "btc-1", "symbol": "BTCUSDT"})},
                {"data": json.dumps({"event_id": "btc-2", "symbol": "btcusdt"})},
                {"data": json.dumps({"event_id": "eth-1", "symbol": "ETHUSDT"})},
            ],
            stop_event,
        )
        redis = FakeAsyncRedis(pubsub)
        dispatcher = RecordingDispatcher()
        subscriber = SpotPublicDepthEventSubscriber(
            dispatcher=dispatcher,  # type: ignore[arg-type]
            redis_factory=lambda: redis,
        )

        await subscriber.run(stop_event)

        assert [event["event_id"] for event in dispatcher.events] == ["btc-2", "eth-1"]
        assert pubsub.subscribed == [SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL]
        assert pubsub.unsubscribed == [SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL]
        assert pubsub.closed is True
        assert redis.closed is True

    asyncio.run(run())
