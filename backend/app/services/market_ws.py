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
        self._connection_intervals: Dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

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
        normalized_interval = _normalize_interval(interval)
        async with self._lock:
            self._symbol_rooms[symbol].add(websocket)
            self._connection_intervals[websocket] = normalized_interval
        await self._ensure_spot_provider_depth(symbol, normalized_interval)

    async def disconnect(self, symbol: str, websocket: WebSocket) -> None:
        symbol = _normalize_symbol(symbol)
        should_release = False
        async with self._lock:
            conns = self._symbol_rooms.get(symbol, set())
            if websocket in conns:
                conns.remove(websocket)
            self._connection_intervals.pop(websocket, None)
            if not conns and symbol in self._symbol_rooms:
                self._symbol_rooms.pop(symbol, None)
                should_release = True
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
                self._connection_intervals.get(ws, "1m")
                for ws in self._symbol_rooms.get(symbol, set())
            }
        return sorted(interval for interval in intervals if interval)

    async def _cleanup_dead(self, symbol: str, dead: list[WebSocket]) -> None:
        if not dead:
            return

        symbol = _normalize_symbol(symbol)
        should_release = False
        async with self._lock:
            room = self._symbol_rooms.get(symbol, set())
            for ws in dead:
                room.discard(ws)
                self._connection_intervals.pop(ws, None)
            if not room and symbol in self._symbol_rooms:
                self._symbol_rooms.pop(symbol, None)
                should_release = True
        if should_release:
            await self._release_spot_provider_depth_if_idle(symbol)

    async def _send_payload(self, symbol: str, payload: dict) -> None:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        conns = await self._get_connections(symbol)
        if not conns:
            return

        text = json.dumps(payload, ensure_ascii=False)

        dead: list[WebSocket] = []
        for ws in conns:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)

        await self._cleanup_dead(symbol, dead)

    async def _ensure_spot_provider_depth(self, symbol: str, interval: str | None = None) -> None:
        try:
            from app.services.spot_market_gateway import spot_market_gateway

            await spot_market_gateway.ensure_symbol(symbol, interval=_normalize_interval(interval))
        except Exception:
            logger.warning("spot_market_ws_provider_depth_ensure_failed symbol=%s", symbol, exc_info=True)

    async def _release_spot_provider_depth_if_idle(self, symbol: str) -> None:
        try:
            from app.services.spot_market_gateway import spot_market_gateway

            await spot_market_gateway.release_symbol_if_idle(symbol)
        except Exception:
            logger.warning("spot_market_ws_provider_depth_release_failed symbol=%s", symbol, exc_info=True)

    def _depth_update_payload(self, symbol: str, depth: Any) -> dict:
        depth_payload = {
            "symbol": getattr(depth, "symbol", symbol),
            "bids": [
                item.model_dump() if hasattr(item, "model_dump") else item.dict()
                for item in getattr(depth, "bids", [])
            ],
            "asks": [
                item.model_dump() if hasattr(item, "model_dump") else item.dict()
                for item in getattr(depth, "asks", [])
            ],
            "ts": getattr(depth, "ts", None),
        }
        for key in (
            "price_precision",
            "amount_precision",
            "provider",
            "stale",
            "updated_at",
            "last_price",
            "mid_price",
            "source",
            "freshness",
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
    ) -> None:
        kline_payload = kline.model_dump() if hasattr(kline, "model_dump") else dict(kline or {})
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
        trade_id: Any = None,
        provider: Any = None,
        provider_symbol: Any = None,
        provider_trade_id: Any = None,
        source: Any = None,
        freshness: Any = None,
        updated_at_ms: Any = None,
    ) -> None:
        """
        增量推送：单笔成交
        """
        symbol = _normalize_symbol(symbol)
        trade_payload = {
            "id": trade_id,
            "trade_id": trade_id,
            "provider_trade_id": provider_trade_id or trade_id,
            "price": _to_str(price),
            "amount": _to_str(amount),
            "side": (side or "").upper(),
            "ts": ts,
        }
        if provider is not None:
            trade_payload["provider"] = str(provider)
        if provider_symbol is not None:
            trade_payload["provider_symbol"] = str(provider_symbol)
        if source is not None:
            trade_payload["source"] = str(source)
        if freshness is not None:
            trade_payload["freshness"] = str(freshness)
        if updated_at_ms is not None:
            trade_payload["updated_at_ms"] = updated_at_ms

        payload = {
            "type": "spot_trade",
            "symbol": symbol,
            "trade_id": trade_id,
            "provider_trade_id": provider_trade_id or trade_id,
            "ts": ts,
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
