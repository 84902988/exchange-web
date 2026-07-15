from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable
from uuid import uuid4

from redis import Redis
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.rq import get_redis_url
from app.db.models.spot_private_event import SpotPrivateEvent
from app.db.session import SessionLocal
from app.services.service_heartbeat import beat_service_heartbeat
from app.services.spot_private_event_bridge import (
    SPOT_PRIVATE_EVENT_PENDING,
    SPOT_PRIVATE_EVENT_PUBLISHED,
    SPOT_PRIVATE_EVENTS_CHANNEL,
    envelope_from_event,
)


logger = logging.getLogger(__name__)

SPOT_PRIVATE_EVENT_RELAY_SERVICE = "spot_private_event_relay"
SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY = "service:lock:spot_private_event_relay"
DEFAULT_RELAY_LOCK_TTL_SECONDS = 30
DEFAULT_RELAY_POLL_INTERVAL_SECONDS = 0.2
DEFAULT_RELAY_FAILURE_RETRY_SECONDS = 1.0
DEFAULT_RELAY_BATCH_SIZE = 100
DEFAULT_RELAY_REDIS_CONNECT_TIMEOUT_SECONDS = 1.0
DEFAULT_RELAY_REDIS_SOCKET_TIMEOUT_SECONDS = 1.0
DEFAULT_RELAY_SHUTDOWN_TIMEOUT_SECONDS = 2.0
DEFAULT_RELAY_INFLIGHT_TIMEOUT_SECONDS = 2.0
DEFAULT_RELAY_RELEASE_TIMEOUT_SECONDS = 1.5

_RENEW_LOCK_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
end
return 0
"""

_RELEASE_LOCK_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
end
return 0
"""


class SpotPrivateEventPublishError(RuntimeError):
    pass


@dataclass(frozen=True)
class SpotPrivateEventRelayResult:
    active: bool
    published: int = 0
    failed: int = 0
    pending: int = 0


def _default_relay_redis_factory() -> Redis:
    return Redis.from_url(
        get_redis_url(),
        socket_connect_timeout=DEFAULT_RELAY_REDIS_CONNECT_TIMEOUT_SECONDS,
        socket_timeout=DEFAULT_RELAY_REDIS_SOCKET_TIMEOUT_SECONDS,
        decode_responses=False,
    )


def _close_redis(redis: Any) -> None:
    close = getattr(redis, "close", None)
    if close is not None:
        close()


class SpotPrivateEventRelay:
    def __init__(
        self,
        *,
        session_factory: Callable[[], Session] = SessionLocal,
        redis_factory: Callable[[], Any] = _default_relay_redis_factory,
        poll_interval_seconds: float = DEFAULT_RELAY_POLL_INTERVAL_SECONDS,
        lock_ttl_seconds: int = DEFAULT_RELAY_LOCK_TTL_SECONDS,
        batch_size: int = DEFAULT_RELAY_BATCH_SIZE,
        failure_retry_seconds: float = DEFAULT_RELAY_FAILURE_RETRY_SECONDS,
        owner_id: str | None = None,
        lock_token: str | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._redis_factory = redis_factory
        self.poll_interval_seconds = max(0.05, float(poll_interval_seconds))
        self.lock_ttl_seconds = max(5, int(lock_ttl_seconds))
        self.batch_size = max(1, int(batch_size))
        self.failure_retry_seconds = max(
            self.poll_interval_seconds,
            float(failure_retry_seconds),
        )
        self.owner_id = owner_id or f"{socket.gethostname()}:{os.getpid()}"
        self.lock_token = lock_token or f"{self.owner_id}:{uuid4().hex}"
        self._last_error_log_at = 0.0
        self._shutdown_requested = threading.Event()
        self._run_once_idle = threading.Event()
        self._run_once_idle.set()

    def _acquire_or_renew_lock(self, redis: Any) -> bool:
        if redis.set(
            SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY,
            self.lock_token,
            nx=True,
            ex=self.lock_ttl_seconds,
        ):
            return True
        return self._renew_lock(redis)

    def _renew_lock(self, redis: Any) -> bool:
        result = redis.eval(
            _RENEW_LOCK_SCRIPT,
            1,
            SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY,
            self.lock_token,
            self.lock_ttl_seconds,
        )
        return int(result or 0) == 1

    def _release_lock(self, redis: Any) -> bool:
        try:
            result = redis.eval(
                _RELEASE_LOCK_SCRIPT,
                1,
                SPOT_PRIVATE_EVENT_RELAY_LOCK_KEY,
                self.lock_token,
            )
            return int(result or 0) == 1
        except Exception:
            logger.debug("spot private event relay lock release failed", exc_info=True)
            return False

    def request_stop(self) -> None:
        self._shutdown_requested.set()

    def wait_until_idle(self, timeout_seconds: float) -> bool:
        return self._run_once_idle.wait(max(0.0, float(timeout_seconds)))

    def _beat(self, redis: Any, *, status: str, result: SpotPrivateEventRelayResult) -> None:
        beat_service_heartbeat(
            redis,
            SPOT_PRIVATE_EVENT_RELAY_SERVICE,
            extra_payload={
                "loop_status": status,
                "owner": self.owner_id,
                "channel": SPOT_PRIVATE_EVENTS_CHANNEL,
                "published": result.published,
                "failed": result.failed,
                "pending": result.pending,
            },
        )

    def _pending_events(self, db: Session) -> list[SpotPrivateEvent]:
        return list(
            db.execute(
                select(SpotPrivateEvent)
                .where(SpotPrivateEvent.status == SPOT_PRIVATE_EVENT_PENDING)
                .order_by(
                    SpotPrivateEvent.user_id.asc(),
                    SpotPrivateEvent.sequence.asc(),
                    SpotPrivateEvent.id.asc(),
                )
                .limit(self.batch_size)
            ).scalars()
        )

    def _publish_one(self, redis: Any, event: SpotPrivateEvent) -> None:
        encoded = json.dumps(
            envelope_from_event(event).to_dict(),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        subscriber_count = redis.publish(SPOT_PRIVATE_EVENTS_CHANNEL, encoded)
        if int(subscriber_count or 0) <= 0:
            raise SpotPrivateEventPublishError("spot private event channel has no subscribers")

    def _log_publish_failure(self, event: SpotPrivateEvent) -> None:
        now = time.monotonic()
        should_warn = now - self._last_error_log_at >= 30.0
        log = logger.warning if should_warn else logger.debug
        if should_warn:
            self._last_error_log_at = now
        log(
            "spot_private_event_publish_failed event_id=%s user_id=%s sequence=%s",
            event.event_id,
            event.user_id,
            event.sequence,
            exc_info=True,
        )

    def run_once(self) -> SpotPrivateEventRelayResult:
        if self._shutdown_requested.is_set():
            return SpotPrivateEventRelayResult(active=False)
        redis = self._redis_factory()
        try:
            if not self._acquire_or_renew_lock(redis):
                result = SpotPrivateEventRelayResult(active=False)
                return result

            db = self._session_factory()
            try:
                events = self._pending_events(db)
                published = 0
                failed = 0
                lock_owned = True
                for event in events:
                    if self._shutdown_requested.is_set():
                        lock_owned = False
                        break
                    if not self._renew_lock(redis):
                        lock_owned = False
                        logger.warning(
                            "spot_private_event_relay_lock_lost owner=%s",
                            self.owner_id,
                        )
                        break
                    try:
                        self._publish_one(redis, event)
                    except Exception:
                        event.retry_count = int(event.retry_count or 0) + 1
                        db.commit()
                        failed += 1
                        self._log_publish_failure(event)
                        break

                    event.status = SPOT_PRIVATE_EVENT_PUBLISHED
                    event.published_at = datetime.utcnow()
                    db.commit()
                    published += 1

                result = SpotPrivateEventRelayResult(
                    active=lock_owned,
                    published=published,
                    failed=failed,
                    pending=max(0, len(events) - published),
                )
                if lock_owned:
                    self._beat(redis, status="active", result=result)
                return result
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        finally:
            _close_redis(redis)

    def release_lock(self) -> bool:
        redis = self._redis_factory()
        try:
            return self._release_lock(redis)
        finally:
            _close_redis(redis)

    def _run_once_tracked(self) -> SpotPrivateEventRelayResult:
        self._run_once_idle.clear()
        try:
            return self.run_once()
        finally:
            self._run_once_idle.set()

    async def run(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set() and not self._shutdown_requested.is_set():
            delay = self.poll_interval_seconds
            try:
                result = await asyncio.to_thread(self._run_once_tracked)
                if result.failed:
                    delay = self.failure_retry_seconds
            except asyncio.CancelledError:
                raise
            except Exception:
                now = time.monotonic()
                if now - self._last_error_log_at >= 30.0:
                    self._last_error_log_at = now
                    logger.warning("spot_private_event_relay_cycle_failed", exc_info=True)
                else:
                    logger.debug("spot_private_event_relay_cycle_failed", exc_info=True)

            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=delay,
                )
            except asyncio.TimeoutError:
                pass


_relay_task: asyncio.Task[None] | None = None
_relay_stop_event: asyncio.Event | None = None
_relay_instance: SpotPrivateEventRelay | None = None


def start_spot_private_event_relay() -> None:
    global _relay_task, _relay_stop_event, _relay_instance
    if _relay_task is not None and not _relay_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("spot_private_event_relay_start_failed_no_event_loop")
        return
    _relay_stop_event = asyncio.Event()
    _relay_instance = SpotPrivateEventRelay()
    _relay_task = loop.create_task(_relay_instance.run(_relay_stop_event))


async def stop_spot_private_event_relay() -> None:
    global _relay_task, _relay_stop_event, _relay_instance
    task = _relay_task
    stop_event = _relay_stop_event
    instance = _relay_instance
    if stop_event is not None:
        stop_event.set()
    if instance is not None:
        instance.request_stop()
    if task is not None and not task.done():
        task.cancel()
    try:
        if task is not None:
            await asyncio.wait_for(
                task,
                timeout=DEFAULT_RELAY_SHUTDOWN_TIMEOUT_SECONDS,
            )
    except asyncio.CancelledError:
        pass
    except asyncio.TimeoutError:
        logger.warning("spot_private_event_relay_shutdown_timeout")
    except Exception:
        logger.warning("spot_private_event_relay_shutdown_failed", exc_info=True)

    worker_idle = True
    if instance is not None:
        try:
            worker_idle = await asyncio.to_thread(
                instance.wait_until_idle,
                DEFAULT_RELAY_INFLIGHT_TIMEOUT_SECONDS,
            )
        except Exception:
            worker_idle = False
            logger.debug(
                "spot private event relay inflight wait failed",
                exc_info=True,
            )
        if not worker_idle:
            logger.warning("spot_private_event_relay_inflight_shutdown_timeout")

    if instance is not None and worker_idle:
        release_task = asyncio.create_task(asyncio.to_thread(instance.release_lock))
        try:
            await asyncio.wait_for(
                release_task,
                timeout=DEFAULT_RELAY_RELEASE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            release_task.cancel()
            logger.warning("spot_private_event_relay_release_timeout")
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug("spot private event relay release failed", exc_info=True)

    _relay_task = None
    _relay_stop_event = None
    _relay_instance = None
