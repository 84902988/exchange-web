from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketState


def normalize_contract_ws_symbol(symbol: str) -> str:
    return str(symbol or "").strip().upper()


def normalize_contract_ws_interval(interval: str | None) -> str:
    normalized = str(interval or "1m").strip().lower()
    return normalized or "1m"


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(item) for item in value]
    return value


class ContractMarketWsManager:
    def __init__(self) -> None:
        self._symbol_rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self._socket_symbols: dict[WebSocket, str] = {}
        self._socket_intervals: dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

    async def connect(
        self,
        symbol: str,
        websocket: WebSocket,
        *,
        interval: str | None = "1m",
        accepted: bool = False,
    ) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        if not normalized_symbol:
            return
        if not accepted and websocket.application_state == WebSocketState.CONNECTING:
            await websocket.accept()
        async with self._lock:
            previous_symbol = self._socket_symbols.get(websocket)
            if previous_symbol and previous_symbol != normalized_symbol:
                previous_room = self._symbol_rooms.get(previous_symbol)
                if previous_room is not None:
                    previous_room.discard(websocket)
                    if not previous_room:
                        self._symbol_rooms.pop(previous_symbol, None)
            self._symbol_rooms[normalized_symbol].add(websocket)
            self._socket_symbols[websocket] = normalized_symbol
            self._socket_intervals[websocket] = normalized_interval

    async def disconnect(self, websocket: WebSocket) -> str | None:
        async with self._lock:
            symbol = self._socket_symbols.pop(websocket, None)
            self._socket_intervals.pop(websocket, None)
            if not symbol:
                return None
            room = self._symbol_rooms.get(symbol)
            if room is not None:
                room.discard(websocket)
                if not room:
                    self._symbol_rooms.pop(symbol, None)
            return symbol

    async def has_subscribers(self, symbol: str) -> bool:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        async with self._lock:
            return bool(self._symbol_rooms.get(normalized_symbol))

    async def subscriber_count(self, symbol: str) -> int:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        async with self._lock:
            return len(self._symbol_rooms.get(normalized_symbol) or ())

    async def subscribed_intervals(self, symbol: str) -> list[str]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        async with self._lock:
            sockets = list(self._symbol_rooms.get(normalized_symbol) or ())
            values = {
                normalize_contract_ws_interval(self._socket_intervals.get(websocket))
                for websocket in sockets
            }
        return sorted(values or {"1m"})

    async def send_to_one(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        await websocket.send_text(json.dumps(_to_jsonable(payload), ensure_ascii=False))

    async def broadcast_to_symbol(self, symbol: str, payload: dict[str, Any]) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return
        async with self._lock:
            sockets = list(self._symbol_rooms.get(normalized_symbol) or ())
        if not sockets:
            return
        text = json.dumps(_to_jsonable(payload), ensure_ascii=False)
        dead: list[WebSocket] = []
        for websocket in sockets:
            try:
                await websocket.send_text(text)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            await self.disconnect(websocket)


contract_market_ws_manager = ContractMarketWsManager()
