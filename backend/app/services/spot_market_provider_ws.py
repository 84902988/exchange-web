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
from types import MappingProxyType
from typing import Any, Mapping, Optional

import websockets

from app.core.config import settings
from app.schemas.market import DepthItem, DepthResponse, TradeItem, TradesResponse
from app.services.contract_market_provider_service import PROVIDER_BITGET_SPOT, PROVIDER_OKX_SPOT
from app.services.spot_kline_bucket import normalize_spot_kline_bucket_interval
from app.services.spot_kline_revision import (
    KlineRevisionCandidate,
    KlineRevisionDecision,
    KlineRevisionReason,
    compare_kline_revision,
)
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
    "1Dutc": "candle1Dutc",
    "1w": "candle1W",
    "1Wutc": "candle1Wutc",
    "1M": "candle1M",
    "1Mutc": "candle1Mutc",
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
SPOT_PROVIDER_WS_KLINE_CHANNELS = {
    PROVIDER_BITGET_SPOT: BITGET_SPOT_KLINE_CHANNELS,
    PROVIDER_OKX_SPOT: OKX_SPOT_KLINE_CHANNELS,
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


def spot_provider_ws_kline_channel(provider: Any, interval: Any) -> Optional[str]:
    provider_code = normalize_spot_ws_provider(provider)
    normalized_interval = normalize_spot_ws_kline_interval(interval)
    return SPOT_PROVIDER_WS_KLINE_CHANNELS.get(provider_code, {}).get(normalized_interval)


def spot_provider_ws_supports_kline_interval(provider: Any, interval: Any) -> bool:
    return spot_provider_ws_kline_channel(provider, interval) is not None


def bitget_spot_kline_channel(interval: Any) -> Optional[str]:
    return spot_provider_ws_kline_channel(PROVIDER_BITGET_SPOT, interval)


def okx_spot_kline_channel(interval: Any) -> Optional[str]:
    return spot_provider_ws_kline_channel(PROVIDER_OKX_SPOT, interval)


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


def _spot_provider_event_time_ms(value: Any) -> Optional[int]:
    try:
        timestamp = int(value or 0)
    except Exception:
        return None
    return timestamp if timestamp > 0 else None


def _trade_value(trade: Any, key: str) -> Any:
    if isinstance(trade, dict):
        return trade.get(key)
    return getattr(trade, key, None)


def _trade_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _trade_nonnegative_time_ms(value: Any) -> Optional[int]:
    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return None
    return timestamp if timestamp >= 0 else None


def spot_trade_event_time_ms(trade: Any) -> Optional[int]:
    return _spot_provider_event_time_ms(_trade_value(trade, "event_time_ms"))


def spot_trade_strong_identity(trade: Any, *, provider: Any = None) -> Optional[str]:
    normalized_provider = _trade_text(_trade_value(trade, "provider")) or _trade_text(provider) or "UNKNOWN"
    normalized_provider = normalized_provider.upper()
    for key in ("provider_trade_id", "trade_id", "id"):
        identity = _trade_text(_trade_value(trade, key))
        if identity is not None:
            return f"provider:{normalized_provider}|trade:{identity}"
    return None


def spot_trade_weak_fingerprint(
    trade: Any,
    *,
    provider: Any = None,
    provider_symbol: Any = None,
) -> str:
    normalized_provider = _trade_text(_trade_value(trade, "provider")) or _trade_text(provider) or "UNKNOWN"
    normalized_provider_symbol = (
        _trade_text(_trade_value(trade, "provider_symbol"))
        or _trade_text(provider_symbol)
        or "UNKNOWN"
    )
    event_time_ms = spot_trade_event_time_ms(trade)
    event_time_token: Any = event_time_ms if event_time_ms is not None else "UNTIMED"
    return "weak:" + repr(
        (
            normalized_provider.upper(),
            normalized_provider_symbol.upper(),
            event_time_token,
            _trade_text(_trade_value(trade, "price")) or "",
            _trade_text(_trade_value(trade, "amount")) or "",
            (_trade_text(_trade_value(trade, "side")) or "").upper(),
        )
    )


def _trade_signature(
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


def _trade_received_at_ms(trade: Any) -> int:
    received_at_ms = _trade_nonnegative_time_ms(_trade_value(trade, "received_at_ms"))
    return received_at_ms if received_at_ms is not None else 0


def _trade_completeness(trade: Any) -> int:
    keys = (
        "provider_trade_id",
        "trade_id",
        "id",
        "event_time_ms",
        "received_at_ms",
        "time_origin",
        "created_at",
        "provider",
        "provider_symbol",
        "source",
        "freshness",
        "price",
        "amount",
        "side",
    )
    return sum(_trade_text(_trade_value(trade, key)) is not None for key in keys)


def _trade_preference_key(trade: Any) -> tuple[int, int, int]:
    return (
        _trade_completeness(trade),
        _trade_received_at_ms(trade),
        spot_trade_event_time_ms(trade) or 0,
    )


def _trade_sort_key(trade: Any) -> tuple[int, int, str, int]:
    event_time_ms = spot_trade_event_time_ms(trade)
    identity = _trade_signature(trade)
    received_at_ms = _trade_received_at_ms(trade)
    if event_time_ms is not None:
        return (0, -event_time_ms, identity, -received_at_ms)
    return (1, -received_at_ms, identity, 0)


def _trade_with_record_context(
    trade: Any,
    *,
    provider: Any,
    provider_symbol: Any,
) -> Optional[dict[str, Any]]:
    if not isinstance(trade, dict):
        return None
    item = dict(trade)
    if _trade_text(item.get("provider")) is None and provider is not None:
        item["provider"] = provider
    if _trade_text(item.get("provider_symbol")) is None and provider_symbol is not None:
        item["provider_symbol"] = provider_symbol
    return item


def _merge_trade_records(
    incoming: list[dict[str, Any]],
    existing: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    strong_items: dict[str, dict[str, Any]] = {}
    incoming_weak: dict[str, list[dict[str, Any]]] = {}
    existing_weak: dict[str, list[dict[str, Any]]] = {}

    for source_items, weak_buckets in ((incoming, incoming_weak), (existing, existing_weak)):
        for trade in source_items:
            strong_identity = spot_trade_strong_identity(trade)
            if strong_identity is not None:
                current = strong_items.get(strong_identity)
                if current is None or _trade_preference_key(trade) > _trade_preference_key(current):
                    strong_items[strong_identity] = trade
                continue
            fingerprint = spot_trade_weak_fingerprint(trade)
            weak_buckets.setdefault(fingerprint, []).append(trade)

    merged = list(strong_items.values())
    for fingerprint in sorted(set(incoming_weak) | set(existing_weak)):
        incoming_items = incoming_weak.get(fingerprint, [])
        existing_items = existing_weak.get(fingerprint, [])
        target_count = max(len(incoming_items), len(existing_items))
        candidates = sorted(
            incoming_items + existing_items,
            key=_trade_preference_key,
            reverse=True,
        )
        # Providers without IDs cannot offer absolute trade identity.  Preserve
        # the largest observed multiplicity without pretending the weak
        # fingerprint uniquely identifies each real trade.
        merged.extend(candidates[:target_count])
    return merged


def _public_kline_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: deepcopy(value) for key, value in item.items() if not str(key).startswith("_")}


_KLINE_REVISION_STATE_KEY = "_revision_state"
_KLINE_AUTO_SEQUENCE_REASONS = {
    KlineRevisionReason.RECEIVED_AT_ONLY,
    KlineRevisionReason.REVISION_CONFLICT,
}


def _kline_revision_int(value: Any, default: int = 0) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return max(0, int(default or 0))
    return normalized if normalized >= 0 else max(0, int(default or 0))


def _kline_revision_metadata_for_bucket(
    bucket_revision_map: dict[Any, Any],
    open_time: int,
) -> dict[str, Any]:
    metadata = bucket_revision_map.get(open_time)
    if metadata is None:
        metadata = bucket_revision_map.get(str(open_time))
    return metadata if isinstance(metadata, dict) else {}


def _kline_close_evidence(
    item: dict[str, Any],
    metadata: dict[str, Any],
    provider: str,
) -> tuple[Optional[bool], str]:
    if "_is_closed" in item:
        is_closed = item.get("_is_closed")
    elif "is_closed" in metadata:
        is_closed = metadata.get("is_closed")
    elif "is_closed" in item:
        is_closed = item.get("is_closed")
    else:
        is_closed = None

    close_state_source = item.get("_close_state_source") or metadata.get("close_state_source")
    if close_state_source:
        return is_closed, str(close_state_source)

    confirm = str(item.get("confirm") or "").strip()
    if provider == PROVIDER_OKX_SPOT and confirm in {"0", "1"}:
        return is_closed, "PROVIDER_CONFIRMED"
    return is_closed, "UNKNOWN"


def _kline_revision_candidate(
    record: dict[str, Any],
    item: dict[str, Any],
    *,
    revision_epoch: int,
    provider_generation: int,
    revision_seq: int,
    metadata: Optional[dict[str, Any]] = None,
) -> KlineRevisionCandidate:
    metadata = metadata or {}
    provider = str(item.get("provider") or record.get("provider") or PROVIDER_BITGET_SPOT).strip().upper()
    is_closed, close_state_source = _kline_close_evidence(item, metadata, provider)
    received_at_ms = _kline_revision_int(
        item.get("_received_at_ms", metadata.get("received_at_ms", record.get("updated_at_ms"))),
    )
    provider_update_time_ms = item.get(
        "_provider_update_time_ms",
        metadata.get("provider_update_time_ms"),
    )
    if provider_update_time_ms is not None:
        provider_update_time_ms = _kline_revision_int(provider_update_time_ms)

    return KlineRevisionCandidate(
        symbol=record.get("symbol"),
        interval=record.get("interval"),
        open_time=item.get("open_time"),
        open=item.get("open"),
        high=item.get("high"),
        low=item.get("low"),
        close=item.get("close"),
        volume=item.get("volume", "0"),
        quote_volume=item.get("quote_volume"),
        provider=provider,
        source=item.get("source") or record.get("source") or SPOT_PROVIDER_WS_SOURCE,
        transport=item.get("_transport") or metadata.get("transport") or "WS",
        provider_generation=provider_generation,
        revision_epoch=revision_epoch,
        revision_seq=revision_seq,
        received_at_ms=received_at_ms,
        is_closed=is_closed,
        close_state_source=close_state_source,
        provider_update_time_ms=provider_update_time_ms,
    )


def _kline_revision_metadata(candidate: KlineRevisionCandidate) -> dict[str, Any]:
    return {
        "revision_epoch": candidate.revision_epoch,
        "provider_generation": candidate.provider_generation,
        "revision_seq": candidate.revision_seq,
        "received_at_ms": candidate.received_at_ms,
        "provider_update_time_ms": candidate.provider_update_time_ms,
        "transport": candidate.transport.value,
        "is_closed": candidate.is_closed,
        "close_state_source": candidate.close_state_source.value,
    }


def _stamp_kline_revision(
    item: dict[str, Any],
    candidate: KlineRevisionCandidate,
) -> dict[str, Any]:
    stamped = deepcopy(item)
    metadata = _kline_revision_metadata(candidate)
    stamped.update(
        {
            "_revision_epoch": metadata["revision_epoch"],
            "_provider_generation": metadata["provider_generation"],
            "_revision_seq": metadata["revision_seq"],
            "_received_at_ms": metadata["received_at_ms"],
            "_provider_update_time_ms": metadata["provider_update_time_ms"],
            "_transport": metadata["transport"],
            "_is_closed": metadata["is_closed"],
            "_close_state_source": metadata["close_state_source"],
        }
    )
    return stamped


def _depth_response_from_record(record: dict[str, Any], *, limit: Optional[int] = None) -> DepthResponse:
    depth_limit = _depth_limit(limit)
    event_time_ms = _spot_provider_event_time_ms(record.get("ts"))
    received_at_ms = int(record.get("updated_at_ms") or 0)
    return DepthResponse(
        symbol=normalize_spot_ws_symbol(record.get("symbol")),
        price_precision=int(record.get("price_precision") or 8),
        amount_precision=int(record.get("amount_precision") or 8),
        bids=[DepthItem(**item) for item in list(record.get("bids") or [])[:depth_limit]],
        asks=[DepthItem(**item) for item in list(record.get("asks") or [])[:depth_limit]],
        ts=int(record.get("ts") or 0),
        event_time_ms=event_time_ms,
        received_at_ms=received_at_ms,
        provider=str(record.get("provider") or PROVIDER_BITGET_SPOT),
        stale=False,
        updated_at=record.get("updated_at"),
        source=str(record.get("source") or SPOT_PROVIDER_WS_SOURCE),
        fetched_at=received_at_ms,
    )


def _trades_response_from_record(record: dict[str, Any], *, limit: Optional[int] = None) -> TradesResponse:
    trade_limit = _trades_limit(limit)
    provider = str(record.get("provider") or PROVIDER_BITGET_SPOT)
    provider_symbol = str(record.get("provider_symbol") or "")
    source = str(record.get("source") or SPOT_PROVIDER_WS_SOURCE)
    freshness = str(record.get("freshness") or "LIVE")
    received_at_ms = _spot_provider_event_time_ms(record.get("updated_at_ms"))
    trades: list[TradeItem] = []
    for raw_item in list(record.get("trades") or [])[:trade_limit]:
        if not isinstance(raw_item, dict):
            continue
        item = dict(raw_item)
        item.setdefault("provider", provider)
        item.setdefault("provider_symbol", provider_symbol)
        item.setdefault("source", source)
        item.setdefault("freshness", freshness)
        item.setdefault("received_at_ms", received_at_ms)
        item.setdefault("updated_at_ms", received_at_ms)
        item.setdefault("time_origin", "PROVIDER")
        trades.append(TradeItem(**item))
    return TradesResponse(
        symbol=normalize_spot_ws_symbol(record.get("symbol")),
        trades=trades,
        provider=provider,
        provider_symbol=provider_symbol,
        stale=False,
        updated_at=record.get("updated_at"),
        updated_at_ms=received_at_ms,
        received_at_ms=received_at_ms,
        source=source,
        freshness=freshness,
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


def _freeze_kline_revision_snapshot(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType(
            {
                key: _freeze_kline_revision_snapshot(item)
                for key, item in value.items()
            }
        )
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_kline_revision_snapshot(item) for item in value)
    return deepcopy(value)


def _kline_revision_response_from_record(
    record: dict[str, Any],
    *,
    limit: Optional[int] = None,
) -> Mapping[str, Any]:
    kline_limit = _kline_limit(limit)
    state_raw = record.get(_KLINE_REVISION_STATE_KEY)
    state = state_raw if isinstance(state_raw, dict) else {}
    bucket_map_raw = state.get("bucket_revision_map")
    bucket_map = bucket_map_raw if isinstance(bucket_map_raw, dict) else {}
    items: list[dict[str, Any]] = []
    for item in list(record.get("items") or [])[-kline_limit:]:
        if not isinstance(item, dict):
            continue
        public_item = _public_kline_item(item)
        open_time = _kline_revision_int(item.get("open_time"))
        metadata = _kline_revision_metadata_for_bucket(bucket_map, open_time)
        public_item.update(
            {
                "revision_epoch": item.get(
                    "_revision_epoch",
                    metadata.get("revision_epoch"),
                ),
                "revision_seq": item.get(
                    "_revision_seq",
                    metadata.get("revision_seq"),
                ),
                "is_closed": item.get(
                    "_is_closed",
                    metadata.get("is_closed", item.get("is_closed")),
                ),
                "close_state_source": item.get(
                    "_close_state_source",
                    metadata.get("close_state_source"),
                ),
            }
        )
        items.append(public_item)

    return _freeze_kline_revision_snapshot(
        {
            "symbol": normalize_spot_ws_symbol(record.get("symbol")),
            "interval": normalize_spot_ws_kline_interval(record.get("interval")),
            "items": items,
            "provider": str(record.get("provider") or PROVIDER_BITGET_SPOT),
            "source": str(record.get("source") or SPOT_PROVIDER_WS_SOURCE),
            "freshness": str(record.get("freshness") or "LIVE"),
            "stale": False,
            "updated_at": record.get("updated_at"),
        }
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
    exchange_ts = _spot_provider_event_time_ms(row.get("ts")) or 0
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
    exchange_ts = _spot_provider_event_time_ms(row.get("ts")) or 0
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

    batch_received_at_ms = _now_ms()
    trades: list[dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        price = _to_decimal(row.get("price"))
        amount = _to_decimal(row.get("size"))
        if price is None or amount is None or price <= 0 or amount <= 0:
            continue
        side_text = str(row.get("side") or "").upper()
        event_time_ms = _spot_provider_event_time_ms(row.get("ts"))
        compatibility_ts = event_time_ms or batch_received_at_ms
        raw_trade_id = row.get("tradeId")
        trade_id = str(raw_trade_id).strip() if raw_trade_id is not None else ""
        trade_id = trade_id or None
        trades.append(
            {
                "id": trade_id,
                "trade_id": trade_id,
                "provider_trade_id": trade_id,
                "price": _decimal_to_str(price),
                "amount": _decimal_to_str(amount),
                "side": "SELL" if side_text == "SELL" else "BUY",
                "ts": compatibility_ts,
                "event_time_ms": event_time_ms,
                "received_at_ms": batch_received_at_ms,
                "created_at": (
                    datetime.utcfromtimestamp(event_time_ms / 1000).isoformat()
                    if event_time_ms is not None
                    else None
                ),
                "time_origin": "PROVIDER",
                "provider": PROVIDER_BITGET_SPOT,
                "provider_symbol": normalize_spot_ws_symbol(provider_symbol),
                "source": SPOT_PROVIDER_WS_SOURCE,
                "freshness": "LIVE",
                "updated_at_ms": batch_received_at_ms,
                "raw_trade": deepcopy(row),
            }
        )

    if not trades:
        return None
    trade_limit = _trades_limit(trades_limit)
    trades = _merge_trade_records(trades, [])
    trades.sort(key=_trade_sort_key)
    timed_event_values = [
        event_time_ms
        for trade in trades
        if (event_time_ms := spot_trade_event_time_ms(trade)) is not None
    ]
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_BITGET_SPOT,
        "provider_symbol": normalize_spot_ws_symbol(provider_symbol),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "trades": trades[:trade_limit],
        "ts": max(timed_event_values) if timed_event_values else batch_received_at_ms,
        "received_at_ms": batch_received_at_ms,
        "updated_at_ms": batch_received_at_ms,
        "updated_at": datetime.utcfromtimestamp(batch_received_at_ms / 1000).isoformat(),
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

    batch_received_at_ms = _now_ms()
    trades: list[dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        price = _to_decimal(row.get("px"))
        amount = _to_decimal(row.get("sz"))
        if price is None or amount is None or price <= 0 or amount <= 0:
            continue
        side_text = str(row.get("side") or "").upper()
        raw_trade_id = row.get("tradeId")
        trade_id = str(raw_trade_id).strip() if raw_trade_id is not None else ""
        trade_id = trade_id or None
        event_time_ms = _spot_provider_event_time_ms(row.get("ts"))
        compatibility_ts = event_time_ms or batch_received_at_ms
        trades.append(
            {
                "id": trade_id,
                "trade_id": trade_id,
                "provider_trade_id": trade_id,
                "price": _decimal_to_str(price),
                "amount": _decimal_to_str(amount),
                "side": "SELL" if side_text == "SELL" else "BUY",
                "ts": compatibility_ts,
                "event_time_ms": event_time_ms,
                "received_at_ms": batch_received_at_ms,
                "created_at": (
                    datetime.utcfromtimestamp(event_time_ms / 1000).isoformat()
                    if event_time_ms is not None
                    else None
                ),
                "time_origin": "PROVIDER",
                "provider": PROVIDER_OKX_SPOT,
                "provider_symbol": str(provider_symbol or "").strip().upper(),
                "source": SPOT_PROVIDER_WS_SOURCE,
                "freshness": "LIVE",
                "updated_at_ms": batch_received_at_ms,
                "raw_trade": deepcopy(row),
            }
        )

    if not trades:
        return None
    trade_limit = _trades_limit(trades_limit)
    trades = _merge_trade_records(trades, [])
    trades.sort(key=_trade_sort_key)
    timed_event_values = [
        event_time_ms
        for trade in trades
        if (event_time_ms := spot_trade_event_time_ms(trade)) is not None
    ]
    return {
        "symbol": normalize_spot_ws_symbol(local_symbol),
        "provider": PROVIDER_OKX_SPOT,
        "provider_symbol": str(provider_symbol or "").strip().upper(),
        "source": SPOT_PROVIDER_WS_SOURCE,
        "freshness": "LIVE",
        "trades": trades[:trade_limit],
        "ts": max(timed_event_values) if timed_event_values else batch_received_at_ms,
        "received_at_ms": batch_received_at_ms,
        "updated_at_ms": batch_received_at_ms,
        "updated_at": datetime.utcfromtimestamp(batch_received_at_ms / 1000).isoformat(),
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
    exchange_ts = _spot_provider_event_time_ms(row.get("ts"))
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
        "ts": exchange_ts or now_ms,
        "event_time_ms": exchange_ts,
        "received_at_ms": now_ms,
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
    exchange_ts = _spot_provider_event_time_ms(row.get("ts"))
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
        "ts": exchange_ts or now_ms,
        "event_time_ms": exchange_ts,
        "received_at_ms": now_ms,
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
        self._task_last_reconnect_at_ms: dict[tuple[str, str, str, str], int] = {}
        self._task_consecutive_failures: dict[tuple[str, str, str, str], int] = {}
        self._task_release_timeout_counts: dict[tuple[str, str, str, str], int] = {}
        self._stopping_threads: dict[tuple[str, str, str, str], threading.Thread] = {}
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
        if (
            not spot_provider_ws_supports_provider(provider_code, domain="kline")
            or not spot_provider_ws_supports_kline_interval(provider_code, normalized_interval)
        ):
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

    def get_fresh_kline_revisions(
        self,
        symbol: str,
        interval: str,
        *,
        provider: Optional[str] = None,
        max_age_ms: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[Mapping[str, Any]]:
        normalized_symbol = normalize_spot_ws_symbol(symbol)
        normalized_interval = normalize_spot_ws_kline_interval(interval)
        provider_code = normalize_spot_ws_provider(provider)
        if (
            not spot_provider_ws_supports_provider(provider_code, domain="kline")
            or not spot_provider_ws_supports_kline_interval(provider_code, normalized_interval)
        ):
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
            response = _kline_revision_response_from_record(item, limit=limit)
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
            self._task_last_reconnect_at_ms.clear()
            self._task_consecutive_failures.clear()
            self._task_release_timeout_counts.clear()
            self._stopping_threads.clear()

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
            active_connections = [item for item in active_provider_tasks if item["connected"]]
            running_threads = [item for item in active_provider_tasks if item["thread_alive"]]
            stopping_threads = [
                self._provider_thread_identity_from_metric_key(metric_key)
                for metric_key, thread in sorted(self._stopping_threads.items())
                if thread.is_alive()
            ]
            generation_records = self._generation_records_locked()
            reconnect_records = self._reconnect_records_locked()
            cache_metrics = self._cache_metrics_locked(now_ms)
            lifecycle_created = sum(self._task_start_counts.values())
            lifecycle_released = sum(self._task_stop_counts.values())
            lifecycle_release_timeout = sum(self._task_release_timeout_counts.values())

        return {
            "active_provider_task_count": len(active_provider_tasks),
            "active_provider_tasks": active_provider_tasks,
            "active_kline_intervals": active_kline_intervals,
            "cache_records": cache_records,
            "active_connections": {
                "count": len(active_connections),
                "items": [self._provider_task_identity(item) for item in active_connections],
                "by_provider": self._count_provider_task_dimension(active_connections, "provider"),
                "by_domain": self._count_provider_task_dimension(active_connections, "domain"),
            },
            "active_threads": {
                "running_count": len(running_threads),
                "stopping_count": len(stopping_threads),
                "running": [self._provider_task_identity(item) for item in running_threads],
                "stopping": stopping_threads,
            },
            "active_tasks": {
                "websocket_task_count": len(active_provider_tasks),
                "reconnect_task_count": 0,
                "reconnect_model": "inline_provider_loop",
            },
            "generation": {
                "records": generation_records,
                "current_generation_count": len(generation_records),
                "retired_generation_count": sum(
                    int(item["retired_generation_count"]) for item in generation_records
                ),
            },
            "reconnect": {
                "count": sum(int(item["reconnect_count"]) for item in reconnect_records),
                "last_reconnect_at_ms": max(
                    (int(item["last_reconnect_at_ms"] or 0) for item in reconnect_records),
                    default=0,
                ) or None,
                "consecutive_failures": sum(
                    int(item["consecutive_failures"]) for item in reconnect_records
                ),
                "max_consecutive_failures": max(
                    (int(item["consecutive_failures"]) for item in reconnect_records),
                    default=0,
                ),
                "records": reconnect_records,
            },
            "lifecycle": {
                "created": lifecycle_created,
                "released": lifecycle_released,
                "release_timeout": lifecycle_release_timeout,
            },
            "cache": cache_metrics,
        }

    @staticmethod
    def _provider_task_identity(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "provider": item.get("provider"),
            "domain": item.get("domain"),
            "symbol": item.get("symbol"),
            "interval": item.get("interval"),
        }

    @staticmethod
    def _count_provider_task_dimension(items: list[dict[str, Any]], field: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for item in items:
            value = str(item.get(field) or "")
            counts[value] = counts.get(value, 0) + 1
        return dict(sorted(counts.items()))

    @staticmethod
    def _provider_thread_identity_from_metric_key(
        metric_key: tuple[str, str, str, str],
    ) -> dict[str, Any]:
        domain, provider, symbol, interval = metric_key
        return {
            "provider": provider,
            "domain": domain,
            "symbol": symbol,
            "interval": interval or None,
        }

    def _generation_records_locked(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        generation_maps = (
            ("depth", self._depth_generations),
            ("ticker", self._ticker_generations),
            ("trades", self._trades_generations),
            ("kline", self._kline_generations),
        )
        for domain, generations in generation_maps:
            for key, generation in sorted(generations.items()):
                provider, symbol, *interval_parts = key
                records.append(
                    {
                        "provider": provider,
                        "domain": domain,
                        "symbol": symbol,
                        "interval": interval_parts[0] if interval_parts else None,
                        "current_generation": int(generation),
                        "retired_generation_count": max(0, int(generation) - 1),
                    }
                )
        return records

    def _reconnect_records_locked(self) -> list[dict[str, Any]]:
        metric_keys = sorted(
            set(self._task_reconnect_counts)
            | set(self._task_last_reconnect_at_ms)
            | set(self._task_consecutive_failures)
        )
        return [
            {
                **self._provider_thread_identity_from_metric_key(metric_key),
                "reconnect_count": int(self._task_reconnect_counts.get(metric_key) or 0),
                "last_reconnect_at_ms": self._task_last_reconnect_at_ms.get(metric_key),
                "consecutive_failures": int(self._task_consecutive_failures.get(metric_key) or 0),
            }
            for metric_key in metric_keys
        ]

    def _cache_metrics_locked(self, now_ms: int) -> dict[str, dict[str, int]]:
        cache_specs = {
            "depth": (self._depth_cache, self._depth_tasks, _max_age_ms(None)),
            "ticker": (self._ticker_cache, self._ticker_tasks, _ticker_max_age_ms(None)),
            "trades": (self._trades_cache, self._trades_tasks, _trades_max_age_ms(None)),
            "kline": (self._kline_cache, self._kline_tasks, _kline_max_age_ms(None)),
        }
        metrics: dict[str, dict[str, int]] = {}
        for domain, (records, tasks, max_age_ms) in cache_specs.items():
            fresh_key_count = sum(
                1 for record in records.values() if is_fresh_record(record, max_age_ms, now_ms=now_ms)
            )
            key_count = len(records)
            domain_metrics = {
                "key_count": key_count,
                "active_key_count": sum(1 for key in records if key in tasks),
                "fresh_key_count": fresh_key_count,
                "stale_key_count": key_count - fresh_key_count,
            }
            if domain == "kline":
                domain_metrics["bucket_count"] = sum(
                    len(record.get("items") or []) for record in records.values()
                )
            metrics[domain] = domain_metrics
        return metrics

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
        self._task_consecutive_failures[metric_key] = 0

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
            self._task_last_reconnect_at_ms[metric_key] = _now_ms()
            self._task_consecutive_failures[metric_key] = int(
                self._task_consecutive_failures.get(metric_key) or 0
            ) + 1

    def _remember_provider_task_connected_locked(
        self,
        domain: str,
        provider: str,
        symbol: str,
        interval: Optional[str] = None,
    ) -> None:
        metric_key = self._provider_metric_key(domain, provider, symbol, interval)
        self._task_consecutive_failures[metric_key] = 0

    def _join_provider_thread_for_release(
        self,
        *,
        domain: str,
        provider: str,
        symbol: str,
        interval: Optional[str],
        task: Optional[threading.Thread],
    ) -> None:
        if task is None or not task.is_alive() or task is threading.current_thread():
            return
        metric_key = self._provider_metric_key(domain, provider, symbol, interval)
        with self._lock:
            self._stopping_threads[metric_key] = task
        try:
            task.join(timeout=2.0)
        finally:
            with self._lock:
                if task.is_alive():
                    self._task_release_timeout_counts[metric_key] = int(
                        self._task_release_timeout_counts.get(metric_key) or 0
                    ) + 1
                if self._stopping_threads.get(metric_key) is task:
                    self._stopping_threads.pop(metric_key, None)

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
            "last_reconnect_at_ms": self._task_last_reconnect_at_ms.get(metric_key),
            "consecutive_failures": int(self._task_consecutive_failures.get(metric_key) or 0),
            "release_timeout_count": int(self._task_release_timeout_counts.get(metric_key) or 0),
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
        if (
            not local_symbol
            or not spot_provider_ws_supports_provider(provider_code, domain="kline")
            or not spot_provider_ws_supports_kline_interval(provider_code, normalized_interval)
        ):
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
        normalized_interval = normalize_spot_ws_kline_interval(interval)
        channel = spot_provider_ws_kline_channel(provider_code, normalized_interval)
        if channel is None:
            return
        provider_symbol = okx_spot_ws_symbol(local_symbol) if provider_code == PROVIDER_OKX_SPOT else local_symbol
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
                channel=channel,
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
        self._join_provider_thread_for_release(
            domain="depth",
            provider=provider_code,
            symbol=local_symbol,
            interval=None,
            task=task,
        )

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
        self._join_provider_thread_for_release(
            domain="trades",
            provider=provider_code,
            symbol=local_symbol,
            interval=None,
            task=task,
        )

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
        self._join_provider_thread_for_release(
            domain="ticker",
            provider=provider_code,
            symbol=local_symbol,
            interval=None,
            task=task,
        )

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
        self._join_provider_thread_for_release(
            domain="kline",
            provider=provider_code,
            symbol=local_symbol,
            interval=normalized_interval,
            task=task,
        )

    def _merge_provider_kline_record_locked(
        self,
        key: tuple[str, str, str],
        record: dict[str, Any],
        limit: int,
        *,
        generation: Optional[int] = None,
    ) -> dict[str, Any]:
        existing = self._kline_cache.get(key) or {}
        existing_state_raw = existing.get(_KLINE_REVISION_STATE_KEY)
        existing_state = existing_state_raw if isinstance(existing_state_raw, dict) else {}
        existing_bucket_map_raw = existing_state.get("bucket_revision_map")
        bucket_revision_map = (
            deepcopy(existing_bucket_map_raw)
            if isinstance(existing_bucket_map_raw, dict)
            else {}
        )
        existing_epoch = _kline_revision_int(existing_state.get("epoch"), 1) or 1
        incoming_epoch = _kline_revision_int(record.get("_revision_epoch"), existing_epoch) or existing_epoch
        incoming_generation = _kline_revision_int(
            generation,
            _kline_revision_int(existing_state.get("generation"), 1) or 1,
        ) or 1
        existing_generation = _kline_revision_int(
            existing_state.get("generation"),
            incoming_generation,
        ) or incoming_generation
        if existing and incoming_epoch < existing_epoch:
            return existing
        if (
            existing
            and incoming_epoch == existing_epoch
            and incoming_generation < existing_generation
        ):
            return existing
        last_revision_seq = _kline_revision_int(existing_state.get("last_revision_seq"))
        by_open_time: dict[int, dict[str, Any]] = {}
        for item in list(existing.get("items") or []):
            try:
                open_time = int(item.get("open_time") or 0)
            except Exception:
                continue
            if open_time > 0:
                by_open_time[open_time] = item
                metadata = _kline_revision_metadata_for_bucket(bucket_revision_map, open_time)
                item_revision_seq = _kline_revision_int(
                    item.get("_revision_seq", metadata.get("revision_seq")),
                )
                item_revision_epoch = _kline_revision_int(
                    item.get("_revision_epoch", metadata.get("revision_epoch")),
                    existing_epoch,
                ) or existing_epoch
                item_generation = _kline_revision_int(
                    item.get("_provider_generation", metadata.get("provider_generation")),
                    existing_generation,
                ) or existing_generation
                existing_candidate = _kline_revision_candidate(
                    existing,
                    item,
                    revision_epoch=item_revision_epoch,
                    provider_generation=item_generation,
                    revision_seq=item_revision_seq,
                    metadata=metadata,
                )
                bucket_revision_map[open_time] = _kline_revision_metadata(existing_candidate)
                last_revision_seq = max(last_revision_seq, item_revision_seq)

        accepted_any = False
        for item in list(record.get("items") or []):
            try:
                open_time = int(item.get("open_time") or 0)
            except Exception:
                continue
            if open_time <= 0:
                continue

            existing_item = by_open_time.get(open_time)
            existing_candidate: Optional[KlineRevisionCandidate] = None
            if existing_item is not None:
                existing_metadata = _kline_revision_metadata_for_bucket(bucket_revision_map, open_time)
                existing_candidate = _kline_revision_candidate(
                    existing or record,
                    existing_item,
                    revision_epoch=_kline_revision_int(
                        existing_item.get("_revision_epoch", existing_metadata.get("revision_epoch")),
                        existing_epoch,
                    )
                    or existing_epoch,
                    provider_generation=_kline_revision_int(
                        existing_item.get(
                            "_provider_generation",
                            existing_metadata.get("provider_generation"),
                        ),
                        _kline_revision_int(
                            existing_state.get("generation"),
                            existing_generation,
                        )
                        or existing_generation,
                    )
                    or existing_generation,
                    revision_seq=_kline_revision_int(
                        existing_item.get("_revision_seq", existing_metadata.get("revision_seq")),
                    ),
                    metadata=existing_metadata,
                )

            explicit_revision_seq = item.get("_revision_seq")
            incoming_candidate: Optional[KlineRevisionCandidate] = None
            if explicit_revision_seq is not None:
                incoming_candidate = _kline_revision_candidate(
                    record,
                    item,
                    revision_epoch=incoming_epoch,
                    provider_generation=incoming_generation,
                    revision_seq=_kline_revision_int(explicit_revision_seq),
                )
            elif existing_candidate is not None:
                probe_candidate = _kline_revision_candidate(
                    record,
                    item,
                    revision_epoch=incoming_epoch,
                    provider_generation=incoming_generation,
                    revision_seq=existing_candidate.revision_seq,
                )
                probe = compare_kline_revision(existing_candidate, probe_candidate)
                if probe.decision == KlineRevisionDecision.NO_CHANGE:
                    continue
                if (
                    probe.decision == KlineRevisionDecision.REJECT
                    and probe.reason not in _KLINE_AUTO_SEQUENCE_REASONS
                ):
                    continue

            if incoming_candidate is None:
                incoming_candidate = _kline_revision_candidate(
                    record,
                    item,
                    revision_epoch=incoming_epoch,
                    provider_generation=incoming_generation,
                    revision_seq=last_revision_seq + 1,
                )

            comparison = compare_kline_revision(existing_candidate, incoming_candidate)
            if comparison.decision != KlineRevisionDecision.ACCEPT:
                continue

            by_open_time[open_time] = _stamp_kline_revision(item, incoming_candidate)
            bucket_revision_map[open_time] = _kline_revision_metadata(incoming_candidate)
            last_revision_seq = max(last_revision_seq, incoming_candidate.revision_seq)
            accepted_any = True

        if existing and not accepted_any:
            return existing

        retained_open_times = sorted(by_open_time.keys())[-limit:]
        merged_record = deepcopy(record)
        merged_record["items"] = [
            by_open_time[open_time]
            for open_time in retained_open_times
        ]
        merged_record[_KLINE_REVISION_STATE_KEY] = {
            "epoch": incoming_epoch,
            "generation": incoming_generation,
            "last_revision_seq": last_revision_seq,
            "bucket_revision_map": {
                open_time: bucket_revision_map[open_time]
                for open_time in retained_open_times
                if open_time in bucket_revision_map
            },
        }
        return merged_record

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
                self._remember_provider_task_connected_locked(
                    "depth", subscription.provider, subscription.local_symbol
                )
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
                self._remember_provider_task_connected_locked(
                    "depth", subscription.provider, subscription.local_symbol
                )
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
                self._remember_provider_task_connected_locked(
                    "ticker", subscription.provider, subscription.local_symbol
                )
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
                self._remember_provider_task_connected_locked(
                    "ticker", subscription.provider, subscription.local_symbol
                )
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
                self._remember_provider_task_connected_locked(
                    "trades", subscription.provider, subscription.local_symbol
                )
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
                self._remember_provider_task_connected_locked(
                    "trades", subscription.provider, subscription.local_symbol
                )
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
                self._remember_provider_task_connected_locked(
                    "kline",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.interval,
                )
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
                self._remember_provider_task_connected_locked(
                    "kline",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.interval,
                )
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
        incoming_provider = record.get("provider") or subscription.provider
        incoming_provider_symbol = record.get("provider_symbol") or subscription.provider_symbol
        existing_provider = existing.get("provider") or subscription.provider
        existing_provider_symbol = existing.get("provider_symbol") or subscription.provider_symbol
        incoming_items = [
            item
            for trade in list(record.get("trades") or [])
            if (
                item := _trade_with_record_context(
                    trade,
                    provider=incoming_provider,
                    provider_symbol=incoming_provider_symbol,
                )
            )
            is not None
        ]
        existing_items = [
            item
            for trade in list(existing.get("trades") or [])
            if (
                item := _trade_with_record_context(
                    trade,
                    provider=existing_provider,
                    provider_symbol=existing_provider_symbol,
                )
            )
            is not None
        ]
        merged = _merge_trade_records(incoming_items, existing_items)
        merged.sort(key=_trade_sort_key)
        final_trades = merged[: subscription.trades_limit]

        received_candidates = [
            value
            for value in (
                _trade_nonnegative_time_ms(record.get("received_at_ms")),
                _trade_nonnegative_time_ms(record.get("updated_at_ms")),
                _trade_nonnegative_time_ms(existing.get("received_at_ms")),
                _trade_nonnegative_time_ms(existing.get("updated_at_ms")),
                *(_trade_received_at_ms(trade) for trade in final_trades),
            )
            if value is not None
        ]
        latest_received_at_ms = max(received_candidates, default=0)
        timed_event_values = [
            event_time_ms
            for trade in final_trades
            if (event_time_ms := spot_trade_event_time_ms(trade)) is not None
        ]
        record["trades"] = final_trades
        record["received_at_ms"] = latest_received_at_ms
        record["updated_at_ms"] = latest_received_at_ms
        record["updated_at"] = datetime.utcfromtimestamp(latest_received_at_ms / 1000).isoformat()
        record["ts"] = max(timed_event_values) if timed_event_values else latest_received_at_ms
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
                generation=generation,
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
                generation=generation,
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


def get_spot_provider_ws_kline_revisions(
    symbol: str,
    interval: str,
    *,
    provider: Optional[str] = None,
    max_age_ms: Optional[int] = None,
    limit: Optional[int] = None,
) -> Optional[Mapping[str, Any]]:
    return spot_market_provider_ws.get_fresh_kline_revisions(
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
