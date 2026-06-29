from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

import websockets
from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.contract_market_provider_service import (
    PROVIDER_BITGET_USDT_FUTURES,
    PROVIDER_OKX_SWAP,
    enabled_contract_market_providers,
    is_contract_market_provider_in_cooldown,
    resolve_contract_provider_symbol,
)


logger = logging.getLogger(__name__)

CONTRACT_PROVIDER_WS_SOURCE = "LIVE_WS"
_SUPPORTED_DEPTH_WS_PROVIDERS = {PROVIDER_OKX_SWAP}


@dataclass(frozen=True)
class ProviderDepthSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    depth_limit: int


def _normalize_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _depth_limit() -> int:
    return max(5, min(int(getattr(settings, "CONTRACT_PROVIDER_WS_DEPTH_LIMIT", 20) or 20), 100))


def _max_age_ms(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "CONTRACT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500)
    return max(100, int(configured or 1500))


def provider_ws_depth_enabled() -> bool:
    return bool(
        getattr(settings, "CONTRACT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "CONTRACT_PROVIDER_WS_DEPTH_ENABLED", False)
    )


def _sort_depth_side(levels: dict[str, Decimal], *, side: str, limit: int) -> list[list[Decimal]]:
    reverse = side == "bids"
    prices = sorted((_to_decimal(price) for price in levels.keys()), reverse=reverse)
    rows: list[list[Decimal]] = []
    for price in prices:
        if price is None:
            continue
        quantity = levels.get(format(price, "f"))
        if quantity is None or quantity <= 0:
            continue
        rows.append([price, quantity])
        if len(rows) >= limit:
            break
    return rows


def _best_depth_price(levels: list[list[Decimal]], *, side: str) -> Optional[Decimal]:
    if not levels:
        return None
    prices = [item[0] for item in levels if item and item[0] > 0]
    if not prices:
        return None
    return max(prices) if side == "bids" else min(prices)


def _normalize_okx_side(levels: Any) -> dict[str, Decimal]:
    normalized: dict[str, Decimal] = {}
    if not isinstance(levels, list):
        return normalized
    for row in levels:
        if not isinstance(row, list) or len(row) < 2:
            continue
        price = _to_decimal(row[0])
        quantity = _to_decimal(row[1])
        if price is None or quantity is None or price <= 0:
            continue
        key = format(price, "f")
        if quantity <= 0:
            normalized.pop(key, None)
        else:
            normalized[key] = quantity
    return normalized


def _merge_okx_side(current: dict[str, Decimal], updates: Any) -> None:
    if not isinstance(updates, list):
        return
    for row in updates:
        if not isinstance(row, list) or len(row) < 2:
            continue
        price = _to_decimal(row[0])
        quantity = _to_decimal(row[1])
        if price is None or quantity is None or price <= 0:
            continue
        key = format(price, "f")
        if quantity <= 0:
            current.pop(key, None)
        else:
            current[key] = quantity


class ContractMarketProviderWsService:
    def __init__(self) -> None:
        self._depth_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._depth_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._depth_stops: dict[tuple[str, str], threading.Event] = {}
        self._depth_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._depth_generations: dict[tuple[str, str], int] = {}
        self._lock = threading.RLock()

    def get_fresh_provider_ws_depth(
        self,
        symbol: str,
        provider_code: Optional[str] = None,
        *,
        max_age_ms: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_provider = _normalize_symbol(provider_code) if provider_code else None
        now_ms = int(time.time() * 1000)
        allowed_age_ms = _max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._depth_cache.items()
                if local_symbol == normalized_symbol and (normalized_provider is None or provider == normalized_provider)
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return deepcopy(item)
        return None

    def select_fresh_depth_for_enabled_providers(
        self,
        db: Session,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
        ensure_subscription: bool = False,
    ) -> Optional[dict[str, Any]]:
        if not provider_ws_depth_enabled():
            return None
        normalized_symbol = _normalize_symbol(symbol)
        for provider in enabled_contract_market_providers(db):
            provider_code = _normalize_symbol(provider.provider_code)
            if provider_code not in {PROVIDER_OKX_SWAP, PROVIDER_BITGET_USDT_FUTURES}:
                continue
            if is_contract_market_provider_in_cooldown(provider_code):
                logger.debug("contract_provider_ws_depth_skipped_cooldown provider=%s symbol=%s", provider_code, normalized_symbol)
                self.stop_depth_subscription(local_symbol=normalized_symbol, provider=provider_code)
                continue
            provider_symbol = resolve_contract_provider_symbol(
                db,
                provider_code=provider_code,
                local_symbol=normalized_symbol,
            )
            if ensure_subscription:
                self.ensure_depth_subscription(
                    local_symbol=normalized_symbol,
                    provider=provider_code,
                    provider_symbol=provider_symbol,
                    depth_limit=_depth_limit(),
                )
            depth = self.get_fresh_provider_ws_depth(
                normalized_symbol,
                provider_code,
                max_age_ms=max_age_ms,
            )
            if depth is not None:
                return depth
        return None

    def ensure_depth_subscription(
        self,
        *,
        local_symbol: str,
        provider: str,
        provider_symbol: str,
        depth_limit: int,
    ) -> None:
        if not provider_ws_depth_enabled():
            return
        normalized_symbol = _normalize_symbol(local_symbol)
        provider_code = _normalize_symbol(provider)
        normalized_provider_symbol = _normalize_symbol(provider_symbol)
        if provider_code not in _SUPPORTED_DEPTH_WS_PROVIDERS:
            logger.debug("contract_provider_ws_depth_unsupported provider=%s symbol=%s", provider_code, normalized_symbol)
            return
        key = (provider_code, normalized_symbol)
        with self._lock:
            existing = self._depth_tasks.get(key)
            if existing is not None and existing.is_alive():
                return
            logger.info(
                "contract_provider_ws_depth_subscription_starting provider=%s symbol=%s provider_symbol=%s",
                provider_code,
                normalized_symbol,
                normalized_provider_symbol,
            )
            stop_event = threading.Event()
            generation = self._depth_generations.get(key, 0) + 1
            self._depth_generations[key] = generation
            subscription = ProviderDepthSubscription(
                local_symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=normalized_provider_symbol,
                depth_limit=max(5, min(int(depth_limit or 20), 100)),
            )
            thread = threading.Thread(
                target=self._run_depth_subscription_thread,
                args=(subscription, stop_event, generation),
                name=f"contract-provider-depth-ws-{provider_code}-{normalized_symbol}",
                daemon=True,
            )
            self._depth_stops[key] = stop_event
            self._depth_tasks[key] = thread
            thread.start()

    def stop_depth_subscription(self, *, local_symbol: str, provider: str) -> None:
        key = (_normalize_symbol(provider), _normalize_symbol(local_symbol))
        with self._lock:
            stop_event = self._depth_stops.get(key)
            thread = self._depth_tasks.get(key)
            connection = self._depth_connections.get(key)
        if stop_event is None and connection is None and thread is None:
            logger.debug(
                "contract_provider_ws_depth_subscription_stop_noop provider=%s symbol=%s",
                key[0],
                key[1],
            )
            return
        logger.info(
            "contract_provider_ws_depth_subscription_stopping provider=%s symbol=%s",
            key[0],
            key[1],
        )
        if stop_event is not None:
            stop_event.set()
        self._close_depth_connection(key, connection)
        self._wait_for_depth_thread_exit(key, thread, timeout_seconds=2.0)
        self._clear_depth_subscription_state(key, remove_cache=False)

    def stop_depth_subscriptions_for_symbol(self, local_symbol: str) -> None:
        self.force_stop_depth_subscriptions_for_symbol(local_symbol)

    def force_stop_depth_subscriptions_for_symbol(
        self,
        local_symbol: str,
        *,
        wait_seconds: float = 3.0,
    ) -> dict[str, Any]:
        normalized_symbol = _normalize_symbol(local_symbol)
        if not normalized_symbol:
            return {
                "symbol": normalized_symbol,
                "matched_keys": [],
                "closed_count": 0,
                "cancelled_count": 0,
                "alive_after_stop": [],
                "registry_after": self.debug_provider_ws_depth_subscriptions(),
            }
        with self._lock:
            all_keys = set(self._depth_stops.keys()) | set(self._depth_tasks.keys()) | set(self._depth_connections.keys())
            keys = [
                key
                for key in all_keys
                if key[1] == normalized_symbol
            ]
            logger.info(
                "contract_provider_ws_depth_subscription_force_stop_for_symbol symbol=%s task_keys=%s connection_keys=%s matched_keys=%s stop_count=%s",
                normalized_symbol,
                sorted(map(str, self._depth_tasks.keys())),
                sorted(map(str, self._depth_connections.keys())),
                sorted(map(str, keys)),
                len(keys),
            )
            stop_events = [self._depth_stops.get(key) for key in keys]
            threads = [self._depth_tasks.get(key) for key in keys]
            connections = [self._depth_connections.get(key) for key in keys]
        if not keys:
            logger.warning(
                "contract_provider_ws_depth_subscription_stop_miss symbol=%s",
                normalized_symbol,
            )
            return {
                "symbol": normalized_symbol,
                "matched_keys": [],
                "closed_count": 0,
                "cancelled_count": 0,
                "alive_after_stop": [],
                "registry_after": self.debug_provider_ws_depth_subscriptions(),
            }
        closed_count = 0
        cancelled_count = 0
        for key, stop_event, connection in zip(keys, stop_events, connections):
            logger.info(
                "contract_provider_ws_depth_subscription_stopping provider=%s symbol=%s",
                key[0],
                key[1],
            )
            if stop_event is not None:
                stop_event.set()
                cancelled_count += 1
            self._close_depth_connection(key, connection)
            if connection is not None:
                closed_count += 1
        alive_after_stop: list[str] = []
        deadline = time.monotonic() + max(0.1, float(wait_seconds or 0))
        for key, thread in zip(keys, threads):
            remaining = max(0.0, deadline - time.monotonic())
            if not self._wait_for_depth_thread_exit(key, thread, timeout_seconds=remaining):
                alive_after_stop.append(str(key))
            self._clear_depth_subscription_state(key, remove_cache=True)
        registry_after = self.debug_provider_ws_depth_subscriptions()
        report = {
            "symbol": normalized_symbol,
            "matched_keys": [str(key) for key in keys],
            "closed_count": closed_count,
            "cancelled_count": cancelled_count,
            "alive_after_stop": alive_after_stop,
            "registry_after": registry_after,
        }
        logger.info("contract_provider_ws_depth_subscription_force_stop_report %s", report)
        return report

    def stop_all(self) -> None:
        with self._lock:
            symbols = sorted({key[1] for key in set(self._depth_stops) | set(self._depth_tasks) | set(self._depth_connections)})
        for symbol in symbols:
            self.force_stop_depth_subscriptions_for_symbol(symbol)

    def _close_depth_connection(
        self,
        key: tuple[str, str],
        connection: Optional[tuple[asyncio.AbstractEventLoop, Any]],
    ) -> None:
        if connection is None:
            return
        loop, websocket = connection
        if loop.is_closed():
            logger.debug(
                "contract_provider_ws_depth_subscription_close_skipped_loop_closed provider=%s symbol=%s",
                key[0],
                key[1],
            )
            return
        try:
            future = asyncio.run_coroutine_threadsafe(self._close_websocket(websocket), loop)
            future.result(timeout=2)
        except Exception:
            logger.info(
                "contract_provider_ws_depth_subscription_close_failed provider=%s symbol=%s",
                key[0],
                key[1],
                exc_info=True,
            )

    async def _close_websocket(self, websocket: Any) -> None:
        close_task = asyncio.create_task(websocket.close())
        try:
            await asyncio.wait_for(close_task, timeout=1.0)
        except Exception:
            close_task.cancel()
            fail_connection = getattr(websocket, "fail_connection", None)
            if callable(fail_connection):
                fail_connection()
            transport = getattr(websocket, "transport", None)
            if transport is not None and not transport.is_closing():
                transport.close()
        wait_closed = getattr(websocket, "wait_closed", None)
        if callable(wait_closed):
            try:
                await asyncio.wait_for(wait_closed(), timeout=1.0)
            except Exception:
                transport = getattr(websocket, "transport", None)
                if transport is not None and not transport.is_closing():
                    transport.close()

    def _wait_for_depth_thread_exit(
        self,
        key: tuple[str, str],
        thread: Optional[threading.Thread],
        *,
        timeout_seconds: float,
    ) -> bool:
        if thread is None:
            return True
        if thread is threading.current_thread():
            return not thread.is_alive()
        if thread.is_alive():
            thread.join(timeout=max(0.0, timeout_seconds))
        alive = thread.is_alive()
        if alive:
            logger.warning(
                "contract_provider_ws_depth_subscription_thread_still_alive provider=%s symbol=%s",
                key[0],
                key[1],
            )
        return not alive

    def _clear_depth_subscription_state(self, key: tuple[str, str], *, remove_cache: bool) -> None:
        with self._lock:
            self._depth_stops.pop(key, None)
            self._depth_tasks.pop(key, None)
            self._depth_connections.pop(key, None)
            self._depth_generations.pop(key, None)
            if remove_cache:
                self._depth_cache.pop(key, None)

    def debug_provider_ws_depth_subscriptions(self) -> dict[str, Any]:
        now_ms = int(time.time() * 1000)
        with self._lock:
            return {
                "tasks": {
                    str(key): bool(thread is not None and thread.is_alive())
                    for key, thread in self._depth_tasks.items()
                },
                "stops": {
                    str(key): bool(stop_event is not None and stop_event.is_set())
                    for key, stop_event in self._depth_stops.items()
                },
                "connections": sorted(map(str, self._depth_connections.keys())),
                "cache": {
                    str(key): {
                        "provider": key[0],
                        "local_symbol": key[1],
                        "age_ms": max(0, now_ms - int(item.get("updated_at_ms") or 0)),
                    }
                    for key, item in self._depth_cache.items()
                },
                "generations": {
                    str(key): generation
                    for key, generation in self._depth_generations.items()
                },
            }

    def _run_depth_subscription_thread(
        self,
        subscription: ProviderDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._run_depth_subscription(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "contract_provider_ws_depth_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    async def _run_depth_subscription(
        self,
        subscription: ProviderDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if subscription.provider != PROVIDER_OKX_SWAP:
            return
        reconnect_delay = 1.0
        while not stop_event.is_set() and provider_ws_depth_enabled():
            try:
                await self._run_okx_depth_ws(subscription, stop_event, generation)
                reconnect_delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                if stop_event.is_set():
                    break
                logger.warning(
                    "contract_provider_ws_depth_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                try:
                    await asyncio.wait_for(asyncio.to_thread(stop_event.wait), timeout=reconnect_delay)
                    break
                except asyncio.TimeoutError:
                    pass
                reconnect_delay = min(reconnect_delay * 2, 15.0)
        logger.info(
            "contract_provider_ws_depth_subscription_thread_exiting provider=%s symbol=%s stop_requested=%s",
            subscription.provider,
            subscription.local_symbol,
            stop_event.is_set(),
        )

    async def _run_okx_depth_ws(
        self,
        subscription: ProviderDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not provider_ws_depth_enabled():
            return
        url = str(getattr(settings, "CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL", "") or "").strip()
        if not url:
            raise ValueError("CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL is required")
        bids: dict[str, Decimal] = {}
        asks: dict[str, Decimal] = {}
        subscribe_payload = {
            "op": "subscribe",
            "args": [{"channel": "books", "instId": subscription.provider_symbol}],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not provider_ws_depth_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                current_generation = self._depth_generations.get(key)
                if current_generation != generation:
                    stop_event.set()
                    return
                self._depth_connections[key] = (loop, websocket)
            logger.info(
                "contract_provider_ws_depth_subscription_started provider=%s symbol=%s provider_symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                while not stop_event.is_set() and provider_ws_depth_enabled():
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    self._handle_okx_depth_message(subscription, raw_message, bids, asks)
            finally:
                with self._lock:
                    current = self._depth_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._depth_connections.pop(key, None)
                logger.info(
                    "contract_provider_ws_depth_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    def _handle_okx_depth_message(
        self,
        subscription: ProviderDepthSubscription,
        raw_message: Any,
        bids: dict[str, Decimal],
        asks: dict[str, Decimal],
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("contract_provider_ws_okx_invalid_json symbol=%s", subscription.local_symbol)
            return
        if not isinstance(message, dict) or message.get("event"):
            return
        data = message.get("data")
        if not isinstance(data, list) or not data:
            return
        row = data[0]
        if not isinstance(row, dict):
            return
        action = str(message.get("action") or "").lower()
        if action == "snapshot" or not bids or not asks:
            bids.clear()
            asks.clear()
            bids.update(_normalize_okx_side(row.get("bids")))
            asks.update(_normalize_okx_side(row.get("asks")))
        else:
            _merge_okx_side(bids, row.get("bids"))
            _merge_okx_side(asks, row.get("asks"))
        self._set_depth_cache(
            subscription,
            bids=bids,
            asks=asks,
            sequence=row.get("seqId"),
            checksum=row.get("checksum"),
            exchange_ts=row.get("ts"),
        )

    def _set_depth_cache(
        self,
        subscription: ProviderDepthSubscription,
        *,
        bids: dict[str, Decimal],
        asks: dict[str, Decimal],
        sequence: Any = None,
        checksum: Any = None,
        exchange_ts: Any = None,
    ) -> None:
        bid_levels = _sort_depth_side(bids, side="bids", limit=subscription.depth_limit)
        ask_levels = _sort_depth_side(asks, side="asks", limit=subscription.depth_limit)
        if not bid_levels or not ask_levels:
            return
        now_ms = int(time.time() * 1000)
        now = datetime.now(timezone.utc)
        payload = {
            "symbol": subscription.local_symbol,
            "provider": subscription.provider,
            "provider_symbol": subscription.provider_symbol,
            "bids": bid_levels,
            "asks": ask_levels,
            "best_bid": _best_depth_price(bid_levels, side="bids"),
            "best_ask": _best_depth_price(ask_levels, side="asks"),
            "source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_freshness": "LIVE",
            "is_realtime": True,
            "executable": True,
            "ts": now,
            "updated_at": now,
            "updated_at_ms": now_ms,
            "sequence": sequence,
            "checksum": checksum,
            "exchange_ts": exchange_ts,
        }
        with self._lock:
            self._depth_cache[(subscription.provider, subscription.local_symbol)] = payload


contract_market_provider_ws = ContractMarketProviderWsService()


def get_fresh_provider_ws_depth(
    symbol: str,
    provider_code: Optional[str] = None,
    *,
    max_age_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.get_fresh_provider_ws_depth(
        symbol,
        provider_code,
        max_age_ms=max_age_ms,
    )


def select_fresh_provider_ws_depth(
    db: Session,
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
    ensure_subscription: bool = False,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.select_fresh_depth_for_enabled_providers(
        db,
        symbol,
        max_age_ms=max_age_ms,
        ensure_subscription=ensure_subscription,
    )


def stop_provider_ws_depth_subscriptions_for_symbol(symbol: str) -> None:
    contract_market_provider_ws.stop_depth_subscriptions_for_symbol(symbol)


def force_stop_provider_ws_depth_subscriptions_for_symbol(
    symbol: str,
    *,
    wait_seconds: float = 3.0,
) -> dict[str, Any]:
    return contract_market_provider_ws.force_stop_depth_subscriptions_for_symbol(
        symbol,
        wait_seconds=wait_seconds,
    )


def debug_provider_ws_depth_subscriptions() -> dict[str, Any]:
    return contract_market_provider_ws.debug_provider_ws_depth_subscriptions()
