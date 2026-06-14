from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Set, Tuple

from fastapi import WebSocket
from sqlalchemy.orm import Session

from app.db.models.asset import UserBalance
from app.services.balance import SPOT_BALANCE_CHAIN_KEY
from app.services.spot_query import get_current_orders


logger = logging.getLogger(__name__)


def _normalize_symbol(symbol: str) -> str:
    return (symbol or "").upper().strip()


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _to_jsonable(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_to_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_to_jsonable(item) for item in value]
    return value


class SpotPrivateWsManager:
    def __init__(self) -> None:
        self._rooms: Dict[Tuple[int, str], Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, user_id: int, symbol: str, websocket: WebSocket) -> None:
        room_key = (int(user_id), _normalize_symbol(symbol))
        async with self._lock:
            self._rooms[room_key].add(websocket)

    async def disconnect(self, user_id: int, symbol: str, websocket: WebSocket) -> None:
        room_key = (int(user_id), _normalize_symbol(symbol))
        async with self._lock:
            conns = self._rooms.get(room_key, set())
            conns.discard(websocket)
            if not conns and room_key in self._rooms:
                self._rooms.pop(room_key, None)

    async def _get_connections(self, user_id: int, symbol: str):
        room_key = (int(user_id), _normalize_symbol(symbol))
        async with self._lock:
            return list(self._rooms.get(room_key, set()))

    async def _get_user_connections(self, user_id: int):
        user_id = int(user_id)
        async with self._lock:
            conns: Set[WebSocket] = set()
            for (room_user_id, _symbol), room in self._rooms.items():
                if int(room_user_id) == user_id:
                    conns.update(room)
            return list(conns)

    async def _cleanup_dead(
        self,
        user_id: int,
        symbol: str,
        dead: list[WebSocket],
    ) -> None:
        if not dead:
            return

        room_key = (int(user_id), _normalize_symbol(symbol))
        async with self._lock:
            room = self._rooms.get(room_key, set())
            for ws in dead:
                room.discard(ws)
            if not room:
                self._rooms.pop(room_key, None)

    async def _cleanup_dead_for_user(self, user_id: int, dead: list[WebSocket]) -> None:
        if not dead:
            return

        user_id = int(user_id)
        async with self._lock:
            empty_keys = []
            for room_key, room in self._rooms.items():
                room_user_id, _symbol = room_key
                if int(room_user_id) != user_id:
                    continue
                for ws in dead:
                    room.discard(ws)
                if not room:
                    empty_keys.append(room_key)
            for room_key in empty_keys:
                self._rooms.pop(room_key, None)

    async def _send_payload(self, user_id: int, symbol: str, payload: dict) -> None:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        conns = await self._get_connections(user_id, symbol)
        if not conns:
            return

        text = json.dumps(_to_jsonable(payload), ensure_ascii=False)

        async def _safe_send(ws: WebSocket):
            try:
                await ws.send_text(text)
                return None
            except Exception:
                return ws

        results = await asyncio.gather(*[_safe_send(ws) for ws in conns])
        dead = [ws for ws in results if ws is not None]

        await self._cleanup_dead(user_id, symbol, dead)

    async def _send_user_payload(self, user_id: int, payload: dict) -> None:
        conns = await self._get_user_connections(user_id)
        if not conns:
            return

        text = json.dumps(_to_jsonable(payload), ensure_ascii=False)

        async def _safe_send(ws: WebSocket):
            try:
                await ws.send_text(text)
                return None
            except Exception:
                return ws

        results = await asyncio.gather(*[_safe_send(ws) for ws in conns])
        dead = [ws for ws in results if ws is not None]

        await self._cleanup_dead_for_user(user_id, dead)

    async def send_orders_snapshot(self, db: Session, user_id: int, symbol: str) -> None:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        result = get_current_orders(db=db, user_id=int(user_id), symbol=symbol, limit=50)

        payload = {
            "type": "spot_user_orders_snapshot",
            "symbol": result.get("symbol", symbol),
            "items": result.get("items", []),
        }

        await self._send_payload(user_id, symbol, payload)

    async def send_orders_snapshot_to_one(
        self,
        websocket: WebSocket,
        db: Session,
        user_id: int,
        symbol: str,
    ) -> None:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        try:
            result = get_current_orders(db=db, user_id=int(user_id), symbol=symbol, limit=50)
        except ValueError as exc:
            logger.warning(
                "spot_private_ws_orders_snapshot_pair_lookup_failed user_id=%s symbol=%s error=%s",
                user_id,
                symbol,
                exc,
            )
            result = {
                "symbol": symbol,
                "items": [],
                "error": str(exc),
            }

        payload = {
            "type": "spot_user_orders_snapshot",
            "symbol": result.get("symbol", symbol),
            "items": result.get("items", []),
        }
        if result.get("error"):
            payload["error"] = result.get("error")

        await websocket.send_text(json.dumps(_to_jsonable(payload), ensure_ascii=False))

    async def send_order_update(
        self,
        user_id: int,
        symbol: str,
        order_payload: dict,
    ) -> None:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        payload = {
            "type": "spot_user_order_update",
            "symbol": symbol,
            "order": _to_jsonable(order_payload or {}),
        }

        await self._send_payload(user_id, symbol, payload)

    async def send_account_balances_snapshot(self, db: Session, user_id: int) -> None:
        rows = (
            db.query(UserBalance)
            .filter(
                UserBalance.user_id == int(user_id),
                UserBalance.chain_key == SPOT_BALANCE_CHAIN_KEY,
            )
            .order_by(UserBalance.coin_symbol.asc(), UserBalance.id.asc())
            .all()
        )

        items = []
        for row in rows:
            available = Decimal(str(row.available_amount or 0))
            frozen = Decimal(str(row.frozen_amount or 0))
            items.append(
                {
                    "account_type": SPOT_BALANCE_CHAIN_KEY,
                    "account_key": SPOT_BALANCE_CHAIN_KEY,
                    "coin_symbol": row.coin_symbol,
                    "symbol": row.coin_symbol,
                    "available": available,
                    "frozen": frozen,
                    "total": available + frozen,
                    "updated_at": row.updated_at,
                }
            )

        payload = {
            "type": "spot_user_balance_update",
            "account_type": SPOT_BALANCE_CHAIN_KEY,
            "account_key": SPOT_BALANCE_CHAIN_KEY,
            "items": items,
        }

        await self._send_user_payload(user_id, payload)


spot_private_ws_manager = SpotPrivateWsManager()
