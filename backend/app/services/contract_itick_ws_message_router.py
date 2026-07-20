from __future__ import annotations

import json
from threading import RLock
from typing import Any, Callable, Dict, Tuple

from app.services.contract_itick_ws_subscription_plan import ItickWsSubscriptionPlan


ItickWsMessageHandler = Callable[[Any], None]


class ItickWsMessageRouter:
    """Routes provider messages without allowing stale symbols to cross consumers."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._handlers: Dict[Tuple[str, str, str, str], ItickWsMessageHandler] = {}

    @staticmethod
    def _normalize_provider_symbol(value: object) -> str:
        symbol = str(value or "").strip().upper()
        if "$" in symbol:
            symbol = symbol.split("$", 1)[0]
        if not symbol:
            raise ValueError("iTick provider symbol is required")
        return symbol

    @staticmethod
    def _normalize_stream(value: object) -> str:
        stream = str(value or "").strip().lower()
        if stream not in {"quote", "tick", "depth", "kline@1"}:
            raise ValueError("unsupported iTick websocket stream")
        return stream

    def register(
        self,
        *,
        market: object,
        provider_symbol: object,
        stream: object,
        consumer_id: object,
        handler: ItickWsMessageHandler,
    ) -> None:
        normalized_market = ItickWsSubscriptionPlan.normalize_market(market)
        normalized_symbol = self._normalize_provider_symbol(provider_symbol)
        normalized_stream = self._normalize_stream(stream)
        normalized_consumer = str(consumer_id or "").strip()
        if not normalized_consumer:
            raise ValueError("iTick websocket consumer id is required")
        if not callable(handler):
            raise ValueError("iTick websocket handler must be callable")
        with self._lock:
            self._handlers[(normalized_market, normalized_symbol, normalized_stream, normalized_consumer)] = handler

    def unregister(
        self,
        *,
        market: object,
        provider_symbol: object,
        stream: object,
        consumer_id: object,
    ) -> None:
        key = (
            ItickWsSubscriptionPlan.normalize_market(market),
            self._normalize_provider_symbol(provider_symbol),
            self._normalize_stream(stream),
            str(consumer_id or "").strip(),
        )
        with self._lock:
            self._handlers.pop(key, None)

    def dispatch(self, market: object, raw_message: Any) -> int:
        normalized_market = ItickWsSubscriptionPlan.normalize_market(market)
        try:
            message = json.loads(raw_message) if isinstance(raw_message, (str, bytes, bytearray)) else raw_message
        except Exception:
            return 0
        rows = self._rows(message)
        dispatched = 0
        for row in rows:
            try:
                symbol = self._normalize_provider_symbol(row.get("s") or row.get("symbol") or row.get("code"))
                stream = self._normalize_stream(row.get("type") or row.get("types"))
            except ValueError:
                continue
            with self._lock:
                handlers = tuple(
                    handler
                    for (item_market, item_symbol, item_stream, _consumer), handler in self._handlers.items()
                    if item_market == normalized_market and item_symbol == symbol and item_stream == stream
                )
            for handler in handlers:
                handler(raw_message)
                dispatched += 1
        return dispatched

    @staticmethod
    def _rows(message: Any) -> tuple[dict[str, Any], ...]:
        if not isinstance(message, dict):
            return ()
        data = message.get("data")
        if isinstance(data, dict):
            return (data,)
        if isinstance(data, list):
            return tuple(row for row in data if isinstance(row, dict))
        if message.get("s") or message.get("symbol"):
            return (message,)
        return ()

    def registered_count(self) -> int:
        with self._lock:
            return len(self._handlers)
