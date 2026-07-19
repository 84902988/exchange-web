from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.services.matching as matching_module
import app.services.spot_private_event_relay as relay_module
from app.db.base import Base
from app.db.models.spot_private_event import SpotPrivateEvent, SpotPrivateEventSequence
from app.services.spot_private_event_bridge import (
    SPOT_PRIVATE_EVENT_PENDING,
    SPOT_PRIVATE_EVENT_PUBLISHED,
    create_spot_private_event,
)
from app.services.matching import _create_matching_private_events
from app.services.spot_private_event_relay import SpotPrivateEventRelay
from app.services.spot_private_event_subscriber import (
    SpotPrivateEventDispatcher,
    SpotPrivateEventSubscriber,
)


def _session_factory():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            SpotPrivateEventSequence.__table__,
            SpotPrivateEvent.__table__,
        ],
    )
    return sessionmaker(bind=engine, expire_on_commit=False)


def _payload(order_id: int = 1, status: str = "OPEN") -> dict[str, Any]:
    return {
        "symbol": "BTCUSDT",
        "order": {
            "id": order_id,
            "symbol": "BTCUSDT",
            "status": status,
            "filled_amount": "0",
            "remaining_amount": "1",
        },
    }


def _matching_order(
    *,
    order_id: int,
    user_id: int,
    side: str,
    status: str,
    filled_amount: str,
) -> SimpleNamespace:
    amount = Decimal("1")
    filled = Decimal(filled_amount)
    now = datetime.utcnow()
    return SimpleNamespace(
        id=order_id,
        user_id=user_id,
        side=side,
        order_type="LIMIT",
        price=Decimal("100"),
        amount=amount,
        filled_amount=filled,
        avg_price=Decimal("100"),
        frozen_amount=Decimal("0"),
        executed_quote_amount=filled * Decimal("100"),
        fee_amount=Decimal("0"),
        fee_asset_id=None,
        fee_asset_symbol="USDT",
        status=status,
        created_at=now,
        updated_at=now,
    )


def _run_async(coro):
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


class FakeRedis:
    def __init__(self, *, publish_error: Exception | None = None) -> None:
        self.values: dict[str, Any] = {}
        self.published: list[tuple[str, dict[str, Any]]] = []
        self.publish_error = publish_error

    def set(self, key, value, nx=False, ex=None):
        del ex
        if nx and key in self.values:
            return False
        self.values[str(key)] = value
        return True

    def get(self, key):
        return self.values.get(str(key))

    def expire(self, key, ttl):
        del ttl
        return key in self.values

    def delete(self, key):
        self.values.pop(str(key), None)

    def eval(self, script, numkeys, key, token, *args):
        assert numkeys == 1
        if self.values.get(str(key)) != token:
            return 0
        if 'redis.call("expire"' in script:
            assert args
            return 1
        if 'redis.call("del"' in script:
            self.values.pop(str(key), None)
            return 1
        raise AssertionError("unexpected lock script")

    def publish(self, channel, encoded):
        if self.publish_error is not None:
            raise self.publish_error
        self.published.append((str(channel), json.loads(encoded)))
        return 1

    def close(self):
        return None


class FakeManager:
    def __init__(self) -> None:
        self.calls: list[tuple[int, str, dict[str, Any]]] = []
        self.balance_calls: list[int] = []

    async def send_order_update(self, user_id, symbol, order_payload):
        self.calls.append((int(user_id), str(symbol), dict(order_payload)))

    async def send_account_balances_snapshot(self, db, user_id):
        del db
        self.balance_calls.append(int(user_id))


class FailingBalanceManager(FakeManager):
    async def send_account_balances_snapshot(self, db, user_id):
        del db, user_id
        raise RuntimeError("balance snapshot failed")


class TrackingSession:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


def test_sequence_is_strictly_incremented_per_user():
    Session = _session_factory()
    db = Session()
    try:
        db.add(SpotPrivateEventSequence(user_id=7, last_sequence=100))
        db.commit()

        events = [
            create_spot_private_event(
                db,
                user_id=7,
                event_type="ORDER_UPDATE",
                payload=_payload(order_id=index),
            )
            for index in (1, 2, 3)
        ]
        db.commit()

        assert [event.sequence for event in events] == [101, 102, 103]
    finally:
        db.close()


def test_relay_publishes_in_user_sequence_order_and_marks_published():
    Session = _session_factory()
    db = Session()
    try:
        db.add(SpotPrivateEventSequence(user_id=9, last_sequence=100))
        db.commit()
        for index in (1, 2, 3):
            create_spot_private_event(
                db,
                user_id=9,
                event_type="ORDER_UPDATE",
                payload=_payload(order_id=index),
            )
        db.commit()
    finally:
        db.close()

    redis = FakeRedis()
    relay = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-a",
    )
    result = relay.run_once()

    assert result.active is True
    assert result.published == 3
    assert [item[1]["sequence"] for item in redis.published] == [101, 102, 103]

    verify_db = Session()
    try:
        statuses = verify_db.execute(
            select(SpotPrivateEvent.status).order_by(SpotPrivateEvent.sequence.asc())
        ).scalars().all()
        assert statuses == [
            SPOT_PRIVATE_EVENT_PUBLISHED,
            SPOT_PRIVATE_EVENT_PUBLISHED,
            SPOT_PRIVATE_EVENT_PUBLISHED,
        ]
    finally:
        verify_db.close()


def test_duplicate_event_is_dispatched_only_once():
    manager = FakeManager()
    dispatcher = SpotPrivateEventDispatcher(manager)  # type: ignore[arg-type]
    event = {
        "event_id": "evt-1",
        "user_id": 11,
        "sequence": 101,
        "event_type": "ORDER_PARTIAL_FILLED",
        "payload": _payload(),
    }

    async def run():
        assert await dispatcher.dispatch(event) is True
        assert await dispatcher.dispatch(event) is False
        assert await dispatcher.dispatch({**event, "event_id": "evt-2"}) is False

    _run_async(run())
    assert len(manager.calls) == 1


def test_redis_publish_failure_keeps_event_pending():
    Session = _session_factory()
    db = Session()
    try:
        create_spot_private_event(
            db,
            user_id=12,
            event_type="ORDER_UPDATE",
            payload=_payload(),
            event_id="evt-fail",
        )
        db.commit()
    finally:
        db.close()

    redis = FakeRedis(publish_error=ConnectionError("redis unavailable"))
    relay = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-failure",
    )
    result = relay.run_once()

    assert result.published == 0
    assert result.failed == 1
    verify_db = Session()
    try:
        event = verify_db.execute(select(SpotPrivateEvent)).scalar_one()
        assert event.status == SPOT_PRIVATE_EVENT_PENDING
        assert event.published_at is None
        assert event.retry_count == 1
    finally:
        verify_db.close()


def test_matching_fill_flows_outbox_relay_subscriber_to_ws_manager():
    Session = _session_factory()
    db = Session()
    try:
        _create_matching_private_events(
            db,
            symbol="BTCUSDT",
            orders=(
                _matching_order(
                    order_id=501,
                    user_id=101,
                    side="BUY",
                    status="FILLED",
                    filled_amount="1",
                ),
                _matching_order(
                    order_id=502,
                    user_id=202,
                    side="SELL",
                    status="PARTIALLY_FILLED",
                    filled_amount="0.5",
                ),
            ),
        )
        db.commit()
    finally:
        db.close()

    verify_db = Session()
    try:
        events = verify_db.execute(
            select(SpotPrivateEvent).order_by(
                SpotPrivateEvent.user_id.asc(),
                SpotPrivateEvent.sequence.asc(),
            )
        ).scalars().all()
        assert [(event.user_id, event.sequence, event.event_type) for event in events] == [
            (101, 1, "ORDER_FILLED"),
            (101, 2, "BALANCE_UPDATED"),
            (202, 1, "ORDER_PARTIAL_FILLED"),
            (202, 2, "BALANCE_UPDATED"),
        ]
        assert len({event.event_id for event in events}) == 4
    finally:
        verify_db.close()

    redis = FakeRedis()
    relay = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="matching-relay",
        lock_token="matching-token",
    )
    assert relay.run_once().published == 4

    manager = FakeManager()
    dispatcher = SpotPrivateEventDispatcher(
        manager,  # type: ignore[arg-type]
        session_factory=Session,
    )

    async def dispatch_all():
        for _channel, event in redis.published:
            assert await dispatcher.dispatch(event) is True
        for _channel, event in redis.published:
            assert await dispatcher.dispatch(event) is False

    _run_async(dispatch_all())
    assert [(item[0], item[1]) for item in manager.calls] == [
        (101, "BTCUSDT"),
        (202, "BTCUSDT"),
    ]
    assert manager.balance_calls == [101, 202]


def test_matching_private_events_rollback_with_trade_transaction():
    Session = _session_factory()
    db = Session()
    try:
        _create_matching_private_events(
            db,
            symbol="BTCUSDT",
            orders=(
                _matching_order(
                    order_id=601,
                    user_id=303,
                    side="BUY",
                    status="FILLED",
                    filled_amount="1",
                ),
                _matching_order(
                    order_id=602,
                    user_id=404,
                    side="SELL",
                    status="FILLED",
                    filled_amount="1",
                ),
            ),
        )
        assert db.execute(select(SpotPrivateEvent)).scalars().all()
        db.rollback()
    finally:
        db.close()

    verify_db = Session()
    try:
        assert verify_db.execute(select(SpotPrivateEvent)).scalars().all() == []
        assert verify_db.execute(select(SpotPrivateEventSequence)).scalars().all() == []
    finally:
        verify_db.close()


def test_matching_private_events_lock_user_sequences_in_stable_order(monkeypatch):
    calls: list[tuple[int, str]] = []

    def record_event(_db, *, user_id, event_type, payload):
        del payload
        calls.append((int(user_id), str(event_type)))

    monkeypatch.setattr(matching_module, "create_spot_private_event", record_event)
    matching_module._create_matching_private_events(
        object(),  # type: ignore[arg-type]
        symbol="BTCUSDT",
        orders=(
            _matching_order(
                order_id=702,
                user_id=202,
                side="SELL",
                status="PARTIALLY_FILLED",
                filled_amount="0.5",
            ),
            _matching_order(
                order_id=701,
                user_id=101,
                side="BUY",
                status="FILLED",
                filled_amount="1",
            ),
        ),
    )

    assert calls == [
        (101, "ORDER_FILLED"),
        (202, "ORDER_PARTIAL_FILLED"),
        (101, "BALANCE_UPDATED"),
        (202, "BALANCE_UPDATED"),
    ]


def test_balance_dispatch_closes_session_when_snapshot_fails():
    session = TrackingSession()
    dispatcher = SpotPrivateEventDispatcher(
        FailingBalanceManager(),  # type: ignore[arg-type]
        session_factory=lambda: session,  # type: ignore[arg-type]
    )

    async def dispatch_balance_event():
        try:
            await dispatcher.dispatch(
                {
                    "event_id": "balance-failure",
                    "user_id": 808,
                    "sequence": 1,
                    "event_type": "BALANCE_UPDATED",
                    "payload": {},
                }
            )
        except RuntimeError as exc:
            assert str(exc) == "balance snapshot failed"
            return
        raise AssertionError("balance snapshot failure did not propagate")

    _run_async(dispatch_balance_event())
    assert session.closed is True


def test_single_active_relay_lock_rejects_second_owner():
    Session = _session_factory()
    redis = FakeRedis()
    first = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-a",
    )
    second = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-b",
    )

    assert first.run_once().active is True
    assert second.run_once().active is False


def test_each_relay_instance_has_a_unique_lock_token():
    Session = _session_factory()
    first = SpotPrivateEventRelay(session_factory=Session, owner_id="same-process")
    second = SpotPrivateEventRelay(session_factory=Session, owner_id="same-process")

    assert first.lock_token != second.lock_token


def test_lock_renew_fails_after_expiry_and_new_owner_acquires():
    Session = _session_factory()
    redis = FakeRedis()
    first = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-a",
        lock_token="token-a",
    )
    second = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-b",
        lock_token="token-b",
    )

    assert first._acquire_or_renew_lock(redis) is True
    redis.delete(relay_module.SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY)
    assert second._acquire_or_renew_lock(redis) is True

    assert first._renew_lock(redis) is False
    assert redis.get(relay_module.SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY) == "token-b"


def test_wrong_owner_release_does_not_delete_current_lock():
    Session = _session_factory()
    redis = FakeRedis()
    first = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-a",
        lock_token="token-a",
    )
    second = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-b",
        lock_token="token-b",
    )

    assert first._acquire_or_renew_lock(redis) is True
    redis.delete(relay_module.SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY)
    assert second._acquire_or_renew_lock(redis) is True

    assert first.release_lock() is False
    assert redis.get(relay_module.SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY) == "token-b"


def test_relay_redis_client_has_bounded_timeouts(monkeypatch):
    monkeypatch.setattr(
        relay_module,
        "get_redis_url",
        lambda: "redis://localhost:6379/0",
    )
    redis = relay_module._default_relay_redis_factory()
    try:
        options = redis.connection_pool.connection_kwargs
        assert options["socket_connect_timeout"] == 1.0
        assert options["socket_timeout"] == 1.0
    finally:
        redis.close()


class SlowUnavailableRedis(FakeRedis):
    def __init__(self) -> None:
        super().__init__()
        self.closed = False

    def eval(self, script, numkeys, key, token, *args):
        del script, numkeys, key, token, args
        time.sleep(0.05)
        raise TimeoutError("redis unavailable")

    def close(self):
        self.closed = True


def test_redis_unavailable_release_closes_client():
    Session = _session_factory()
    redis = SlowUnavailableRedis()
    relay = SpotPrivateEventRelay(
        session_factory=Session,
        redis_factory=lambda: redis,
        owner_id="relay-release",
        lock_token="token-release",
    )

    assert relay.release_lock() is False
    assert redis.closed is True


def test_redis_unavailable_shutdown_is_bounded(monkeypatch):
    async def run():
        Session = _session_factory()
        redis = SlowUnavailableRedis()
        relay = SpotPrivateEventRelay(
            session_factory=Session,
            redis_factory=lambda: redis,
            owner_id="relay-shutdown",
            lock_token="token-shutdown",
        )

        async def parked_task():
            await asyncio.Event().wait()

        task = asyncio.create_task(parked_task())
        await asyncio.sleep(0)
        relay_module._relay_task = task
        relay_module._relay_stop_event = asyncio.Event()
        relay_module._relay_instance = relay
        monkeypatch.setattr(relay_module, "DEFAULT_RELAY_SHUTDOWN_TIMEOUT_SECONDS", 0.01)
        monkeypatch.setattr(relay_module, "DEFAULT_RELAY_RELEASE_TIMEOUT_SECONDS", 0.01)

        started_at = time.monotonic()
        await relay_module.stop_spot_private_event_relay()
        elapsed = time.monotonic() - started_at

        assert elapsed < 0.1
        assert relay._shutdown_requested.is_set()
        assert task.done()
        assert relay_module._relay_task is None
        assert relay_module._relay_stop_event is None
        assert relay_module._relay_instance is None

    _run_async(run())


def test_shutdown_does_not_fail_when_default_executor_is_unavailable(monkeypatch):
    async def run():
        Session = _session_factory()
        relay = SpotPrivateEventRelay(
            session_factory=Session,
            redis_factory=FakeRedis,
            owner_id="relay-executor-shutdown",
            lock_token="token-executor-shutdown",
        )

        async def parked_task():
            await asyncio.Event().wait()

        async def unavailable_to_thread(*_args, **_kwargs):
            raise RuntimeError("Executor shutdown has been called")

        task = asyncio.create_task(parked_task())
        await asyncio.sleep(0)
        relay_module._relay_task = task
        relay_module._relay_stop_event = asyncio.Event()
        relay_module._relay_instance = relay
        monkeypatch.setattr(relay_module.asyncio, "to_thread", unavailable_to_thread)

        await relay_module.stop_spot_private_event_relay()

        assert task.done()
        assert relay_module._relay_task is None
        assert relay_module._relay_stop_event is None
        assert relay_module._relay_instance is None

    _run_async(run())


def test_two_api_dispatchers_each_fan_out_to_local_manager():
    first_manager = FakeManager()
    second_manager = FakeManager()
    first = SpotPrivateEventDispatcher(first_manager)  # type: ignore[arg-type]
    second = SpotPrivateEventDispatcher(second_manager)  # type: ignore[arg-type]
    event = {
        "event_id": "evt-multi-process",
        "user_id": 13,
        "sequence": 201,
        "event_type": "ORDER_FILLED",
        "payload": _payload(order_id=88),
    }

    async def run():
        assert await first.dispatch(event) is True
        assert await second.dispatch(event) is True

    _run_async(run())
    assert len(first_manager.calls) == 1
    assert len(second_manager.calls) == 1


def test_fresh_dispatcher_after_api_restart_accepts_next_event():
    before_restart_manager = FakeManager()
    after_restart_manager = FakeManager()

    async def run():
        before_restart = SpotPrivateEventDispatcher(before_restart_manager)  # type: ignore[arg-type]
        assert await before_restart.dispatch(
            {
                "event_id": "evt-before-api-restart",
                "user_id": 15,
                "sequence": 401,
                "event_type": "ORDER_PARTIAL_FILLED",
                "payload": _payload(order_id=101),
            }
        ) is True

        after_restart = SpotPrivateEventDispatcher(after_restart_manager)  # type: ignore[arg-type]
        assert await after_restart.dispatch(
            {
                "event_id": "evt-after-api-restart",
                "user_id": 15,
                "sequence": 402,
                "event_type": "ORDER_PARTIAL_FILLED",
                "payload": _payload(order_id=101, status="PARTIALLY_FILLED"),
            }
        ) is True

    _run_async(run())
    assert len(before_restart_manager.calls) == 1
    assert len(after_restart_manager.calls) == 1


class FailingAsyncPubSub:
    async def subscribe(self, channel):
        del channel
        raise ConnectionError("subscriber restart")

    async def unsubscribe(self, channel):
        del channel

    async def close(self):
        return None


class RecoveringAsyncPubSub:
    def __init__(self, event, stop_event):
        self.event = event
        self.stop_event = stop_event
        self.delivered = False

    async def subscribe(self, channel):
        del channel

    async def get_message(self, **kwargs):
        del kwargs
        if self.delivered:
            await asyncio.sleep(0)
            return None
        self.delivered = True
        self.stop_event.set()
        return {"data": json.dumps(self.event)}

    async def unsubscribe(self, channel):
        del channel

    async def close(self):
        return None


class FakeAsyncRedis:
    def __init__(self, pubsub):
        self._pubsub = pubsub

    def pubsub(self):
        return self._pubsub

    async def close(self):
        return None


def test_subscriber_recovers_after_redis_connection_failure():
    manager = FakeManager()
    dispatcher = SpotPrivateEventDispatcher(manager)  # type: ignore[arg-type]

    async def run():
        stop_event = asyncio.Event()
        event = {
            "event_id": "evt-after-restart",
            "user_id": 14,
            "sequence": 301,
            "event_type": "ORDER_FILLED",
            "payload": _payload(order_id=99),
        }
        clients = [
            FakeAsyncRedis(FailingAsyncPubSub()),
            FakeAsyncRedis(RecoveringAsyncPubSub(event, stop_event)),
        ]

        def redis_factory():
            return clients.pop(0)

        subscriber = SpotPrivateEventSubscriber(
            dispatcher=dispatcher,
            redis_factory=redis_factory,
            heartbeat=None,
            retry_delay_seconds=0.01,
            max_retry_delay_seconds=0.02,
        )
        await asyncio.wait_for(subscriber.run(stop_event), timeout=1.0)

    _run_async(run())
    assert len(manager.calls) == 1
    assert manager.calls[0][0:2] == (14, "BTCUSDT")
