from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from decimal import Decimal
from typing import Dict, Set, Any

from fastapi import WebSocket
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketState

from app.db.session import SessionLocal
from app.services.market import get_market_depth
from app.services.spot_kline_bucket import normalize_spot_kline_bucket_interval
from app.services.spot_kline_realtime import apply_spot_trade_to_klines
from app.services.spot_market_view import (
    build_empty_spot_market_view,
    build_spot_market_snapshot_payload,
    get_spot_market_snapshot_payload,
)


logger = logging.getLogger(__name__)
SPOT_SNAPSHOT_BUILD_TIMEOUT_SECONDS = 3.0
SPOT_SNAPSHOT_VIEW_BUDGET_SECONDS = 2.2
SPOT_SNAPSHOT_TIMEOUT_LOG_THROTTLE_SECONDS = 30.0
SPOT_WS_SLOW_SEND_THRESHOLD_MS = 500.0
SPOT_WS_FANOUT_SLOW_LOG_THROTTLE_SECONDS = 30.0
_SPOT_SNAPSHOT_TIMEOUT_LOG_LAST_AT: dict[str, float] = {}


def _normalize_symbol(symbol: str) -> str:
    raw = str(symbol or "").upper().strip()
    return "".join(ch for ch in raw if ch.isalnum())


def _normalize_interval(interval: str | None) -> str:
    normalized = normalize_spot_kline_bucket_interval(interval)
    if normalized in {"1m", "5m", "15m", "1h", "4h", "1d", "1Dutc", "1w", "1Wutc", "1M", "1Mutc"}:
        return normalized
    return "1m"


def _to_str(v: Any) -> str:
    if v is None:
        return "0"
    if isinstance(v, Decimal):
        return format(v, "f")
    return str(v)


def _spot_snapshot_fallback_payload(symbol: str, reason: str) -> dict:
    view = build_empty_spot_market_view(symbol=symbol, warnings=[reason])
    return build_spot_market_snapshot_payload(view)


def _log_spot_snapshot_timeout(symbol: str) -> None:
    now = time.monotonic()
    last_at = _SPOT_SNAPSHOT_TIMEOUT_LOG_LAST_AT.get(symbol)
    if last_at is not None and now - last_at < SPOT_SNAPSHOT_TIMEOUT_LOG_THROTTLE_SECONDS:
        return
    _SPOT_SNAPSHOT_TIMEOUT_LOG_LAST_AT[symbol] = now
    logger.warning("spot_market_snapshot_timeout symbol=%s", symbol)


def _build_spot_snapshot_payload(symbol: str) -> dict:
    db = SessionLocal()
    try:
        return get_spot_market_snapshot_payload(
            db=db,
            symbol=symbol,
            total_budget_seconds=SPOT_SNAPSHOT_VIEW_BUDGET_SECONDS,
            fast_external=True,
        )
    finally:
        db.close()


class MarketWsManager:
    def __init__(self) -> None:
        self._symbol_rooms: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._connection_kline_intervals: Dict[WebSocket, Set[str]] = {}
        self._lock = asyncio.Lock()
        self._dead_cleanup_count = 0
        self._last_connect_at: dict[str, float] = {}
        self._last_disconnect_at: dict[str, float] = {}
        self._fanout_metrics: dict[str, dict[str, Any]] = {}
        self._last_slow_fanout_log_at: dict[str, float] = {}

    async def connect(
        self,
        symbol: str,
        websocket: WebSocket,
        *,
        accepted: bool = False,
        interval: str | None = None,
    ) -> None:
        if not accepted and websocket.application_state == WebSocketState.CONNECTING:
            await websocket.accept()
        symbol = _normalize_symbol(symbol)
        normalized_interval = _normalize_interval(interval) if interval else None
        async with self._lock:
            self._symbol_rooms[symbol].add(websocket)
            intervals = self._connection_kline_intervals.setdefault(websocket, set())
            if normalized_interval:
                intervals.add(normalized_interval)
            self._last_connect_at[symbol] = time.time()
            subscriber_count = len(self._symbol_rooms.get(symbol, set()))
            total_connections = self._total_connection_count_locked()
        logger.info(
            "spot_ws_connect symbol=%s subscriber_count=%s total_connections=%s",
            symbol,
            subscriber_count,
            total_connections,
        )
        await self._ensure_spot_provider_depth(symbol, normalized_interval)

    async def disconnect(self, symbol: str, websocket: WebSocket) -> None:
        symbol = _normalize_symbol(symbol)
        should_release = False
        async with self._lock:
            conns = self._symbol_rooms.get(symbol, set())
            if websocket in conns:
                conns.remove(websocket)
            self._connection_kline_intervals.pop(websocket, None)
            if not conns and symbol in self._symbol_rooms:
                self._symbol_rooms.pop(symbol, None)
                should_release = True
            self._last_disconnect_at[symbol] = time.time()
            subscriber_count = len(self._symbol_rooms.get(symbol, set()))
            total_connections = self._total_connection_count_locked()
        logger.info(
            "spot_ws_disconnect symbol=%s subscriber_count=%s total_connections=%s",
            symbol,
            subscriber_count,
            total_connections,
        )
        if should_release:
            await self._release_spot_provider_depth_if_idle(symbol)

    async def _get_connections(self, symbol: str):
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            return list(self._symbol_rooms.get(symbol, set()))

    async def subscriber_count(self, symbol: str) -> int:
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            return len(self._symbol_rooms.get(symbol, set()))

    async def kline_intervals(self, symbol: str) -> list[str]:
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            intervals = {
                interval
                for ws in self._symbol_rooms.get(symbol, set())
                for interval in self._connection_kline_intervals.get(ws, set())
            }
        return sorted(interval for interval in intervals if interval)

    async def get_metrics_snapshot(self) -> dict[str, Any]:
        async with self._lock:
            symbols = sorted(self._symbol_rooms.keys())
            per_symbol = {}
            for symbol in symbols:
                room = self._symbol_rooms.get(symbol, set())
                interval_counts: dict[str, int] = defaultdict(int)
                for ws in room:
                    for interval in self._connection_kline_intervals.get(ws, set()):
                        interval_counts[interval] += 1
                per_symbol[symbol] = {
                    "subscriber_count": len(room),
                    "kline_interval_subscriber_count": dict(sorted(interval_counts.items())),
                    "last_connect_at": self._last_connect_at.get(symbol),
                    "last_disconnect_at": self._last_disconnect_at.get(symbol),
                }
            return {
                "total_active_connections": self._total_connection_count_locked(),
                "active_rooms": len(self._symbol_rooms),
                "symbols": per_symbol,
                "dead_websocket_cleanup_count": self._dead_cleanup_count,
                "fanout": dict(self._fanout_metrics),
            }

    async def set_kline_subscription(
        self,
        symbol: str,
        websocket: WebSocket,
        interval: str | None,
        *,
        subscribed: bool,
    ) -> None:
        symbol = _normalize_symbol(symbol)
        normalized_interval = _normalize_interval(interval)
        if not symbol:
            return

        should_ensure = False
        async with self._lock:
            if websocket not in self._symbol_rooms.get(symbol, set()):
                return
            intervals = self._connection_kline_intervals.setdefault(websocket, set())
            if subscribed:
                if normalized_interval not in intervals:
                    intervals.add(normalized_interval)
                    should_ensure = True
            else:
                intervals.discard(normalized_interval)

        if subscribed and should_ensure:
            await self._ensure_spot_provider_depth(symbol, normalized_interval)

    async def _cleanup_dead(self, symbol: str, dead: list[WebSocket]) -> None:
        if not dead:
            return

        symbol = _normalize_symbol(symbol)
        should_release = False
        async with self._lock:
            room = self._symbol_rooms.get(symbol, set())
            for ws in dead:
                room.discard(ws)
                self._connection_kline_intervals.pop(ws, None)
            self._dead_cleanup_count += len(dead)
            if not room and symbol in self._symbol_rooms:
                self._symbol_rooms.pop(symbol, None)
                should_release = True
        if should_release:
            await self._release_spot_provider_depth_if_idle(symbol)

    async def _send_payload(self, symbol: str, payload: dict) -> None:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        conns = await self._get_payload_recipients(symbol, payload)
        if not conns:
            return

        text = json.dumps(payload, ensure_ascii=False)
        event_type = str(payload.get("type") or "unknown")
        fanout_started_at = time.perf_counter()

        dead: list[WebSocket] = []
        slow_send_count = 0
        max_send_duration_ms = 0.0
        for ws in conns:
            send_started_at = time.perf_counter()
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
            finally:
                send_duration_ms = (time.perf_counter() - send_started_at) * 1000
                max_send_duration_ms = max(max_send_duration_ms, send_duration_ms)
                if send_duration_ms >= SPOT_WS_SLOW_SEND_THRESHOLD_MS:
                    slow_send_count += 1

        await self._cleanup_dead(symbol, dead)
        fanout_duration_ms = (time.perf_counter() - fanout_started_at) * 1000
        self._remember_fanout_metric(
            symbol=symbol,
            event_type=event_type,
            subscriber_count=len(conns),
            fanout_duration_ms=fanout_duration_ms,
            slow_send_count=slow_send_count,
            failed_send_count=len(dead),
            cleaned_dead_ws_count=len(dead),
            max_send_duration_ms=max_send_duration_ms,
        )
        self._log_slow_fanout_if_needed(
            symbol=symbol,
            event_type=event_type,
            subscriber_count=len(conns),
            fanout_duration_ms=fanout_duration_ms,
            slow_send_count=slow_send_count,
            failed_send_count=len(dead),
            cleaned_dead_ws_count=len(dead),
        )

    async def _get_payload_recipients(self, symbol: str, payload: dict) -> list[WebSocket]:
        symbol = _normalize_symbol(symbol)
        payload_type = str(payload.get("type") or "")
        if payload_type != "spot_kline_update":
            return await self._get_connections(symbol)

        interval = _normalize_interval(str(payload.get("interval") or "1m"))
        async with self._lock:
            return [
                ws
                for ws in self._symbol_rooms.get(symbol, set())
                if interval in self._connection_kline_intervals.get(ws, set())
            ]

    async def _ensure_spot_provider_depth(self, symbol: str, interval: str | None = None) -> None:
        try:
            from app.services.spot_market_gateway import spot_market_gateway

            await spot_market_gateway.ensure_symbol(
                symbol,
                interval=_normalize_interval(interval) if interval else None,
            )
        except Exception:
            logger.warning("spot_market_ws_provider_depth_ensure_failed symbol=%s", symbol, exc_info=True)

    async def _release_spot_provider_depth_if_idle(self, symbol: str) -> None:
        try:
            from app.services.spot_market_gateway import spot_market_gateway

            await spot_market_gateway.release_symbol_if_idle(symbol)
        except Exception:
            logger.warning("spot_market_ws_provider_depth_release_failed symbol=%s", symbol, exc_info=True)

    def _total_connection_count_locked(self) -> int:
        return sum(len(room) for room in self._symbol_rooms.values())

    def _remember_fanout_metric(
        self,
        *,
        symbol: str,
        event_type: str,
        subscriber_count: int,
        fanout_duration_ms: float,
        slow_send_count: int,
        failed_send_count: int,
        cleaned_dead_ws_count: int,
        max_send_duration_ms: float,
    ) -> None:
        metric_key = f"{symbol}:{event_type}"
        existing = self._fanout_metrics.get(metric_key, {})
        self._fanout_metrics[metric_key] = {
            "symbol": symbol,
            "event_type": event_type,
            "subscriber_count": subscriber_count,
            "fanout_count": int(existing.get("fanout_count") or 0) + 1,
            "last_fanout_at": time.time(),
            "last_fanout_duration_ms": round(fanout_duration_ms, 3),
            "max_fanout_duration_ms": round(
                max(float(existing.get("max_fanout_duration_ms") or 0.0), fanout_duration_ms),
                3,
            ),
            "last_max_send_duration_ms": round(max_send_duration_ms, 3),
            "slow_send_count": int(existing.get("slow_send_count") or 0) + slow_send_count,
            "failed_send_count": int(existing.get("failed_send_count") or 0) + failed_send_count,
            "cleaned_dead_ws_count": int(existing.get("cleaned_dead_ws_count") or 0) + cleaned_dead_ws_count,
        }

    def _log_slow_fanout_if_needed(
        self,
        *,
        symbol: str,
        event_type: str,
        subscriber_count: int,
        fanout_duration_ms: float,
        slow_send_count: int,
        failed_send_count: int,
        cleaned_dead_ws_count: int,
    ) -> None:
        if slow_send_count <= 0 and fanout_duration_ms < SPOT_WS_SLOW_SEND_THRESHOLD_MS:
            return
        metric_key = f"{symbol}:{event_type}"
        now = time.monotonic()
        last_at = self._last_slow_fanout_log_at.get(metric_key)
        if last_at is not None and now - last_at < SPOT_WS_FANOUT_SLOW_LOG_THROTTLE_SECONDS:
            return
        self._last_slow_fanout_log_at[metric_key] = now
        logger.warning(
            "spot_ws_fanout_slow symbol=%s event_type=%s duration_ms=%.1f subscribers=%s "
            "slow_send_count=%s failed_send_count=%s cleaned_dead_ws_count=%s",
            symbol,
            event_type,
            fanout_duration_ms,
            subscriber_count,
            slow_send_count,
            failed_send_count,
            cleaned_dead_ws_count,
        )

    def _depth_update_payload(self, symbol: str, depth: Any) -> dict:
        bids = [
            item.model_dump() if hasattr(item, "model_dump") else item.dict()
            for item in getattr(depth, "bids", [])
        ]
        asks = [
            item.model_dump() if hasattr(item, "model_dump") else item.dict()
            for item in getattr(depth, "asks", [])
        ]
        has_depth_levels = bool(bids or asks)
        depth_payload = {
            "symbol": getattr(depth, "symbol", symbol),
            "bids": bids,
            "asks": asks,
            "ts": getattr(depth, "ts", None),
            "source": (getattr(depth, "source", None) or "INTERNAL") if has_depth_levels else "MISSING",
            "freshness": (getattr(depth, "freshness", None) or "RECENT") if has_depth_levels else "MISSING",
            "stale": bool(getattr(depth, "stale", False)) if has_depth_levels else False,
        }
        for key in (
            "price_precision",
            "amount_precision",
            "provider",
            "updated_at",
            "last_price",
            "mid_price",
            "fetched_at",
        ):
            value = getattr(depth, key, None)
            if value is not None:
                depth_payload[key] = value
        return {
            "type": "spot_depth_update",
            "symbol": _normalize_symbol(symbol),
            "depth": depth_payload,
        }

    def _ticker_update_payload(self, symbol: str, ticker: dict[str, Any]) -> dict:
        ticker_payload = dict(ticker or {})
        ticker_payload["symbol"] = _normalize_symbol(ticker_payload.get("symbol") or symbol)
        return {
            "type": "spot_ticker_update",
            "symbol": _normalize_symbol(symbol),
            "ticker": ticker_payload,
        }

    async def broadcast_depth_update(self, symbol: str, depth: Any) -> None:
        await self._send_payload(symbol, self._depth_update_payload(symbol, depth))

    async def broadcast_ticker_update(self, symbol: str, ticker: dict[str, Any]) -> None:
        await self._send_payload(symbol, self._ticker_update_payload(symbol, ticker))

    async def broadcast_provider_kline_update(
        self,
        symbol: str,
        interval: str,
        kline: Any,
        *,
        source: str = "LIVE_WS",
        updated_at: Any = None,
        revision_epoch: Any = None,
        revision_seq: Any = None,
        is_closed: Any = None,
        close_state_source: Any = None,
    ) -> None:
        kline_payload = kline.model_dump() if hasattr(kline, "model_dump") else dict(kline or {})
        revision_fields = {
            "revision_epoch": revision_epoch,
            "revision_seq": revision_seq,
            "is_closed": is_closed,
            "close_state_source": close_state_source,
        }
        for key, value in revision_fields.items():
            if value is not None:
                kline_payload[key] = value
        await self._send_payload(
            symbol,
            {
                "type": "spot_kline_update",
                "symbol": _normalize_symbol(symbol),
                "interval": _normalize_interval(str(interval or "1m")),
                "kline": kline_payload,
                "source": source,
                "updated_at": updated_at,
            },
        )

    async def send_snapshot(self, db: Session, symbol: str) -> None:
        """
        全量快照：
        - 连接建立时推一次
        - 也可在撮合/下单/撤单后兜底推一次
        """
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        try:
            payload = await asyncio.wait_for(
                asyncio.to_thread(_build_spot_snapshot_payload, symbol),
                timeout=SPOT_SNAPSHOT_BUILD_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            _log_spot_snapshot_timeout(symbol)
            payload = _spot_snapshot_fallback_payload(symbol, "snapshot_timeout")
        except Exception as exc:
            logger.warning("spot_market_snapshot_failed symbol=%s error=%s", symbol, exc)
            payload = _spot_snapshot_fallback_payload(symbol, f"snapshot_unavailable:{exc}")

        await self._send_payload(symbol, payload)

    async def send_trade(
        self,
        *,
        symbol: str,
        price: Any,
        amount: Any,
        side: str,
        ts: int,
        id: Any = None,
        trade_id: Any = None,
        provider: Any = None,
        provider_symbol: Any = None,
        provider_trade_id: Any = None,
        source: Any = None,
        freshness: Any = None,
        updated_at_ms: Any = None,
        event_time_ms: Any = None,
        received_at_ms: Any = None,
        time_origin: Any = None,
        created_at: Any = None,
    ) -> None:
        """
        增量推送：单笔成交
        """
        symbol = _normalize_symbol(symbol)
        item_id = id if id is not None else trade_id
        normalized_trade_id = trade_id if trade_id is not None else item_id
        normalized_provider_trade_id = provider_trade_id
        if normalized_provider_trade_id is None:
            normalized_provider_trade_id = normalized_trade_id
        if normalized_provider_trade_id is None:
            normalized_provider_trade_id = item_id
        trade_payload = {
            "id": item_id,
            "trade_id": normalized_trade_id,
            "provider_trade_id": normalized_provider_trade_id,
            "price": _to_str(price),
            "amount": _to_str(amount),
            "side": (side or "").upper(),
            "ts": ts,
            "event_time_ms": event_time_ms,
            "received_at_ms": received_at_ms,
            "time_origin": time_origin,
            "created_at": created_at,
            "provider": str(provider) if provider is not None else None,
            "provider_symbol": str(provider_symbol) if provider_symbol is not None else None,
            "source": str(source) if source is not None else None,
            "freshness": str(freshness) if freshness is not None else None,
        }
        if updated_at_ms is not None:
            trade_payload["updated_at_ms"] = updated_at_ms

        payload = {
            "type": "spot_trade",
            "symbol": symbol,
            "trade_id": normalized_trade_id,
            "provider_trade_id": normalized_provider_trade_id,
            "ts": ts,
            "event_time_ms": event_time_ms,
            "received_at_ms": received_at_ms,
            "time_origin": time_origin,
            "trade": trade_payload,
        }
        if provider is not None:
            payload["provider"] = str(provider)
        if provider_symbol is not None:
            payload["provider_symbol"] = str(provider_symbol)
        if source is not None:
            payload["source"] = str(source)
        if freshness is not None:
            payload["freshness"] = str(freshness)
        if updated_at_ms is not None:
            payload["updated_at_ms"] = updated_at_ms
        await self._send_payload(symbol, payload)

    async def send_kline_update(
        self,
        *,
        db: Session,
        symbol: str,
        price: Any,
        amount: Any,
        ts: int,
    ) -> None:
        """
        Incremental authoritative spot kline updates generated from completed trades.
        """
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        try:
            payloads = apply_spot_trade_to_klines(
                db,
                symbol=symbol,
                trade_price=price,
                trade_amount=amount,
                trade_ts_ms=ts,
            )
        except Exception as exc:
            logger.warning("spot_kline_update_failed symbol=%s error=%s", symbol, exc)
            return

        for payload in payloads:
            await self._send_payload(symbol, payload)

    async def send_depth_update(
        self,
        *,
        db: Session,
        symbol: str,
        limit: int = 20,
    ) -> None:
        """
        增量推送：最新盘口
        当前先推“最新 depth 快照”
        后面如果你想升级成真正 diff，再继续拆
        """
        symbol = _normalize_symbol(symbol)
        depth = get_market_depth(db=db, symbol=symbol, limit=limit)

        await self.broadcast_depth_update(symbol, depth)


market_ws_manager = MarketWsManager()
