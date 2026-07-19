from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
from collections import OrderedDict
from typing import Any, Callable
from uuid import uuid4

from redis import Redis

from app.core.rq import get_redis_url
from app.db.session import SessionLocal
from app.services.market_ws import MarketWsManager, market_ws_manager


logger = logging.getLogger(__name__)
SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL = "spot:public_depth_events"
SPOT_PUBLIC_DEPTH_WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"
DEFAULT_SEEN_EVENT_LIMIT = 10_000
DEFAULT_EVENT_BATCH_SIZE = 256
DEFAULT_REDIS_TIMEOUT_SECONDS = 1.0


def _default_publisher_redis_factory() -> Redis:
    return Redis.from_url(
        get_redis_url(),
        socket_connect_timeout=DEFAULT_REDIS_TIMEOUT_SECONDS,
        socket_timeout=DEFAULT_REDIS_TIMEOUT_SECONDS,
        decode_responses=False,
    )


def publish_spot_public_depth_refresh(
    symbol: str,
    *,
    reason: str,
    redis_factory: Callable[[], Any] = _default_publisher_redis_factory,
) -> bool:
    normalized_symbol = str(symbol or "").upper().strip()
    if not normalized_symbol:
        return False
    redis = None
    try:
        redis = redis_factory()
        redis.publish(
            SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL,
            json.dumps(
                {
                    "event_id": f"spot-depth-{uuid4().hex}",
                    "symbol": normalized_symbol,
                    "reason": str(reason or "unknown").strip() or "unknown",
                    "publisher_id": SPOT_PUBLIC_DEPTH_WORKER_ID,
                    "published_at_ms": int(time.time() * 1000),
                },
                separators=(",", ":"),
            ),
        )
        return True
    except Exception:
        logger.warning(
            "spot_public_depth_event_publish_failed symbol=%s reason=%s",
            normalized_symbol,
            reason,
            exc_info=True,
        )
        return False
    finally:
        if redis is not None:
            close = getattr(redis, "close", None)
            if close is not None:
                try:
                    close()
                except Exception:
                    logger.debug(
                        "spot public depth publisher redis close failed",
                        exc_info=True,
                    )


def _decode_event(data: Any) -> dict[str, Any] | None:
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")
    if isinstance(data, str):
        data = json.loads(data)
    return data if isinstance(data, dict) else None


async def _close_redis_resource(resource: Any) -> None:
    close = getattr(resource, "aclose", None) or getattr(resource, "close", None)
    if close is None:
        return
    result = close()
    if hasattr(result, "__await__"):
        await result


class SpotPublicDepthEventDispatcher:
    def __init__(
        self,
        manager: MarketWsManager = market_ws_manager,
        *,
        session_factory: Callable[[], Any] = SessionLocal,
        local_worker_id: str = SPOT_PUBLIC_DEPTH_WORKER_ID,
        seen_event_limit: int = DEFAULT_SEEN_EVENT_LIMIT,
    ) -> None:
        self._manager = manager
        self._session_factory = session_factory
        self._local_worker_id = str(local_worker_id or "").strip()
        self._seen_event_limit = max(100, int(seen_event_limit))
        self._seen_event_ids: OrderedDict[str, None] = OrderedDict()

    def _remember_event(self, event_id: str) -> None:
        if not event_id:
            return
        self._seen_event_ids[event_id] = None
        self._seen_event_ids.move_to_end(event_id)
        while len(self._seen_event_ids) > self._seen_event_limit:
            self._seen_event_ids.popitem(last=False)

    async def dispatch(self, event: dict[str, Any]) -> bool:
        publisher_id = str(event.get("publisher_id") or "").strip()
        if publisher_id and publisher_id == self._local_worker_id:
            return False

        event_id = str(event.get("event_id") or "").strip()
        if event_id and event_id in self._seen_event_ids:
            return False

        symbol = str(event.get("symbol") or "").upper().strip()
        if not symbol:
            return False
        db = self._session_factory()
        try:
            await self._manager.send_depth_update(db=db, symbol=symbol, limit=20)
            await self._manager.send_snapshot(db, symbol)
        finally:
            db.close()
        self._remember_event(event_id)
        return True


def _coalesce_events_by_symbol(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest_by_symbol: dict[str, dict[str, Any]] = {}
    for event in events:
        symbol = str(event.get("symbol") or "").upper().strip()
        if not symbol:
            continue
        latest_by_symbol[symbol] = event
    return list(latest_by_symbol.values())


def _default_redis_factory() -> Any:
    import redis.asyncio as redis_async

    return redis_async.Redis.from_url(
        get_redis_url(), socket_connect_timeout=1.0, socket_timeout=1.0, decode_responses=False
    )


class SpotPublicDepthEventSubscriber:
    def __init__(
        self,
        *,
        dispatcher: SpotPublicDepthEventDispatcher | None = None,
        redis_factory: Callable[[], Any] = _default_redis_factory,
    ) -> None:
        self.dispatcher = dispatcher or SpotPublicDepthEventDispatcher()
        self._redis_factory = redis_factory

    async def run(self, stop_event: asyncio.Event) -> None:
        retry_delay = 1.0
        while not stop_event.is_set():
            redis = None
            pubsub = None
            try:
                redis = self._redis_factory()
                pubsub = redis.pubsub()
                await pubsub.subscribe(SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL)
                retry_delay = 1.0
                while not stop_event.is_set():
                    message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if not message:
                        continue
                    events: list[dict[str, Any]] = []
                    event = _decode_event(message.get("data"))
                    if event is not None:
                        events.append(event)

                    for _ in range(DEFAULT_EVENT_BATCH_SIZE - 1):
                        if stop_event.is_set():
                            break
                        queued_message = await pubsub.get_message(
                            ignore_subscribe_messages=True,
                            timeout=0.0,
                        )
                        if not queued_message:
                            break
                        queued_event = _decode_event(queued_message.get("data"))
                        if queued_event is not None:
                            events.append(queued_event)

                    for queued_event in _coalesce_events_by_symbol(events):
                        await self.dispatcher.dispatch(queued_event)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("spot_public_depth_event_subscriber_failed", exc_info=True)
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=retry_delay)
                except asyncio.TimeoutError:
                    pass
                retry_delay = min(retry_delay * 2.0, 15.0)
            finally:
                if pubsub is not None:
                    try:
                        await pubsub.unsubscribe(SPOT_PUBLIC_DEPTH_EVENTS_CHANNEL)
                    except Exception:
                        pass
                    try:
                        await _close_redis_resource(pubsub)
                    except Exception:
                        logger.debug(
                            "spot public depth pubsub close failed",
                            exc_info=True,
                        )
                if redis is not None:
                    try:
                        await _close_redis_resource(redis)
                    except Exception:
                        logger.debug(
                            "spot public depth redis close failed",
                            exc_info=True,
                        )


_subscriber_task: asyncio.Task[None] | None = None
_subscriber_stop_event: asyncio.Event | None = None


def start_spot_public_depth_event_subscriber() -> None:
    global _subscriber_task, _subscriber_stop_event
    if _subscriber_task is not None and not _subscriber_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("spot_public_depth_event_subscriber_start_failed_no_event_loop")
        return
    _subscriber_stop_event = asyncio.Event()
    _subscriber_task = loop.create_task(SpotPublicDepthEventSubscriber().run(_subscriber_stop_event))


async def stop_spot_public_depth_event_subscriber() -> None:
    global _subscriber_task, _subscriber_stop_event
    task = _subscriber_task
    stop_event = _subscriber_stop_event
    _subscriber_task = None
    _subscriber_stop_event = None
    if stop_event is not None:
        stop_event.set()
    if task is None:
        return
    try:
        await asyncio.wait_for(task, timeout=2.0)
    except asyncio.TimeoutError:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.warning(
            "spot_public_depth_event_subscriber_shutdown_failed",
            exc_info=True,
        )
