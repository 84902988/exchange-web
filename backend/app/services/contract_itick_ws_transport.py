from __future__ import annotations

import asyncio
import inspect
import json
import logging
import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, Optional, Tuple

import websockets

from app.services.contract_itick_ws_subscription_plan import (
    ITICK_WS_STREAMS,
    ItickWsMarketPlan,
    ItickWsSubscriptionPlan,
)


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ItickWsTransportCommand:
    action: str
    stream: str
    symbols: Tuple[str, ...]

    def payload(self) -> dict[str, str]:
        return {
            "ac": self.action,
            "params": ",".join(self.symbols),
            "types": self.stream,
        }


def build_itick_transport_commands(
    previous: ItickWsMarketPlan,
    current: ItickWsMarketPlan,
) -> Tuple[ItickWsTransportCommand, ...]:
    if previous.market != current.market:
        raise ValueError("cannot diff iTick websocket plans from different markets")
    commands: list[ItickWsTransportCommand] = []
    for stream in sorted(ITICK_WS_STREAMS):
        previous_symbols = set(previous.symbols_for(stream))
        current_symbols = set(current.symbols_for(stream))
        removed = tuple(sorted(previous_symbols - current_symbols))
        added = tuple(sorted(current_symbols - previous_symbols))
        if removed:
            commands.append(ItickWsTransportCommand("unsubscribe", stream, removed))
        if added:
            commands.append(ItickWsTransportCommand("subscribe", stream, added))
    return tuple(commands)


def itick_reconnect_delay_seconds(attempt: int, *, jitter: float = 0.0) -> float:
    safe_attempt = max(0, int(attempt or 0))
    base = min(30.0, 0.5 * (2 ** min(safe_attempt, 6)))
    safe_jitter = max(-0.25, min(float(jitter or 0.0), 0.25))
    return max(0.1, base * (1.0 + safe_jitter))


class ItickSharedWsTransport:
    """Runs one physical iTick websocket per active market plan."""

    def __init__(
        self,
        *,
        plan: ItickWsSubscriptionPlan,
        base_url: str,
        token_provider: Callable[[], str],
        message_handler: Callable[[str, Any], None],
    ) -> None:
        self._plan = plan
        self._base_url = str(base_url or "").strip().rstrip("/")
        self._token_provider = token_provider
        self._message_handler = message_handler
        self._lock = threading.RLock()
        self._threads: Dict[str, threading.Thread] = {}
        self._stops: Dict[str, threading.Event] = {}
        self._wakes: Dict[str, threading.Event] = {}

    def notify(self, market: object) -> None:
        normalized_market = self._plan.normalize_market(market)
        current = self._plan.market_plan(normalized_market)
        with self._lock:
            wake = self._wakes.setdefault(normalized_market, threading.Event())
            wake.set()
            thread = self._threads.get(normalized_market)
            if current.symbols_by_stream and (thread is None or not thread.is_alive()):
                stop = threading.Event()
                self._stops[normalized_market] = stop
                thread = threading.Thread(
                    target=self._thread_main,
                    args=(normalized_market, stop, wake),
                    name=f"itick-ws-{normalized_market}",
                    daemon=True,
                )
                self._threads[normalized_market] = thread
                thread.start()

    def stop_market(self, market: object, *, timeout_seconds: float = 3.0) -> None:
        normalized_market = self._plan.normalize_market(market)
        with self._lock:
            stop = self._stops.get(normalized_market)
            wake = self._wakes.get(normalized_market)
            thread = self._threads.get(normalized_market)
        if stop is not None:
            stop.set()
        if wake is not None:
            wake.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(0.0, float(timeout_seconds or 0.0)))
        with self._lock:
            if thread is None or not thread.is_alive():
                self._threads.pop(normalized_market, None)
                self._stops.pop(normalized_market, None)

    def stop_all(self) -> None:
        with self._lock:
            markets = tuple(self._threads)
        for market in markets:
            self.stop_market(market)

    def debug_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                market: {
                    "alive": thread.is_alive(),
                    "plan_revision": self._plan.market_plan(market).revision,
                }
                for market, thread in self._threads.items()
            }

    def _thread_main(
        self,
        market: str,
        stop: threading.Event,
        wake: threading.Event,
    ) -> None:
        try:
            asyncio.run(self._run_market(market, stop, wake))
        finally:
            with self._lock:
                current = self._threads.get(market)
                if current is threading.current_thread():
                    self._threads.pop(market, None)
                    self._stops.pop(market, None)

    async def _run_market(
        self,
        market: str,
        stop: threading.Event,
        wake: threading.Event,
    ) -> None:
        attempt = 0
        while not stop.is_set():
            desired = self._plan.market_plan(market)
            if not desired.symbols_by_stream:
                return
            try:
                await self._run_connected(market, stop, wake)
                attempt = 0
            except Exception as exc:
                if stop.is_set():
                    return
                delay = itick_reconnect_delay_seconds(
                    attempt,
                    jitter=random.uniform(-0.2, 0.2),
                )
                attempt += 1
                logger.warning(
                    "contract_itick_shared_ws_reconnecting market=%s delay=%.3f reason=%s",
                    market,
                    delay,
                    exc,
                )
                await self._wait(stop, wake, delay)

    async def _run_connected(
        self,
        market: str,
        stop: threading.Event,
        wake: threading.Event,
    ) -> None:
        if not self._base_url:
            raise ValueError("iTick websocket base URL is required")
        token = str(self._token_provider() or "").strip()
        if not token:
            raise ValueError("iTick websocket token is required")
        url = f"{self._base_url}/{market}"
        header_key = (
            "additional_headers"
            if "additional_headers" in inspect.signature(websockets.connect).parameters
            else "extra_headers"
        )
        connect_kwargs = {
            "ping_interval": 20,
            "ping_timeout": 10,
            "close_timeout": 5,
            header_key: {"token": token},
        }
        empty = ItickWsMarketPlan(market=market, revision=0, symbols_by_stream=())
        applied = empty
        async with websockets.connect(url, **connect_kwargs) as websocket:
            while not stop.is_set():
                desired = self._plan.market_plan(market)
                for command in build_itick_transport_commands(applied, desired):
                    await websocket.send(json.dumps(command.payload(), separators=(",", ":")))
                applied = desired
                wake.clear()
                if not desired.symbols_by_stream:
                    return
                try:
                    raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    if wake.is_set():
                        continue
                    await websocket.send(json.dumps({"ac": "ping", "params": str(int(time.time() * 1000))}))
                    continue
                self._message_handler(market, raw_message)

    @staticmethod
    async def _wait(stop: threading.Event, wake: threading.Event, seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while not stop.is_set() and not wake.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
