from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import replace
from decimal import Decimal
from typing import Any, Callable, Mapping, Optional

from app.core.config import settings
from app.db.models.trading_pair import TradingPair
from app.db.session import SessionLocal
from app.schemas.market import DepthItem, DepthResponse, TradesResponse
from app.schemas.spot_domain_snapshot import (
    DepthDomainSnapshot,
    DomainCacheOrigin,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainName,
    DomainSource,
    DomainTransport,
    TickerDomainSnapshot,
    TradesDomainSnapshot,
)
from app.services.contract_market_provider_service import PROVIDER_BITGET_SPOT, enabled_spot_market_providers
from app.services.market_domain_snapshot import MarketDomainSnapshot
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
    get_spot_provider_ws_kline_revisions,
    get_spot_provider_ws_ticker,
    get_spot_provider_ws_trades,
    normalize_spot_ws_symbol,
    release_spot_provider_ws_depth,
    release_spot_provider_ws_kline,
    spot_trade_strong_identity,
    spot_trade_weak_fingerprint,
    spot_provider_ws_supports_provider,
)
from app.services.spot_kline_bucket import normalize_spot_kline_bucket_interval
from app.services.spot_depth_domain_snapshot import map_depth_domain_snapshot
from app.services.spot_kline_domain_snapshot import (
    KlineDomainSnapshot,
    map_kline_domain_snapshot,
)
from app.services.spot_ticker_domain_snapshot import map_ticker_domain_snapshot
from app.services.spot_domain_snapshot_freshness import (
    DomainSnapshotContext,
    resolve_domain_snapshot_freshness,
)
from app.services.spot_trades_domain_snapshot import map_trades_domain_snapshot


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


def _first_not_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


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
        get_kline_revisions: Optional[Callable[..., Optional[Mapping[str, Any]]]] = None,
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
        self._get_klines = (
            get_kline_revisions
            or get_klines
            or get_spot_provider_ws_kline_revisions
        )
        self._get_klines_accepts_provider = get_kline_revisions is None and get_klines is None
        self._provider_symbol_allowed = provider_symbol_allowed or self._default_provider_symbol_allowed
        self._provider_symbol_allowed_is_default = provider_symbol_allowed is None
        self._precision_resolver = precision_resolver or self._default_precision_resolver
        self._ws_manager = ws_manager
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._idle_tasks: dict[str, asyncio.Task[None]] = {}
        self._task_lock = asyncio.Lock()
        self._broadcast_state = SpotGatewayBroadcastState()
        self._kline_revision_high_water: dict[Any, tuple[int, int, int]] = {}
        self._depth_authority = SpotGatewayDepthAuthority()
        self._ensured_kline_intervals: dict[str, set[str]] = {}
        self._pending_kline_releases: dict[str, dict[str, float]] = {}
        self._kline_release_grace_seconds = max(0.0, float(kline_release_grace_seconds))
        self._precision_cache: dict[str, tuple[int, int]] = {}
        self._symbol_providers: dict[str, str] = {}
        self._pending_provider_switches: dict[str, tuple[str, str]] = {}
        self._depth_domain_snapshots: dict[str, DepthDomainSnapshot] = {}
        self._ticker_domain_snapshots: dict[str, TickerDomainSnapshot] = {}
        self._trades_domain_snapshots: dict[str, TradesDomainSnapshot] = {}
        self._kline_domain_snapshots: dict[tuple[str, str], KlineDomainSnapshot] = {}
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
        snapshot_fallback_reason: Optional[DomainFallbackReason] = None,
        snapshot_sequence: Optional[int] = None,
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
        try:
            snapshot_transport, snapshot_cache_origin = self._depth_snapshot_origin(state.source)
            self._record_depth_domain_snapshot(
                symbol=normalized_symbol,
                depth=state.depth,
                provider=state.provider,
                provider_symbol=state.provider_symbol,
                transport=snapshot_transport,
                cache_origin=snapshot_cache_origin,
                source=self._depth_snapshot_source(state.source),
                freshness=self._depth_snapshot_freshness(state.freshness),
                fallback_reason=snapshot_fallback_reason,
                provider_event_time_ms=state.event_time_ms,
                received_at_ms=state.received_at_ms,
                cache_updated_at_ms=(
                    state.received_at_ms
                    if snapshot_cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
                    else None
                ),
                provider_generation=state.provider_generation,
                sequence=snapshot_sequence,
            )
        except Exception:
            logger.warning(
                "spot_market_gateway_depth_snapshot_failed symbol=%s provider=%s",
                normalized_symbol,
                state.provider,
                exc_info=True,
            )
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
                    authority_snapshot = self.get_depth_domain_snapshot(symbol)
                    if self._should_broadcast_depth(
                        symbol,
                        authoritative_depth,
                        snapshot=authority_snapshot,
                    ):
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
                if depth is None and authority_state is None:
                    self._record_depth_domain_snapshot(
                        symbol=symbol,
                        depth=None,
                        provider=provider_code,
                        transport=DomainTransport.PROVIDER_WS,
                        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
                        fallback_reason=DomainFallbackReason.CACHE_MISS,
                    )
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
                depth_snapshot = self.get_depth_domain_snapshot(symbol)
                if depth is not None and self._should_broadcast_depth(
                    symbol,
                    depth,
                    snapshot=depth_snapshot,
                ):
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
                ticker_snapshot = self._record_ticker_domain_snapshot(
                    symbol,
                    ticker,
                    transport=DomainTransport.PROVIDER_WS,
                    cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
                    fallback_reason=(
                        DomainFallbackReason.CACHE_MISS if ticker is None else None
                    ),
                )
                legacy_ticker = (
                    self._format_ticker_for_broadcast(symbol, ticker_snapshot.data)
                    if ticker_snapshot.data is not None
                    else None
                )
                if legacy_ticker is not None and self._should_broadcast_ticker(
                    symbol,
                    legacy_ticker,
                    snapshot=ticker_snapshot,
                ):
                    try:
                        await self._market_ws_manager().broadcast_ticker_update(symbol, legacy_ticker)
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
                try:
                    trades_snapshot = self._record_trades_domain_snapshot(
                        symbol=symbol,
                        trades=trades,
                        provider=provider_code if trades is None else None,
                        transport=DomainTransport.PROVIDER_WS,
                        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
                        fallback_reason=(
                            DomainFallbackReason.CACHE_MISS if trades is None else None
                        ),
                    )
                except Exception:
                    trades_snapshot = None
                    logger.warning(
                        "spot_market_gateway_trades_snapshot_failed symbol=%s provider=%s",
                        symbol,
                        provider_code,
                        exc_info=True,
                    )
                for trade in self._new_trades_for_broadcast(
                    symbol,
                    trades,
                    snapshot=trades_snapshot,
                ):
                    try:
                        item_id = getattr(trade, "id", None)
                        trade_id = _first_not_none(getattr(trade, "trade_id", None), item_id)
                        provider_trade_id = _first_not_none(
                            getattr(trade, "provider_trade_id", None),
                            trade_id,
                            item_id,
                        )
                        trade_ts = getattr(trade, "ts", None)
                        await self._market_ws_manager().send_trade(
                            symbol=symbol,
                            price=getattr(trade, "price", None),
                            amount=getattr(trade, "amount", None),
                            side=getattr(trade, "side", ""),
                            ts=int(trade_ts) if trade_ts is not None else 0,
                            id=item_id,
                            trade_id=trade_id,
                            provider=_first_not_none(
                                getattr(trade, "provider", None),
                                getattr(trades, "provider", None),
                            ),
                            provider_symbol=_first_not_none(
                                getattr(trade, "provider_symbol", None),
                                getattr(trades, "provider_symbol", None),
                            ),
                            provider_trade_id=provider_trade_id,
                            source=_first_not_none(
                                getattr(trade, "source", None),
                                getattr(trades, "source", None),
                            ),
                            freshness=_first_not_none(
                                getattr(trade, "freshness", None),
                                getattr(trades, "freshness", None),
                            ),
                            updated_at_ms=_first_not_none(
                                getattr(trade, "updated_at_ms", None),
                                getattr(trades, "updated_at_ms", None),
                            ),
                            event_time_ms=getattr(trade, "event_time_ms", None),
                            received_at_ms=_first_not_none(
                                getattr(trade, "received_at_ms", None),
                                getattr(trades, "received_at_ms", None),
                            ),
                            time_origin=getattr(trade, "time_origin", None),
                            created_at=getattr(trade, "created_at", None),
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
                    try:
                        kline_snapshot = self._record_kline_domain_snapshot(
                            symbol=symbol,
                            interval=interval,
                            kline=klines,
                            provider=(klines or {}).get("provider") or provider_code,
                            provider_symbol=(klines or {}).get("provider_symbol"),
                            transport=DomainTransport.PROVIDER_WS,
                            cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
                            fallback_reason=(
                                DomainFallbackReason.CACHE_MISS if klines is None else None
                            ),
                            revision_epoch=(kline or {}).get("revision_epoch"),
                            revision_sequence=(kline or {}).get("revision_seq"),
                            is_closed=(kline or {}).get("is_closed"),
                            close_state_source=(kline or {}).get("close_state_source"),
                        )
                    except Exception:
                        kline_snapshot = None
                        logger.warning(
                            "spot_market_gateway_kline_snapshot_failed symbol=%s interval=%s provider=%s",
                            symbol,
                            interval,
                            provider_code,
                            exc_info=True,
                        )
                    if kline is not None and self._should_broadcast_kline(
                        symbol,
                        interval,
                        kline,
                        provider=(klines or {}).get("provider"),
                        snapshot=kline_snapshot,
                    ):
                        try:
                            await self._market_ws_manager().broadcast_provider_kline_update(
                                symbol,
                                interval,
                                kline,
                                source=str((klines or {}).get("source") or "LIVE_WS"),
                                updated_at=(klines or {}).get("updated_at"),
                                revision_epoch=kline.get("revision_epoch"),
                                revision_seq=kline.get("revision_seq"),
                                is_closed=kline.get("is_closed"),
                                close_state_source=kline.get("close_state_source"),
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
            for interval in sorted(self._ensured_kline_intervals.get(symbol, set())):
                if self._release_kline_accepts_provider:
                    await asyncio.to_thread(
                        self._release_kline,
                        symbol,
                        interval,
                        provider=previous_provider,
                    )
                else:
                    await asyncio.to_thread(self._release_kline, symbol, interval)
                self._clear_kline_interval_state(symbol, interval, provider=previous_provider)
            if self._ensure_depth_accepts_provider:
                self._ensure_depth(symbol, provider=provider_code)
            else:
                self._ensure_depth(symbol)
            for interval in sorted(self._ensured_kline_intervals.get(symbol, set())):
                self._ensure_kline_interval(symbol, interval, provider=provider_code)
            self._broadcast_state.clear_symbol(symbol)
            self._clear_kline_revision_symbol(symbol)
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
        self._clear_kline_revision_symbol(symbol)
        self._ensured_kline_intervals.pop(symbol, None)
        self._pending_kline_releases.pop(symbol, None)
        self._precision_cache.pop(symbol, None)
        self._depth_domain_snapshots.pop(symbol, None)
        self._ticker_domain_snapshots.pop(symbol, None)
        self._trades_domain_snapshots.pop(symbol, None)
        self._symbol_providers.pop(symbol, None)
        self._pending_provider_switches.pop(symbol, None)
        self._depth_authority.clear_symbol(symbol)

    def _should_broadcast_depth(
        self,
        symbol: str,
        depth: DepthResponse,
        *,
        snapshot: Optional[DepthDomainSnapshot] = None,
    ) -> bool:
        snapshot_provider = snapshot.metadata.provider if snapshot is not None else None
        domain_key = self._domain_key(
            "depth",
            symbol,
            provider=snapshot_provider or getattr(depth, "provider", None),
        )
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

    def get_depth_domain_snapshot(self, symbol: str) -> Optional[DepthDomainSnapshot]:
        return self._depth_domain_snapshots.get(normalize_spot_ws_symbol(symbol))

    @staticmethod
    def _depth_snapshot_origin(source: str) -> tuple[DomainTransport, DomainCacheOrigin]:
        normalized_source = str(source or "").strip().upper()
        if normalized_source == "LIVE_WS":
            return DomainTransport.PROVIDER_WS, DomainCacheOrigin.PROVIDER_MEMORY
        if normalized_source in {"REST", "REST_SNAPSHOT", "EXTERNAL"}:
            return DomainTransport.PROVIDER_REST, DomainCacheOrigin.NONE
        if normalized_source == "LAST_GOOD":
            return DomainTransport.CACHE_READ, DomainCacheOrigin.LAST_GOOD_MEMORY
        if normalized_source in {"STALE", "STALE_CACHE"}:
            return DomainTransport.CACHE_READ, DomainCacheOrigin.REDIS
        return DomainTransport.NONE, DomainCacheOrigin.NONE

    @staticmethod
    def _depth_snapshot_source(source: str) -> Optional[DomainSource]:
        normalized_source = str(source or "").strip().upper()
        return {
            "LIVE_WS": DomainSource.LIVE_WS,
            "REST": DomainSource.REST_SNAPSHOT,
            "REST_SNAPSHOT": DomainSource.REST_SNAPSHOT,
            "EXTERNAL": DomainSource.REST_SNAPSHOT,
            "LAST_GOOD": DomainSource.LAST_GOOD,
            "STALE": DomainSource.DB_CACHE,
            "STALE_CACHE": DomainSource.DB_CACHE,
            "INTERNAL": DomainSource.INTERNAL,
        }.get(normalized_source)

    @staticmethod
    def _depth_snapshot_freshness(freshness: str) -> Optional[DomainFreshness]:
        normalized_freshness = str(freshness or "").strip().upper()
        return {
            "LIVE": DomainFreshness.LIVE,
            "RECENT": DomainFreshness.RECENT,
            "STALE": DomainFreshness.STALE,
            "LAST_GOOD": DomainFreshness.LAST_GOOD,
            "LAST_VALID": DomainFreshness.LAST_GOOD,
            "MISSING": DomainFreshness.MISSING,
        }.get(normalized_freshness)

    def record_depth_market_domain_snapshot(
        self,
        *,
        snapshot: MarketDomainSnapshot,
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> DepthDomainSnapshot:
        if snapshot.domain != "depth":
            raise ValueError("market domain snapshot must use the depth domain")
        if context.domain != DomainName.DEPTH:
            raise ValueError("depth snapshot context must use the depth domain")
        normalized_symbol = normalize_spot_ws_symbol(snapshot.symbol)
        if normalized_symbol != normalize_spot_ws_symbol(context.symbol):
            raise ValueError("depth snapshot symbol does not match context")
        if snapshot.data is not None and not isinstance(snapshot.data, Mapping):
            raise ValueError("depth market domain snapshot data must be a mapping")

        resolved_context = replace(
            context,
            symbol=normalized_symbol,
            provider=snapshot.provider,
            cache_updated_at_ms=(
                context.cache_updated_at_ms
                if context.cache_updated_at_ms is not None
                else snapshot.updated_at
            ),
        )
        depth = dict(snapshot.data) if isinstance(snapshot.data, Mapping) else None
        return self.record_depth_domain_snapshot(
            depth=depth,
            context=resolved_context,
            emitted_at_ms=emitted_at_ms,
        )

    def record_depth_domain_snapshot(
        self,
        *,
        depth: Any,
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> DepthDomainSnapshot:
        if context.domain != DomainName.DEPTH:
            raise ValueError("depth snapshot context must use the depth domain")
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)
        resolution = resolve_domain_snapshot_freshness(
            context,
            now_ms=current_ms,
        )
        return self._record_depth_domain_snapshot(
            symbol=context.symbol,
            depth=depth,
            transport=context.transport,
            cache_origin=context.cache_origin,
            provider=context.provider,
            provider_symbol=context.provider_symbol,
            source=context.source,
            freshness=resolution.freshness,
            fallback_reason=context.fallback_reason,
            provider_event_time_ms=context.provider_event_time_ms,
            received_at_ms=context.received_at_ms,
            cache_updated_at_ms=context.cache_updated_at_ms,
            age_ms=resolution.age_ms,
            ttl_ms=resolution.ttl_ms,
            stale=resolution.stale,
            provider_generation=context.provider_generation,
            freshness_basis=resolution.freshness_basis,
            emitted_at_ms=current_ms,
        )

    def _record_depth_domain_snapshot(
        self,
        *,
        symbol: str,
        depth: Any,
        transport: DomainTransport = DomainTransport.PROVIDER_WS,
        cache_origin: DomainCacheOrigin = DomainCacheOrigin.PROVIDER_MEMORY,
        provider: Optional[str] = None,
        provider_symbol: Optional[str] = None,
        source: Optional[DomainSource] = None,
        freshness: Optional[DomainFreshness] = None,
        fallback_reason: Optional[DomainFallbackReason] = None,
        provider_event_time_ms: Optional[int] = None,
        received_at_ms: Optional[int] = None,
        cache_updated_at_ms: Optional[int] = None,
        age_ms: Optional[int] = None,
        ttl_ms: Optional[int] = None,
        stale: Optional[bool] = None,
        provider_generation: Optional[int] = None,
        sequence: Optional[int] = None,
        freshness_basis: Optional[DomainFreshnessBasis] = None,
        emitted_at_ms: Optional[int] = None,
    ) -> DepthDomainSnapshot:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)
        resolved_age_ms = age_ms
        if resolved_age_ms is None and cache_updated_at_ms is not None:
            resolved_age_ms = max(0, current_ms - int(cache_updated_at_ms))
        resolved_ttl_ms = ttl_ms
        if resolved_ttl_ms is None and transport == DomainTransport.PROVIDER_WS:
            resolved_ttl_ms = int(
                getattr(settings, "SPOT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500) or 1500
            )
        resolved_freshness_basis = freshness_basis or (
            DomainFreshnessBasis.RECEIVED_AT
            if depth is not None
            else DomainFreshnessBasis.NOT_APPLICABLE
        )
        snapshot = map_depth_domain_snapshot(
            symbol=normalized_symbol,
            depth=depth,
            transport=transport,
            cache_origin=cache_origin,
            provider=provider,
            provider_symbol=provider_symbol,
            source=source,
            freshness=freshness,
            fallback_reason=fallback_reason,
            provider_event_time_ms=provider_event_time_ms,
            received_at_ms=received_at_ms,
            cache_updated_at_ms=cache_updated_at_ms,
            age_ms=resolved_age_ms,
            ttl_ms=resolved_ttl_ms,
            stale=stale,
            provider_generation=provider_generation,
            sequence=sequence,
            freshness_basis=resolved_freshness_basis,
            emitted_at_ms=current_ms,
        )
        self._depth_domain_snapshots[normalized_symbol] = snapshot
        return snapshot

    def _depth_signature(self, depth: DepthResponse) -> str:
        bids = [(item.price, item.amount) for item in depth.bids[:20]]
        asks = [(item.price, item.amount) for item in depth.asks[:20]]
        return repr((bids, asks, getattr(depth, "ts", None)))

    def _should_broadcast_ticker(
        self,
        symbol: str,
        ticker: dict[str, Any],
        *,
        snapshot: Optional[TickerDomainSnapshot] = None,
    ) -> bool:
        snapshot_provider = snapshot.metadata.provider if snapshot is not None else None
        domain_key = self._domain_key(
            "ticker",
            symbol,
            provider=snapshot_provider or ticker.get("provider"),
        )
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

    def get_ticker_domain_snapshot(self, symbol: str) -> Optional[TickerDomainSnapshot]:
        return self._ticker_domain_snapshots.get(normalize_spot_ws_symbol(symbol))

    def record_ticker_market_domain_snapshot(
        self,
        *,
        snapshot: MarketDomainSnapshot,
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> TickerDomainSnapshot:
        if snapshot.domain != "ticker":
            raise ValueError("market domain snapshot must use the ticker domain")
        if context.domain != DomainName.TICKER:
            raise ValueError("ticker snapshot context must use the ticker domain")
        normalized_symbol = normalize_spot_ws_symbol(snapshot.symbol)
        if normalized_symbol != normalize_spot_ws_symbol(context.symbol):
            raise ValueError("ticker snapshot symbol does not match context")
        if snapshot.data is not None and not isinstance(snapshot.data, Mapping):
            raise ValueError("ticker market domain snapshot data must be a mapping")

        resolved_context = replace(
            context,
            symbol=normalized_symbol,
            provider=snapshot.provider,
            cache_updated_at_ms=(
                context.cache_updated_at_ms
                if context.cache_updated_at_ms is not None
                else snapshot.updated_at
            ),
        )
        ticker = dict(snapshot.data) if isinstance(snapshot.data, Mapping) else None
        return self.record_ticker_domain_snapshot(
            ticker=ticker,
            context=resolved_context,
            emitted_at_ms=emitted_at_ms,
        )

    def record_ticker_domain_snapshot(
        self,
        *,
        ticker: Optional[Mapping[str, Any]],
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> TickerDomainSnapshot:
        if context.domain != DomainName.TICKER:
            raise ValueError("ticker snapshot context must use the ticker domain")
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)
        resolution = resolve_domain_snapshot_freshness(
            context,
            now_ms=current_ms,
        )
        return self._record_ticker_domain_snapshot(
            context.symbol,
            ticker,
            transport=context.transport,
            cache_origin=context.cache_origin,
            provider=context.provider,
            provider_symbol=context.provider_symbol,
            source=context.source,
            freshness=resolution.freshness,
            fallback_reason=context.fallback_reason,
            provider_event_time_ms=context.provider_event_time_ms,
            received_at_ms=context.received_at_ms,
            cache_updated_at_ms=context.cache_updated_at_ms,
            age_ms=resolution.age_ms,
            ttl_ms=resolution.ttl_ms,
            freshness_basis=resolution.freshness_basis,
            provider_generation=context.provider_generation,
            emitted_at_ms=current_ms,
        )

    def _record_ticker_domain_snapshot(
        self,
        symbol: str,
        ticker: Optional[Mapping[str, Any]],
        *,
        transport: DomainTransport = DomainTransport.PROVIDER_WS,
        cache_origin: DomainCacheOrigin = DomainCacheOrigin.PROVIDER_MEMORY,
        provider: Optional[str] = None,
        provider_symbol: Optional[str] = None,
        source: Optional[DomainSource] = None,
        freshness: Optional[DomainFreshness] = None,
        fallback_reason: Optional[DomainFallbackReason] = None,
        provider_event_time_ms: Optional[int] = None,
        received_at_ms: Optional[int] = None,
        cache_updated_at_ms: Optional[int] = None,
        age_ms: Optional[int] = None,
        ttl_ms: Optional[int] = None,
        freshness_basis: Optional[DomainFreshnessBasis] = None,
        provider_generation: Optional[int] = None,
        emitted_at_ms: Optional[int] = None,
    ) -> TickerDomainSnapshot:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)

        resolved_cache_updated_at_ms = cache_updated_at_ms
        if (
            resolved_cache_updated_at_ms is None
            and ticker is not None
            and cache_origin != DomainCacheOrigin.NONE
        ):
            try:
                resolved_cache_updated_at_ms = int(ticker.get("updated_at_ms"))
            except (TypeError, ValueError):
                resolved_cache_updated_at_ms = None

        resolved_age_ms = age_ms
        if resolved_age_ms is None and resolved_cache_updated_at_ms is not None:
            resolved_age_ms = max(0, current_ms - resolved_cache_updated_at_ms)

        resolved_ttl_ms = ttl_ms
        if resolved_ttl_ms is None and transport == DomainTransport.PROVIDER_WS:
            resolved_ttl_ms = int(
                getattr(settings, "SPOT_PROVIDER_WS_TICKER_MAX_AGE_MS", 1500) or 1500
            )

        resolved_freshness_basis = freshness_basis or (
            DomainFreshnessBasis.RECEIVED_AT
            if ticker is not None
            else DomainFreshnessBasis.NOT_APPLICABLE
        )
        snapshot = map_ticker_domain_snapshot(
            symbol=normalized_symbol,
            ticker=ticker,
            transport=transport,
            cache_origin=cache_origin,
            provider=provider,
            provider_symbol=provider_symbol,
            source=source,
            freshness=freshness,
            fallback_reason=fallback_reason,
            provider_event_time_ms=provider_event_time_ms,
            received_at_ms=received_at_ms,
            cache_updated_at_ms=resolved_cache_updated_at_ms,
            age_ms=resolved_age_ms,
            ttl_ms=resolved_ttl_ms,
            freshness_basis=resolved_freshness_basis,
            provider_generation=provider_generation,
            emitted_at_ms=current_ms,
        )
        self._ticker_domain_snapshots[normalized_symbol] = snapshot
        return snapshot

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

    def _new_trades_for_broadcast(
        self,
        symbol: str,
        trades: Optional[TradesResponse],
        *,
        snapshot: Optional[TradesDomainSnapshot] = None,
    ) -> list[Any]:
        if trades is None or not getattr(trades, "trades", None):
            return []
        snapshot_provider = snapshot.metadata.provider if snapshot is not None else None
        domain_key = self._domain_key(
            "trades",
            symbol,
            provider=snapshot_provider or getattr(trades, "provider", None),
        )
        now_ms = self._broadcast_state.now_ms()
        if not self._broadcast_state.should_broadcast_domain(
            domain_key,
            None,
            self._trades_broadcast_interval_ms(),
            now_ms=now_ms,
        ):
            return []
        batch_seen: set[str] = set()
        weak_occurrences: dict[str, int] = {}
        new_items: list[Any] = []
        new_signatures: list[str] = []
        provider = getattr(trades, "provider", None)
        provider_symbol = getattr(trades, "provider_symbol", None)
        for trade in reversed(list(trades.trades or [])):
            strong_identity = spot_trade_strong_identity(trade, provider=provider)
            if strong_identity is not None:
                signature = strong_identity
            else:
                fingerprint = spot_trade_weak_fingerprint(
                    trade,
                    provider=provider,
                    provider_symbol=provider_symbol,
                )
                occurrence = weak_occurrences.get(fingerprint, 0) + 1
                weak_occurrences[fingerprint] = occurrence
                # Weak identity is only a conservative multiset count.  Stable
                # occurrences prevent replay while preserving real collisions.
                signature = f"{fingerprint}|occurrence:{occurrence}"
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

    def get_trades_domain_snapshot(self, symbol: str) -> Optional[TradesDomainSnapshot]:
        return self._trades_domain_snapshots.get(normalize_spot_ws_symbol(symbol))

    def record_trades_market_domain_snapshot(
        self,
        *,
        snapshot: MarketDomainSnapshot,
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> TradesDomainSnapshot:
        if snapshot.domain != "trades":
            raise ValueError("market domain snapshot must use the trades domain")
        if context.domain != DomainName.TRADES:
            raise ValueError("trades snapshot context must use the trades domain")
        normalized_symbol = normalize_spot_ws_symbol(snapshot.symbol)
        if normalized_symbol != normalize_spot_ws_symbol(context.symbol):
            raise ValueError("trades snapshot symbol does not match context")
        if snapshot.data is not None and not isinstance(snapshot.data, Mapping):
            raise ValueError("trades market domain snapshot data must be a mapping")

        resolved_context = replace(
            context,
            symbol=normalized_symbol,
            provider=snapshot.provider,
            cache_updated_at_ms=(
                context.cache_updated_at_ms
                if context.cache_updated_at_ms is not None
                else snapshot.updated_at
            ),
        )
        trades = dict(snapshot.data) if isinstance(snapshot.data, Mapping) else None
        return self.record_trades_domain_snapshot(
            trades=trades,
            context=resolved_context,
            emitted_at_ms=emitted_at_ms,
        )

    def record_trades_domain_snapshot(
        self,
        *,
        trades: Any,
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> TradesDomainSnapshot:
        if context.domain != DomainName.TRADES:
            raise ValueError("trades snapshot context must use the trades domain")
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)
        resolution = resolve_domain_snapshot_freshness(
            context,
            now_ms=current_ms,
        )
        return self._record_trades_domain_snapshot(
            symbol=context.symbol,
            trades=trades,
            transport=context.transport,
            cache_origin=context.cache_origin,
            provider=context.provider,
            provider_symbol=context.provider_symbol,
            source=context.source,
            freshness=resolution.freshness,
            fallback_reason=context.fallback_reason,
            provider_event_time_ms=context.provider_event_time_ms,
            received_at_ms=context.received_at_ms,
            cache_updated_at_ms=context.cache_updated_at_ms,
            age_ms=resolution.age_ms,
            ttl_ms=resolution.ttl_ms,
            stale=resolution.stale,
            freshness_basis=resolution.freshness_basis,
            emitted_at_ms=current_ms,
        )

    def _record_trades_domain_snapshot(
        self,
        *,
        symbol: str,
        trades: Any,
        transport: DomainTransport = DomainTransport.PROVIDER_WS,
        cache_origin: DomainCacheOrigin = DomainCacheOrigin.PROVIDER_MEMORY,
        provider: Optional[str] = None,
        provider_symbol: Optional[str] = None,
        source: Optional[DomainSource] = None,
        freshness: Optional[DomainFreshness] = None,
        fallback_reason: Optional[DomainFallbackReason] = None,
        provider_event_time_ms: Optional[int] = None,
        received_at_ms: Optional[int] = None,
        cache_updated_at_ms: Optional[int] = None,
        age_ms: Optional[int] = None,
        ttl_ms: Optional[int] = None,
        stale: Optional[bool] = None,
        freshness_basis: Optional[DomainFreshnessBasis] = None,
        emitted_at_ms: Optional[int] = None,
    ) -> TradesDomainSnapshot:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)

        resolved_cache_updated_at_ms = cache_updated_at_ms
        if (
            resolved_cache_updated_at_ms is None
            and trades is not None
            and cache_origin != DomainCacheOrigin.NONE
        ):
            raw_cache_updated_at_ms = (
                trades.get("updated_at_ms")
                if isinstance(trades, Mapping)
                else getattr(trades, "updated_at_ms", None)
            )
            try:
                resolved_cache_updated_at_ms = int(raw_cache_updated_at_ms)
            except (TypeError, ValueError):
                resolved_cache_updated_at_ms = None

        resolved_age_ms = age_ms
        if resolved_age_ms is None and resolved_cache_updated_at_ms is not None:
            resolved_age_ms = max(0, current_ms - resolved_cache_updated_at_ms)
        resolved_ttl_ms = ttl_ms
        if resolved_ttl_ms is None and transport == DomainTransport.PROVIDER_WS:
            resolved_ttl_ms = int(
                getattr(settings, "SPOT_PROVIDER_WS_TRADES_MAX_AGE_MS", 1500) or 1500
            )
        resolved_freshness_basis = freshness_basis or (
            DomainFreshnessBasis.RECEIVED_AT
            if trades is not None
            else DomainFreshnessBasis.NOT_APPLICABLE
        )
        snapshot = map_trades_domain_snapshot(
            symbol=normalized_symbol,
            trades=trades,
            transport=transport,
            cache_origin=cache_origin,
            provider=provider,
            provider_symbol=provider_symbol,
            source=source,
            freshness=freshness,
            fallback_reason=fallback_reason,
            provider_event_time_ms=provider_event_time_ms,
            received_at_ms=received_at_ms,
            cache_updated_at_ms=resolved_cache_updated_at_ms,
            age_ms=resolved_age_ms,
            ttl_ms=resolved_ttl_ms,
            stale=stale,
            freshness_basis=resolved_freshness_basis,
            emitted_at_ms=current_ms,
        )
        self._trades_domain_snapshots[normalized_symbol] = snapshot
        return snapshot

    def _trade_signature(
        self,
        trade: Any,
        *,
        provider: Any = None,
        provider_symbol: Any = None,
    ) -> str:
        return spot_trade_strong_identity(trade, provider=provider) or spot_trade_weak_fingerprint(
            trade,
            provider=provider,
            provider_symbol=provider_symbol,
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
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        normalized_interval = self._normalize_interval(interval)
        domain_key = self._domain_key(
            "kline",
            normalized_symbol,
            provider=provider or self._symbol_providers.get(normalized_symbol) or PROVIDER_BITGET_SPOT,
            interval=normalized_interval,
        )
        self._broadcast_state.clear_domain_key(domain_key)
        self._kline_revision_high_water.pop(domain_key, None)
        self._kline_domain_snapshots.pop((normalized_symbol, normalized_interval), None)

    def _clear_kline_revision_symbol(self, symbol: str) -> None:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        if not normalized_symbol:
            return
        for key in [
            key
            for key in self._kline_revision_high_water
            if key.symbol == normalized_symbol
        ]:
            self._kline_revision_high_water.pop(key, None)
        for key in [
            key
            for key in self._kline_domain_snapshots
            if key[0] == normalized_symbol
        ]:
            self._kline_domain_snapshots.pop(key, None)

    def _latest_kline_for_broadcast(
        self,
        klines: Optional[Mapping[str, Any]],
    ) -> Optional[dict[str, Any]]:
        items = list((klines or {}).get("items") or [])
        if not items:
            return None
        valid_items: list[dict[str, Any]] = []
        for item in items:
            if isinstance(item, Mapping):
                valid_items.append(dict(item))
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
        snapshot: Optional[KlineDomainSnapshot] = None,
    ) -> bool:
        normalized_interval = self._normalize_interval(interval)
        snapshot_provider = snapshot.metadata.provider if snapshot is not None else None
        domain_key = self._domain_key(
            "kline",
            symbol,
            provider=snapshot_provider or provider or kline.get("provider"),
            interval=normalized_interval,
        )
        signature = self._kline_signature(symbol, normalized_interval, kline)
        revision_identity = self._kline_revision_identity(kline)
        previous_revision = self._kline_revision_high_water.get(domain_key)
        if (
            revision_identity is not None
            and previous_revision is not None
            and not self._is_newer_kline_revision(previous_revision, revision_identity)
        ):
            return False
        now_ms = self._broadcast_state.now_ms()
        if not self._broadcast_state.should_broadcast_domain(
            domain_key,
            signature,
            self._kline_broadcast_interval_ms(),
            now_ms=now_ms,
        ):
            return False
        self._broadcast_state.remember_broadcast(domain_key, signature, now_ms=now_ms)
        if revision_identity is not None:
            self._kline_revision_high_water[domain_key] = revision_identity
        return True

    def get_kline_domain_snapshot(
        self,
        symbol: str,
        interval: str,
    ) -> Optional[KlineDomainSnapshot]:
        return self._kline_domain_snapshots.get(
            (normalize_spot_ws_symbol(symbol), self._normalize_interval(interval))
        )

    def record_kline_market_domain_snapshot(
        self,
        *,
        snapshot: MarketDomainSnapshot,
        kline: Mapping[str, Any],
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> KlineDomainSnapshot:
        if snapshot.domain != "kline":
            raise ValueError("market domain snapshot must use the kline domain")
        if context.domain != DomainName.KLINE:
            raise ValueError("kline snapshot context must use the kline domain")
        if not context.interval:
            raise ValueError("kline snapshot context requires an interval")
        normalized_symbol = normalize_spot_ws_symbol(snapshot.symbol)
        if normalized_symbol != normalize_spot_ws_symbol(context.symbol):
            raise ValueError("kline snapshot symbol does not match context")
        if not isinstance(snapshot.data, (list, tuple)):
            raise ValueError("kline market domain snapshot data must be a sequence")

        resolved_context = replace(
            context,
            symbol=normalized_symbol,
            provider=snapshot.provider or context.provider,
            cache_updated_at_ms=(
                context.cache_updated_at_ms
                if context.cache_updated_at_ms is not None
                else snapshot.updated_at
                if context.transport != DomainTransport.DB_READ
                else None
            ),
            db_updated_at_ms=(
                context.db_updated_at_ms
                if context.db_updated_at_ms is not None
                else snapshot.updated_at
                if context.transport == DomainTransport.DB_READ
                else None
            ),
        )
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)
        resolution = resolve_domain_snapshot_freshness(
            resolved_context,
            now_ms=current_ms,
        )
        current_items = [
            dict(item)
            for item in snapshot.data
            if isinstance(item, Mapping)
        ]
        latest_item = (
            max(current_items, key=lambda item: int(item.get("open_time") or 0))
            if current_items
            else {}
        )
        resolved_cache_updated_at_ms = (
            resolved_context.db_updated_at_ms
            if resolved_context.transport == DomainTransport.DB_READ
            else resolved_context.cache_updated_at_ms
        )
        return self._record_kline_domain_snapshot(
            symbol=resolved_context.symbol,
            interval=resolved_context.interval,
            kline=dict(kline),
            transport=resolved_context.transport,
            cache_origin=resolved_context.cache_origin,
            provider=resolved_context.provider,
            provider_symbol=resolved_context.provider_symbol,
            source=resolved_context.source,
            freshness=resolution.freshness,
            fallback_reason=resolved_context.fallback_reason,
            provider_event_time_ms=resolved_context.provider_event_time_ms,
            received_at_ms=resolved_context.received_at_ms,
            cache_updated_at_ms=resolved_cache_updated_at_ms,
            age_ms=resolution.age_ms,
            ttl_ms=resolution.ttl_ms,
            stale=resolution.stale,
            provider_generation=resolved_context.provider_generation,
            revision_epoch=latest_item.get("revision_epoch"),
            revision_sequence=latest_item.get("revision_seq"),
            is_closed=latest_item.get("is_closed"),
            close_state_source=latest_item.get("close_state_source"),
            freshness_basis=resolution.freshness_basis,
            emitted_at_ms=current_ms,
        )

    def record_kline_domain_snapshot(
        self,
        *,
        kline: Any,
        context: DomainSnapshotContext,
        emitted_at_ms: Optional[int] = None,
    ) -> KlineDomainSnapshot:
        if context.domain != DomainName.KLINE:
            raise ValueError("kline snapshot context must use the kline domain")
        if not context.interval:
            raise ValueError("kline snapshot context requires an interval")
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)
        resolution = resolve_domain_snapshot_freshness(
            context,
            now_ms=current_ms,
        )
        resolved_cache_updated_at_ms = (
            context.db_updated_at_ms
            if context.transport == DomainTransport.DB_READ
            else context.cache_updated_at_ms
        )
        return self._record_kline_domain_snapshot(
            symbol=context.symbol,
            interval=context.interval,
            kline=kline,
            transport=context.transport,
            cache_origin=context.cache_origin,
            provider=context.provider,
            provider_symbol=context.provider_symbol,
            source=context.source,
            freshness=resolution.freshness,
            fallback_reason=context.fallback_reason,
            provider_event_time_ms=context.provider_event_time_ms,
            received_at_ms=context.received_at_ms,
            cache_updated_at_ms=resolved_cache_updated_at_ms,
            age_ms=resolution.age_ms,
            ttl_ms=resolution.ttl_ms,
            stale=resolution.stale,
            provider_generation=context.provider_generation,
            freshness_basis=resolution.freshness_basis,
            emitted_at_ms=current_ms,
        )

    def _record_kline_domain_snapshot(
        self,
        *,
        symbol: str,
        interval: str,
        kline: Any,
        transport: DomainTransport = DomainTransport.PROVIDER_WS,
        cache_origin: DomainCacheOrigin = DomainCacheOrigin.PROVIDER_MEMORY,
        provider: Optional[str] = None,
        provider_symbol: Optional[str] = None,
        source: Optional[DomainSource] = None,
        freshness: Optional[DomainFreshness] = None,
        fallback_reason: Optional[DomainFallbackReason] = None,
        provider_event_time_ms: Optional[int] = None,
        received_at_ms: Optional[int] = None,
        cache_updated_at_ms: Optional[int] = None,
        age_ms: Optional[int] = None,
        ttl_ms: Optional[int] = None,
        stale: Optional[bool] = None,
        provider_generation: Optional[int] = None,
        revision_epoch: Optional[int] = None,
        revision_sequence: Optional[int] = None,
        is_closed: Optional[bool] = None,
        close_state_source: Optional[str] = None,
        history_terminal: Optional[bool] = None,
        history_incomplete: Optional[bool] = None,
        terminal_reason: Optional[str] = None,
        earliest_available_time: Optional[int] = None,
        coverage_complete: Optional[bool] = None,
        continuity_valid: Optional[bool] = None,
        freshness_basis: Optional[DomainFreshnessBasis] = None,
        emitted_at_ms: Optional[int] = None,
    ) -> KlineDomainSnapshot:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        normalized_interval = self._normalize_interval(interval)
        current_ms = int(emitted_at_ms if emitted_at_ms is not None else time.time() * 1000)

        resolved_cache_updated_at_ms = cache_updated_at_ms
        if (
            resolved_cache_updated_at_ms is None
            and isinstance(kline, Mapping)
            and cache_origin != DomainCacheOrigin.NONE
        ):
            try:
                resolved_cache_updated_at_ms = int(kline.get("updated_at_ms"))
            except (TypeError, ValueError):
                resolved_cache_updated_at_ms = None
        resolved_age_ms = age_ms
        if resolved_age_ms is None and resolved_cache_updated_at_ms is not None:
            resolved_age_ms = max(0, current_ms - resolved_cache_updated_at_ms)
        resolved_ttl_ms = ttl_ms
        if resolved_ttl_ms is None and transport == DomainTransport.PROVIDER_WS:
            resolved_ttl_ms = int(
                getattr(settings, "SPOT_PROVIDER_WS_KLINE_MAX_AGE_MS", 1500) or 1500
            )
        resolved_freshness_basis = freshness_basis or (
            DomainFreshnessBasis.RECEIVED_AT
            if kline is not None
            else DomainFreshnessBasis.NOT_APPLICABLE
        )
        snapshot = map_kline_domain_snapshot(
            symbol=normalized_symbol,
            interval=normalized_interval,
            kline=kline,
            transport=transport,
            cache_origin=cache_origin,
            provider=provider,
            provider_symbol=provider_symbol,
            source=source,
            freshness=freshness,
            fallback_reason=fallback_reason,
            provider_event_time_ms=provider_event_time_ms,
            received_at_ms=received_at_ms,
            cache_updated_at_ms=resolved_cache_updated_at_ms,
            age_ms=resolved_age_ms,
            ttl_ms=resolved_ttl_ms,
            stale=stale,
            provider_generation=provider_generation,
            revision_epoch=revision_epoch,
            revision_sequence=revision_sequence,
            is_closed=is_closed,
            close_state_source=close_state_source,
            history_terminal=history_terminal,
            history_incomplete=history_incomplete,
            terminal_reason=terminal_reason,
            earliest_available_time=earliest_available_time,
            coverage_complete=coverage_complete,
            continuity_valid=continuity_valid,
            freshness_basis=resolved_freshness_basis,
            emitted_at_ms=current_ms,
        )
        self._kline_domain_snapshots[(normalized_symbol, normalized_interval)] = snapshot
        return snapshot

    def _kline_signature(self, symbol: str, interval: str, kline: dict[str, Any]) -> str:
        keys = (
            "open_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "quote_volume",
            "is_closed",
            "close_state_source",
            "revision_epoch",
            "revision_seq",
        )
        return repr(
            (
                normalize_spot_ws_symbol(symbol),
                self._normalize_interval(interval),
                tuple(kline.get(key) for key in keys),
            )
        )

    def _kline_revision_identity(
        self,
        kline: Mapping[str, Any],
    ) -> Optional[tuple[int, int, int]]:
        values = (
            kline.get("open_time"),
            kline.get("revision_epoch"),
            kline.get("revision_seq"),
        )
        if any(value is None for value in values):
            return None
        try:
            open_time, revision_epoch, revision_seq = (int(value) for value in values)
        except (TypeError, ValueError):
            return None
        if open_time <= 0 or revision_epoch < 0 or revision_seq < 0:
            return None
        return open_time, revision_epoch, revision_seq

    def _is_newer_kline_revision(
        self,
        previous: tuple[int, int, int],
        incoming: tuple[int, int, int],
    ) -> bool:
        previous_open_time, previous_epoch, previous_seq = previous
        incoming_open_time, incoming_epoch, incoming_seq = incoming
        if incoming_epoch != previous_epoch:
            return incoming_epoch > previous_epoch
        if incoming_open_time != previous_open_time:
            return incoming_open_time > previous_open_time
        return incoming_seq > previous_seq

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
