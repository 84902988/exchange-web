from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

import websockets

from app.core.config import settings
from app.schemas.market import DepthItem, DepthResponse
from app.services.contract_market_provider_service import PROVIDER_BITGET_SPOT


logger = logging.getLogger(__name__)

SPOT_PROVIDER_WS_SOURCE = "LIVE_WS"
BITGET_SPOT_DEPTH_CHANNEL = "books15"


@dataclass(frozen=True)
class SpotDepthSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    depth_limit: int
    channel: str = BITGET_SPOT_DEPTH_CHANNEL
    ws_url: Optional[str] = None


def normalize_spot_ws_symbol(value: Any) -> str:
    raw = str(value or "").strip().upper()
    return "".join(ch for ch in raw if ch.isalnum())


def spot_provider_ws_depth_enabled() -> bool:
    return bool(
        getattr(settings, "SPOT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "SPOT_PROVIDER_WS_DEPTH_ENABLED", False)
    )


def _now_ms() -> int:
    return int(time.time() * 1000)


def _depth_limit(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_DEPTH_LIMIT", 20)
    return max(1, min(int(configured or 20), 100))


def _max_age_ms(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500)
    return max(100, int(configured or 1500))


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _decimal_to_str(value: Decimal) -> str:
    return format(value.normalize(), "f") if value == value.normalize() else format(value, "f")


def _normalize_depth_side(levels: Any, *, reverse: bool, limit: int) -> list[dict[str, str]]:
    normalized: list[tuple[Decimal, Decimal]] = []
    if not isinstance(levels, list):
        return []
    for row in levels:
        price_value: Any = None
        amount_value: Any = None
        if isinstance(row, list) and len(row) >= 2:
            price_value = row[0]
            amount_value = row[1]
        elif isinstance(row, dict):
            price_value = row.get("price") or row.get("px")
            amount_value = row.get("amount") or row.get("size") or row.get("qty") or row.get("quantity")
        price = _to_decimal(price_value)
        amount = _to_decimal(amount_value)
        if price is None or amount is None or price <= 0 or amount <= 0:
            continue
        normalized.append((price, amount))
    normalized.sort(key=lambda item: item[0], reverse=reverse)
    return [
        {"price": _decimal_to_str(price), "amount": _decimal_to_str(amount)}
        for price, amount in normalized[:limit]
    ]


def _spot_provider_ts(value: Any) -> int:
    try:
        timestamp = int(value or 0)
    except Exception:
        timestamp = 0
    return timestamp if timestamp > 0 else _now_ms()


def _depth_response_from_record(record: dict[str, Any], *, limit: Optional[int] = None) -> DepthResponse:
    depth_limit = _depth_limit(limit)
    return DepthResponse(
        symbol=normalize_spot_ws_symbol(record.get("symbol")),
        price_precision=int(record.get("price_precision") or 8),
        amount_precision=int(record.get("amount_precision") or 8),
        bids=[DepthItem(**item) for item in list(record.get("bids") or [])[:depth_limit]],
        asks=[DepthItem(**item) for item in list(record.get("asks") or [])[:depth_limit]],
        ts=int(record.get("ts") or record.get("updated_at_ms") or _now_ms()),
        provider=str(record.get("provider") or PROVIDER_BITGET_SPOT),
        stale=False,
        updated_at=record.get("updated_at"),
        source=str(record.get("source") or SPOT_PROVIDER_WS_SOURCE),
        fetched_at=int(record.get("updated_at_ms") or _now_ms()),
    )


def normalize_bitget_depth_message(
    message: dict[str, Any],
    *,
    local_symbol: str,
    provider_symbol: str,
    depth_limit: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    if not isinstance(message, dict) or message.get("event"):
        return None
    data = message.get("data")
    if not isinstance(data, list) or not data:
        return None
    row = data[0]
    if not isinstance(row, dict):
        return None

    limit = _depth_limit(depth_limit)
    bids = _normalize_depth_side(row.get("bids"), reverse=True, limit=limit)
    asks = _normalize_depth_side(row.get("asks"), reverse=False, limit=limit)
    if not bids or not asks:
        return None

    now_ms = _now_ms()
    exchange_ts = _spot_provider_ts(row.get("ts"))
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_BITGET_SPOT,
        "provider_symbol": normalize_spot_ws_symbol(provider_symbol),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "bids": bids,
        "asks": asks,
        "ts": exchange_ts,
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
        "price_precision": 8,
        "amount_precision": 8,
    }


class SpotMarketProviderWsService:
    def __init__(self) -> None:
        self._depth_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._depth_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._depth_stops: dict[tuple[str, str], threading.Event] = {}
        self._depth_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._depth_generations: dict[tuple[str, str], int] = {}
        self._lock = threading.RLock()

    def get_fresh_depth(
        self,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[DepthResponse]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        now_ms = _now_ms()
        allowed_age_ms = _max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._depth_cache.items()
                if provider == PROVIDER_BITGET_SPOT and local_symbol == normalized_symbol
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return _depth_response_from_record(deepcopy(item), limit=limit)
        return None

    def set_depth_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        payload.setdefault("provider", PROVIDER_BITGET_SPOT)
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        with self._lock:
            self._depth_cache[(PROVIDER_BITGET_SPOT, normalized_symbol)] = payload

    def clear_for_tests(self) -> None:
        with self._lock:
            self._depth_cache.clear()
            self._depth_tasks.clear()
            self._depth_stops.clear()
            self._depth_connections.clear()
            self._depth_generations.clear()

    def ensure_symbol(self, symbol: str) -> None:
        if not spot_provider_ws_depth_enabled():
            return
        local_symbol = normalize_spot_ws_symbol(symbol)
        if not local_symbol:
            return
        provider_symbol = local_symbol
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            task = self._depth_tasks.get(key)
            if task is not None and task.is_alive():
                return
            generation = self._depth_generations.get(key, 0) + 1
            self._depth_generations[key] = generation
            stop_event = threading.Event()
            self._depth_stops[key] = stop_event
            subscription = SpotDepthSubscription(
                local_symbol=local_symbol,
                provider=PROVIDER_BITGET_SPOT,
                provider_symbol=provider_symbol,
                depth_limit=_depth_limit(),
                ws_url=str(getattr(settings, "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL", "") or "").strip(),
            )
            thread = threading.Thread(
                target=self._run_depth_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-depth-ws-{local_symbol}",
                daemon=True,
            )
            self._depth_tasks[key] = thread
            thread.start()

    def release_symbol(self, symbol: str) -> None:
        local_symbol = normalize_spot_ws_symbol(symbol)
        if not local_symbol:
            return
        self._stop_depth_subscription(local_symbol)

    def _stop_depth_subscription(self, local_symbol: str) -> None:
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            stop_event = self._depth_stops.pop(key, None)
            task = self._depth_tasks.pop(key, None)
            connection = self._depth_connections.pop(key, None)
            self._depth_generations[key] = self._depth_generations.get(key, 0) + 1
        if stop_event is not None:
            stop_event.set()
        if connection is not None:
            loop, websocket = connection
            if not loop.is_closed():
                try:
                    asyncio.run_coroutine_threadsafe(websocket.close(), loop)
                except Exception:
                    logger.debug("spot_provider_ws_depth_close_failed symbol=%s", local_symbol, exc_info=True)
        if task is not None and task.is_alive() and task is not threading.current_thread():
            task.join(timeout=2.0)

    def _run_depth_thread(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._depth_loop(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "spot_provider_ws_depth_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    async def _depth_loop(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set() and spot_provider_ws_depth_enabled():
            try:
                await self._run_bitget_depth_ws(subscription, stop_event, generation)
            except Exception:
                logger.warning(
                    "spot_provider_ws_depth_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                await asyncio.sleep(1.0)

    async def _run_bitget_depth_ws(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not spot_provider_ws_depth_enabled():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_BITGET_PUBLIC_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "instType": "SPOT",
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not spot_provider_ws_depth_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                if self._depth_generations.get(key) != generation:
                    stop_event.set()
                    return
                self._depth_connections[key] = (loop, websocket)
            logger.info(
                "spot_provider_ws_depth_subscription_started provider=%s symbol=%s provider_symbol=%s channel=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
                subscription.channel,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                last_ping_at = time.monotonic()
                while not stop_event.is_set() and spot_provider_ws_depth_enabled():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_bitget_depth_message(subscription, raw_message, generation)
            finally:
                with self._lock:
                    current = self._depth_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._depth_connections.pop(key, None)
                logger.info(
                    "spot_provider_ws_depth_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    def _handle_bitget_depth_message(
        self,
        subscription: SpotDepthSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("spot_provider_ws_bitget_depth_invalid_json symbol=%s", subscription.local_symbol)
            return
        record = normalize_bitget_depth_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
            depth_limit=subscription.depth_limit,
        )
        if record is None:
            return
        key = (subscription.provider, subscription.local_symbol)
        with self._lock:
            if self._depth_generations.get(key) != generation:
                return
            self._depth_cache[key] = record


spot_market_provider_ws = SpotMarketProviderWsService()


def get_spot_provider_ws_depth(
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
    limit: Optional[int] = None,
) -> Optional[DepthResponse]:
    if not spot_provider_ws_depth_enabled():
        return None
    return spot_market_provider_ws.get_fresh_depth(symbol, max_age_ms=max_age_ms, limit=limit)


def ensure_spot_provider_ws_depth(symbol: str) -> None:
    spot_market_provider_ws.ensure_symbol(symbol)


def release_spot_provider_ws_depth(symbol: str) -> None:
    spot_market_provider_ws.release_symbol(symbol)
