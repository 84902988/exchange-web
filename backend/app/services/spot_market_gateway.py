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
from app.services.contract_market_provider_service import PROVIDER_BITGET_SPOT, enabled_spot_market_providers
from app.services.spot_market_gateway_state import (
    SpotGatewayBroadcastState,
    SpotGatewayDepthAuthority,
    SpotGatewayDepthState,
    make_domain_key,
)
from app.services.spot_market_provider_ws import (
    ensure_spot_provider_ws_depth,
    ensure_spot_provider_ws_kline,
    get_spot_provider_ws_depth,
    get_spot_provider_ws_klines,
    get_spot_provider_ws_ticker,
    get_spot_provider_ws_trades,
    normalize_spot_ws_symbol,
    release_spot_provider_ws_depth,
    release_spot_provider_ws_kline,
    spot_provider_ws_supports_provider,
)
from app.services.spot_kline_bucket import normalize_spot_kline_bucket_interval


logger = logging.getLogger(__name__)

_MAX_KLINE_BROADCAST_INTERVAL_MS = 500
_KLINE_INTERVAL_RELEASE_GRACE_SECONDS = 3.0
_EXECUTOR_SHUTDOWN_MESSAGES = (
    "executor shutdown has been called",
    "cannot schedule new futures after shutdown",
    "executor shutdown",
)


def _is_executor_shutdown(exc: BaseException) -> bool:
    if not isinstance(exc, RuntimeError):
        return False
    message = str(exc).strip().lower()
    return any(fragment in message for fragment in _EXECUTOR_SHUTDOWN_MESSAGES)


class SpotMarketGateway:
    def __init__(
        self,
        *,
        ensure_depth: Optional[Callable[[str], None]] = None,
        ensure_kline: Optional[Callable[[str, str], None]] = None,
        release_depth: Optional[Callable[[str], None]] = None,
        release_kline: Optional[Callable[[str, str], None]] = None,
        get_depth: Optional[Callable[..., Optional[DepthResponse]]] = None,
        get_ticker: Optional[Callable[..., Optional[dict[str, Any]]]] = None,
        get_trades: Optional[Callable[..., Optional[TradesResponse]]] = None,
        get_klines: Optional[Callable[..., Optional[dict[str, Any]]]] = None,
        provider_symbol_allowed: Optional[Callable[[str], bool]] = None,
        precision_resolver: Optional[Callable[[str], tuple[int, int]]] = None,
        ws_manager: Any = None,
        kline_release_grace_seconds: float = _KLINE_INTERVAL_RELEASE_GRACE_SECONDS,
    ) -> None:
        self._ensure_depth = ensure_depth or ensure_spot_provider_ws_depth
        self._ensure_depth_accepts_provider = ensure_depth is None
        self._ensure_kline = ensure_kline or ensure_spot_provider_ws_kline
        self._ensure_kline_accepts_provider = ensure_kline is None
        self._release_depth = release_depth or release_spot_provider_ws_depth
        self._release_depth_accepts_provider = release_depth is None
        self._release_kline = release_kline or release_spot_provider_ws_kline
        self._release_kline_accepts_provider = release_kline is None
        self._get_depth = get_depth or get_spot_provider_ws_depth
        self._get_depth_accepts_provider = get_depth is None
        self._get_ticker = get_ticker or get_spot_provider_ws_ticker
        self._get_ticker_accepts_provider = get_ticker is None
        self._get_trades = get_trades or get_spot_provider_ws_trades
        self._get_trades_accepts_provider = get_trades is None
        self._get_klines = get_klines or get_spot_provider_ws_klines
        self._get_klines_accepts_provider = get_klines is None
        self._provider_symbol_allowed = provider_symbol_allowed or self._default_provider_symbol_allowed
        self._provider_symbol_allowed_is_default = provider_symbol_allowed is None
        self._precision_resolver = precision_resolver or self._default_precision_resolver
        self._ws_manager = ws_manager
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._idle_tasks: dict[str, asyncio.Task[None]] = {}
        self._task_lock = asyncio.Lock()
        self._broadcast_state = SpotGatewayBroadcastState()
        self._depth_authority = SpotGatewayDepthAuthority()
        self._ensured_kline_intervals: dict[str, set[str]] = {}
        self._pending_kline_releases: dict[str, dict[str, float]] = {}
        self._kline_release_grace_seconds = max(0.0, float(kline_release_grace_seconds))
        self._precision_cache: dict[str, tuple[int, int]] = {}
        self._symbol_providers: dict[str, str] = {}
        self._pending_provider_switches: dict[str, tuple[str, str]] = {}
        self._broadcast_counters: dict[str, int] = {
            "depth": 0,
            "ticker": 0,
            "trades": 0,
            "kline": 0,
        }
        self._last_broadcast_at: dict[str, float] = {}
        self._last_broadcast_type: dict[str, str] = {}
        self._idle_stop_count = 0

    async def ensure_symbol(self, symbol: str, *, interval: str = "1m") -> None:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol:
            return
        active_provider = self._depth_authority.active_provider(normalized_symbol)
        if self._provider_symbol_allowed_is_default:
            provider_code = active_provider or await asyncio.to_thread(
                self._select_provider_ws_code,
                normalized_symbol,
            )
        else:
            provider_code = PROVIDER_BITGET_SPOT
        if not provider_code or not await self._provider_symbol_allowed_async(normalized_symbol):
            return
        self._symbol_providers[normalized_symbol] = provider_code
        self._depth_authority.ensure_provider(normalized_symbol, provider_code)
        await self._cancel_idle_release(normalized_symbol)
        try:
            if self._ensure_depth_accepts_provider:
                self._ensure_depth(normalized_symbol, provider=provider_code)
            else:
                self._ensure_depth(normalized_symbol)
            if interval is not None:
                self._ensure_kline_interval(
                    normalized_symbol,
                    self._normalize_interval(interval),
                    provider=provider_code,
                )
        except Exception:
            logger.warning("spot_market_gateway_ensure_provider_ws_failed symbol=%s", normalized_symbol, exc_info=True)
        async with self._task_lock:
            task = self._tasks.get(normalized_symbol)
            if task is not None and not task.done():
                return
            task = asyncio.create_task(self._refresh_loop(normalized_symbol))
            task.add_done_callback(self._consume_task_result)
            self._tasks[normalized_symbol] = task

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
            task = asyncio.create_task(self._idle_release_after_delay(normalized_symbol, delay))
            task.add_done_callback(self._consume_task_result)
            self._idle_tasks[normalized_symbol] = task

    async def get_metrics_snapshot(self) -> dict[str, Any]:
        async with self._task_lock:
            now = time.monotonic()
            active_symbols = sorted(
                set(self._tasks.keys())
                | set(self._idle_tasks.keys())
                | set(self._symbol_providers.keys())
                | set(self._ensured_kline_intervals.keys())
            )
            task_active = {
                symbol: task is not None and not task.done()
                for symbol, task in self._tasks.items()
            }
            idle_release_pending = {
                symbol: task is not None and not task.done()
                for symbol, task in self._idle_tasks.items()
            }
            ensured_kline_intervals = {
                symbol: sorted(intervals)
                for symbol, intervals in self._ensured_kline_intervals.items()
            }
            pending_kline_releases = {
                symbol: {
                    interval: max(0.0, release_at - now)
                    for interval, release_at in releases.items()
                }
                for symbol, releases in self._pending_kline_releases.items()
            }
            symbol_providers = dict(self._symbol_providers)
            provider_generations = {
                symbol: self._depth_authority.active_generation(symbol)
                for symbol in active_symbols
            }
            broadcast_counters = dict(self._broadcast_counters)
            last_broadcast_at = dict(self._last_broadcast_at)
            last_broadcast_type = dict(self._last_broadcast_type)
            idle_stop_count = self._idle_stop_count

        subscriber_counts = {}
        for symbol in active_symbols:
            try:
                subscriber_counts[symbol] = await self._subscriber_count(symbol)
            except Exception:
                subscriber_counts[symbol] = None

        return {
            "active_symbols": active_symbols,
            "symbols": {
                symbol: {
                    "gateway_loop_active": bool(task_active.get(symbol)),
                    "subscriber_count": subscriber_counts.get(symbol),
                    "provider": symbol_providers.get(symbol),
                    "provider_generation": provider_generations.get(symbol, 0),
                    "ensured_kline_intervals": ensured_kline_intervals.get(symbol, []),
                    "idle_release_pending": bool(idle_release_pending.get(symbol)),
                    "pending_kline_release_in_seconds": pending_kline_releases.get(symbol, {}),
                    "last_broadcast_at": last_broadcast_at.get(symbol),
                    "last_broadcast_type": last_broadcast_type.get(symbol),
                }
                for symbol in active_symbols
            },
            "broadcast_counters": broadcast_counters,
            "idle_stop_count": idle_stop_count,
        }

    def get_authoritative_depth(self, symbol: str) -> Optional[SpotGatewayDepthState]:
        return self._depth_authority.snapshot(normalize_spot_ws_symbol(symbol))

    def get_active_depth_provider(self, symbol: str) -> tuple[Optional[str], int]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        return (
            self._depth_authority.active_provider(normalized_symbol),
            self._depth_authority.active_generation(normalized_symbol),
        )

    def commit_authoritative_depth(
        self,
        *,
        symbol: str,
        provider: str,
        provider_symbol: str,
        depth: DepthResponse,
        event_time_ms: int,
        received_at_ms: int,
        freshness: str,
        source: str,
        allow_switch: bool = False,
        expected_provider: Optional[str] = None,
    ) -> Optional[SpotGatewayDepthState]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        try:
            best_bid = Decimal(str(depth.bids[0].price)) if depth.bids else None
            best_ask = Decimal(str(depth.asks[0].price)) if depth.asks else None
        except (ArithmeticError, TypeError, ValueError):
            return None
        if (
            best_bid is None
            or best_ask is None
            or best_bid <= 0
            or best_ask <= 0
            or best_ask < best_bid
            or int(received_at_ms or 0) <= 0
            or (
                getattr(depth, "provider", None)
                and str(getattr(depth, "provider", "") or "").strip().upper()
                != str(provider or "").strip().upper()
            )
        ):
            return None
        previous_provider = self._depth_authority.active_provider(normalized_symbol)
        state = self._depth_authority.commit(
            symbol=normalized_symbol,
            provider=provider,
            provider_symbol=provider_symbol,
            depth=depth,
            event_time_ms=event_time_ms,
            received_at_ms=received_at_ms,
            freshness=freshness,
            source=source,
            allow_switch=allow_switch,
            expected_provider=expected_provider,
        )
        if state is None:
            return None
        self._symbol_providers[normalized_symbol] = state.provider
        if previous_provider and previous_provider != state.provider:
            self._pending_provider_switches[normalized_symbol] = (previous_provider, state.provider)
        return state

    @staticmethod
    def _consume_task_result(task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except RuntimeError as exc:
            if _is_executor_shutdown(exc):
                return
            logger.warning("spot_market_gateway_task_failed", exc_info=True)
        except Exception:
            logger.warning("spot_market_gateway_task_failed", exc_info=True)

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
            provider_code = self._symbol_providers.get(symbol, PROVIDER_BITGET_SPOT)
            await self._release_provider_symbol(symbol, provider_code)
            self._idle_stop_count += 1
            logger.info("spot_market_gateway_release_provider_ws symbol=%s", symbol)
            logger.info(
                "spot_ws_idle_stop symbol=%s provider=%s idle_stop_count=%s",
                symbol,
                provider_code,
                self._idle_stop_count,
            )
        except asyncio.CancelledError:
            raise
        except RuntimeError as exc:
            if _is_executor_shutdown(exc):
                return
            logger.warning("spot_market_gateway_release_failed symbol=%s", symbol, exc_info=True)
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
            while True:
                await self._apply_pending_provider_switch(symbol)
                subscriber_count = await self._subscriber_count(symbol)
                if subscriber_count <= 0:
                    await self.release_symbol_if_idle(symbol)
                    break
                provider_code = self._depth_authority.active_provider(symbol) or self._symbol_providers.get(symbol)
                if not provider_code or not await self._provider_symbol_allowed_async(symbol):
                    break
                if self._provider_symbol_allowed_is_default and not self._depth_authority.fallback_active(symbol):
                    selected_provider_code = await asyncio.to_thread(self._select_provider_ws_code, symbol)
                    if selected_provider_code != provider_code:
                        await self._release_provider_symbol(symbol, provider_code)
                        break
                authority_state = self._depth_authority.snapshot(symbol)
                if (
                    authority_state is not None
                    and authority_state.provider == provider_code
                    and int(time.time() * 1000) - authority_state.received_at_ms
                    <= int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500) or 1500)
                ):
                    authoritative_depth = self._format_depth_for_broadcast(symbol, authority_state.depth)
                    if self._should_broadcast_depth(symbol, authoritative_depth):
                        try:
                            await self._market_ws_manager().broadcast_depth_update(symbol, authoritative_depth)
                            self._remember_broadcast_metric(symbol, "depth")
                        except Exception:
                            logger.warning(
                                "spot_market_gateway_authoritative_depth_broadcast_failed symbol=%s",
                                symbol,
                                exc_info=True,
                            )
                try:
                    if self._get_depth_accepts_provider:
                        depth = self._get_depth(
                            symbol,
                            provider=provider_code,
                            limit=int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_LIMIT", 20) or 20),
                        )
                    else:
                        depth = self._get_depth(
                            symbol,
                            limit=int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_LIMIT", 20) or 20),
                        )
                except Exception:
                    logger.warning("spot_market_gateway_get_depth_failed symbol=%s", symbol, exc_info=True)
                    depth = None
                if depth is not None:
                    depth = self._format_depth_for_broadcast(symbol, depth)
                    state = self.commit_authoritative_depth(
                        symbol=symbol,
                        provider=provider_code,
                        provider_symbol="",
                        depth=depth,
                        event_time_ms=int(getattr(depth, "ts", 0) or 0),
                        received_at_ms=int(getattr(depth, "fetched_at", 0) or int(time.time() * 1000)),
                        freshness=str(getattr(depth, "freshness", None) or "LIVE"),
                        source=str(getattr(depth, "source", None) or "LIVE_WS"),
                    )
                    depth = state.depth if state is not None else None
                if depth is not None and self._should_broadcast_depth(symbol, depth):
                    try:
                        await self._market_ws_manager().broadcast_depth_update(symbol, depth)
                        self._remember_broadcast_metric(symbol, "depth")
                    except Exception:
                        logger.warning("spot_market_gateway_depth_broadcast_failed symbol=%s", symbol, exc_info=True)

                try:
                    if self._get_ticker_accepts_provider:
                        ticker = self._get_ticker(symbol, provider=provider_code)
                    else:
                        ticker = self._get_ticker(symbol)
                except Exception:
                    logger.warning("spot_market_gateway_get_ticker_failed symbol=%s", symbol, exc_info=True)
                    ticker = None
                if ticker is not None:
                    ticker = self._format_ticker_for_broadcast(symbol, ticker)
                if ticker is not None and self._should_broadcast_ticker(symbol, ticker):
                    try:
                        await self._market_ws_manager().broadcast_ticker_update(symbol, ticker)
                        self._remember_broadcast_metric(symbol, "ticker")
                    except Exception:
                        logger.warning("spot_market_gateway_ticker_broadcast_failed symbol=%s", symbol, exc_info=True)

                try:
                    if self._get_trades_accepts_provider:
                        trades = self._get_trades(
                            symbol,
                            provider=provider_code,
                            limit=int(getattr(settings, "SPOT_PROVIDER_WS_TRADES_LIMIT", 30) or 30),
                        )
                    else:
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
                            provider=getattr(trade, "provider", None) or getattr(trades, "provider", None),
                            provider_symbol=(
                                getattr(trade, "provider_symbol", None)
                                or getattr(trades, "provider_symbol", None)
                            ),
                            provider_trade_id=(
                                getattr(trade, "provider_trade_id", None)
                                or getattr(trade, "trade_id", None)
                                or getattr(trade, "id", None)
                            ),
                            source=getattr(trade, "source", None) or getattr(trades, "source", None),
                            freshness=getattr(trade, "freshness", None) or getattr(trades, "freshness", None),
                            updated_at_ms=(
                                getattr(trade, "updated_at_ms", None)
                                or getattr(trades, "updated_at_ms", None)
                            ),
                        )
                        self._remember_broadcast_metric(symbol, "trades")
                    except Exception:
                        logger.warning("spot_market_gateway_trade_broadcast_failed symbol=%s", symbol, exc_info=True)

                active_kline_intervals = await self._sync_kline_intervals(
                    symbol,
                    await self._active_kline_intervals(symbol),
                )
                for interval in active_kline_intervals:
                    try:
                        if self._get_klines_accepts_provider:
                            klines = self._get_klines(
                                symbol,
                                interval,
                                provider=provider_code,
                                limit=int(getattr(settings, "SPOT_PROVIDER_WS_KLINE_LIMIT", 300) or 300),
                            )
                        else:
                            klines = self._get_klines(
                                symbol,
                                interval,
                                limit=int(getattr(settings, "SPOT_PROVIDER_WS_KLINE_LIMIT", 300) or 300),
                            )
                    except Exception:
                        logger.warning(
                            "spot_market_gateway_get_kline_failed symbol=%s interval=%s",
                            symbol,
                            interval,
                            exc_info=True,
                        )
                        klines = None
                    kline = self._latest_kline_for_broadcast(klines)
                    if kline is not None and self._should_broadcast_kline(
                        symbol,
                        interval,
                        kline,
                        provider=(klines or {}).get("provider"),
                    ):
                        try:
                            await self._market_ws_manager().broadcast_provider_kline_update(
                                symbol,
                                interval,
                                kline,
                                source=str((klines or {}).get("source") or "LIVE_WS"),
                                updated_at=(klines or {}).get("updated_at"),
                            )
                            self._remember_broadcast_metric(symbol, "kline")
                        except Exception:
                            logger.warning(
                                "spot_market_gateway_kline_broadcast_failed symbol=%s interval=%s",
                                symbol,
                                interval,
                                exc_info=True,
                            )

                await asyncio.sleep(self._loop_interval_seconds())
        except asyncio.CancelledError:
            return
        except RuntimeError as exc:
            if _is_executor_shutdown(exc):
                return
            logger.warning("spot_market_gateway_refresh_loop_failed symbol=%s", symbol, exc_info=True)
        except Exception:
            logger.warning("spot_market_gateway_refresh_loop_failed symbol=%s", symbol, exc_info=True)
        finally:
            async with self._task_lock:
                task = self._tasks.get(symbol)
                if task is current_task:
                    self._tasks.pop(symbol, None)

    async def _apply_pending_provider_switch(self, symbol: str) -> None:
        pending = self._pending_provider_switches.pop(symbol, None)
        if pending is None:
            return
        previous_provider, provider_code = pending
        try:
            if self._release_depth_accepts_provider:
                await asyncio.to_thread(self._release_depth, symbol, provider=previous_provider)
            else:
                await asyncio.to_thread(self._release_depth, symbol)
            if self._ensure_depth_accepts_provider:
                self._ensure_depth(symbol, provider=provider_code)
            else:
                self._ensure_depth(symbol)
            for interval in sorted(self._ensured_kline_intervals.get(symbol, set())):
                self._ensure_kline_interval(symbol, interval, provider=provider_code)
            self._broadcast_state.clear_symbol(symbol)
        except Exception:
            if self._depth_authority.active_provider(symbol) == provider_code:
                self._pending_provider_switches[symbol] = (previous_provider, provider_code)
            logger.warning(
                "spot_market_gateway_provider_switch_failed symbol=%s previous=%s provider=%s",
                symbol,
                previous_provider,
                provider_code,
                exc_info=True,
            )

    async def _release_provider_symbol(self, symbol: str, provider_code: str) -> None:
        if self._release_depth_accepts_provider:
            await asyncio.to_thread(self._release_depth, symbol, provider=provider_code)
        else:
            await asyncio.to_thread(self._release_depth, symbol)
        self._broadcast_state.clear_symbol(symbol)
        self._ensured_kline_intervals.pop(symbol, None)
        self._pending_kline_releases.pop(symbol, None)
        self._precision_cache.pop(symbol, None)
        self._symbol_providers.pop(symbol, None)
        self._pending_provider_switches.pop(symbol, None)
        self._depth_authority.clear_symbol(symbol)

    def _should_broadcast_depth(self, symbol: str, depth: DepthResponse) -> bool:
        domain_key = self._domain_key("depth", symbol, provider=getattr(depth, "provider", None))
        signature = self._depth_signature(depth)
        now_ms = self._broadcast_state.now_ms()
        if not self._broadcast_state.should_broadcast_domain(
            domain_key,
            signature,
            self._broadcast_interval_ms(),
            now_ms=now_ms,
        ):
            return False
        self._broadcast_state.remember_broadcast(domain_key, signature, now_ms=now_ms)
        return True

    def _depth_signature(self, depth: DepthResponse) -> str:
        bids = [(item.price, item.amount) for item in depth.bids[:20]]
        asks = [(item.price, item.amount) for item in depth.asks[:20]]
        return repr((bids, asks, getattr(depth, "ts", None)))

    def _should_broadcast_ticker(self, symbol: str, ticker: dict[str, Any]) -> bool:
        domain_key = self._domain_key("ticker", symbol, provider=ticker.get("provider"))
        signature = self._ticker_signature(ticker)
        now_ms = self._broadcast_state.now_ms()
        if not self._broadcast_state.should_broadcast_domain(
            domain_key,
            signature,
            self._ticker_broadcast_interval_ms(),
            now_ms=now_ms,
        ):
            return False
        self._broadcast_state.remember_broadcast(domain_key, signature, now_ms=now_ms)
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
        domain_key = self._domain_key("trades", symbol, provider=getattr(trades, "provider", None))
        now_ms = self._broadcast_state.now_ms()
        if not self._broadcast_state.should_broadcast_domain(
            domain_key,
            None,
            self._trades_broadcast_interval_ms(),
            now_ms=now_ms,
        ):
            return []
        batch_seen: set[str] = set()
        new_items: list[Any] = []
        new_signatures: list[str] = []
        for trade in reversed(list(trades.trades or [])):
            signature = self._trade_signature(trade)
            if (
                not signature
                or signature in batch_seen
                or self._broadcast_state.has_seen_trade_signature(domain_key, signature)
            ):
                continue
            batch_seen.add(signature)
            new_signatures.append(signature)
            new_items.append(trade)
        if new_signatures:
            self._broadcast_state.remember_trade_signatures(domain_key, new_signatures, max_seen=200)
            self._broadcast_state.remember_broadcast(domain_key, repr(new_signatures), now_ms=now_ms)
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

    async def _active_kline_intervals(self, symbol: str) -> list[str]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        try:
            intervals = await self._market_ws_manager().kline_intervals(normalized_symbol)
        except Exception:
            intervals = list(self._ensured_kline_intervals.get(normalized_symbol, set()))
        return sorted({self._normalize_interval(interval) for interval in intervals or []})

    async def _sync_kline_intervals(self, symbol: str, intervals: list[str]) -> list[str]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol:
            return []
        active_intervals = sorted({self._normalize_interval(interval) for interval in intervals or []})
        ensured_intervals = set(self._ensured_kline_intervals.get(normalized_symbol, set()))
        provider_code = self._symbol_providers.get(normalized_symbol) or PROVIDER_BITGET_SPOT
        if not spot_provider_ws_supports_provider(provider_code, domain="kline"):
            for interval in ensured_intervals:
                self._clear_kline_interval_state(normalized_symbol, interval, provider=provider_code)
            self._ensured_kline_intervals.pop(normalized_symbol, None)
            self._pending_kline_releases.pop(normalized_symbol, None)
            return []

        now = time.monotonic()
        pending_releases = self._pending_kline_releases.setdefault(normalized_symbol, {})
        for interval in sorted(ensured_intervals - set(active_intervals)):
            release_at = pending_releases.get(interval)
            if release_at is None:
                release_at = now + self._kline_release_grace_seconds
                pending_releases[interval] = release_at
            if release_at > now:
                continue
            try:
                if self._release_kline_accepts_provider:
                    await asyncio.to_thread(self._release_kline, normalized_symbol, interval, provider=provider_code)
                else:
                    await asyncio.to_thread(self._release_kline, normalized_symbol, interval)
            except Exception:
                logger.warning(
                    "spot_market_gateway_release_kline_interval_failed symbol=%s interval=%s",
                    normalized_symbol,
                    interval,
                    exc_info=True,
                )
                continue
            pending_releases.pop(interval, None)
            self._ensured_kline_intervals.get(normalized_symbol, set()).discard(interval)
            self._clear_kline_interval_state(normalized_symbol, interval, provider=provider_code)

        ready_intervals: list[str] = []
        for interval in active_intervals:
            pending_releases.pop(interval, None)
            try:
                self._ensure_kline_interval(normalized_symbol, interval, provider=provider_code)
            except Exception:
                logger.warning(
                    "spot_market_gateway_ensure_kline_interval_failed symbol=%s interval=%s",
                    normalized_symbol,
                    interval,
                    exc_info=True,
                )
                continue
            ready_intervals.append(interval)
        if not pending_releases:
            self._pending_kline_releases.pop(normalized_symbol, None)
        return ready_intervals

    def _ensure_kline_interval(self, symbol: str, interval: str, *, provider: Optional[str] = None) -> None:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        normalized_interval = self._normalize_interval(interval)
        if not normalized_symbol:
            return
        provider_code = str(provider or self._symbol_providers.get(normalized_symbol) or PROVIDER_BITGET_SPOT)
        if not spot_provider_ws_supports_provider(provider_code, domain="kline"):
            return
        self._pending_kline_releases.get(normalized_symbol, {}).pop(normalized_interval, None)
        if self._ensure_kline_accepts_provider:
            self._ensure_kline(normalized_symbol, normalized_interval, provider=provider_code)
        else:
            self._ensure_kline(normalized_symbol, normalized_interval)
        self._ensured_kline_intervals.setdefault(normalized_symbol, set()).add(normalized_interval)

    def _clear_kline_interval_state(self, symbol: str, interval: str, *, provider: Optional[str] = None) -> None:
        self._broadcast_state.clear_domain_key(
            self._domain_key(
                "kline",
                symbol,
                provider=provider or self._symbol_providers.get(normalize_spot_ws_symbol(symbol)) or PROVIDER_BITGET_SPOT,
                interval=interval,
            )
        )

    def _latest_kline_for_broadcast(self, klines: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
        items = list((klines or {}).get("items") or [])
        if not items:
            return None
        valid_items: list[dict[str, Any]] = []
        for item in items:
            if isinstance(item, dict):
                valid_items.append(item)
        if not valid_items:
            return None
        valid_items.sort(key=lambda item: int(item.get("open_time") or 0))
        return valid_items[-1]

    def _should_broadcast_kline(
        self,
        symbol: str,
        interval: str,
        kline: dict[str, Any],
        *,
        provider: Any = None,
    ) -> bool:
        normalized_interval = self._normalize_interval(interval)
        domain_key = self._domain_key(
            "kline",
            symbol,
            provider=provider or kline.get("provider"),
            interval=normalized_interval,
        )
        signature = self._kline_signature(symbol, normalized_interval, kline)
        now_ms = self._broadcast_state.now_ms()
        if not self._broadcast_state.should_broadcast_domain(
            domain_key,
            signature,
            self._kline_broadcast_interval_ms(),
            now_ms=now_ms,
        ):
            return False
        self._broadcast_state.remember_broadcast(domain_key, signature, now_ms=now_ms)
        return True

    def _kline_signature(self, symbol: str, interval: str, kline: dict[str, Any]) -> str:
        keys = ("open_time", "open", "high", "low", "close", "volume", "quote_volume")
        return repr(
            (
                normalize_spot_ws_symbol(symbol),
                self._normalize_interval(interval),
                tuple(kline.get(key) for key in keys),
            )
        )

    def _remember_broadcast_metric(self, symbol: str, domain: str) -> None:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol:
            return
        self._broadcast_counters[domain] = int(self._broadcast_counters.get(domain) or 0) + 1
        self._last_broadcast_at[normalized_symbol] = time.time()
        self._last_broadcast_type[normalized_symbol] = domain

    def _domain_key(
        self,
        domain: str,
        symbol: str,
        *,
        provider: Any = None,
        interval: Optional[str] = None,
    ):
        return make_domain_key(
            domain,
            str(provider or PROVIDER_BITGET_SPOT),
            normalize_spot_ws_symbol(symbol),
            interval=self._normalize_interval(interval) if interval is not None else None,
        )

    def _normalize_interval(self, interval: Any) -> str:
        normalized = normalize_spot_kline_bucket_interval(interval)
        if normalized in {"1m", "5m", "15m", "1h", "4h", "1d", "1Dutc", "1w", "1Wutc", "1M", "1Mutc"}:
            return normalized
        return "1m"

    def _broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_BROADCAST_INTERVAL_MS", 200) or 200)
        return max(0.05, interval_ms / 1000)

    def _broadcast_interval_ms(self) -> int:
        return int(self._broadcast_interval_seconds() * 1000)

    def _ticker_broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_TICKER_BROADCAST_INTERVAL_MS", 500) or 500)
        return max(0.1, interval_ms / 1000)

    def _ticker_broadcast_interval_ms(self) -> int:
        return int(self._ticker_broadcast_interval_seconds() * 1000)

    def _trades_broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_TRADES_BROADCAST_INTERVAL_MS", 200) or 200)
        return max(0.05, interval_ms / 1000)

    def _trades_broadcast_interval_ms(self) -> int:
        return int(self._trades_broadcast_interval_seconds() * 1000)

    def _kline_broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "SPOT_PROVIDER_WS_KLINE_BROADCAST_INTERVAL_MS", 1000) or 1000)
        return max(0.1, min(interval_ms, _MAX_KLINE_BROADCAST_INTERVAL_MS) / 1000)

    def _kline_broadcast_interval_ms(self) -> int:
        return int(self._kline_broadcast_interval_seconds() * 1000)

    def _loop_interval_seconds(self) -> float:
        return min(
            self._broadcast_interval_seconds(),
            self._ticker_broadcast_interval_seconds(),
            self._trades_broadcast_interval_seconds(),
            self._kline_broadcast_interval_seconds(),
        )

    async def _subscriber_count(self, symbol: str) -> int:
        return await self._market_ws_manager().subscriber_count(symbol)

    async def _provider_symbol_allowed_async(self, symbol: str) -> bool:
        if self._provider_symbol_allowed_is_default:
            return await asyncio.to_thread(self._provider_symbol_allowed, symbol)
        return bool(self._provider_symbol_allowed(symbol))

    def _market_ws_manager(self) -> Any:
        if self._ws_manager is not None:
            return self._ws_manager
        from app.services.market_ws import market_ws_manager

        return market_ws_manager

    def _select_provider_ws_code(self, symbol: str) -> Optional[str]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol:
            return None
        db = SessionLocal()
        try:
            pair = (
                db.query(TradingPair)
                .filter(TradingPair.symbol == normalized_symbol, TradingPair.status == 1)
                .first()
            )
            if pair is None:
                return None
            if str(getattr(pair, "data_source", "") or "").strip().upper() != "BINANCE":
                return None
            providers = tuple(enabled_spot_market_providers(db))
            if not providers:
                return None
            primary_provider = providers[0]
            provider_code = str(getattr(primary_provider, "provider_code", "") or "").strip().upper()
            if not spot_provider_ws_supports_provider(provider_code, domain="depth"):
                return None
            return provider_code
        except Exception:
            logger.warning("spot_market_gateway_provider_select_failed symbol=%s", normalized_symbol, exc_info=True)
            return None
        finally:
            db.close()

    def _default_provider_symbol_allowed(self, symbol: str) -> bool:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol:
            return False
        db = SessionLocal()
        try:
            pair = (
                db.query(TradingPair)
                .filter(TradingPair.symbol == normalized_symbol, TradingPair.status == 1)
                .first()
            )
            if pair is None:
                return False
            return str(getattr(pair, "data_source", "") or "").strip().upper() == "BINANCE"
        except Exception:
            logger.warning("spot_market_gateway_provider_symbol_check_failed symbol=%s", normalized_symbol, exc_info=True)
            return False
        finally:
            db.close()

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
                "freshness": (
                    "LAST_GOOD"
                    if getattr(depth, "stale", False)
                    else str(getattr(depth, "freshness", None) or "LIVE").strip().upper()
                ),
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
