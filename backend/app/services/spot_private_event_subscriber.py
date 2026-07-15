from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import OrderedDict
from typing import Any, Callable

from app.core.rq import get_redis_connection, get_redis_url
from app.services.service_heartbeat import beat_service_heartbeat
from app.services.spot_private_event_bridge import SPOT_PRIVATE_EVENTS_CHANNEL
from app.services.spot_private_ws import SpotPrivateWsManager, spot_private_ws_manager


logger = logging.getLogger(__name__)

SPOT_PRIVATE_EVENT_SUBSCRIBER_SERVICE = "spot_private_event_subscriber"
DEFAULT_SEEN_EVENT_LIMIT = 10_000


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


def _beat_subscriber(status: str, dispatch_count: int) -> None:
    redis = get_redis_connection()
    try:
        beat_service_heartbeat(
            redis,
            SPOT_PRIVATE_EVENT_SUBSCRIBER_SERVICE,
            extra_payload={
                "loop_status": status,
                "channel": SPOT_PRIVATE_EVENTS_CHANNEL,
                "dispatch_count": int(dispatch_count),
            },
        )
    finally:
        close = getattr(redis, "close", None)
        if close is not None:
            close()


class SpotPrivateEventDispatcher:
    def __init__(
        self,
        manager: SpotPrivateWsManager = spot_private_ws_manager,
        *,
        seen_event_limit: int = DEFAULT_SEEN_EVENT_LIMIT,
    ) -> None:
        self._manager = manager
        self._seen_event_limit = max(100, int(seen_event_limit))
        self._seen_event_ids: OrderedDict[str, None] = OrderedDict()
        self._high_water_by_user: dict[int, int] = {}

    def _remember_event(self, event_id: str) -> None:
        self._seen_event_ids[event_id] = None
        self._seen_event_ids.move_to_end(event_id)
        while len(self._seen_event_ids) > self._seen_event_limit:
            self._seen_event_ids.popitem(last=False)

    async def dispatch(self, event: dict[str, Any]) -> bool:
        event_id = str(event.get("event_id") or "").strip()
        if not event_id or event_id in self._seen_event_ids:
            return False

        try:
            user_id = int(event.get("user_id"))
            sequence = int(event.get("sequence"))
        except (TypeError, ValueError):
            logger.warning("spot_private_event_invalid_identity event_id=%s", event_id)
            return False
        if user_id <= 0 or sequence <= 0:
            return False

        high_water = int(self._high_water_by_user.get(user_id, 0))
        if sequence <= high_water:
            self._remember_event(event_id)
            return False

        payload = event.get("payload")
        if not isinstance(payload, dict):
            logger.warning("spot_private_event_invalid_payload event_id=%s", event_id)
            return False
        symbol = str(payload.get("symbol") or "").upper().strip()
        order_payload = payload.get("order")
        if not symbol or not isinstance(order_payload, dict):
            logger.warning("spot_private_event_invalid_order_payload event_id=%s", event_id)
            return False

        await self._manager.send_order_update(user_id, symbol, order_payload)
        self._high_water_by_user[user_id] = sequence
        self._remember_event(event_id)
        return True


def _default_redis_factory() -> Any:
    import redis.asyncio as redis_async

    return redis_async.Redis.from_url(
        get_redis_url(),
        socket_connect_timeout=1.0,
        socket_timeout=1.0,
        decode_responses=False,
    )


class SpotPrivateEventSubscriber:
    def __init__(
        self,
        *,
        dispatcher: SpotPrivateEventDispatcher | None = None,
        redis_factory: Callable[[], Any] = _default_redis_factory,
        heartbeat: Callable[[str, int], Any] | None = _beat_subscriber,
        retry_delay_seconds: float = 1.0,
        max_retry_delay_seconds: float = 15.0,
    ) -> None:
        self.dispatcher = dispatcher or SpotPrivateEventDispatcher()
        self._redis_factory = redis_factory
        self._heartbeat = heartbeat
        self._retry_delay_seconds = max(0.01, float(retry_delay_seconds))
        self._max_retry_delay_seconds = max(
            self._retry_delay_seconds,
            float(max_retry_delay_seconds),
        )

    async def _beat(self, status: str, dispatch_count: int) -> None:
        if self._heartbeat is None:
            return
        result = await asyncio.to_thread(self._heartbeat, status, dispatch_count)
        if hasattr(result, "__await__"):
            await result

    async def run(self, stop_event: asyncio.Event) -> None:
        retry_delay = self._retry_delay_seconds
        last_error_log_at = 0.0
        while not stop_event.is_set():
            redis = None
            pubsub = None
            try:
                redis = self._redis_factory()
                pubsub = redis.pubsub()
                await pubsub.subscribe(SPOT_PRIVATE_EVENTS_CHANNEL)
                retry_delay = self._retry_delay_seconds
                dispatch_count = 0
                last_heartbeat_at = 0.0
                await self._beat("subscribed", dispatch_count)
                logger.info(
                    "spot_private_event_subscriber_started channel=%s",
                    SPOT_PRIVATE_EVENTS_CHANNEL,
                )

                while not stop_event.is_set():
                    now = time.monotonic()
                    if now - last_heartbeat_at >= 10.0:
                        await self._beat("subscribed", dispatch_count)
                        last_heartbeat_at = now
                    message = await pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=1.0,
                    )
                    if not message:
                        continue
                    event = _decode_event(message.get("data"))
                    if event and await self.dispatcher.dispatch(event):
                        dispatch_count += 1
            except asyncio.CancelledError:
                raise
            except Exception:
                now = time.monotonic()
                if now - last_error_log_at >= 30.0:
                    last_error_log_at = now
                    logger.warning("spot_private_event_subscriber_failed", exc_info=True)
                else:
                    logger.debug("spot_private_event_subscriber_failed", exc_info=True)
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=retry_delay)
                except asyncio.TimeoutError:
                    pass
                retry_delay = min(retry_delay * 2.0, self._max_retry_delay_seconds)
            finally:
                if pubsub is not None:
                    try:
                        await pubsub.unsubscribe(SPOT_PRIVATE_EVENTS_CHANNEL)
                    except Exception:
                        pass
                    await _close_redis_resource(pubsub)
                if redis is not None:
                    await _close_redis_resource(redis)


_subscriber_task: asyncio.Task[None] | None = None
_subscriber_stop_event: asyncio.Event | None = None
_subscriber_instance: SpotPrivateEventSubscriber | None = None


def start_spot_private_event_subscriber() -> None:
    global _subscriber_task, _subscriber_stop_event, _subscriber_instance
    if _subscriber_task is not None and not _subscriber_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("spot_private_event_subscriber_start_failed_no_event_loop")
        return
    _subscriber_stop_event = asyncio.Event()
    _subscriber_instance = SpotPrivateEventSubscriber()
    _subscriber_task = loop.create_task(_subscriber_instance.run(_subscriber_stop_event))


async def stop_spot_private_event_subscriber() -> None:
    global _subscriber_task, _subscriber_stop_event, _subscriber_instance
    task = _subscriber_task
    stop_event = _subscriber_stop_event
    _subscriber_task = None
    _subscriber_stop_event = None
    _subscriber_instance = None
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
