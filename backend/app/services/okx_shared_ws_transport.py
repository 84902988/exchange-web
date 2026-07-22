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

    def __init__(
        self,
        *,
        urls: dict[str, str],
        idle_timeout_seconds: float = 10.0,
        route_idle_timeout_seconds: float | None = None,
    ) -> None:
        self._urls = {str(key): str(value or "").strip() for key, value in urls.items()}
        self._idle_timeout_seconds = max(5.0, float(idle_timeout_seconds))
        route_idle_timeout = (
            self._idle_timeout_seconds
            if route_idle_timeout_seconds is None
            else float(route_idle_timeout_seconds)
        )
        self._route_idle_timeout_seconds = max(self._idle_timeout_seconds, route_idle_timeout)
        self._lock = threading.RLock()
        self._handlers: dict[OkxWsSubscription, dict[str, Callable[[Any], None]]] = {}
        self._revision: dict[str, int] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._stops: dict[str, threading.Event] = {}
        self._wakes: dict[str, threading.Event] = {}
        self._last_data_at: dict[OkxWsSubscription, float] = {}
        self._connect_counts: dict[str, int] = {}
        self._restart_counts: dict[str, int] = {}
        self._last_errors: dict[str, str] = {}

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

    def ensure_running(self, subscription: OkxWsSubscription) -> bool:
        """Keep an existing logical registration attached to a live owner thread.

        Provider services call this on their normal refresh cadence.  It closes
        the race where a previous owner exits after a replacement subscriber
        observed the still-alive thread but before that thread removed itself.
        """

        normalized = self._normalize(subscription)
        with self._lock:
            routes = self._handlers.get(normalized)
            if not routes:
                return False
            self._notify_locked(normalized.endpoint)
            return True

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
                self._last_data_at.pop(normalized, None)
            self._revision[normalized.endpoint] = self._revision.get(normalized.endpoint, 0) + 1
            self._notify_locked(normalized.endpoint)

    def stop_all(self) -> None:
        with self._lock:
            endpoints = tuple(
                set(self._threads)
                | {subscription.endpoint for subscription in self._handlers}
            )
            self._handlers.clear()
            self._last_data_at.clear()
            for endpoint in endpoints:
                self._revision[endpoint] = self._revision.get(endpoint, 0) + 1
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
        now = time.monotonic()
        with self._lock:
            return {
                "physical_connection_limit": len(self._urls),
                "active_threads": sum(1 for thread in self._threads.values() if thread.is_alive()),
                "active_threads_by_endpoint": {
                    endpoint: bool(thread is not None and thread.is_alive())
                    for endpoint, thread in self._threads.items()
                },
                "logical_subscription_count": len(self._handlers),
                "subscriptions_by_endpoint": {
                    endpoint: sum(1 for item in self._handlers if item.endpoint == endpoint)
                    for endpoint in self._urls
                },
                "route_data_age_ms": {
                    f"{item.endpoint}:{item.channel}:{item.instrument}": (
                        max(0, int((now - last_data_at) * 1000))
                        if (last_data_at := self._last_data_at.get(item)) is not None
                        else None
                    )
                    for item in self._handlers
                },
                "connect_counts": dict(self._connect_counts),
                "restart_counts": dict(self._restart_counts),
                "last_errors": dict(self._last_errors),
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
        self._ensure_thread_locked(endpoint)

    def _ensure_thread_locked(self, endpoint: str) -> None:
        desired = any(item.endpoint == endpoint for item in self._handlers)
        thread = self._threads.get(endpoint)
        if desired and (thread is None or not thread.is_alive()):
            wake = self._wakes.setdefault(endpoint, threading.Event())
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

    def _dispatch(self, endpoint: str, raw_message: Any) -> tuple[OkxWsSubscription | None, bool]:
        try:
            payload = json.loads(raw_message) if isinstance(raw_message, str) else raw_message
        except (TypeError, ValueError):
            return None, False
        if not isinstance(payload, dict):
            return None, False
        arg = payload.get("arg")
        if not isinstance(arg, dict):
            return None, False
        key = OkxWsSubscription(endpoint, str(arg.get("channel") or ""), str(arg.get("instId") or "").upper())
        has_data = "data" in payload and payload.get("data") is not None
        with self._lock:
            handlers = tuple((self._handlers.get(key) or {}).values())
            if handlers and has_data:
                self._last_data_at[key] = time.monotonic()
        for handler in handlers:
            try:
                handler(raw_message)
            except Exception:
                logger.warning("okx_shared_ws_handler_failed endpoint=%s channel=%s instrument=%s", endpoint, key.channel, key.instrument, exc_info=True)
        return (key if handlers else None), has_data

    def _thread_main(self, endpoint: str, stop: threading.Event, wake: threading.Event) -> None:
        try:
            asyncio.run(self._run(endpoint, stop, wake))
        finally:
            with self._lock:
                if self._threads.get(endpoint) is threading.current_thread():
                    self._threads.pop(endpoint, None)
                    if self._stops.get(endpoint) is stop:
                        self._stops.pop(endpoint, None)
                    if any(item.endpoint == endpoint for item in self._handlers):
                        self._restart_counts[endpoint] = self._restart_counts.get(endpoint, 0) + 1
                        self._ensure_thread_locked(endpoint)

    async def _run(self, endpoint: str, stop: threading.Event, wake: threading.Event) -> None:
        attempt = 0
        while not stop.is_set():
            # Consume the acquire/release wake that led to this iteration. A
            # later registration change can then interrupt reconnect backoff.
            wake.clear()
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
                with self._lock:
                    self._last_errors[endpoint] = str(exc)
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
        route_started_at: dict[OkxWsSubscription, float] = {}
        route_last_data_at: dict[OkxWsSubscription, float] = {}
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            with self._lock:
                self._connect_counts[endpoint] = self._connect_counts.get(endpoint, 0) + 1
                self._last_errors.pop(endpoint, None)
            while not stop.is_set():
                _revision, desired = self._snapshot(endpoint)
                removed = sorted(applied - desired, key=lambda item: (item.channel, item.instrument))
                added = sorted(desired - applied, key=lambda item: (item.channel, item.instrument))
                if removed:
                    await websocket.send(json.dumps({"op": "unsubscribe", "args": [item.argument() for item in removed]}, separators=(",", ":")))
                if added:
                    await websocket.send(json.dumps({"op": "subscribe", "args": [item.argument() for item in added]}, separators=(",", ":")))
                route_now = time.monotonic()
                for item in removed:
                    route_started_at.pop(item, None)
                    route_last_data_at.pop(item, None)
                for item in added:
                    route_started_at[item] = route_now
                    route_last_data_at.pop(item, None)
                applied = desired
                wake.clear()
                if not desired:
                    return
                try:
                    raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                except asyncio.TimeoutError as exc:
                    self._raise_if_required_route_stale(
                        applied,
                        route_started_at=route_started_at,
                        route_last_data_at=route_last_data_at,
                    )
                    if time.monotonic() - last_message_at >= self._idle_timeout_seconds:
                        raise TimeoutError("OKX shared websocket business messages became idle") from exc
                    continue
                last_message_at = time.monotonic()
                route, has_data = self._dispatch(endpoint, raw_message)
                if route is not None and has_data:
                    route_last_data_at[route] = last_message_at
                self._raise_if_required_route_stale(
                    applied,
                    route_started_at=route_started_at,
                    route_last_data_at=route_last_data_at,
                    now=last_message_at,
                )

    @staticmethod
    def _route_requires_liveness(subscription: OkxWsSubscription) -> bool:
        channel = subscription.channel.strip().lower()
        # Trade feeds can legitimately remain quiet. Order books, tickers and
        # candles are cadence-bearing OKX streams and must not be kept alive by
        # unrelated traffic on the same physical connection.
        return channel.startswith("books") or channel == "tickers" or channel.startswith("candle")

    def _route_timeout_seconds(self, subscription: OkxWsSubscription) -> float:
        if subscription.channel.strip().lower().startswith("candle"):
            return max(30.0, self._route_idle_timeout_seconds)
        return self._route_idle_timeout_seconds

    def _raise_if_required_route_stale(
        self,
        routes: frozenset[OkxWsSubscription],
        *,
        route_started_at: dict[OkxWsSubscription, float],
        route_last_data_at: dict[OkxWsSubscription, float],
        now: float | None = None,
    ) -> None:
        observed_at = time.monotonic() if now is None else float(now)
        for route in routes:
            if not self._route_requires_liveness(route):
                continue
            anchor = route_last_data_at.get(route, route_started_at.get(route, observed_at))
            if observed_at - anchor < self._route_timeout_seconds(route):
                continue
            raise TimeoutError(
                "OKX shared websocket route became idle "
                f"endpoint={route.endpoint} channel={route.channel} instrument={route.instrument}"
            )

    @staticmethod
    async def _wait(stop: threading.Event, wake: threading.Event, seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while not stop.is_set() and not wake.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
