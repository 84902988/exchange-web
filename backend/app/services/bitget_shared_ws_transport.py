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
class BitgetWsSubscription:
    channel: str
    instrument: str
    instrument_type: str = "SPOT"

    def argument(self) -> dict[str, str]:
        return {
            "instType": self.instrument_type,
            "channel": self.channel,
            "instId": self.instrument,
        }


class BitgetSharedWsTransport:
    """One Bitget public websocket for all active spot domains and symbols."""

    def __init__(self, *, url: str, idle_timeout_seconds: float = 10.0) -> None:
        self._url = str(url or "").strip()
        self._idle_timeout_seconds = max(5.0, float(idle_timeout_seconds))
        self._lock = threading.RLock()
        self._handlers: dict[BitgetWsSubscription, dict[str, Callable[[Any], None]]] = {}
        self._revision = 0
        self._thread: threading.Thread | None = None
        self._stop: threading.Event | None = None
        self._wake = threading.Event()

    def acquire(self, subscription: BitgetWsSubscription, consumer_id: str, handler: Callable[[Any], None]) -> None:
        normalized = self._normalize(subscription)
        consumer = str(consumer_id or "").strip()
        if not consumer:
            raise ValueError("Bitget websocket consumer id is required")
        with self._lock:
            routes = self._handlers.setdefault(normalized, {})
            changed = consumer not in routes
            routes[consumer] = handler
            if changed:
                self._revision += 1
            self._wake.set()
            if self._thread is None or not self._thread.is_alive():
                stop = threading.Event()
                self._stop = stop
                self._thread = threading.Thread(
                    target=self._thread_main,
                    args=(stop,),
                    name="bitget-shared-ws-public",
                    daemon=True,
                )
                self._thread.start()

    def release(self, subscription: BitgetWsSubscription, consumer_id: str) -> None:
        normalized = self._normalize(subscription)
        with self._lock:
            routes = self._handlers.get(normalized)
            if not routes or consumer_id not in routes:
                return
            routes.pop(consumer_id, None)
            if not routes:
                self._handlers.pop(normalized, None)
            self._revision += 1
            self._wake.set()

    def stop_all(self) -> None:
        with self._lock:
            stop, thread = self._stop, self._thread
        if stop is not None:
            stop.set()
        self._wake.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3.0)

    def debug_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "physical_connection_limit": 1,
                "thread_alive": bool(self._thread and self._thread.is_alive()),
                "logical_subscription_count": len(self._handlers),
                "revision": self._revision,
            }

    @staticmethod
    def _normalize(subscription: BitgetWsSubscription) -> BitgetWsSubscription:
        normalized = BitgetWsSubscription(
            channel=str(subscription.channel or "").strip(),
            instrument=str(subscription.instrument or "").strip().upper(),
            instrument_type=str(subscription.instrument_type or "SPOT").strip().upper(),
        )
        if not normalized.channel or not normalized.instrument:
            raise ValueError("invalid Bitget websocket subscription")
        return normalized

    def _snapshot(self) -> tuple[int, frozenset[BitgetWsSubscription]]:
        with self._lock:
            return self._revision, frozenset(item for item, handlers in self._handlers.items() if handlers)

    def _dispatch(self, raw_message: Any) -> None:
        if raw_message == "pong":
            return
        try:
            payload = json.loads(raw_message) if isinstance(raw_message, str) else raw_message
        except (TypeError, ValueError):
            return
        if not isinstance(payload, dict):
            return
        arg = payload.get("arg")
        if not isinstance(arg, dict):
            return
        key = BitgetWsSubscription(
            str(arg.get("channel") or ""),
            str(arg.get("instId") or "").upper(),
            str(arg.get("instType") or "SPOT").upper(),
        )
        with self._lock:
            handlers = tuple((self._handlers.get(key) or {}).values())
        for handler in handlers:
            try:
                handler(raw_message)
            except Exception:
                logger.warning("bitget_shared_ws_handler_failed channel=%s instrument=%s", key.channel, key.instrument, exc_info=True)

    def _thread_main(self, stop: threading.Event) -> None:
        try:
            asyncio.run(self._run(stop))
        finally:
            with self._lock:
                if self._thread is threading.current_thread():
                    self._thread = None
                    self._stop = None

    async def _run(self, stop: threading.Event) -> None:
        attempt = 0
        while not stop.is_set():
            _revision, desired = self._snapshot()
            if not desired:
                return
            try:
                await self._run_connected(stop)
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
                logger.warning("bitget_shared_ws_reconnecting delay=%.2f reason=%s", delay, exc)
                await self._wait(stop, delay)

    async def _run_connected(self, stop: threading.Event) -> None:
        if not self._url:
            raise ValueError("Bitget websocket URL is required")
        applied: frozenset[BitgetWsSubscription] = frozenset()
        last_message_at = time.monotonic()
        last_ping_at = last_message_at
        async with websockets.connect(self._url, ping_interval=None, close_timeout=5) as websocket:
            while not stop.is_set():
                _revision, desired = self._snapshot()
                removed = sorted(applied - desired, key=lambda item: (item.channel, item.instrument))
                added = sorted(desired - applied, key=lambda item: (item.channel, item.instrument))
                if removed:
                    await websocket.send(json.dumps({"op": "unsubscribe", "args": [item.argument() for item in removed]}, separators=(",", ":")))
                if added:
                    await websocket.send(json.dumps({"op": "subscribe", "args": [item.argument() for item in added]}, separators=(",", ":")))
                applied = desired
                self._wake.clear()
                if not desired:
                    return
                now = time.monotonic()
                if now - last_ping_at >= 25.0:
                    await websocket.send("ping")
                    last_ping_at = now
                try:
                    raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                except asyncio.TimeoutError as exc:
                    if time.monotonic() - last_message_at >= self._idle_timeout_seconds:
                        raise TimeoutError("Bitget shared websocket business messages became idle") from exc
                    continue
                last_message_at = time.monotonic()
                self._dispatch(raw_message)

    async def _wait(self, stop: threading.Event, seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while not stop.is_set() and not self._wake.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
