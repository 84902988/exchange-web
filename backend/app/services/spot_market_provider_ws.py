from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

import websockets

from app.core.config import settings
from app.schemas.market import DepthItem, DepthResponse, TradeItem, TradesResponse
from app.services.contract_market_provider_service import PROVIDER_BITGET_SPOT


logger = logging.getLogger(__name__)

SPOT_PROVIDER_WS_SOURCE = "LIVE_WS"
BITGET_SPOT_DEPTH_CHANNEL = "books15"
BITGET_SPOT_TICKER_CHANNEL = "ticker"
BITGET_SPOT_TRADES_CHANNEL = "trade"


@dataclass(frozen=True)
class SpotDepthSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    depth_limit: int
    channel: str = BITGET_SPOT_DEPTH_CHANNEL
    ws_url: Optional[str] = None


@dataclass(frozen=True)
class SpotTickerSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    channel: str = BITGET_SPOT_TICKER_CHANNEL
    ws_url: Optional[str] = None


@dataclass(frozen=True)
class SpotTradesSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    trades_limit: int
    channel: str = BITGET_SPOT_TRADES_CHANNEL
    ws_url: Optional[str] = None


def normalize_spot_ws_symbol(value: Any) -> str:
    raw = str(value or "").strip().upper()
    return "".join(ch for ch in raw if ch.isalnum())


def spot_provider_ws_depth_enabled() -> bool:
    return bool(
        getattr(settings, "SPOT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "SPOT_PROVIDER_WS_DEPTH_ENABLED", False)
    )


def spot_provider_ws_ticker_enabled() -> bool:
    return bool(
        getattr(settings, "SPOT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "SPOT_PROVIDER_WS_TICKER_ENABLED", False)
    )


def spot_provider_ws_trades_enabled() -> bool:
    return bool(
        getattr(settings, "SPOT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "SPOT_PROVIDER_WS_TRADES_ENABLED", False)
    )


def _now_ms() -> int:
    return int(time.time() * 1000)


def _depth_limit(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_DEPTH_LIMIT", 20)
    return max(1, min(int(configured or 20), 100))


def _max_age_ms(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500)
    return max(100, int(configured or 1500))


def _ticker_max_age_ms(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_TICKER_MAX_AGE_MS", 1500)
    return max(100, int(configured or 1500))


def _trades_max_age_ms(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_TRADES_MAX_AGE_MS", 1500)
    return max(100, int(configured or 1500))


def _trades_limit(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_TRADES_LIMIT", 30)
    return max(1, min(int(configured or 30), 100))


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _decimal_to_str(value: Decimal) -> str:
    return format(value.normalize(), "f") if value == value.normalize() else format(value, "f")


def _normalize_depth_side(levels: Any, *, reverse: bool, limit: int) -> list[dict[str, str]]:
    normalized: list[tuple[Decimal, Decimal]] = []
    if not isinstance(levels, list):
        return []
    for row in levels:
        price_value: Any = None
        amount_value: Any = None
        if isinstance(row, list) and len(row) >= 2:
            price_value = row[0]
            amount_value = row[1]
        elif isinstance(row, dict):
            price_value = row.get("price") or row.get("px")
            amount_value = row.get("amount") or row.get("size") or row.get("qty") or row.get("quantity")
        price = _to_decimal(price_value)
        amount = _to_decimal(amount_value)
        if price is None or amount is None or price <= 0 or amount <= 0:
            continue
        normalized.append((price, amount))
    normalized.sort(key=lambda item: item[0], reverse=reverse)
    return [
        {"price": _decimal_to_str(price), "amount": _decimal_to_str(amount)}
        for price, amount in normalized[:limit]
    ]


def _spot_provider_ts(value: Any) -> int:
    try:
        timestamp = int(value or 0)
    except Exception:
        timestamp = 0
    return timestamp if timestamp > 0 else _now_ms()


def _trade_signature(trade: dict[str, Any]) -> str:
    trade_id = str(trade.get("id") or trade.get("tradeId") or "").strip()
    if trade_id:
        return f"id:{trade_id}"
    return repr(
        (
            str(trade.get("price") or ""),
            str(trade.get("amount") or trade.get("size") or ""),
            str(trade.get("side") or "").upper(),
            int(trade.get("ts") or 0),
        )
    )


def _depth_response_from_record(record: dict[str, Any], *, limit: Optional[int] = None) -> DepthResponse:
    depth_limit = _depth_limit(limit)
    return DepthResponse(
        symbol=normalize_spot_ws_symbol(record.get("symbol")),
        price_precision=int(record.get("price_precision") or 8),
        amount_precision=int(record.get("amount_precision") or 8),
        bids=[DepthItem(**item) for item in list(record.get("bids") or [])[:depth_limit]],
        asks=[DepthItem(**item) for item in list(record.get("asks") or [])[:depth_limit]],
        ts=int(record.get("ts") or record.get("updated_at_ms") or _now_ms()),
        provider=str(record.get("provider") or PROVIDER_BITGET_SPOT),
        stale=False,
        updated_at=record.get("updated_at"),
        source=str(record.get("source") or SPOT_PROVIDER_WS_SOURCE),
        fetched_at=int(record.get("updated_at_ms") or _now_ms()),
    )


def _trades_response_from_record(record: dict[str, Any], *, limit: Optional[int] = None) -> TradesResponse:
    trade_limit = _trades_limit(limit)
    return TradesResponse(
        symbol=normalize_spot_ws_symbol(record.get("symbol")),
        trades=[TradeItem(**item) for item in list(record.get("trades") or [])[:trade_limit]],
        provider=str(record.get("provider") or PROVIDER_BITGET_SPOT),
        stale=False,
        updated_at=record.get("updated_at"),
        source=str(record.get("source") or SPOT_PROVIDER_WS_SOURCE),
        freshness=str(record.get("freshness") or "LIVE"),
    )


def normalize_bitget_depth_message(
    message: dict[str, Any],
    *,
    local_symbol: str,
    provider_symbol: str,
    depth_limit: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    if not isinstance(message, dict) or message.get("event"):
        return None
    data = message.get("data")
    if not isinstance(data, list) or not data:
        return None
    row = data[0]
    if not isinstance(row, dict):
        return None

    limit = _depth_limit(depth_limit)
    bids = _normalize_depth_side(row.get("bids"), reverse=True, limit=limit)
    asks = _normalize_depth_side(row.get("asks"), reverse=False, limit=limit)
    if not bids or not asks:
        return None

    now_ms = _now_ms()
    exchange_ts = _spot_provider_ts(row.get("ts"))
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_BITGET_SPOT,
        "provider_symbol": normalize_spot_ws_symbol(provider_symbol),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "bids": bids,
        "asks": asks,
        "ts": exchange_ts,
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
        "price_precision": 8,
        "amount_precision": 8,
    }


def normalize_bitget_trade_message(
    message: dict[str, Any],
    *,
    local_symbol: str,
    provider_symbol: str,
    trades_limit: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    if not isinstance(message, dict) or message.get("event"):
        return None
    data = message.get("data")
    if not isinstance(data, list) or not data:
        return None

    trades: list[dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        price = _to_decimal(row.get("price"))
        amount = _to_decimal(row.get("size"))
        if price is None or amount is None or price <= 0 or amount <= 0:
            continue
        side_text = str(row.get("side") or "").upper()
        trades.append(
            {
                "id": str(row.get("tradeId") or ""),
                "price": _decimal_to_str(price),
                "amount": _decimal_to_str(amount),
                "side": "SELL" if side_text == "SELL" else "BUY",
                "ts": _spot_provider_ts(row.get("ts")),
            }
        )

    if not trades:
        return None
    trade_limit = _trades_limit(trades_limit)
    trades.sort(key=lambda item: int(item.get("ts") or 0), reverse=True)
    now_ms = _now_ms()
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_BITGET_SPOT,
        "provider_symbol": normalize_spot_ws_symbol(provider_symbol),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "trades": trades[:trade_limit],
        "ts": int(trades[0].get("ts") or now_ms),
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
    }


def normalize_bitget_ticker_message(
    message: dict[str, Any],
    *,
    local_symbol: str,
    provider_symbol: str,
) -> Optional[dict[str, Any]]:
    if not isinstance(message, dict) or message.get("event"):
        return None
    data = message.get("data")
    if not isinstance(data, list) or not data:
        return None
    row = data[0]
    if not isinstance(row, dict):
        return None

    last_price = _to_decimal(row.get("lastPr") or row.get("last") or row.get("close"))
    if last_price is None or last_price <= 0:
        return None
    open_24h = _to_decimal(row.get("open24h") or row.get("openUtc")) or last_price
    high_24h = _to_decimal(row.get("high24h")) or last_price
    low_24h = _to_decimal(row.get("low24h")) or last_price
    base_volume = _to_decimal(row.get("baseVolume") or row.get("baseVol")) or Decimal("0")
    quote_volume = (
        _to_decimal(row.get("quoteVolume") or row.get("quoteVol") or row.get("usdtVolume"))
        or Decimal("0")
    )
    if quote_volume <= 0 and base_volume > 0:
        quote_volume = base_volume * last_price
    price_change_24h = last_price - open_24h
    price_change_percent = Decimal("0")
    if open_24h > 0:
        price_change_percent = (price_change_24h / open_24h) * Decimal("100")

    now_ms = _now_ms()
    exchange_ts = _spot_provider_ts(row.get("ts"))
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_BITGET_SPOT,
        "provider_symbol": normalize_spot_ws_symbol(provider_symbol),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "last_price": _decimal_to_str(last_price),
        "open_24h": _decimal_to_str(open_24h),
        "price_change_24h": _decimal_to_str(price_change_24h),
        "price_change_percent": _decimal_to_str(price_change_percent),
        "high_24h": _decimal_to_str(high_24h),
        "low_24h": _decimal_to_str(low_24h),
        "base_volume_24h": _decimal_to_str(base_volume),
        "volume_24h": _decimal_to_str(base_volume),
        "quote_volume_24h": _decimal_to_str(quote_volume),
        "quote_freshness": "LIVE",
        "stale": False,
        "market_status": "OPEN",
        "ts": exchange_ts,
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
    }


class SpotMarketProviderWsService:
    def __init__(self) -> None:
        self._depth_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._ticker_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._trades_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._depth_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._ticker_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._trades_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._depth_stops: dict[tuple[str, str], threading.Event] = {}
        self._ticker_stops: dict[tuple[str, str], threading.Event] = {}
        self._trades_stops: dict[tuple[str, str], threading.Event] = {}
        self._depth_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._ticker_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._trades_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._depth_generations: dict[tuple[str, str], int] = {}
        self._ticker_generations: dict[tuple[str, str], int] = {}
        self._trades_generations: dict[tuple[str, str], int] = {}
        self._lock = threading.RLock()

    def get_fresh_depth(
        self,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[DepthResponse]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        now_ms = _now_ms()
        allowed_age_ms = _max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._depth_cache.items()
                if provider == PROVIDER_BITGET_SPOT and local_symbol == normalized_symbol
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return _depth_response_from_record(deepcopy(item), limit=limit)
        return None

    def get_fresh_ticker(
        self,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        now_ms = _now_ms()
        allowed_age_ms = _ticker_max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._ticker_cache.items()
                if provider == PROVIDER_BITGET_SPOT and local_symbol == normalized_symbol
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return deepcopy(item)
        return None

    def get_fresh_trades(
        self,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[TradesResponse]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        now_ms = _now_ms()
        allowed_age_ms = _trades_max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._trades_cache.items()
                if provider == PROVIDER_BITGET_SPOT and local_symbol == normalized_symbol
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return _trades_response_from_record(deepcopy(item), limit=limit)
        return None

    def set_depth_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        payload.setdefault("provider", PROVIDER_BITGET_SPOT)
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        with self._lock:
            self._depth_cache[(PROVIDER_BITGET_SPOT, normalized_symbol)] = payload

    def set_ticker_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        payload.setdefault("provider", PROVIDER_BITGET_SPOT)
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("quote_freshness", "LIVE")
        payload.setdefault("stale", False)
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        with self._lock:
            self._ticker_cache[(PROVIDER_BITGET_SPOT, normalized_symbol)] = payload

    def set_trades_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        payload.setdefault("provider", PROVIDER_BITGET_SPOT)
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("freshness", "LIVE")
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        payload["trades"] = list(payload.get("trades") or [])[:_trades_limit()]
        with self._lock:
            self._trades_cache[(PROVIDER_BITGET_SPOT, normalized_symbol)] = payload

    def clear_for_tests(self) -> None:
        with self._lock:
            self._depth_cache.clear()
            self._ticker_cache.clear()
            self._trades_cache.clear()
            self._depth_tasks.clear()
            self._ticker_tasks.clear()
            self._trades_tasks.clear()
            self._depth_stops.clear()
            self._ticker_stops.clear()
            self._trades_stops.clear()
            self._depth_connections.clear()
            self._ticker_connections.clear()
            self._trades_connections.clear()
            self._depth_generations.clear()
            self._ticker_generations.clear()
            self._trades_generations.clear()

    def ensure_symbol(self, symbol: str) -> None:
        if (
            not spot_provider_ws_depth_enabled()
            and not spot_provider_ws_ticker_enabled()
            and not spot_provider_ws_trades_enabled()
        ):
            return
        local_symbol = normalize_spot_ws_symbol(symbol)
        if not local_symbol:
            return
        if spot_provider_ws_depth_enabled():
            self._ensure_depth_symbol(local_symbol)
        if spot_provider_ws_ticker_enabled():
            self._ensure_ticker_symbol(local_symbol)
        if spot_provider_ws_trades_enabled():
            self._ensure_trades_symbol(local_symbol)

    def _ensure_depth_symbol(self, local_symbol: str) -> None:
        provider_symbol = local_symbol
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            task = self._depth_tasks.get(key)
            if task is not None and task.is_alive():
                return
            generation = self._depth_generations.get(key, 0) + 1
            self._depth_generations[key] = generation
            stop_event = threading.Event()
            self._depth_stops[key] = stop_event
            subscription = SpotDepthSubscription(
                local_symbol=local_symbol,
                provider=PROVIDER_BITGET_SPOT,
                provider_symbol=provider_symbol,
                depth_limit=_depth_limit(),
                ws_url=str(getattr(settings, "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL", "") or "").strip(),
            )
            thread = threading.Thread(
                target=self._run_depth_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-depth-ws-{local_symbol}",
                daemon=True,
            )
            self._depth_tasks[key] = thread
            thread.start()

    def _ensure_ticker_symbol(self, local_symbol: str) -> None:
        provider_symbol = local_symbol
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            task = self._ticker_tasks.get(key)
            if task is not None and task.is_alive():
                return
            generation = self._ticker_generations.get(key, 0) + 1
            self._ticker_generations[key] = generation
            stop_event = threading.Event()
            self._ticker_stops[key] = stop_event
            subscription = SpotTickerSubscription(
                local_symbol=local_symbol,
                provider=PROVIDER_BITGET_SPOT,
                provider_symbol=provider_symbol,
                ws_url=str(getattr(settings, "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL", "") or "").strip(),
            )
            thread = threading.Thread(
                target=self._run_ticker_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-ticker-ws-{local_symbol}",
                daemon=True,
            )
            self._ticker_tasks[key] = thread
            thread.start()

    def _ensure_trades_symbol(self, local_symbol: str) -> None:
        provider_symbol = local_symbol
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            task = self._trades_tasks.get(key)
            if task is not None and task.is_alive():
                return
            generation = self._trades_generations.get(key, 0) + 1
            self._trades_generations[key] = generation
            stop_event = threading.Event()
            self._trades_stops[key] = stop_event
            subscription = SpotTradesSubscription(
                local_symbol=local_symbol,
                provider=PROVIDER_BITGET_SPOT,
                provider_symbol=provider_symbol,
                trades_limit=_trades_limit(),
                ws_url=str(getattr(settings, "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL", "") or "").strip(),
            )
            thread = threading.Thread(
                target=self._run_trades_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-trades-ws-{local_symbol}",
                daemon=True,
            )
            self._trades_tasks[key] = thread
            thread.start()

    def release_symbol(self, symbol: str) -> None:
        local_symbol = normalize_spot_ws_symbol(symbol)
        if not local_symbol:
            return
        self._stop_depth_subscription(local_symbol)
        self._stop_ticker_subscription(local_symbol)
        self._stop_trades_subscription(local_symbol)

    def _stop_depth_subscription(self, local_symbol: str) -> None:
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            stop_event = self._depth_stops.pop(key, None)
            task = self._depth_tasks.pop(key, None)
            connection = self._depth_connections.pop(key, None)
            self._depth_generations[key] = self._depth_generations.get(key, 0) + 1
        if stop_event is not None:
            stop_event.set()
        if connection is not None:
            loop, websocket = connection
            if not loop.is_closed():
                try:
                    asyncio.run_coroutine_threadsafe(websocket.close(), loop)
                except Exception:
                    logger.debug("spot_provider_ws_depth_close_failed symbol=%s", local_symbol, exc_info=True)
        if task is not None and task.is_alive() and task is not threading.current_thread():
            task.join(timeout=2.0)

    def _stop_trades_subscription(self, local_symbol: str) -> None:
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            stop_event = self._trades_stops.pop(key, None)
            task = self._trades_tasks.pop(key, None)
            connection = self._trades_connections.pop(key, None)
            self._trades_generations[key] = self._trades_generations.get(key, 0) + 1
        if stop_event is not None:
            stop_event.set()
        if connection is not None:
            loop, websocket = connection
            if not loop.is_closed():
                try:
                    asyncio.run_coroutine_threadsafe(websocket.close(), loop)
                except Exception:
                    logger.debug("spot_provider_ws_trades_close_failed symbol=%s", local_symbol, exc_info=True)
        if task is not None and task.is_alive() and task is not threading.current_thread():
            task.join(timeout=2.0)

    def _stop_ticker_subscription(self, local_symbol: str) -> None:
        key = (PROVIDER_BITGET_SPOT, local_symbol)
        with self._lock:
            stop_event = self._ticker_stops.pop(key, None)
            task = self._ticker_tasks.pop(key, None)
            connection = self._ticker_connections.pop(key, None)
            self._ticker_generations[key] = self._ticker_generations.get(key, 0) + 1
        if stop_event is not None:
            stop_event.set()
        if connection is not None:
            loop, websocket = connection
            if not loop.is_closed():
                try:
                    asyncio.run_coroutine_threadsafe(websocket.close(), loop)
                except Exception:
                    logger.debug("spot_provider_ws_ticker_close_failed symbol=%s", local_symbol, exc_info=True)
        if task is not None and task.is_alive() and task is not threading.current_thread():
            task.join(timeout=2.0)

    def _run_depth_thread(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._depth_loop(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "spot_provider_ws_depth_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    def _run_ticker_thread(
        self,
        subscription: SpotTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._ticker_loop(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "spot_provider_ws_ticker_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    def _run_trades_thread(
        self,
        subscription: SpotTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._trades_loop(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "spot_provider_ws_trades_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    async def _depth_loop(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set() and spot_provider_ws_depth_enabled():
            try:
                await self._run_bitget_depth_ws(subscription, stop_event, generation)
            except Exception:
                logger.warning(
                    "spot_provider_ws_depth_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                await asyncio.sleep(1.0)

    async def _ticker_loop(
        self,
        subscription: SpotTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set() and spot_provider_ws_ticker_enabled():
            try:
                await self._run_bitget_ticker_ws(subscription, stop_event, generation)
            except Exception:
                logger.warning(
                    "spot_provider_ws_ticker_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                await asyncio.sleep(1.0)

    async def _trades_loop(
        self,
        subscription: SpotTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set() and spot_provider_ws_trades_enabled():
            try:
                await self._run_bitget_trades_ws(subscription, stop_event, generation)
            except Exception:
                logger.warning(
                    "spot_provider_ws_trades_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                await asyncio.sleep(1.0)

    async def _run_bitget_depth_ws(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not spot_provider_ws_depth_enabled():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_BITGET_PUBLIC_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "instType": "SPOT",
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not spot_provider_ws_depth_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                if self._depth_generations.get(key) != generation:
                    stop_event.set()
                    return
                self._depth_connections[key] = (loop, websocket)
            logger.info(
                "spot_provider_ws_depth_subscription_started provider=%s symbol=%s provider_symbol=%s channel=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
                subscription.channel,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                last_ping_at = time.monotonic()
                while not stop_event.is_set() and spot_provider_ws_depth_enabled():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_bitget_depth_message(subscription, raw_message, generation)
            finally:
                with self._lock:
                    current = self._depth_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._depth_connections.pop(key, None)
                logger.info(
                    "spot_provider_ws_depth_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    async def _run_bitget_ticker_ws(
        self,
        subscription: SpotTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not spot_provider_ws_ticker_enabled():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_BITGET_PUBLIC_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "instType": "SPOT",
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not spot_provider_ws_ticker_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                if self._ticker_generations.get(key) != generation:
                    stop_event.set()
                    return
                self._ticker_connections[key] = (loop, websocket)
            logger.info(
                "spot_provider_ws_ticker_subscription_started provider=%s symbol=%s provider_symbol=%s channel=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
                subscription.channel,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                last_ping_at = time.monotonic()
                while not stop_event.is_set() and spot_provider_ws_ticker_enabled():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_bitget_ticker_message(subscription, raw_message, generation)
            finally:
                with self._lock:
                    current = self._ticker_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._ticker_connections.pop(key, None)
                logger.info(
                    "spot_provider_ws_ticker_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    async def _run_bitget_trades_ws(
        self,
        subscription: SpotTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not spot_provider_ws_trades_enabled():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_BITGET_PUBLIC_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "instType": "SPOT",
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not spot_provider_ws_trades_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                if self._trades_generations.get(key) != generation:
                    stop_event.set()
                    return
                self._trades_connections[key] = (loop, websocket)
            logger.info(
                "spot_provider_ws_trades_subscription_started provider=%s symbol=%s provider_symbol=%s channel=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
                subscription.channel,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                last_ping_at = time.monotonic()
                while not stop_event.is_set() and spot_provider_ws_trades_enabled():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_bitget_trades_message(subscription, raw_message, generation)
            finally:
                with self._lock:
                    current = self._trades_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._trades_connections.pop(key, None)
                logger.info(
                    "spot_provider_ws_trades_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    def _handle_bitget_depth_message(
        self,
        subscription: SpotDepthSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("spot_provider_ws_bitget_depth_invalid_json symbol=%s", subscription.local_symbol)
            return
        record = normalize_bitget_depth_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
            depth_limit=subscription.depth_limit,
        )
        if record is None:
            return
        key = (subscription.provider, subscription.local_symbol)
        with self._lock:
            if self._depth_generations.get(key) != generation:
                return
            self._depth_cache[key] = record

    def _handle_bitget_ticker_message(
        self,
        subscription: SpotTickerSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("spot_provider_ws_bitget_ticker_invalid_json symbol=%s", subscription.local_symbol)
            return
        record = normalize_bitget_ticker_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
        )
        if record is None:
            return
        key = (subscription.provider, subscription.local_symbol)
        with self._lock:
            if self._ticker_generations.get(key) != generation:
                return
            self._ticker_cache[key] = record

    def _handle_bitget_trades_message(
        self,
        subscription: SpotTradesSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("spot_provider_ws_bitget_trades_invalid_json symbol=%s", subscription.local_symbol)
            return
        record = normalize_bitget_trade_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
            trades_limit=subscription.trades_limit,
        )
        if record is None:
            return
        key = (subscription.provider, subscription.local_symbol)
        with self._lock:
            if self._trades_generations.get(key) != generation:
                return
            existing = self._trades_cache.get(key) or {}
            combined = list(record.get("trades") or []) + list(existing.get("trades") or [])
            deduped: list[dict[str, Any]] = []
            seen: set[str] = set()
            for trade in combined:
                signature = _trade_signature(trade)
                if not signature or signature in seen:
                    continue
                seen.add(signature)
                deduped.append(trade)
                if len(deduped) >= subscription.trades_limit:
                    break
            record["trades"] = deduped
            self._trades_cache[key] = record


spot_market_provider_ws = SpotMarketProviderWsService()


def get_spot_provider_ws_depth(
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
    limit: Optional[int] = None,
) -> Optional[DepthResponse]:
    if not spot_provider_ws_depth_enabled():
        return None
    return spot_market_provider_ws.get_fresh_depth(symbol, max_age_ms=max_age_ms, limit=limit)


def ensure_spot_provider_ws_depth(symbol: str) -> None:
    spot_market_provider_ws.ensure_symbol(symbol)


def release_spot_provider_ws_depth(symbol: str) -> None:
    spot_market_provider_ws.release_symbol(symbol)


def get_spot_provider_ws_ticker(
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    if not spot_provider_ws_ticker_enabled():
        return None
    return spot_market_provider_ws.get_fresh_ticker(symbol, max_age_ms=max_age_ms)


def ensure_spot_provider_ws_ticker(symbol: str) -> None:
    spot_market_provider_ws.ensure_symbol(symbol)


def release_spot_provider_ws_ticker(symbol: str) -> None:
    spot_market_provider_ws.release_symbol(symbol)


def get_spot_provider_ws_trades(
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
    limit: Optional[int] = None,
) -> Optional[TradesResponse]:
    if not spot_provider_ws_trades_enabled():
        return None
    return spot_market_provider_ws.get_fresh_trades(symbol, max_age_ms=max_age_ms, limit=limit)


def ensure_spot_provider_ws_trades(symbol: str) -> None:
    spot_market_provider_ws.ensure_symbol(symbol)


def release_spot_provider_ws_trades(symbol: str) -> None:
    spot_market_provider_ws.release_symbol(symbol)
