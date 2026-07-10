from __future__ import annotations

import asyncio
import importlib
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
from app.services.contract_market_provider_service import PROVIDER_BITGET_SPOT, PROVIDER_OKX_SPOT
from app.services.spot_kline_bucket import normalize_spot_kline_bucket_interval
from app.services.spot_market_domain_cache import is_fresh_record


logger = logging.getLogger(__name__)

SPOT_PROVIDER_WS_SOURCE = "LIVE_WS"
SPOT_PROVIDER_WS_SUPPORTED_PROVIDERS = {PROVIDER_BITGET_SPOT, PROVIDER_OKX_SPOT}
SPOT_PROVIDER_WS_DEPTH_SUPPORTED_PROVIDERS = {PROVIDER_BITGET_SPOT, PROVIDER_OKX_SPOT}
SPOT_PROVIDER_WS_TICKER_SUPPORTED_PROVIDERS = {PROVIDER_BITGET_SPOT, PROVIDER_OKX_SPOT}
SPOT_PROVIDER_WS_TRADES_SUPPORTED_PROVIDERS = {PROVIDER_BITGET_SPOT, PROVIDER_OKX_SPOT}
SPOT_PROVIDER_WS_KLINE_SUPPORTED_PROVIDERS = {PROVIDER_BITGET_SPOT, PROVIDER_OKX_SPOT}
BITGET_SPOT_DEPTH_CHANNEL = "books15"
OKX_SPOT_DEPTH_CHANNEL = "books"
BITGET_SPOT_TICKER_CHANNEL = "ticker"
OKX_SPOT_TICKER_CHANNEL = "tickers"
BITGET_SPOT_TRADES_CHANNEL = "trade"
OKX_SPOT_TRADES_CHANNEL = "trades"
BITGET_SPOT_KLINE_CHANNELS = {
    "1m": "candle1m",
    "5m": "candle5m",
    "15m": "candle15",
    "1h": "candle1H",
    "4h": "candle4H",
    "1d": "candle1D",
    "1w": "candle1W",
    "1M": "candle1M",
}
OKX_SPOT_KLINE_CHANNELS = {
    "1m": "candle1m",
    "5m": "candle5m",
    "15m": "candle15m",
    "1h": "candle1H",
    "4h": "candle4H",
    "1d": "candle1D",
    "1Dutc": "candle1Dutc",
    "1w": "candle1W",
    "1Wutc": "candle1Wutc",
    "1M": "candle1M",
    "1Mutc": "candle1Mutc",
}
SPOT_KLINE_INTERVAL_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
    "1Dutc": 86_400_000,
    "1w": 7 * 86_400_000,
    "1Wutc": 7 * 86_400_000,
    "1M": 30 * 86_400_000,
    "1Mutc": 30 * 86_400_000,
}
_PROVIDER_WS_SHUTDOWN_NOISE_MESSAGES = (
    "cannot schedule new futures after shutdown",
    "event loop is closed",
    "executor shutdown",
)
_PROVIDER_WS_DISCONNECT_LOG_THROTTLE_SECONDS = 30.0
_PROVIDER_WS_DISCONNECT_LOG_LAST_AT: dict[tuple[str, str, str, str, str], float] = {}


def _websocket_connection_closed_types() -> tuple[type[BaseException], ...]:
    exceptions: list[type[BaseException]] = []
    try:
        websocket_exceptions = importlib.import_module("websockets.exceptions")
    except (AttributeError, ImportError, ModuleNotFoundError):
        websocket_exceptions = None
    if websocket_exceptions is None:
        return ()
    for name in ("ConnectionClosed", "ConnectionClosedError", "ConnectionClosedOK"):
        exc_type = getattr(websocket_exceptions, name, None)
        if isinstance(exc_type, type):
            exceptions.append(exc_type)
    return tuple(exceptions)


_PROVIDER_WS_RECOVERABLE_EXCEPTIONS = (
    ConnectionResetError,
    TimeoutError,
    OSError,
    asyncio.TimeoutError,
    *_websocket_connection_closed_types(),
)


def _is_provider_ws_shutdown_noise(
    exc: BaseException,
    stop_event: Optional[threading.Event] = None,
) -> bool:
    if stop_event is not None and stop_event.is_set():
        return True
    if not isinstance(exc, RuntimeError):
        return False
    message = str(exc).strip().lower()
    return any(fragment in message for fragment in _PROVIDER_WS_SHUTDOWN_NOISE_MESSAGES)


def _is_provider_ws_recoverable_disconnect(exc: BaseException) -> bool:
    return isinstance(exc, _PROVIDER_WS_RECOVERABLE_EXCEPTIONS)


def _log_provider_ws_disconnected(
    domain: str,
    subscription: Any,
    exc: BaseException,
    *,
    retry_in: float,
) -> None:
    reason = type(exc).__name__
    interval = getattr(subscription, "interval", "")
    key = (str(domain), subscription.provider, subscription.local_symbol, str(interval), reason)
    now = time.monotonic()
    last_at = _PROVIDER_WS_DISCONNECT_LOG_LAST_AT.get(key)
    if last_at is not None and now - last_at < _PROVIDER_WS_DISCONNECT_LOG_THROTTLE_SECONDS:
        return
    _PROVIDER_WS_DISCONNECT_LOG_LAST_AT[key] = now
    if interval:
        logger.warning(
            "spot_provider_ws_%s_disconnected provider=%s symbol=%s provider_symbol=%s interval=%s reason=%s retry_in=%.1fs",
            domain,
            subscription.provider,
            subscription.local_symbol,
            subscription.provider_symbol,
            interval,
            reason,
            retry_in,
        )
        return
    logger.warning(
        "spot_provider_ws_%s_disconnected provider=%s symbol=%s provider_symbol=%s reason=%s retry_in=%.1fs",
        domain,
        subscription.provider,
        subscription.local_symbol,
        subscription.provider_symbol,
        reason,
        retry_in,
    )


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


@dataclass(frozen=True)
class SpotKlineSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    interval: str
    channel: str
    kline_limit: int
    ws_url: Optional[str] = None


def normalize_spot_ws_symbol(value: Any) -> str:
    raw = str(value or "").strip().upper()
    return "".join(ch for ch in raw if ch.isalnum())


def normalize_spot_ws_provider(value: Any) -> str:
    return str(value or PROVIDER_BITGET_SPOT).strip().upper()


def spot_provider_ws_supports_provider(provider: Any, *, domain: Optional[str] = None) -> bool:
    provider_code = normalize_spot_ws_provider(provider)
    normalized_domain = str(domain or "").strip().lower()
    if normalized_domain == "depth":
        return provider_code in SPOT_PROVIDER_WS_DEPTH_SUPPORTED_PROVIDERS
    if normalized_domain == "ticker":
        return provider_code in SPOT_PROVIDER_WS_TICKER_SUPPORTED_PROVIDERS
    if normalized_domain in {"trade", "trades"}:
        return provider_code in SPOT_PROVIDER_WS_TRADES_SUPPORTED_PROVIDERS
    if normalized_domain == "kline":
        return provider_code in SPOT_PROVIDER_WS_KLINE_SUPPORTED_PROVIDERS
    return provider_code in SPOT_PROVIDER_WS_SUPPORTED_PROVIDERS


def okx_spot_ws_symbol(value: Any) -> str:
    normalized = normalize_spot_ws_symbol(value)
    if normalized.endswith("USDT") and len(normalized) > 4:
        return f"{normalized[:-4]}-USDT"
    return normalized


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


def normalize_spot_ws_kline_interval(interval: Any) -> str:
    normalized = normalize_spot_kline_bucket_interval(interval)
    if normalized == "15":
        normalized = "15m"
    if normalized not in SPOT_KLINE_INTERVAL_MS:
        normalized = "1m"
    return normalized


def bitget_spot_kline_channel(interval: Any) -> str:
    return BITGET_SPOT_KLINE_CHANNELS[normalize_spot_ws_kline_interval(interval)]


def okx_spot_kline_channel(interval: Any) -> str:
    return OKX_SPOT_KLINE_CHANNELS[normalize_spot_ws_kline_interval(interval)]


def _kline_max_age_ms(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_KLINE_MAX_AGE_MS", 1500)
    return max(100, int(configured or 1500))


def _kline_limit(value: Optional[int] = None) -> int:
    configured = value if value is not None else getattr(settings, "SPOT_PROVIDER_WS_KLINE_LIMIT", 300)
    return max(1, min(int(configured or 300), 1000))


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _decimal_to_str(value: Decimal) -> str:
    return format(value.normalize(), "f") if value == value.normalize() else format(value, "f")


def _bitget_change_ratio(row: dict[str, Any]) -> Optional[Decimal]:
    return _to_decimal(row.get("change24h"))


def _bitget_open_24h(row: dict[str, Any], last_price: Decimal, change_ratio: Optional[Decimal]) -> Decimal:
    open_24h = _to_decimal(row.get("open") or row.get("open24h"))
    if open_24h is not None and open_24h > 0:
        return open_24h
    if change_ratio is not None and change_ratio != Decimal("-1"):
        inferred_open = last_price / (Decimal("1") + change_ratio)
        if inferred_open > 0:
            return inferred_open
    return last_price


def _bitget_price_change_24h(
    *,
    last_price: Decimal,
    open_24h: Decimal,
    change_ratio: Optional[Decimal],
) -> Decimal:
    if change_ratio is not None and change_ratio != Decimal("-1"):
        return last_price * change_ratio / (Decimal("1") + change_ratio)
    if open_24h > 0:
        return last_price - open_24h
    return Decimal("0")


def _bitget_price_change_percent(open_24h: Decimal, price_change_24h: Decimal, change_ratio: Optional[Decimal]) -> Decimal:
    if change_ratio is not None:
        return change_ratio * Decimal("100")
    if open_24h > 0:
        return (price_change_24h / open_24h) * Decimal("100")
    return Decimal("0")


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


def _normalize_depth_delta_side(levels: Any) -> list[tuple[Decimal, Decimal]]:
    normalized: list[tuple[Decimal, Decimal]] = []
    if not isinstance(levels, list):
        return normalized
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
        if price is None or amount is None or price <= 0 or amount < 0:
            continue
        normalized.append((price, amount))
    return normalized


def _depth_record_side_to_book(levels: Any) -> dict[Decimal, Decimal]:
    book: dict[Decimal, Decimal] = {}
    if not isinstance(levels, list):
        return book
    for row in levels:
        if not isinstance(row, dict):
            continue
        price = _to_decimal(row.get("price"))
        amount = _to_decimal(row.get("amount"))
        if price is None or amount is None or price <= 0 or amount <= 0:
            continue
        book[price] = amount
    return book


def _depth_book_to_side(book: dict[Decimal, Decimal], *, reverse: bool, limit: int) -> list[dict[str, str]]:
    items = sorted(
        ((price, amount) for price, amount in book.items() if price > 0 and amount > 0),
        key=lambda item: item[0],
        reverse=reverse,
    )
    return [
        {"price": _decimal_to_str(price), "amount": _decimal_to_str(amount)}
        for price, amount in items[:limit]
    ]


def _merge_depth_side(existing_levels: Any, delta_levels: Any, *, reverse: bool, limit: int) -> list[dict[str, str]]:
    book = _depth_record_side_to_book(existing_levels)
    for price, amount in _normalize_depth_delta_side(delta_levels):
        if amount <= 0:
            book.pop(price, None)
        else:
            book[price] = amount
    return _depth_book_to_side(book, reverse=reverse, limit=limit)


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


def _public_kline_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: deepcopy(value) for key, value in item.items() if not str(key).startswith("_")}


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
        provider_symbol=str(record.get("provider_symbol") or ""),
        stale=False,
        updated_at=record.get("updated_at"),
        updated_at_ms=int(record.get("updated_at_ms") or _now_ms()),
        source=str(record.get("source") or SPOT_PROVIDER_WS_SOURCE),
        freshness=str(record.get("freshness") or "LIVE"),
    )


def _klines_response_from_record(record: dict[str, Any], *, limit: Optional[int] = None) -> dict[str, Any]:
    kline_limit = _kline_limit(limit)
    return {
        "symbol": normalize_spot_ws_symbol(record.get("symbol")),
        "interval": normalize_spot_ws_kline_interval(record.get("interval")),
        "items": [_public_kline_item(item) for item in list(record.get("items") or [])[-kline_limit:]],
        "provider": str(record.get("provider") or PROVIDER_BITGET_SPOT),
        "source": str(record.get("source") or SPOT_PROVIDER_WS_SOURCE),
        "freshness": str(record.get("freshness") or "LIVE"),
        "stale": False,
        "updated_at": record.get("updated_at"),
    }


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


def normalize_okx_depth_message(
    message: dict[str, Any],
    *,
    local_symbol: str,
    provider_symbol: str,
    depth_limit: Optional[int] = None,
    previous_record: Optional[dict[str, Any]] = None,
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
    action = str(message.get("action") or "snapshot").strip().lower()
    if action == "update" and previous_record:
        bids = _merge_depth_side(
            previous_record.get("raw_bids") or previous_record.get("bids"),
            row.get("bids"),
            reverse=True,
            limit=limit,
        )
        asks = _merge_depth_side(
            previous_record.get("raw_asks") or previous_record.get("asks"),
            row.get("asks"),
            reverse=False,
            limit=limit,
        )
    else:
        bids = _normalize_depth_side(row.get("bids"), reverse=True, limit=limit)
        asks = _normalize_depth_side(row.get("asks"), reverse=False, limit=limit)
    if not bids or not asks:
        return None

    now_ms = _now_ms()
    exchange_ts = _spot_provider_ts(row.get("ts"))
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_OKX_SPOT,
        "provider_symbol": str(provider_symbol or "").strip().upper(),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "quote_source": SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "market_status": "OPEN",
        "bids": bids,
        "asks": asks,
        "raw_bids": bids,
        "raw_asks": asks,
        "ts": exchange_ts,
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
        "price_precision": 8,
        "amount_precision": 8,
    }


def normalize_bitget_kline_message(
    message: dict[str, Any],
    *,
    local_symbol: str,
    provider_symbol: str,
    interval: str,
    kline_limit: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    if not isinstance(message, dict) or message.get("event"):
        return None
    normalized_interval = normalize_spot_ws_kline_interval(interval)
    data = message.get("data")
    if not isinstance(data, list) or not data:
        return None

    items: list[dict[str, Any]] = []
    interval_ms = SPOT_KLINE_INTERVAL_MS[normalized_interval]
    for row in data:
        if not isinstance(row, list) or len(row) < 7:
            continue
        try:
            open_time = int(row[0])
        except Exception:
            continue
        open_price = _to_decimal(row[1])
        high_price = _to_decimal(row[2])
        low_price = _to_decimal(row[3])
        close_price = _to_decimal(row[4])
        base_volume = _to_decimal(row[5]) or Decimal("0")
        quote_volume = _to_decimal(row[6]) or Decimal("0")
        if (
            open_time <= 0
            or open_price is None
            or high_price is None
            or low_price is None
            or close_price is None
            or open_price <= 0
            or high_price <= 0
            or low_price <= 0
            or close_price <= 0
            or base_volume < 0
            or quote_volume < 0
        ):
            continue
        items.append(
            {
                "open_time": open_time,
                "close_time": open_time + interval_ms,
                "open": _decimal_to_str(open_price),
                "high": _decimal_to_str(high_price),
                "low": _decimal_to_str(low_price),
                "close": _decimal_to_str(close_price),
                "volume": _decimal_to_str(base_volume),
                "quote_volume": _decimal_to_str(quote_volume),
                "source": SPOT_PROVIDER_WS_SOURCE,
                "freshness": "LIVE",
                "provider": PROVIDER_BITGET_SPOT,
            }
        )

    if not items:
        return None
    items.sort(key=lambda item: int(item["open_time"]))
    now_ms = _now_ms()
    limit = _kline_limit(kline_limit)
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_BITGET_SPOT,
        "provider_symbol": normalize_spot_ws_symbol(provider_symbol),
        "interval": normalized_interval,
        "source": SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "items": items[-limit:],
        "ts": int(items[-1].get("open_time") or now_ms),
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
    }


def normalize_okx_kline_message(
    message: dict[str, Any],
    *,
    local_symbol: str,
    provider_symbol: str,
    interval: str,
    kline_limit: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    if not isinstance(message, dict) or message.get("event"):
        return None
    normalized_interval = normalize_spot_ws_kline_interval(interval)
    data = message.get("data")
    if not isinstance(data, list) or not data:
        return None

    items: list[dict[str, Any]] = []
    interval_ms = SPOT_KLINE_INTERVAL_MS[normalized_interval]
    for row in data:
        if not isinstance(row, list) or len(row) < 5:
            continue
        try:
            open_time = int(row[0])
        except Exception:
            continue
        open_price = _to_decimal(row[1])
        high_price = _to_decimal(row[2])
        low_price = _to_decimal(row[3])
        close_price = _to_decimal(row[4])
        base_volume = _to_decimal(row[5] if len(row) > 5 else None) or Decimal("0")
        quote_volume = _to_decimal(row[7] if len(row) > 7 else None) or Decimal("0")
        confirm_raw = str(row[8]) if len(row) > 8 else ""
        if (
            open_time <= 0
            or open_price is None
            or high_price is None
            or low_price is None
            or close_price is None
            or open_price <= 0
            or high_price <= 0
            or low_price <= 0
            or close_price <= 0
            or base_volume < 0
            or quote_volume < 0
        ):
            continue
        items.append(
            {
                "open_time": open_time,
                "open_time_ms": open_time,
                "close_time": open_time + interval_ms,
                "open": _decimal_to_str(open_price),
                "high": _decimal_to_str(high_price),
                "low": _decimal_to_str(low_price),
                "close": _decimal_to_str(close_price),
                "volume": _decimal_to_str(base_volume),
                "quote_volume": _decimal_to_str(quote_volume),
                "confirm": confirm_raw,
                "is_closed": confirm_raw == "1",
                "source": SPOT_PROVIDER_WS_SOURCE,
                "freshness": "LIVE",
                "provider": PROVIDER_OKX_SPOT,
            }
        )

    if not items:
        return None
    items.sort(key=lambda item: int(item["open_time"]))
    now_ms = _now_ms()
    limit = _kline_limit(kline_limit)
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_OKX_SPOT,
        "provider_symbol": str(provider_symbol or "").strip().upper(),
        "interval": normalized_interval,
        "source": SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "items": items[-limit:],
        "ts": int(items[-1].get("open_time") or now_ms),
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
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
        ts = _spot_provider_ts(row.get("ts"))
        trades.append(
            {
                "id": str(row.get("tradeId") or ""),
                "trade_id": str(row.get("tradeId") or ""),
                "provider_trade_id": str(row.get("tradeId") or ""),
                "price": _decimal_to_str(price),
                "amount": _decimal_to_str(amount),
                "side": "SELL" if side_text == "SELL" else "BUY",
                "ts": ts,
                "created_at": datetime.utcfromtimestamp(ts / 1000).isoformat(),
                "raw_trade": deepcopy(row),
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


def normalize_okx_trade_message(
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
        price = _to_decimal(row.get("px"))
        amount = _to_decimal(row.get("sz"))
        if price is None or amount is None or price <= 0 or amount <= 0:
            continue
        side_text = str(row.get("side") or "").upper()
        trade_id = str(row.get("tradeId") or "").strip()
        ts = _spot_provider_ts(row.get("ts"))
        trades.append(
            {
                "id": trade_id,
                "trade_id": trade_id,
                "provider_trade_id": trade_id,
                "price": _decimal_to_str(price),
                "amount": _decimal_to_str(amount),
                "side": "SELL" if side_text == "SELL" else "BUY",
                "ts": ts,
                "created_at": datetime.utcfromtimestamp(ts / 1000).isoformat(),
                "raw_trade": deepcopy(row),
            }
        )

    if not trades:
        return None
    trade_limit = _trades_limit(trades_limit)
    trades.sort(key=lambda item: int(item.get("ts") or 0), reverse=True)
    now_ms = _now_ms()
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_OKX_SPOT,
        "provider_symbol": str(provider_symbol or "").strip().upper(),
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
    change_ratio = _bitget_change_ratio(row)
    open_24h = _bitget_open_24h(row, last_price, change_ratio)
    high_24h = _to_decimal(row.get("high24h")) or last_price
    low_24h = _to_decimal(row.get("low24h")) or last_price
    base_volume = _to_decimal(row.get("baseVolume") or row.get("baseVol")) or Decimal("0")
    quote_volume = (
        _to_decimal(row.get("quoteVolume") or row.get("quoteVol") or row.get("usdtVolume"))
        or Decimal("0")
    )
    if quote_volume <= 0 and base_volume > 0:
        quote_volume = base_volume * last_price
    price_change_24h = _bitget_price_change_24h(
        last_price=last_price,
        open_24h=open_24h,
        change_ratio=change_ratio,
    )
    price_change_percent = _bitget_price_change_percent(open_24h, price_change_24h, change_ratio)

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


def normalize_okx_ticker_message(
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

    last_price = _to_decimal(row.get("last"))
    if last_price is None or last_price <= 0:
        return None
    open_24h = _to_decimal(row.get("open24h")) or last_price
    if open_24h <= 0:
        open_24h = last_price
    high_24h = _to_decimal(row.get("high24h")) or last_price
    low_24h = _to_decimal(row.get("low24h")) or last_price
    base_volume = _to_decimal(row.get("vol24h")) or Decimal("0")
    quote_volume = _to_decimal(row.get("volCcy24h")) or Decimal("0")
    if quote_volume <= 0 and base_volume > 0:
        quote_volume = base_volume * last_price
    price_change_24h = last_price - open_24h if open_24h > 0 else Decimal("0")
    price_change_percent = (
        (price_change_24h / open_24h) * Decimal("100")
        if open_24h > 0
        else Decimal("0")
    )
    bid_price = _to_decimal(row.get("bidPx"))
    ask_price = _to_decimal(row.get("askPx"))
    bid_amount = _to_decimal(row.get("bidSz"))
    ask_amount = _to_decimal(row.get("askSz"))
    last_amount = _to_decimal(row.get("lastSz"))

    now_ms = _now_ms()
    exchange_ts = _spot_provider_ts(row.get("ts"))
    record = {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_OKX_SPOT,
        "provider_symbol": str(provider_symbol or "").strip().upper(),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "last_price": _decimal_to_str(last_price),
        "price": _decimal_to_str(last_price),
        "display_price": _decimal_to_str(last_price),
        "open_24h": _decimal_to_str(open_24h),
        "price_change_24h": _decimal_to_str(price_change_24h),
        "price_change_percent": _decimal_to_str(price_change_percent),
        "price_change_percent_24h": _decimal_to_str(price_change_percent),
        "high_24h": _decimal_to_str(high_24h),
        "low_24h": _decimal_to_str(low_24h),
        "base_volume_24h": _decimal_to_str(base_volume),
        "volume_24h": _decimal_to_str(base_volume),
        "quote_volume_24h": _decimal_to_str(quote_volume),
        "quote_source": SPOT_PROVIDER_WS_SOURCE,
        "quote_freshness": "LIVE",
        "freshness": "LIVE",
        "stale": False,
        "market_status": "OPEN",
        "ts": exchange_ts,
        "updated_at_ms": now_ms,
        "updated_at": datetime.utcfromtimestamp(now_ms / 1000).isoformat(),
    }
    if bid_price is not None and bid_price > 0:
        record["bid_price"] = _decimal_to_str(bid_price)
    if ask_price is not None and ask_price > 0:
        record["ask_price"] = _decimal_to_str(ask_price)
    if bid_amount is not None and bid_amount >= 0:
        record["bid_amount"] = _decimal_to_str(bid_amount)
    if ask_amount is not None and ask_amount >= 0:
        record["ask_amount"] = _decimal_to_str(ask_amount)
    if last_amount is not None and last_amount >= 0:
        record["last_amount"] = _decimal_to_str(last_amount)
    return record


class SpotMarketProviderWsService:
    def __init__(self) -> None:
        self._depth_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._ticker_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._trades_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._kline_cache: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._depth_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._ticker_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._trades_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._kline_tasks: dict[tuple[str, str, str], threading.Thread] = {}
        self._depth_stops: dict[tuple[str, str], threading.Event] = {}
        self._ticker_stops: dict[tuple[str, str], threading.Event] = {}
        self._trades_stops: dict[tuple[str, str], threading.Event] = {}
        self._kline_stops: dict[tuple[str, str, str], threading.Event] = {}
        self._depth_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._ticker_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._trades_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._kline_connections: dict[tuple[str, str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._depth_generations: dict[tuple[str, str], int] = {}
        self._ticker_generations: dict[tuple[str, str], int] = {}
        self._trades_generations: dict[tuple[str, str], int] = {}
        self._kline_generations: dict[tuple[str, str, str], int] = {}
        self._task_started_at_ms: dict[tuple[str, str, str, str], int] = {}
        self._task_stopped_at_ms: dict[tuple[str, str, str, str], int] = {}
        self._task_start_counts: dict[tuple[str, str, str, str], int] = {}
        self._task_stop_counts: dict[tuple[str, str, str, str], int] = {}
        self._task_reconnect_counts: dict[tuple[str, str, str, str], int] = {}
        self._lock = threading.RLock()

    def get_fresh_depth(
        self,
        symbol: str,
        *,
        provider: Optional[str] = None,
        max_age_ms: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[DepthResponse]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="depth"):
            return None
        now_ms = _now_ms()
        allowed_age_ms = _max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._depth_cache.items()
                if provider == provider_code and local_symbol == normalized_symbol
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                if not is_fresh_record(item, allowed_age_ms, now_ms=now_ms):
                    continue
                return _depth_response_from_record(deepcopy(item), limit=limit)
        return None

    def get_fresh_ticker(
        self,
        symbol: str,
        *,
        provider: Optional[str] = None,
        max_age_ms: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="ticker"):
            return None
        now_ms = _now_ms()
        allowed_age_ms = _ticker_max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._ticker_cache.items()
                if provider == provider_code and local_symbol == normalized_symbol
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                if not is_fresh_record(item, allowed_age_ms, now_ms=now_ms):
                    continue
                return deepcopy(item)
        return None

    def get_fresh_trades(
        self,
        symbol: str,
        *,
        provider: Optional[str] = None,
        max_age_ms: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[TradesResponse]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="trades"):
            return None
        now_ms = _now_ms()
        allowed_age_ms = _trades_max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._trades_cache.items()
                if provider == provider_code and local_symbol == normalized_symbol
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                if not is_fresh_record(item, allowed_age_ms, now_ms=now_ms):
                    continue
                return _trades_response_from_record(deepcopy(item), limit=limit)
        return None

    def get_fresh_klines(
        self,
        symbol: str,
        interval: str,
        *,
        provider: Optional[str] = None,
        max_age_ms: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        normalized_interval = normalize_spot_ws_kline_interval(interval)
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="kline"):
            return None
        now_ms = _now_ms()
        allowed_age_ms = _kline_max_age_ms(max_age_ms)
        key = (provider_code, normalized_symbol, normalized_interval)
        with self._lock:
            item = self._kline_cache.get(key)
            if item is None:
                return None
            if not is_fresh_record(item, allowed_age_ms, now_ms=now_ms):
                return None
            response = _klines_response_from_record(deepcopy(item), limit=limit)
            if not response.get("items"):
                return None
            return response

    def set_depth_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        provider_code = normalize_spot_ws_provider(payload.get("provider"))
        payload.setdefault("provider", provider_code)
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        with self._lock:
            self._depth_cache[(provider_code, normalized_symbol)] = payload

    def set_ticker_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        provider_code = normalize_spot_ws_provider(payload.get("provider"))
        payload.setdefault("provider", provider_code)
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("quote_freshness", "LIVE")
        payload.setdefault("stale", False)
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        with self._lock:
            self._ticker_cache[(provider_code, normalized_symbol)] = payload

    def set_trades_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        provider_code = normalize_spot_ws_provider(payload.get("provider"))
        payload.setdefault("provider", provider_code)
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("freshness", "LIVE")
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        payload["trades"] = list(payload.get("trades") or [])[:_trades_limit()]
        with self._lock:
            self._trades_cache[(provider_code, normalized_symbol)] = payload

    def set_kline_cache_for_tests(self, record: dict[str, Any]) -> None:
        normalized_symbol = normalize_spot_ws_symbol(record.get("symbol"))
        normalized_interval = normalize_spot_ws_kline_interval(record.get("interval"))
        if not normalized_symbol:
            return
        payload = deepcopy(record)
        payload["symbol"] = normalized_symbol
        payload["interval"] = normalized_interval
        provider_code = normalize_spot_ws_provider(payload.get("provider"))
        payload["provider"] = provider_code
        payload.setdefault("source", SPOT_PROVIDER_WS_SOURCE)
        payload.setdefault("freshness", "LIVE")
        payload.setdefault("updated_at_ms", _now_ms())
        payload.setdefault("ts", payload["updated_at_ms"])
        payload.setdefault("updated_at", datetime.utcfromtimestamp(int(payload["updated_at_ms"]) / 1000).isoformat())
        payload["items"] = list(payload.get("items") or [])[-_kline_limit():]
        with self._lock:
            self._kline_cache[(provider_code, normalized_symbol, normalized_interval)] = payload

    def clear_for_tests(self) -> None:
        with self._lock:
            self._depth_cache.clear()
            self._ticker_cache.clear()
            self._trades_cache.clear()
            self._kline_cache.clear()
            self._depth_tasks.clear()
            self._ticker_tasks.clear()
            self._trades_tasks.clear()
            self._kline_tasks.clear()
            self._depth_stops.clear()
            self._ticker_stops.clear()
            self._trades_stops.clear()
            self._kline_stops.clear()
            self._depth_connections.clear()
            self._ticker_connections.clear()
            self._trades_connections.clear()
            self._kline_connections.clear()
            self._depth_generations.clear()
            self._ticker_generations.clear()
            self._trades_generations.clear()
            self._kline_generations.clear()
            self._task_started_at_ms.clear()
            self._task_stopped_at_ms.clear()
            self._task_start_counts.clear()
            self._task_stop_counts.clear()
            self._task_reconnect_counts.clear()

    def get_metrics_snapshot(self) -> dict[str, Any]:
        now_ms = _now_ms()
        with self._lock:
            active_provider_tasks = []
            for key, task in self._depth_tasks.items():
                provider, symbol = key
                active_provider_tasks.append(
                    self._provider_task_snapshot_locked(
                        domain="depth",
                        provider=provider,
                        symbol=symbol,
                        interval=None,
                        task=task,
                        stop_event=self._depth_stops.get(key),
                        connected=key in self._depth_connections,
                    )
                )
            for key, task in self._ticker_tasks.items():
                provider, symbol = key
                active_provider_tasks.append(
                    self._provider_task_snapshot_locked(
                        domain="ticker",
                        provider=provider,
                        symbol=symbol,
                        interval=None,
                        task=task,
                        stop_event=self._ticker_stops.get(key),
                        connected=key in self._ticker_connections,
                    )
                )
            for key, task in self._trades_tasks.items():
                provider, symbol = key
                active_provider_tasks.append(
                    self._provider_task_snapshot_locked(
                        domain="trades",
                        provider=provider,
                        symbol=symbol,
                        interval=None,
                        task=task,
                        stop_event=self._trades_stops.get(key),
                        connected=key in self._trades_connections,
                    )
                )
            for key, task in self._kline_tasks.items():
                provider, symbol, interval = key
                active_provider_tasks.append(
                    self._provider_task_snapshot_locked(
                        domain="kline",
                        provider=provider,
                        symbol=symbol,
                        interval=interval,
                        task=task,
                        stop_event=self._kline_stops.get(key),
                        connected=key in self._kline_connections,
                    )
                )

            active_kline_intervals = [
                {
                    "provider": provider,
                    "symbol": symbol,
                    "interval": interval,
                }
                for provider, symbol, interval in sorted(self._kline_tasks.keys())
            ]
            cache_records = {
                "depth": [
                    self._cache_record_snapshot_locked("depth", key, record, now_ms)
                    for key, record in sorted(self._depth_cache.items())
                ],
                "ticker": [
                    self._cache_record_snapshot_locked("ticker", key, record, now_ms)
                    for key, record in sorted(self._ticker_cache.items())
                ],
                "trades": [
                    self._cache_record_snapshot_locked("trades", key, record, now_ms)
                    for key, record in sorted(self._trades_cache.items())
                ],
                "kline": [
                    self._cache_record_snapshot_locked("kline", key, record, now_ms)
                    for key, record in sorted(self._kline_cache.items())
                ],
            }

        return {
            "active_provider_task_count": len(active_provider_tasks),
            "active_provider_tasks": active_provider_tasks,
            "active_kline_intervals": active_kline_intervals,
            "cache_records": cache_records,
        }

    def _provider_metric_key(
        self,
        domain: str,
        provider: str,
        symbol: str,
        interval: Optional[str] = None,
    ) -> tuple[str, str, str, str]:
        return (domain, provider, symbol, interval or "")

    def _remember_provider_task_started_locked(
        self,
        domain: str,
        provider: str,
        symbol: str,
        interval: Optional[str] = None,
    ) -> None:
        metric_key = self._provider_metric_key(domain, provider, symbol, interval)
        self._task_started_at_ms[metric_key] = _now_ms()
        self._task_start_counts[metric_key] = int(self._task_start_counts.get(metric_key) or 0) + 1

    def _remember_provider_task_stopped_locked(
        self,
        domain: str,
        provider: str,
        symbol: str,
        interval: Optional[str] = None,
    ) -> None:
        metric_key = self._provider_metric_key(domain, provider, symbol, interval)
        self._task_stopped_at_ms[metric_key] = _now_ms()
        self._task_stop_counts[metric_key] = int(self._task_stop_counts.get(metric_key) or 0) + 1

    def _remember_provider_task_reconnect(
        self,
        domain: str,
        provider: str,
        symbol: str,
        interval: Optional[str] = None,
    ) -> None:
        metric_key = self._provider_metric_key(domain, provider, symbol, interval)
        with self._lock:
            self._task_reconnect_counts[metric_key] = int(self._task_reconnect_counts.get(metric_key) or 0) + 1

    def _provider_task_snapshot_locked(
        self,
        *,
        domain: str,
        provider: str,
        symbol: str,
        interval: Optional[str],
        task: threading.Thread,
        stop_event: Optional[threading.Event],
        connected: bool,
    ) -> dict[str, Any]:
        metric_key = self._provider_metric_key(domain, provider, symbol, interval)
        return {
            "domain": domain,
            "provider": provider,
            "symbol": symbol,
            "interval": interval,
            "thread_alive": task.is_alive(),
            "stop_requested": bool(stop_event.is_set()) if stop_event is not None else True,
            "connected": connected,
            "last_start_at_ms": self._task_started_at_ms.get(metric_key),
            "last_stop_at_ms": self._task_stopped_at_ms.get(metric_key),
            "start_count": int(self._task_start_counts.get(metric_key) or 0),
            "stop_count": int(self._task_stop_counts.get(metric_key) or 0),
            "reconnect_count": int(self._task_reconnect_counts.get(metric_key) or 0),
        }

    def _cache_record_snapshot_locked(
        self,
        domain: str,
        key: tuple[str, ...],
        record: dict[str, Any],
        now_ms: int,
    ) -> dict[str, Any]:
        updated_at_ms = int(record.get("updated_at_ms") or record.get("ts") or 0)
        payload: dict[str, Any] = {
            "domain": domain,
            "provider": key[0] if len(key) > 0 else None,
            "symbol": key[1] if len(key) > 1 else None,
            "interval": key[2] if len(key) > 2 else None,
            "updated_at_ms": updated_at_ms or None,
            "age_ms": max(0, now_ms - updated_at_ms) if updated_at_ms > 0 else None,
            "freshness": record.get("freshness") or record.get("quote_freshness"),
            "source": record.get("source"),
        }
        if domain == "depth":
            payload["bid_count"] = len(record.get("bids") or [])
            payload["ask_count"] = len(record.get("asks") or [])
        elif domain == "trades":
            payload["trade_count"] = len(record.get("trades") or [])
        elif domain == "kline":
            payload["bars_count"] = len(record.get("items") or [])
        return payload

    def ensure_symbol(self, symbol: str, *, provider: Optional[str] = None) -> None:
        local_symbol = normalize_spot_ws_symbol(symbol)
        provider_code = normalize_spot_ws_provider(provider)
        if not local_symbol or not spot_provider_ws_supports_provider(provider_code):
            return
        if spot_provider_ws_supports_provider(provider_code, domain="depth"):
            self._ensure_depth_symbol(local_symbol, provider=provider_code)
        if spot_provider_ws_supports_provider(provider_code, domain="ticker"):
            self._ensure_ticker_symbol(local_symbol, provider=provider_code)
        if spot_provider_ws_supports_provider(provider_code, domain="trades"):
            self._ensure_trades_symbol(local_symbol, provider=provider_code)

    def ensure_kline(self, symbol: str, interval: str, *, provider: Optional[str] = None) -> None:
        local_symbol = normalize_spot_ws_symbol(symbol)
        normalized_interval = normalize_spot_ws_kline_interval(interval)
        provider_code = normalize_spot_ws_provider(provider)
        if not local_symbol or not spot_provider_ws_supports_provider(provider_code, domain="kline"):
            return
        self._ensure_kline_symbol(local_symbol, normalized_interval, provider=provider_code)

    def _ensure_depth_symbol(self, local_symbol: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="depth"):
            return
        provider_symbol = okx_spot_ws_symbol(local_symbol) if provider_code == PROVIDER_OKX_SPOT else local_symbol
        key = (provider_code, local_symbol)
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
                provider=provider_code,
                provider_symbol=provider_symbol,
                depth_limit=_depth_limit(),
                channel=OKX_SPOT_DEPTH_CHANNEL if provider_code == PROVIDER_OKX_SPOT else BITGET_SPOT_DEPTH_CHANNEL,
                ws_url=str(
                    getattr(
                        settings,
                        "SPOT_PROVIDER_WS_OKX_PUBLIC_URL"
                        if provider_code == PROVIDER_OKX_SPOT
                        else "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL",
                        "",
                    )
                    or ""
                ).strip(),
            )
            thread = threading.Thread(
                target=self._run_depth_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-depth-ws-{provider_code}-{local_symbol}",
                daemon=True,
            )
            self._depth_tasks[key] = thread
            self._remember_provider_task_started_locked("depth", provider_code, local_symbol)
            thread.start()

    def _ensure_ticker_symbol(self, local_symbol: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="ticker"):
            return
        provider_symbol = okx_spot_ws_symbol(local_symbol) if provider_code == PROVIDER_OKX_SPOT else local_symbol
        key = (provider_code, local_symbol)
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
                provider=provider_code,
                provider_symbol=provider_symbol,
                channel=OKX_SPOT_TICKER_CHANNEL if provider_code == PROVIDER_OKX_SPOT else BITGET_SPOT_TICKER_CHANNEL,
                ws_url=str(
                    getattr(
                        settings,
                        "SPOT_PROVIDER_WS_OKX_PUBLIC_URL"
                        if provider_code == PROVIDER_OKX_SPOT
                        else "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL",
                        "",
                    )
                    or ""
                ).strip(),
            )
            thread = threading.Thread(
                target=self._run_ticker_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-ticker-ws-{provider_code}-{local_symbol}",
                daemon=True,
            )
            self._ticker_tasks[key] = thread
            self._remember_provider_task_started_locked("ticker", provider_code, local_symbol)
            thread.start()

    def _ensure_trades_symbol(self, local_symbol: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="trades"):
            return
        provider_symbol = okx_spot_ws_symbol(local_symbol) if provider_code == PROVIDER_OKX_SPOT else local_symbol
        key = (provider_code, local_symbol)
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
                provider=provider_code,
                provider_symbol=provider_symbol,
                trades_limit=_trades_limit(),
                channel=OKX_SPOT_TRADES_CHANNEL if provider_code == PROVIDER_OKX_SPOT else BITGET_SPOT_TRADES_CHANNEL,
                ws_url=str(
                    getattr(
                        settings,
                        "SPOT_PROVIDER_WS_OKX_PUBLIC_URL"
                        if provider_code == PROVIDER_OKX_SPOT
                        else "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL",
                        "",
                    )
                    or ""
                ).strip(),
            )
            thread = threading.Thread(
                target=self._run_trades_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-trades-ws-{provider_code}-{local_symbol}",
                daemon=True,
            )
            self._trades_tasks[key] = thread
            self._remember_provider_task_started_locked("trades", provider_code, local_symbol)
            thread.start()

    def _ensure_kline_symbol(self, local_symbol: str, interval: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        if not spot_provider_ws_supports_provider(provider_code, domain="kline"):
            return
        provider_symbol = okx_spot_ws_symbol(local_symbol) if provider_code == PROVIDER_OKX_SPOT else local_symbol
        normalized_interval = normalize_spot_ws_kline_interval(interval)
        key = (provider_code, local_symbol, normalized_interval)
        with self._lock:
            task = self._kline_tasks.get(key)
            if task is not None and task.is_alive():
                return
            generation = self._kline_generations.get(key, 0) + 1
            self._kline_generations[key] = generation
            stop_event = threading.Event()
            self._kline_stops[key] = stop_event
            subscription = SpotKlineSubscription(
                local_symbol=local_symbol,
                provider=provider_code,
                provider_symbol=provider_symbol,
                interval=normalized_interval,
                channel=okx_spot_kline_channel(normalized_interval)
                if provider_code == PROVIDER_OKX_SPOT
                else bitget_spot_kline_channel(normalized_interval),
                kline_limit=_kline_limit(),
                ws_url=str(
                    getattr(
                        settings,
                        "SPOT_PROVIDER_WS_OKX_BUSINESS_URL"
                        if provider_code == PROVIDER_OKX_SPOT
                        else "SPOT_PROVIDER_WS_BITGET_PUBLIC_URL",
                        "",
                    )
                    or ""
                ).strip(),
            )
            thread = threading.Thread(
                target=self._run_kline_thread,
                args=(subscription, stop_event, generation),
                name=f"spot-kline-ws-{provider_code}-{local_symbol}-{normalized_interval}",
                daemon=True,
            )
            self._kline_tasks[key] = thread
            self._remember_provider_task_started_locked(
                "kline",
                provider_code,
                local_symbol,
                normalized_interval,
            )
            thread.start()

    def release_symbol(self, symbol: str, *, provider: Optional[str] = None) -> None:
        local_symbol = normalize_spot_ws_symbol(symbol)
        provider_code = normalize_spot_ws_provider(provider)
        if not local_symbol or not spot_provider_ws_supports_provider(provider_code):
            return
        if spot_provider_ws_supports_provider(provider_code, domain="depth"):
            self._stop_depth_subscription(local_symbol, provider=provider_code)
        if spot_provider_ws_supports_provider(provider_code, domain="ticker"):
            self._stop_ticker_subscription(local_symbol, provider=provider_code)
        if spot_provider_ws_supports_provider(provider_code, domain="trades"):
            self._stop_trades_subscription(local_symbol, provider=provider_code)
        if spot_provider_ws_supports_provider(provider_code, domain="kline"):
            self._stop_kline_subscriptions(local_symbol, provider=provider_code)

    def release_kline(self, symbol: str, interval: str, *, provider: Optional[str] = None) -> None:
        local_symbol = normalize_spot_ws_symbol(symbol)
        provider_code = normalize_spot_ws_provider(provider)
        if not local_symbol or not spot_provider_ws_supports_provider(provider_code, domain="kline"):
            return
        self._stop_kline_subscription(
            local_symbol,
            normalize_spot_ws_kline_interval(interval),
            provider=provider_code,
        )

    def _stop_depth_subscription(self, local_symbol: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        key = (provider_code, local_symbol)
        with self._lock:
            stop_event = self._depth_stops.pop(key, None)
            task = self._depth_tasks.pop(key, None)
            connection = self._depth_connections.pop(key, None)
            self._depth_generations[key] = self._depth_generations.get(key, 0) + 1
            if stop_event is not None or task is not None or connection is not None:
                self._remember_provider_task_stopped_locked("depth", provider_code, local_symbol)
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

    def _stop_trades_subscription(self, local_symbol: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        key = (provider_code, local_symbol)
        with self._lock:
            stop_event = self._trades_stops.pop(key, None)
            task = self._trades_tasks.pop(key, None)
            connection = self._trades_connections.pop(key, None)
            self._trades_generations[key] = self._trades_generations.get(key, 0) + 1
            if stop_event is not None or task is not None or connection is not None:
                self._remember_provider_task_stopped_locked("trades", provider_code, local_symbol)
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

    def _stop_ticker_subscription(self, local_symbol: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        key = (provider_code, local_symbol)
        with self._lock:
            stop_event = self._ticker_stops.pop(key, None)
            task = self._ticker_tasks.pop(key, None)
            connection = self._ticker_connections.pop(key, None)
            self._ticker_generations[key] = self._ticker_generations.get(key, 0) + 1
            if stop_event is not None or task is not None or connection is not None:
                self._remember_provider_task_stopped_locked("ticker", provider_code, local_symbol)
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

    def _stop_kline_subscriptions(self, local_symbol: str, *, provider: Optional[str] = None) -> None:
        provider_code = normalize_spot_ws_provider(provider)
        with self._lock:
            intervals = [
                interval
                for provider, symbol, interval in self._kline_tasks.keys()
                if provider == provider_code and symbol == local_symbol
            ]
        for interval in intervals:
            self._stop_kline_subscription(local_symbol, interval, provider=provider_code)

    def _stop_kline_subscription(self, local_symbol: str, interval: str, *, provider: Optional[str] = None) -> None:
        normalized_interval = normalize_spot_ws_kline_interval(interval)
        provider_code = normalize_spot_ws_provider(provider)
        key = (provider_code, local_symbol, normalized_interval)
        with self._lock:
            stop_event = self._kline_stops.pop(key, None)
            task = self._kline_tasks.pop(key, None)
            connection = self._kline_connections.pop(key, None)
            self._kline_generations[key] = self._kline_generations.get(key, 0) + 1
            if stop_event is not None or task is not None or connection is not None:
                self._remember_provider_task_stopped_locked(
                    "kline",
                    provider_code,
                    local_symbol,
                    normalized_interval,
                )
        if stop_event is not None:
            stop_event.set()
        if connection is not None:
            loop, websocket = connection
            if not loop.is_closed():
                try:
                    asyncio.run_coroutine_threadsafe(websocket.close(), loop)
                except Exception:
                    logger.debug(
                        "spot_provider_ws_kline_close_failed symbol=%s interval=%s",
                        local_symbol,
                        normalized_interval,
                        exc_info=True,
                    )
        if task is not None and task.is_alive() and task is not threading.current_thread():
            task.join(timeout=2.0)

    def _merge_provider_kline_record_locked(
        self,
        key: tuple[str, str, str],
        record: dict[str, Any],
        limit: int,
    ) -> dict[str, Any]:
        existing = self._kline_cache.get(key) or {}
        by_open_time: dict[int, dict[str, Any]] = {}
        for item in list(existing.get("items") or []):
            try:
                open_time = int(item.get("open_time") or 0)
            except Exception:
                continue
            if open_time > 0:
                by_open_time[open_time] = item
        for item in list(record.get("items") or []):
            try:
                open_time = int(item.get("open_time") or 0)
            except Exception:
                continue
            if open_time <= 0:
                continue
            by_open_time[open_time] = deepcopy(item)
        record["items"] = [
            by_open_time[open_time]
            for open_time in sorted(by_open_time.keys())[-limit:]
        ]
        return record

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

    def _run_kline_thread(
        self,
        subscription: SpotKlineSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._kline_loop(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "spot_provider_ws_kline_thread_failed provider=%s symbol=%s interval=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.interval,
                exc_info=True,
            )

    async def _depth_loop(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set():
            try:
                if subscription.provider == PROVIDER_OKX_SPOT:
                    await self._run_okx_depth_ws(subscription, stop_event, generation)
                else:
                    await self._run_bitget_depth_ws(subscription, stop_event, generation)
            except Exception as exc:
                if _is_provider_ws_shutdown_noise(exc, stop_event):
                    return
                if stop_event.is_set():
                    return
                self._remember_provider_task_reconnect("depth", subscription.provider, subscription.local_symbol)
                retry_in = 1.0
                if _is_provider_ws_recoverable_disconnect(exc):
                    _log_provider_ws_disconnected("depth", subscription, exc, retry_in=retry_in)
                else:
                    logger.warning(
                        "spot_provider_ws_depth_failed provider=%s symbol=%s provider_symbol=%s",
                        subscription.provider,
                        subscription.local_symbol,
                        subscription.provider_symbol,
                        exc_info=True,
                    )
                await asyncio.sleep(retry_in)

    async def _ticker_loop(
        self,
        subscription: SpotTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set():
            try:
                if subscription.provider == PROVIDER_OKX_SPOT:
                    await self._run_okx_ticker_ws(subscription, stop_event, generation)
                else:
                    await self._run_bitget_ticker_ws(subscription, stop_event, generation)
            except Exception as exc:
                if _is_provider_ws_shutdown_noise(exc, stop_event):
                    return
                if stop_event.is_set():
                    return
                self._remember_provider_task_reconnect("ticker", subscription.provider, subscription.local_symbol)
                retry_in = 1.0
                if _is_provider_ws_recoverable_disconnect(exc):
                    _log_provider_ws_disconnected("ticker", subscription, exc, retry_in=retry_in)
                else:
                    logger.warning(
                        "spot_provider_ws_ticker_failed provider=%s symbol=%s provider_symbol=%s",
                        subscription.provider,
                        subscription.local_symbol,
                        subscription.provider_symbol,
                        exc_info=True,
                    )
                await asyncio.sleep(retry_in)

    async def _trades_loop(
        self,
        subscription: SpotTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set():
            try:
                if subscription.provider == PROVIDER_OKX_SPOT:
                    await self._run_okx_trades_ws(subscription, stop_event, generation)
                else:
                    await self._run_bitget_trades_ws(subscription, stop_event, generation)
            except Exception as exc:
                if _is_provider_ws_shutdown_noise(exc, stop_event):
                    return
                if stop_event.is_set():
                    return
                self._remember_provider_task_reconnect("trades", subscription.provider, subscription.local_symbol)
                retry_in = 1.0
                if _is_provider_ws_recoverable_disconnect(exc):
                    _log_provider_ws_disconnected("trades", subscription, exc, retry_in=retry_in)
                else:
                    logger.warning(
                        "spot_provider_ws_trades_failed provider=%s symbol=%s provider_symbol=%s",
                        subscription.provider,
                        subscription.local_symbol,
                        subscription.provider_symbol,
                        exc_info=True,
                    )
                await asyncio.sleep(retry_in)

    async def _kline_loop(
        self,
        subscription: SpotKlineSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        while not stop_event.is_set():
            try:
                if subscription.provider == PROVIDER_OKX_SPOT:
                    await self._run_okx_kline_ws(subscription, stop_event, generation)
                else:
                    await self._run_bitget_kline_ws(subscription, stop_event, generation)
            except Exception as exc:
                if _is_provider_ws_shutdown_noise(exc, stop_event):
                    return
                if stop_event.is_set():
                    return
                self._remember_provider_task_reconnect(
                    "kline",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.interval,
                )
                retry_in = 1.0
                if _is_provider_ws_recoverable_disconnect(exc):
                    _log_provider_ws_disconnected("kline", subscription, exc, retry_in=retry_in)
                else:
                    logger.warning(
                        "spot_provider_ws_kline_failed provider=%s symbol=%s provider_symbol=%s interval=%s",
                        subscription.provider,
                        subscription.local_symbol,
                        subscription.provider_symbol,
                        subscription.interval,
                        exc_info=True,
                    )
                await asyncio.sleep(retry_in)

    async def _run_bitget_depth_ws(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set():
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
            if stop_event.is_set():
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
                while not stop_event.is_set():
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

    async def _run_okx_depth_ws(
        self,
        subscription: SpotDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_OKX_PUBLIC_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set():
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
                while not stop_event.is_set():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_okx_depth_message(subscription, raw_message, generation)
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
        if stop_event.is_set():
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
            if stop_event.is_set():
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
                while not stop_event.is_set():
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

    async def _run_okx_ticker_ws(
        self,
        subscription: SpotTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_OKX_PUBLIC_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set():
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
                while not stop_event.is_set():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_okx_ticker_message(subscription, raw_message, generation)
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
        if stop_event.is_set():
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
            if stop_event.is_set():
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
                while not stop_event.is_set():
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

    async def _run_okx_trades_ws(
        self,
        subscription: SpotTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_OKX_PUBLIC_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set():
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
                while not stop_event.is_set():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_okx_trades_message(subscription, raw_message, generation)
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

    async def _run_bitget_kline_ws(
        self,
        subscription: SpotKlineSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set():
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
        key = (subscription.provider, subscription.local_symbol, subscription.interval)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                if self._kline_generations.get(key) != generation:
                    stop_event.set()
                    return
                self._kline_connections[key] = (loop, websocket)
            logger.info(
                "spot_provider_ws_kline_subscription_started provider=%s symbol=%s provider_symbol=%s interval=%s channel=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
                subscription.interval,
                subscription.channel,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                last_ping_at = time.monotonic()
                while not stop_event.is_set():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_bitget_kline_message(subscription, raw_message, generation)
            finally:
                with self._lock:
                    current = self._kline_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._kline_connections.pop(key, None)
                logger.info(
                    "spot_provider_ws_kline_subscription_stopped provider=%s symbol=%s provider_symbol=%s interval=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    subscription.interval,
                )

    async def _run_okx_kline_ws(
        self,
        subscription: SpotKlineSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set():
            return
        url = str(subscription.ws_url or "").strip()
        if not url:
            raise ValueError("SPOT_PROVIDER_WS_OKX_BUSINESS_URL is required")

        subscribe_payload = {
            "op": "subscribe",
            "args": [
                {
                    "channel": subscription.channel,
                    "instId": subscription.provider_symbol,
                }
            ],
        }
        key = (subscription.provider, subscription.local_symbol, subscription.interval)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                if self._kline_generations.get(key) != generation:
                    stop_event.set()
                    return
                self._kline_connections[key] = (loop, websocket)
            logger.info(
                "spot_provider_ws_kline_subscription_started provider=%s symbol=%s provider_symbol=%s interval=%s channel=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
                subscription.interval,
                subscription.channel,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                last_ping_at = time.monotonic()
                while not stop_event.is_set():
                    if time.monotonic() - last_ping_at >= 25:
                        await websocket.send("ping")
                        last_ping_at = time.monotonic()
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if raw_message == "pong":
                        continue
                    self._handle_okx_kline_message(subscription, raw_message, generation)
            finally:
                with self._lock:
                    current = self._kline_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._kline_connections.pop(key, None)
                logger.info(
                    "spot_provider_ws_kline_subscription_stopped provider=%s symbol=%s provider_symbol=%s interval=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    subscription.interval,
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

    def _handle_okx_depth_message(
        self,
        subscription: SpotDepthSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("spot_provider_ws_okx_depth_invalid_json symbol=%s", subscription.local_symbol)
            return
        key = (subscription.provider, subscription.local_symbol)
        with self._lock:
            if self._depth_generations.get(key) != generation:
                return
            previous_record = deepcopy(self._depth_cache.get(key) or {})
        record = normalize_okx_depth_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
            depth_limit=subscription.depth_limit,
            previous_record=previous_record,
        )
        if record is None:
            return
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

    def _handle_okx_ticker_message(
        self,
        subscription: SpotTickerSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("spot_provider_ws_okx_ticker_invalid_json symbol=%s", subscription.local_symbol)
            return
        record = normalize_okx_ticker_message(
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

    def _store_trades_record_locked(
        self,
        subscription: SpotTradesSubscription,
        record: dict[str, Any],
        generation: int,
    ) -> None:
        key = (subscription.provider, subscription.local_symbol)
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
        with self._lock:
            self._store_trades_record_locked(subscription, record, generation)

    def _handle_okx_trades_message(
        self,
        subscription: SpotTradesSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("spot_provider_ws_okx_trades_invalid_json symbol=%s", subscription.local_symbol)
            return
        record = normalize_okx_trade_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
            trades_limit=subscription.trades_limit,
        )
        if record is None:
            return
        with self._lock:
            self._store_trades_record_locked(subscription, record, generation)

    def _handle_bitget_kline_message(
        self,
        subscription: SpotKlineSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug(
                "spot_provider_ws_bitget_kline_invalid_json symbol=%s interval=%s",
                subscription.local_symbol,
                subscription.interval,
            )
            return
        record = normalize_bitget_kline_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
            interval=subscription.interval,
            kline_limit=subscription.kline_limit,
        )
        if record is None:
            return
        key = (subscription.provider, subscription.local_symbol, subscription.interval)
        with self._lock:
            if self._kline_generations.get(key) != generation:
                return
            self._kline_cache[key] = self._merge_provider_kline_record_locked(
                key,
                record,
                subscription.kline_limit,
            )

    def _handle_okx_kline_message(
        self,
        subscription: SpotKlineSubscription,
        raw_message: Any,
        generation: int,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug(
                "spot_provider_ws_okx_kline_invalid_json symbol=%s interval=%s",
                subscription.local_symbol,
                subscription.interval,
            )
            return
        record = normalize_okx_kline_message(
            message,
            local_symbol=subscription.local_symbol,
            provider_symbol=subscription.provider_symbol,
            interval=subscription.interval,
            kline_limit=subscription.kline_limit,
        )
        if record is None:
            return
        key = (subscription.provider, subscription.local_symbol, subscription.interval)
        with self._lock:
            if self._kline_generations.get(key) != generation:
                return
            self._kline_cache[key] = self._merge_provider_kline_record_locked(
                key,
                record,
                subscription.kline_limit,
            )


spot_market_provider_ws = SpotMarketProviderWsService()


def get_spot_provider_ws_depth(
    symbol: str,
    *,
    provider: Optional[str] = None,
    max_age_ms: Optional[int] = None,
    limit: Optional[int] = None,
) -> Optional[DepthResponse]:
    return spot_market_provider_ws.get_fresh_depth(
        symbol,
        provider=provider,
        max_age_ms=max_age_ms,
        limit=limit,
    )


def ensure_spot_provider_ws_depth(symbol: str, *, provider: Optional[str] = None) -> None:
    spot_market_provider_ws.ensure_symbol(symbol, provider=provider)


def release_spot_provider_ws_depth(symbol: str, *, provider: Optional[str] = None) -> None:
    spot_market_provider_ws.release_symbol(symbol, provider=provider)


def get_spot_provider_ws_ticker(
    symbol: str,
    *,
    provider: Optional[str] = None,
    max_age_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    return spot_market_provider_ws.get_fresh_ticker(symbol, provider=provider, max_age_ms=max_age_ms)


def ensure_spot_provider_ws_ticker(symbol: str, *, provider: Optional[str] = None) -> None:
    if spot_provider_ws_supports_provider(provider, domain="ticker"):
        spot_market_provider_ws.ensure_symbol(symbol, provider=provider)


def release_spot_provider_ws_ticker(symbol: str, *, provider: Optional[str] = None) -> None:
    if spot_provider_ws_supports_provider(provider, domain="ticker"):
        spot_market_provider_ws.release_symbol(symbol, provider=provider)


def get_spot_provider_ws_trades(
    symbol: str,
    *,
    provider: Optional[str] = None,
    max_age_ms: Optional[int] = None,
    limit: Optional[int] = None,
) -> Optional[TradesResponse]:
    return spot_market_provider_ws.get_fresh_trades(
        symbol,
        provider=provider,
        max_age_ms=max_age_ms,
        limit=limit,
    )


def ensure_spot_provider_ws_trades(symbol: str, *, provider: Optional[str] = None) -> None:
    if spot_provider_ws_supports_provider(provider, domain="trades"):
        spot_market_provider_ws.ensure_symbol(symbol, provider=provider)


def release_spot_provider_ws_trades(symbol: str, *, provider: Optional[str] = None) -> None:
    if spot_provider_ws_supports_provider(provider, domain="trades"):
        spot_market_provider_ws.release_symbol(symbol, provider=provider)


def get_spot_provider_ws_klines(
    symbol: str,
    interval: str,
    *,
    provider: Optional[str] = None,
    max_age_ms: Optional[int] = None,
    limit: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    return spot_market_provider_ws.get_fresh_klines(
        symbol,
        interval,
        provider=provider,
        max_age_ms=max_age_ms,
        limit=limit,
    )


def ensure_spot_provider_ws_kline(
    symbol: str,
    interval: str = "1m",
    *,
    provider: Optional[str] = None,
) -> None:
    if spot_provider_ws_supports_provider(provider, domain="kline"):
        spot_market_provider_ws.ensure_kline(symbol, interval, provider=provider)


def release_spot_provider_ws_kline(
    symbol: str,
    interval: str = "1m",
    *,
    provider: Optional[str] = None,
) -> None:
    if spot_provider_ws_supports_provider(provider, domain="kline"):
        spot_market_provider_ws.release_kline(symbol, interval, provider=provider)
