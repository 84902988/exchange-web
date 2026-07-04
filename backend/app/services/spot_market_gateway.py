from __future__ import annotations

import asyncio
import logging
import time
from decimal import Decimal
from typing import Any, Callable, Optional

from app.core.config import settings
from app.db.models.trading_pair import TradingPair
from app.db.session import SessionLocal
from app.schemas.market import DepthItem, DepthResponse, TradesResponse
from app.services.spot_market_provider_ws import (
    ensure_spot_provider_ws_depth,
    get_spot_provider_ws_depth,
    get_spot_provider_ws_ticker,
    get_spot_provider_ws_trades,
    normalize_spot_ws_symbol,
    release_spot_provider_ws_depth,
    spot_provider_ws_depth_enabled,
    spot_provider_ws_ticker_enabled,
    spot_provider_ws_trades_enabled,
)


logger = logging.getLogger(__name__)


class SpotMarketGateway:
    def __init__(
        self,
        *,
        provider_depth_enabled: Optional[Callable[[], bool]] = None,
        provider_ticker_enabled: Optional[Callable[[], bool]] = None,
        provider_trades_enabled: Optional[Callable[[], bool]] = None,
        ensure_depth: Optional[Callable[[str], None]] = None,
        release_depth: Optional[Callable[[str], None]] = None,
        get_depth: Optional[Callable[..., Optional[DepthResponse]]] = None,
        get_ticker: Optional[Callable[..., Optional[dict[str, Any]]]] = None,
        get_trades: Optional[Callable[..., Optional[TradesResponse]]] = None,
        precision_resolver: Optional[Callable[[str], tuple[int, int]]] = None,
        ws_manager: Any = None,
    ) -> None:
        self._provider_depth_enabled = provider_depth_enabled or spot_provider_ws_depth_enabled
        self._provider_ticker_enabled = provider_ticker_enabled or spot_provider_ws_ticker_enabled
        self._provider_trades_enabled = provider_trades_enabled or spot_provider_ws_trades_enabled
        self._ensure_depth = ensure_depth or ensure_spot_provider_ws_depth
        self._release_depth = release_depth or release_spot_provider_ws_depth
        self._get_depth = get_depth or get_spot_provider_ws_depth
        self._get_ticker = get_ticker or get_spot_provider_ws_ticker
        self._get_trades = get_trades or get_spot_provider_ws_trades
        self._precision_resolver = precision_resolver or self._default_precision_resolver
        self._ws_manager = ws_manager
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._idle_tasks: dict[str, asyncio.Task[None]] = {}
        self._task_lock = asyncio.Lock()
        self._last_depth_broadcast_at: dict[str, float] = {}
        self._last_depth_signature: dict[str, str] = {}
        self._last_ticker_broadcast_at: dict[str, float] = {}
        self._last_ticker_signature: dict[str, str] = {}
        self._last_trade_broadcast_at: dict[str, float] = {}
        self._seen_trade_signatures: dict[str, list[str]] = {}
        self._precision_cache: dict[str, tuple[int, int]] = {}

    async def ensure_symbol(self, symbol: str) -> None:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol or not self._provider_enabled():
            return
        await self._cancel_idle_release(normalized_symbol)
        try:
            self._ensure_depth(normalized_symbol)
        except Exception:
            logger.warning("spot_market_gateway_ensure_provider_ws_failed symbol=%s", normalized_symbol, exc_info=True)
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
            self._last_ticker_broadcast_at.pop(symbol, None)
            self._last_ticker_signature.pop(symbol, None)
            self._last_trade_broadcast_at.pop(symbol, None)
            self._seen_trade_signatures.pop(symbol, None)
            self._precision_cache.pop(symbol, None)
            logger.info("spot_market_gateway_release_provider_ws symbol=%s", symbol)
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
            while self._provider_enabled():
                subscriber_count = await self._subscriber_count(symbol)
                if subscriber_count <= 0:
                    await self.release_symbol_if_idle(symbol)
                    break
                if self._provider_depth_enabled():
                    try:
                        depth = self._get_depth(
                            symbol,
                            limit=int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_LIMIT", 20) or 20),
                        )
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

                if self._provider_ticker_enabled():
                    try:
                        ticker = self._get_ticker(symbol)
                    except Exception:
                        logger.warning("spot_market_gateway_get_ticker_failed symbol=%s", symbol, exc_info=True)
                        ticker = None
                    if ticker is not None:
                        ticker = self._format_ticker_for_broadcast(symbol, ticker)
                    if ticker is not None and self._should_broadcast_ticker(symbol, ticker):
                        try:
                            await self._market_ws_manager().broadcast_ticker_update(symbol, ticker)
                        except Exception:
                            logger.warning("spot_market_gateway_ticker_broadcast_failed symbol=%s", symbol, exc_info=True)

                if self._provider_trades_enabled():
                    try:
                        trades = self._get_trades(
                            symbol,
                            limit=int(getattr(settings, "SPOT_PROVIDER_WS_TRADES_LIMIT", 30) or 30),
                        )
                    except Exception:
                        logger.warning("spot_market_gateway_get_trades_failed symbol=%s", symbol, exc_info=True)
                        trades = None
                    for trade in self._new_trades_for_broadcast(symbol, trades):
                        try:
                            await self._market_ws_manager().send_trade(
                                symbol=symbol,
                                price=getattr(trade, "price", None),
                                amount=getattr(trade, "amount", None),
                                side=getattr(trade, "side", ""),
                                ts=int(getattr(trade, "ts", 0) or 0),
                                trade_id=getattr(trade, "id", None),
                            )
                        except Exception:
                            logger.warning("spot_market_gateway_trade_broadcast_failed symbol=%s", symbol, exc_info=True)

                await asyncio.sleep(self._loop_interval_seconds())
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

    def _should_broadcast_ticker(self, symbol: str, ticker: dict[str, Any]) -> bool:
        now = time.monotonic()
        min_interval_seconds = self._ticker_broadcast_interval_seconds()
        last_at = self._last_ticker_broadcast_at.get(symbol, 0.0)
        if now - last_at < min_interval_seconds:
            return False
        signature = self._ticker_signature(ticker)
        if self._last_ticker_signature.get(symbol) == signature:
            return False
        self._last_ticker_signature[symbol] = signature
        self._last_ticker_broadcast_at[symbol] = now
        return True

    def _ticker_signature(self, ticker: dict[str, Any]) -> str:
        keys = (
            "last_price",
            "price_change_24h",
            "price_change_percent",
            "high_24h",
            "low_24h",
            "base_volume_24h",
            "quote_volume_24h",
            "ts",
        )
        return repr(tuple(ticker.get(key) for key in keys))

    def _new_trades_for_broadcast(self, symbol: str, trades: Optional[TradesResponse]) -> list[Any]:
        if trades is None or not getattr(trades, "trades", None):
            return []
        now = time.monotonic()
        min_interval_seconds = self._trades_broadcast_interval_seconds()
        last_at = self._last_trade_broadcast_at.get(symbol, 0.0)
        if now - last_at < min_interval_seconds:
            return []
        seen = set(self._seen_trade_signatures.get(symbol, []))
        new_items: list[Any] = []
        new_signatures: list[str] = []
        for trade in reversed(list(trades.trades or [])):
            signature = self._trade_signature(trade)
            if not signature or signature in seen:
                continue
            seen.add(signature)
            new_signatures.append(signature)
            new_items.append(trade)
        if new_signatures:
            retained = (self._seen_trade_signatures.get(symbol, []) + new_signatures)[-200:]
            self._seen_trade_signatures[symbol] = retained
            self._last_trade_broadcast_at[symbol] = now
        return new_items

    def _trade_signature(self, trade: Any) -> str:
        trade_id = str(getattr(trade, "id", "") or "").strip()
        if trade_id:
            return f"id:{trade_id}"
        return repr(
            (
                getattr(trade, "price", None),
                getattr(trade, "amount", None),
                str(getattr(trade, "side", "") or "").upper(),
                int(getattr(trade, "ts", 0) or 0),
            )
        )

    def _broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_BROADCAST_INTERVAL_MS", 200) or 200)
        return max(0.05, interval_ms / 1000)

    def _ticker_broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_TICKER_BROADCAST_INTERVAL_MS", 500) or 500)
        return max(0.1, interval_ms / 1000)

    def _trades_broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_TRADES_BROADCAST_INTERVAL_MS", 200) or 200)
        return max(0.05, interval_ms / 1000)

    def _loop_interval_seconds(self) -> float:
        intervals: list[float] = []
        if self._provider_depth_enabled():
            intervals.append(self._broadcast_interval_seconds())
        if self._provider_ticker_enabled():
            intervals.append(self._ticker_broadcast_interval_seconds())
        if self._provider_trades_enabled():
            intervals.append(self._trades_broadcast_interval_seconds())
        return min(intervals) if intervals else 1.0

    def _provider_enabled(self) -> bool:
        return bool(
            self._provider_depth_enabled()
            or self._provider_ticker_enabled()
            or self._provider_trades_enabled()
        )

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

    def _format_ticker_for_broadcast(self, symbol: str, ticker: dict[str, Any]) -> dict[str, Any]:
        price_precision, amount_precision = self._precision_for_symbol(symbol)
        payload = dict(ticker)
        payload.update(
            {
                "symbol": normalize_spot_ws_symbol(symbol),
                "price_precision": price_precision,
                "amount_precision": amount_precision,
                "source": payload.get("source") or "LIVE_WS",
                "freshness": payload.get("freshness") or "LIVE",
                "quote_freshness": payload.get("quote_freshness") or "LIVE",
                "stale": bool(payload.get("stale", False)),
            }
        )
        return payload

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
