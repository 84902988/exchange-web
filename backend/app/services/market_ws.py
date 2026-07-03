from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from decimal import Decimal
from typing import Dict, Set, Any

from fastapi import WebSocket
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketState

from app.services.market import get_market_depth
from app.services.spot_market_view import get_spot_market_snapshot_payload


def _normalize_symbol(symbol: str) -> str:
    return (symbol or "").upper().strip()


def _to_str(v: Any) -> str:
    if v is None:
        return "0"
    if isinstance(v, Decimal):
        return format(v, "f")
    return str(v)


class MarketWsManager:
    def __init__(self) -> None:
        self._symbol_rooms: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, symbol: str, websocket: WebSocket, *, accepted: bool = False) -> None:
        if not accepted and websocket.application_state == WebSocketState.CONNECTING:
            await websocket.accept()
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            self._symbol_rooms[symbol].add(websocket)

    async def disconnect(self, symbol: str, websocket: WebSocket) -> None:
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            conns = self._symbol_rooms.get(symbol, set())
            if websocket in conns:
                conns.remove(websocket)
            if not conns and symbol in self._symbol_rooms:
                self._symbol_rooms.pop(symbol, None)

    async def _get_connections(self, symbol: str):
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            return list(self._symbol_rooms.get(symbol, set()))

    async def _cleanup_dead(self, symbol: str, dead: list[WebSocket]) -> None:
        if not dead:
            return

        symbol = _normalize_symbol(symbol)
        async with self._lock:
            room = self._symbol_rooms.get(symbol, set())
            for ws in dead:
                room.discard(ws)
            if not room and symbol in self._symbol_rooms:
                self._symbol_rooms.pop(symbol, None)

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

    async def send_snapshot(self, db: Session, symbol: str) -> None:
        """
        全量快照：
        - 连接建立时推一次
        - 也可在撮合/下单/撤单后兜底推一次
        """
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        payload = get_spot_market_snapshot_payload(db=db, symbol=symbol)

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
    ) -> None:
        """
        增量推送：单笔成交
        """
        symbol = _normalize_symbol(symbol)
        payload = {
            "type": "spot_trade",
            "symbol": symbol,
            "trade": {
                "id": trade_id,
                "price": _to_str(price),
                "amount": _to_str(amount),
                "side": (side or "").upper(),
                "ts": ts,
            },
        }
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

        payload = {
            "type": "spot_depth_update",
            "symbol": symbol,
            "depth": {
                "symbol": depth.symbol,
                "bids": [
                    item.model_dump() if hasattr(item, "model_dump") else item.dict()
                    for item in depth.bids
                ],
                "asks": [
                    item.model_dump() if hasattr(item, "model_dump") else item.dict()
                    for item in depth.asks
                ],
                "ts": getattr(depth, "ts", None),
            },
        }

        await self._send_payload(symbol, payload)


market_ws_manager = MarketWsManager()
