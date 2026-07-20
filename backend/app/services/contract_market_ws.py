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
    normalized = str(interval or "1m").strip()
    if normalized == "1M":
        return "1M"
    return normalized.lower() or "1m"


def normalize_contract_ws_domain(domain: str | None) -> str:
    normalized = str(domain or "").strip().lower()
    return normalized if normalized in {"market", "kline"} else ""


def contract_ws_payload_action(payload: dict[str, Any]) -> str:
    return str(payload.get("op") or payload.get("type") or payload.get("action") or "").strip().lower()


def contract_ws_payload_domain(payload: dict[str, Any]) -> str:
    explicit_domain = normalize_contract_ws_domain(payload.get("domain"))
    if explicit_domain:
        return explicit_domain
    payload_type = str(payload.get("type") or "").strip().lower()
    if "kline" in payload_type or "candle" in payload_type:
        return "kline"
    return "market"


async def handle_contract_ws_domain_command(
    *,
    action: str,
    payload: dict[str, Any],
    websocket: WebSocket,
    manager: Any,
    gateway: Any,
    connected_symbol: str,
    connected_interval: str,
) -> tuple[str, str] | None:
    domain = normalize_contract_ws_domain(payload.get("domain"))
    if action not in {"subscribe", "unsubscribe"} or not domain:
        return None

    if action == "unsubscribe":
        await manager.unsubscribe_domain(
            websocket,
            domain,
            interval=payload.get("interval") or connected_interval,
        )
        return connected_symbol, connected_interval

    next_symbol = normalize_contract_ws_symbol(payload.get("symbol") or connected_symbol)
    next_interval = normalize_contract_ws_interval(payload.get("interval") or connected_interval)
    if not next_symbol:
        return connected_symbol, connected_interval

    previous_symbol = connected_symbol
    await manager.subscribe_domain(
        next_symbol,
        websocket,
        domain,
        interval=next_interval if domain == "kline" else None,
    )
    if previous_symbol != next_symbol:
        await gateway.release_symbol_if_idle(previous_symbol)
    await gateway.ensure_symbol(next_symbol)
    snapshot = (
        await gateway.market_snapshot(next_symbol)
        if domain == "market"
        else await gateway.kline_snapshot(next_symbol, next_interval)
    )
    await manager.send_to_one(websocket, snapshot)
    return next_symbol, next_interval if domain == "kline" else connected_interval


async def handle_contract_ws_legacy_subscribe(
    *,
    action: str,
    payload: dict[str, Any],
    websocket: WebSocket,
    manager: Any,
    gateway: Any,
    connected_symbol: str,
    connected_interval: str,
) -> tuple[str, str] | None:
    if action != "subscribe" or normalize_contract_ws_domain(payload.get("domain")):
        return None
    next_symbol = normalize_contract_ws_symbol(payload.get("symbol") or connected_symbol)
    next_interval = normalize_contract_ws_interval(payload.get("interval") or connected_interval)
    if not next_symbol:
        return connected_symbol, connected_interval
    previous_symbol = connected_symbol
    await manager.connect(
        next_symbol,
        websocket,
        interval=next_interval,
        accepted=True,
        legacy=True,
    )
    if previous_symbol != next_symbol:
        await gateway.release_symbol_if_idle(previous_symbol)
    await gateway.ensure_symbol(next_symbol)
    snapshot = await gateway.snapshot(next_symbol, next_interval)
    await manager.send_to_one(websocket, snapshot)
    return next_symbol, next_interval


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
        self._socket_market_subscriptions: set[WebSocket] = set()
        self._socket_kline_intervals: dict[WebSocket, set[str]] = {}
        self._legacy_sockets: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    def _socket_connected(self, websocket: WebSocket) -> bool:
        return (
            websocket.application_state == WebSocketState.CONNECTED
            and websocket.client_state == WebSocketState.CONNECTED
        )

    def _prune_symbol_locked(self, symbol: str) -> None:
        room = self._symbol_rooms.get(symbol)
        if not room:
            self._symbol_rooms.pop(symbol, None)
            return
        dead = [websocket for websocket in room if not self._socket_connected(websocket)]
        for websocket in dead:
            room.discard(websocket)
            self._socket_symbols.pop(websocket, None)
            self._socket_market_subscriptions.discard(websocket)
            self._socket_kline_intervals.pop(websocket, None)
            self._legacy_sockets.discard(websocket)
        if not room:
            self._symbol_rooms.pop(symbol, None)

    async def connect(
        self,
        symbol: str,
        websocket: WebSocket,
        *,
        interval: str | None = "1m",
        accepted: bool = False,
        legacy: bool = True,
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
                self._socket_market_subscriptions.discard(websocket)
                self._socket_kline_intervals.pop(websocket, None)
            self._symbol_rooms[normalized_symbol].add(websocket)
            self._socket_symbols[websocket] = normalized_symbol
            if legacy:
                self._legacy_sockets.add(websocket)
                self._socket_market_subscriptions.add(websocket)
                self._socket_kline_intervals[websocket] = {normalized_interval}

    def _activate_domain_protocol_locked(self, websocket: WebSocket) -> None:
        if websocket not in self._legacy_sockets:
            return
        self._legacy_sockets.discard(websocket)
        self._socket_market_subscriptions.discard(websocket)
        self._socket_kline_intervals.pop(websocket, None)

    async def subscribe_domain(
        self,
        symbol: str,
        websocket: WebSocket,
        domain: str,
        *,
        interval: str | None = None,
    ) -> str | None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_domain = normalize_contract_ws_domain(domain)
        if not normalized_symbol or not normalized_domain:
            return None
        normalized_interval = normalize_contract_ws_interval(interval)

        async with self._lock:
            previous_symbol = self._socket_symbols.get(websocket)
            if previous_symbol and previous_symbol != normalized_symbol:
                previous_room = self._symbol_rooms.get(previous_symbol)
                if previous_room is not None:
                    previous_room.discard(websocket)
                    if not previous_room:
                        self._symbol_rooms.pop(previous_symbol, None)
                self._socket_market_subscriptions.discard(websocket)
                self._socket_kline_intervals.pop(websocket, None)
            self._symbol_rooms[normalized_symbol].add(websocket)
            self._socket_symbols[websocket] = normalized_symbol
            self._activate_domain_protocol_locked(websocket)
            if normalized_domain == "market":
                self._socket_market_subscriptions.add(websocket)
            else:
                self._socket_kline_intervals[websocket] = {normalized_interval}
            return previous_symbol

    async def unsubscribe_domain(
        self,
        websocket: WebSocket,
        domain: str,
        *,
        interval: str | None = None,
    ) -> None:
        normalized_domain = normalize_contract_ws_domain(domain)
        if not normalized_domain:
            return
        normalized_interval = normalize_contract_ws_interval(interval)
        async with self._lock:
            self._activate_domain_protocol_locked(websocket)
            if normalized_domain == "market":
                self._socket_market_subscriptions.discard(websocket)
                return
            intervals = self._socket_kline_intervals.get(websocket)
            if not intervals:
                return
            intervals.discard(normalized_interval)
            if not intervals:
                self._socket_kline_intervals.pop(websocket, None)

    async def disconnect(self, websocket: WebSocket) -> str | None:
        async with self._lock:
            symbol = self._socket_symbols.pop(websocket, None)
            self._socket_market_subscriptions.discard(websocket)
            self._socket_kline_intervals.pop(websocket, None)
            self._legacy_sockets.discard(websocket)
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
            self._prune_symbol_locked(normalized_symbol)
            sockets = self._symbol_rooms.get(normalized_symbol) or ()
            return any(
                websocket in self._socket_market_subscriptions
                or bool(self._socket_kline_intervals.get(websocket))
                for websocket in sockets
            )

    async def subscriber_count(self, symbol: str) -> int:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        async with self._lock:
            self._prune_symbol_locked(normalized_symbol)
            sockets = self._symbol_rooms.get(normalized_symbol) or ()
            return sum(
                1
                for websocket in sockets
                if websocket in self._socket_market_subscriptions
                or bool(self._socket_kline_intervals.get(websocket))
            )

    async def subscribed_intervals(self, symbol: str) -> list[str]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        async with self._lock:
            self._prune_symbol_locked(normalized_symbol)
            sockets = list(self._symbol_rooms.get(normalized_symbol) or ())
            values = {
                normalize_contract_ws_interval(interval)
                for websocket in sockets
                for interval in self._socket_kline_intervals.get(websocket, set())
            }
        return sorted(values)

    async def market_subscriber_count(self, symbol: str) -> int:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        async with self._lock:
            self._prune_symbol_locked(normalized_symbol)
            sockets = self._symbol_rooms.get(normalized_symbol) or ()
            return sum(1 for websocket in sockets if websocket in self._socket_market_subscriptions)

    async def send_to_one(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        await websocket.send_text(json.dumps(_to_jsonable(payload), ensure_ascii=False))

    async def broadcast_to_symbol(self, symbol: str, payload: dict[str, Any]) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return
        domain = contract_ws_payload_domain(payload)
        payload_interval = normalize_contract_ws_interval(payload.get("interval"))
        async with self._lock:
            self._prune_symbol_locked(normalized_symbol)
            sockets = []
            for websocket in self._symbol_rooms.get(normalized_symbol) or ():
                if websocket in self._legacy_sockets:
                    sockets.append(websocket)
                    continue
                if domain == "market" and websocket in self._socket_market_subscriptions:
                    sockets.append(websocket)
                    continue
                if domain == "kline" and payload_interval in self._socket_kline_intervals.get(websocket, set()):
                    sockets.append(websocket)
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
