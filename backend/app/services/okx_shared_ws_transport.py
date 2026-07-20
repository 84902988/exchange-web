from __future__ import annotations

import asyncio
import json
import logging
import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

import websockets


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OkxWsSubscription:
    endpoint: str
    channel: str
    instrument: str

    def argument(self) -> dict[str, str]:
        return {"channel": self.channel, "instId": self.instrument}


class OkxSharedWsTransport:
    """One physical OKX socket per endpoint with dynamic, reference-counted routes."""

    def __init__(self, *, urls: dict[str, str], idle_timeout_seconds: float = 10.0) -> None:
        self._urls = {str(key): str(value or "").strip() for key, value in urls.items()}
        self._idle_timeout_seconds = max(5.0, float(idle_timeout_seconds))
        self._lock = threading.RLock()
        self._handlers: dict[OkxWsSubscription, dict[str, Callable[[Any], None]]] = {}
        self._revision: dict[str, int] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._stops: dict[str, threading.Event] = {}
        self._wakes: dict[str, threading.Event] = {}

    def acquire(self, subscription: OkxWsSubscription, consumer_id: str, handler: Callable[[Any], None]) -> None:
        normalized = self._normalize(subscription)
        consumer = str(consumer_id or "").strip()
        if not consumer:
            raise ValueError("OKX websocket consumer id is required")
        with self._lock:
            routes = self._handlers.setdefault(normalized, {})
            changed = consumer not in routes
            routes[consumer] = handler
            if changed:
                self._revision[normalized.endpoint] = self._revision.get(normalized.endpoint, 0) + 1
            self._notify_locked(normalized.endpoint)

    def release(self, subscription: OkxWsSubscription, consumer_id: str) -> None:
        normalized = self._normalize(subscription)
        consumer = str(consumer_id or "").strip()
        with self._lock:
            routes = self._handlers.get(normalized)
            if not routes or consumer not in routes:
                return
            routes.pop(consumer, None)
            if not routes:
                self._handlers.pop(normalized, None)
            self._revision[normalized.endpoint] = self._revision.get(normalized.endpoint, 0) + 1
            self._notify_locked(normalized.endpoint)

    def stop_all(self) -> None:
        with self._lock:
            endpoints = tuple(self._threads)
        for endpoint in endpoints:
            with self._lock:
                stop = self._stops.get(endpoint)
                wake = self._wakes.get(endpoint)
                thread = self._threads.get(endpoint)
            if stop is not None:
                stop.set()
            if wake is not None:
                wake.set()
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=3.0)

    def debug_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "physical_connection_limit": len(self._urls),
                "active_threads": sum(1 for thread in self._threads.values() if thread.is_alive()),
                "logical_subscription_count": len(self._handlers),
                "subscriptions_by_endpoint": {
                    endpoint: sum(1 for item in self._handlers if item.endpoint == endpoint)
                    for endpoint in self._urls
                },
            }

    @staticmethod
    def _normalize(subscription: OkxWsSubscription) -> OkxWsSubscription:
        normalized = OkxWsSubscription(
            endpoint=str(subscription.endpoint or "").strip().lower(),
            channel=str(subscription.channel or "").strip(),
            instrument=str(subscription.instrument or "").strip().upper(),
        )
        if not normalized.endpoint or not normalized.channel or not normalized.instrument:
            raise ValueError("invalid OKX websocket subscription")
        return normalized

    def _notify_locked(self, endpoint: str) -> None:
        wake = self._wakes.setdefault(endpoint, threading.Event())
        wake.set()
        desired = any(item.endpoint == endpoint for item in self._handlers)
        thread = self._threads.get(endpoint)
        if desired and (thread is None or not thread.is_alive()):
            stop = threading.Event()
            thread = threading.Thread(
                target=self._thread_main,
                args=(endpoint, stop, wake),
                name=f"okx-shared-ws-{endpoint}",
                daemon=True,
            )
            self._stops[endpoint] = stop
            self._threads[endpoint] = thread
            thread.start()

    def _snapshot(self, endpoint: str) -> tuple[int, frozenset[OkxWsSubscription]]:
        with self._lock:
            return self._revision.get(endpoint, 0), frozenset(
                item for item, handlers in self._handlers.items() if item.endpoint == endpoint and handlers
            )

    def _dispatch(self, endpoint: str, raw_message: Any) -> None:
        try:
            payload = json.loads(raw_message) if isinstance(raw_message, str) else raw_message
        except (TypeError, ValueError):
            return
        if not isinstance(payload, dict):
            return
        arg = payload.get("arg")
        if not isinstance(arg, dict):
            return
        key = OkxWsSubscription(endpoint, str(arg.get("channel") or ""), str(arg.get("instId") or "").upper())
        with self._lock:
            handlers = tuple((self._handlers.get(key) or {}).values())
        for handler in handlers:
            try:
                handler(raw_message)
            except Exception:
                logger.warning("okx_shared_ws_handler_failed endpoint=%s channel=%s instrument=%s", endpoint, key.channel, key.instrument, exc_info=True)

    def _thread_main(self, endpoint: str, stop: threading.Event, wake: threading.Event) -> None:
        try:
            asyncio.run(self._run(endpoint, stop, wake))
        finally:
            with self._lock:
                if self._threads.get(endpoint) is threading.current_thread():
                    self._threads.pop(endpoint, None)
                    self._stops.pop(endpoint, None)

    async def _run(self, endpoint: str, stop: threading.Event, wake: threading.Event) -> None:
        attempt = 0
        while not stop.is_set():
            _revision, desired = self._snapshot(endpoint)
            if not desired:
                return
            try:
                await self._run_connected(endpoint, stop, wake)
                attempt = 0
            except Exception as exc:
                if stop.is_set():
                    return
                if isinstance(exc, RuntimeError) and any(
                    fragment in str(exc).lower()
                    for fragment in ("cannot schedule new futures after shutdown", "event loop is closed")
                ):
                    return
                delay = min(30.0, 0.5 * (2 ** min(attempt, 6))) * random.uniform(0.8, 1.2)
                attempt += 1
                logger.warning("okx_shared_ws_reconnecting endpoint=%s delay=%.2f reason=%s", endpoint, delay, exc)
                await self._wait(stop, wake, delay)

    async def _run_connected(self, endpoint: str, stop: threading.Event, wake: threading.Event) -> None:
        url = self._urls.get(endpoint, "")
        if not url:
            raise ValueError(f"OKX websocket URL is required for {endpoint}")
        applied: frozenset[OkxWsSubscription] = frozenset()
        last_message_at = time.monotonic()
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            while not stop.is_set():
                _revision, desired = self._snapshot(endpoint)
                removed = sorted(applied - desired, key=lambda item: (item.channel, item.instrument))
                added = sorted(desired - applied, key=lambda item: (item.channel, item.instrument))
                if removed:
                    await websocket.send(json.dumps({"op": "unsubscribe", "args": [item.argument() for item in removed]}, separators=(",", ":")))
                if added:
                    await websocket.send(json.dumps({"op": "subscribe", "args": [item.argument() for item in added]}, separators=(",", ":")))
                applied = desired
                wake.clear()
                if not desired:
                    return
                try:
                    raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                except asyncio.TimeoutError as exc:
                    if time.monotonic() - last_message_at >= self._idle_timeout_seconds:
                        raise TimeoutError("OKX shared websocket business messages became idle") from exc
                    continue
                last_message_at = time.monotonic()
                self._dispatch(endpoint, raw_message)

    @staticmethod
    async def _wait(stop: threading.Event, wake: threading.Event, seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while not stop.is_set() and not wake.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
