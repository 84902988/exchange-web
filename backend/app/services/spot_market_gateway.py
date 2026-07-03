from __future__ import annotations

import asyncio
import logging
import time
from decimal import Decimal
from typing import Any, Callable, Optional

from app.core.config import settings
from app.db.models.trading_pair import TradingPair
from app.db.session import SessionLocal
from app.schemas.market import DepthItem, DepthResponse
from app.services.spot_market_provider_ws import (
    ensure_spot_provider_ws_depth,
    get_spot_provider_ws_depth,
    normalize_spot_ws_symbol,
    release_spot_provider_ws_depth,
    spot_provider_ws_depth_enabled,
)


logger = logging.getLogger(__name__)


class SpotMarketGateway:
    def __init__(
        self,
        *,
        provider_depth_enabled: Optional[Callable[[], bool]] = None,
        ensure_depth: Optional[Callable[[str], None]] = None,
        release_depth: Optional[Callable[[str], None]] = None,
        get_depth: Optional[Callable[..., Optional[DepthResponse]]] = None,
        precision_resolver: Optional[Callable[[str], tuple[int, int]]] = None,
        ws_manager: Any = None,
    ) -> None:
        self._provider_depth_enabled = provider_depth_enabled or spot_provider_ws_depth_enabled
        self._ensure_depth = ensure_depth or ensure_spot_provider_ws_depth
        self._release_depth = release_depth or release_spot_provider_ws_depth
        self._get_depth = get_depth or get_spot_provider_ws_depth
        self._precision_resolver = precision_resolver or self._default_precision_resolver
        self._ws_manager = ws_manager
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._idle_tasks: dict[str, asyncio.Task[None]] = {}
        self._task_lock = asyncio.Lock()
        self._last_depth_broadcast_at: dict[str, float] = {}
        self._last_depth_signature: dict[str, str] = {}
        self._precision_cache: dict[str, tuple[int, int]] = {}

    async def ensure_symbol(self, symbol: str) -> None:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol or not self._provider_depth_enabled():
            return
        await self._cancel_idle_release(normalized_symbol)
        try:
            self._ensure_depth(normalized_symbol)
        except Exception:
            logger.warning("spot_market_gateway_ensure_depth_failed symbol=%s", normalized_symbol, exc_info=True)
        async with self._task_lock:
            task = self._tasks.get(normalized_symbol)
            if task is not None and not task.done():
                return
            self._tasks[normalized_symbol] = asyncio.create_task(self._refresh_loop(normalized_symbol))

    async def release_symbol_if_idle(
        self,
        symbol: str,
        *,
        idle_delay_seconds: Optional[float] = None,
    ) -> None:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol:
            return
        subscriber_count = await self._subscriber_count(normalized_symbol)
        if subscriber_count > 0:
            return
        async with self._task_lock:
            idle_task = self._idle_tasks.get(normalized_symbol)
            if idle_task is not None and not idle_task.done():
                return
            delay = (
                float(idle_delay_seconds)
                if idle_delay_seconds is not None
                else max(0.0, float(getattr(settings, "SPOT_PROVIDER_WS_IDLE_STOP_SECONDS", 10) or 10))
            )
            self._idle_tasks[normalized_symbol] = asyncio.create_task(
                self._idle_release_after_delay(normalized_symbol, delay)
            )

    async def _cancel_idle_release(self, symbol: str) -> None:
        async with self._task_lock:
            task = self._idle_tasks.pop(symbol, None)
            if task is not None and not task.done():
                task.cancel()

    async def _idle_release_after_delay(self, symbol: str, delay_seconds: float) -> None:
        try:
            if delay_seconds > 0:
                await asyncio.sleep(delay_seconds)
            subscriber_count = await self._subscriber_count(symbol)
            if subscriber_count > 0:
                return
            async with self._task_lock:
                refresh_task = self._tasks.pop(symbol, None)
                if refresh_task is not None and not refresh_task.done():
                    refresh_task.cancel()
            await asyncio.to_thread(self._release_depth, symbol)
            self._last_depth_broadcast_at.pop(symbol, None)
            self._last_depth_signature.pop(symbol, None)
            self._precision_cache.pop(symbol, None)
            logger.info("spot_market_gateway_release_provider_ws_depth symbol=%s", symbol)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("spot_market_gateway_release_failed symbol=%s", symbol, exc_info=True)
        finally:
            async with self._task_lock:
                task = self._idle_tasks.get(symbol)
                if task is asyncio.current_task():
                    self._idle_tasks.pop(symbol, None)

    async def _refresh_loop(self, symbol: str) -> None:
        current_task = asyncio.current_task()
        try:
            while self._provider_depth_enabled():
                subscriber_count = await self._subscriber_count(symbol)
                if subscriber_count <= 0:
                    await self.release_symbol_if_idle(symbol)
                    break
                try:
                    depth = self._get_depth(symbol, limit=int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_LIMIT", 20) or 20))
                except Exception:
                    logger.warning("spot_market_gateway_get_depth_failed symbol=%s", symbol, exc_info=True)
                    depth = None
                if depth is not None:
                    depth = self._format_depth_for_broadcast(symbol, depth)
                if depth is not None and self._should_broadcast_depth(symbol, depth):
                    try:
                        await self._market_ws_manager().broadcast_depth_update(symbol, depth)
                    except Exception:
                        logger.warning("spot_market_gateway_depth_broadcast_failed symbol=%s", symbol, exc_info=True)
                await asyncio.sleep(self._broadcast_interval_seconds())
        except asyncio.CancelledError:
            raise
        finally:
            async with self._task_lock:
                task = self._tasks.get(symbol)
                if task is current_task:
                    self._tasks.pop(symbol, None)

    def _should_broadcast_depth(self, symbol: str, depth: DepthResponse) -> bool:
        now = time.monotonic()
        min_interval_seconds = self._broadcast_interval_seconds()
        last_at = self._last_depth_broadcast_at.get(symbol, 0.0)
        if now - last_at < min_interval_seconds:
            return False
        signature = self._depth_signature(depth)
        if self._last_depth_signature.get(symbol) == signature:
            return False
        self._last_depth_signature[symbol] = signature
        self._last_depth_broadcast_at[symbol] = now
        return True

    def _depth_signature(self, depth: DepthResponse) -> str:
        bids = [(item.price, item.amount) for item in depth.bids[:20]]
        asks = [(item.price, item.amount) for item in depth.asks[:20]]
        return repr((bids, asks, getattr(depth, "ts", None)))

    def _broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_BROADCAST_INTERVAL_MS", 200) or 200)
        return max(0.05, interval_ms / 1000)

    async def _subscriber_count(self, symbol: str) -> int:
        return await self._market_ws_manager().subscriber_count(symbol)

    def _market_ws_manager(self) -> Any:
        if self._ws_manager is not None:
            return self._ws_manager
        from app.services.market_ws import market_ws_manager

        return market_ws_manager

    def _format_depth_for_broadcast(self, symbol: str, depth: DepthResponse) -> DepthResponse:
        price_precision, amount_precision = self._precision_for_symbol(symbol)

        def quantize(value: Any, precision: int) -> str:
            decimal_value = Decimal(str(value))
            return format(decimal_value.quantize(Decimal("1").scaleb(-precision)), "f")

        def adapt(levels: list[DepthItem]) -> list[DepthItem]:
            items: list[DepthItem] = []
            for item in levels:
                try:
                    price = quantize(item.price, price_precision)
                    amount = quantize(item.amount, amount_precision)
                except Exception:
                    continue
                items.append(DepthItem(price=price, amount=amount))
            return items

        data = depth.model_dump() if hasattr(depth, "model_dump") else depth.dict()
        data.update(
            {
                "symbol": normalize_spot_ws_symbol(symbol),
                "price_precision": price_precision,
                "amount_precision": amount_precision,
                "bids": adapt(list(depth.bids or [])),
                "asks": adapt(list(depth.asks or [])),
                "freshness": "LAST_GOOD" if getattr(depth, "stale", False) else "LIVE",
            }
        )
        return DepthResponse(**data)

    def _precision_for_symbol(self, symbol: str) -> tuple[int, int]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        cached = self._precision_cache.get(normalized_symbol)
        if cached is not None:
            return cached
        try:
            precision = self._precision_resolver(normalized_symbol)
        except Exception:
            logger.debug("spot_market_gateway_precision_resolve_failed symbol=%s", normalized_symbol, exc_info=True)
            precision = (8, 8)
        self._precision_cache[normalized_symbol] = precision
        return precision

    def _default_precision_resolver(self, symbol: str) -> tuple[int, int]:
        db = SessionLocal()
        try:
            pair = (
                db.query(TradingPair)
                .filter(TradingPair.symbol == normalize_spot_ws_symbol(symbol), TradingPair.status == 1)
                .first()
            )
            if pair is None:
                return (8, 8)
            return (
                self._normalize_precision(getattr(pair, "price_precision", None), 8),
                self._normalize_precision(getattr(pair, "amount_precision", None), 8),
            )
        finally:
            db.close()

    def _normalize_precision(self, value: Any, fallback: int) -> int:
        try:
            precision = int(value)
        except Exception:
            return fallback
        if 0 <= precision <= 12:
            return precision
        return fallback


spot_market_gateway = SpotMarketGateway()
