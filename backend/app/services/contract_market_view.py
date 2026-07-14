from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.contract_symbol import ContractSymbol
from app.schemas.contract_market_domain_snapshot import (
    ContractMarketDomainName,
    ContractMarketDomainSnapshot,
)
from app.services.contract_market_guard import (
    QUOTE_FRESHNESS_LIVE,
    QUOTE_SOURCE_LAST_GOOD_BBO,
)
from app.services.contract_market_service import (
    ContractSymbolNotFound,
)
from app.services.contract_trading_session_resolver import (
    SESSION_AFTER_HOURS,
    SESSION_CLOSED,
    SESSION_HOLIDAY,
    SESSION_PRE_MARKET,
    resolve_contract_trading_session,
)


DISPLAY_STATE_LOADING = "LOADING"
DISPLAY_STATE_LIVE_TRADABLE = "LIVE_TRADABLE"
DISPLAY_STATE_EXPIRED = "EXPIRED"
DISPLAY_STATE_UNAVAILABLE = "UNAVAILABLE"

DISPLAY_PRICE_SOURCE_LIVE_MID = "LIVE_MID"
DISPLAY_PRICE_SOURCE_TRADE_TICK = "TRADE_TICK"
DISPLAY_PRICE_SOURCE_KLINE_CLOSE = "KLINE_CLOSE"
DISPLAY_PRICE_SOURCE_NONE = "NONE"

KLINE_MODE_TRADE_DRIVEN = "TRADE_DRIVEN"
KLINE_MODE_PROVIDER_KLINE = "PROVIDER_KLINE"
KLINE_VOLUME_SOURCE_PROVIDER = "PROVIDER_KLINE"
_NON_PROVIDER_KLINE_SOURCE_TOKENS = {
    "BBO",
    "DEPTH",
    "DISPLAY_PRICE",
    "LIVE_MID",
    "QUOTE_DRIVEN",
    "SYNTHETIC_FROM_QUOTE",
    "TRADE_TICK",
}

EXECUTION_MODE_LIVE_BBO = "LIVE_BBO"
EXECUTION_MODE_DISABLED = "DISABLED"

MARKET_TYPE_CONTRACT = "CONTRACT"
DEFAULT_KLINE_INTERVAL = "1m"
_CLOSED_MARKET_STATUSES = {"CLOSED", "HOLIDAY"}
_NON_REALTIME_BBO_SESSION_TYPES = {"PRE_MARKET", "PREMARKET", "AFTER_HOURS", "POST_MARKET", "POSTMARKET", "CLOSED", "HOLIDAY"}
_TRADFI_CATEGORIES = {"STOCK", "FOREX", "METAL", "GOLD", "COMMODITY", "FUTURES", "INDEX", "CFD"}
_NON_TRADING_DISPLAY_STATES = {
    SESSION_PRE_MARKET,
    SESSION_AFTER_HOURS,
    SESSION_CLOSED,
    SESSION_HOLIDAY,
}
_LAST_GOOD_BBO_MAX_AGE_MS = 72 * 60 * 60 * 1000


def _normalized(value: Any) -> str:
    return str(value or "").strip().upper()


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    try:
        parsed = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _format_decimal(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return format(value, "f")


def _first_payload_decimal(*payloads: Optional[dict[str, Any]], key: str) -> Optional[Decimal]:
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        value = _to_decimal(payload.get(key))
        if value is not None:
            return value
    return None


def _to_datetime(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 1_000_000_000_000:
            timestamp = timestamp / 1000
        try:
            dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        except Exception:
            return None
    else:
        text = str(value or "").strip()
        if not text:
            return None
        if text.isdigit():
            return _to_datetime(float(text))
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _price_age_ms(value: Optional[datetime], now: datetime) -> Optional[int]:
    if value is None:
        return None
    age = int((now - value).total_seconds() * 1000)
    return max(age, 0)


def _attr(source: Any, name: str) -> Any:
    if source is None:
        return None
    if isinstance(source, dict):
        return source.get(name)
    return getattr(source, name, None)


def _contract_category(contract_symbol: Any, quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    raw = (
        _attr(contract_symbol, "category")
        or (quote or {}).get("category")
        or (depth or {}).get("category")
        or ""
    )
    category = _normalized(raw)
    if category in {"GOLD", "SILVER", "METALS"}:
        return "METAL"
    if category in {"FUTURE", "FUTURES", "OIL", "ENERGY"}:
        return "COMMODITY"
    if category:
        return category
    provider = _normalized(_attr(contract_symbol, "provider") or (quote or {}).get("provider") or (depth or {}).get("provider"))
    if provider == "BINANCE":
        return "CRYPTO"
    return "INTERNAL"


def _is_crypto_contract(contract_symbol: Any, quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> bool:
    category = _contract_category(contract_symbol, quote, depth)
    provider = _normalized(_attr(contract_symbol, "provider") or (quote or {}).get("provider") or (depth or {}).get("provider"))
    return category == "CRYPTO" or provider == "BINANCE"


def _display_symbol(symbol: str, contract_symbol: Any) -> str:
    return str(_attr(contract_symbol, "display_name") or symbol).strip() or symbol


def _first_decimal(*values: Any) -> Optional[Decimal]:
    for value in values:
        parsed = _to_decimal(value)
        if parsed is not None and parsed > 0:
            return parsed
    return None


def _bbo_from_payloads(
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
) -> tuple[Optional[Decimal], Optional[Decimal], Optional[dict[str, Any]]]:
    depth_bid = _first_decimal((depth or {}).get("best_bid"), (depth or {}).get("bid"))
    depth_ask = _first_decimal((depth or {}).get("best_ask"), (depth or {}).get("ask"))
    if depth_bid is not None and depth_ask is not None and depth_ask >= depth_bid:
        return depth_bid, depth_ask, depth

    quote_bid = _first_decimal((quote or {}).get("bid_price"), (quote or {}).get("best_bid"), (quote or {}).get("bid"))
    quote_ask = _first_decimal((quote or {}).get("ask_price"), (quote or {}).get("best_ask"), (quote or {}).get("ask"))
    if quote_bid is not None and quote_ask is not None and quote_ask >= quote_bid:
        return quote_bid, quote_ask, quote
    return None, None, None


def _payload_source(payload: Optional[dict[str, Any]]) -> str:
    return _normalized((payload or {}).get("quote_source") or (payload or {}).get("source"))


def _payload_freshness(payload: Optional[dict[str, Any]]) -> str:
    return _normalized((payload or {}).get("quote_freshness"))


def _optional_normalized(value: Any) -> Optional[str]:
    normalized = _normalized(value)
    return normalized or None


def _payload_source_or_none(payload: Optional[dict[str, Any]]) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _optional_normalized(payload.get("quote_source") or payload.get("source"))


def _payload_freshness_or_none(payload: Optional[dict[str, Any]]) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _optional_normalized(payload.get("quote_freshness") or payload.get("freshness"))


def _payload_time(payload: Optional[dict[str, Any]]) -> Optional[datetime]:
    if not isinstance(payload, dict):
        return None
    return (
        _to_datetime(payload.get("ts"))
        or _to_datetime(payload.get("source_updated_at"))
        or _to_datetime(payload.get("updated_at"))
    )


def _latest_kline_open_time(latest_kline: Optional[dict[str, Any]]) -> Optional[datetime]:
    if not isinstance(latest_kline, dict):
        return None
    return (
        _to_datetime(latest_kline.get("open_time_ms"))
        or _to_datetime(latest_kline.get("open_time"))
        or _to_datetime(latest_kline.get("time"))
        or _to_datetime(latest_kline.get("t"))
    )


def _latest_kline_close(latest_kline: Optional[dict[str, Any]]) -> Optional[Decimal]:
    if not isinstance(latest_kline, dict):
        return None
    return _first_decimal(
        latest_kline.get("close"),
        latest_kline.get("c"),
        latest_kline.get("last"),
        latest_kline.get("p"),
    )


def _latest_trade_price(latest_trade: Optional[dict[str, Any]]) -> Optional[Decimal]:
    if not isinstance(latest_trade, dict):
        return None
    price_source = _normalized(latest_trade.get("price_source"))
    if price_source != DISPLAY_PRICE_SOURCE_TRADE_TICK:
        return None
    return _first_decimal(
        latest_trade.get("price"),
        latest_trade.get("last_price"),
    )


def _latest_trade_time(latest_trade: Optional[dict[str, Any]]) -> Optional[datetime]:
    if not isinstance(latest_trade, dict):
        return None
    price_source = _normalized(latest_trade.get("price_source"))
    if price_source != DISPLAY_PRICE_SOURCE_TRADE_TICK:
        return None
    return (
        _to_datetime(latest_trade.get("time"))
        or _to_datetime(latest_trade.get("ts"))
        or _to_datetime(latest_trade.get("timestamp"))
    )


def _latest_trade_source(latest_trade: Optional[dict[str, Any]]) -> Optional[str]:
    if not isinstance(latest_trade, dict):
        return None
    return _optional_normalized(
        latest_trade.get("source")
        or latest_trade.get("quote_source")
        or latest_trade.get("price_source")
    )


def _latest_trade_freshness(latest_trade: Optional[dict[str, Any]]) -> Optional[str]:
    if not isinstance(latest_trade, dict):
        return None
    return _optional_normalized(latest_trade.get("quote_freshness") or latest_trade.get("freshness"))


def _normalize_interval(interval: Any) -> str:
    normalized = str(interval or DEFAULT_KLINE_INTERVAL).strip().lower()
    return normalized or DEFAULT_KLINE_INTERVAL


def _latest_kline_open_time_ms(latest_kline: Optional[dict[str, Any]]) -> Optional[int]:
    dt = _latest_kline_open_time(latest_kline)
    if dt is None:
        return None
    return int(dt.timestamp() * 1000)


def _kline_decimal(latest_kline: Optional[dict[str, Any]], *keys: str) -> Optional[Decimal]:
    if not isinstance(latest_kline, dict):
        return None
    for key in keys:
        parsed = _to_decimal(latest_kline.get(key))
        if parsed is not None:
            return parsed
    return None


def _is_provider_kline_row(candle: Optional[dict[str, Any]]) -> bool:
    if not isinstance(candle, dict):
        return False
    for key in ("kline_mode", "price_source", "source", "quote_source"):
        raw_value = candle.get(key)
        if raw_value is None or raw_value == "":
            continue
        normalized = str(raw_value).strip().upper()
        if normalized in _NON_PROVIDER_KLINE_SOURCE_TOKENS or "QUOTE" in normalized:
            return False
    return True


def _format_kline_candle(
    *,
    time_ms: int,
    interval: str,
    open_price: Decimal,
    high_price: Decimal,
    low_price: Decimal,
    close_price: Decimal,
    volume: Decimal,
    kline_mode: str,
    price_source: str,
    updated_at_ms: int,
) -> dict[str, Any]:
    return {
        "time": int(time_ms / 1000),
        "open_time": int(time_ms),
        "open": _format_decimal(open_price),
        "high": _format_decimal(high_price),
        "low": _format_decimal(low_price),
        "close": _format_decimal(close_price),
        "volume": _format_decimal(volume) or "0",
        "interval": _normalize_interval(interval),
        "kline_mode": kline_mode,
        "price_source": price_source,
        "volume_source": KLINE_VOLUME_SOURCE_PROVIDER,
        "updated_at_ms": updated_at_ms,
    }


def _provider_kline_candle(
    latest_kline: Optional[dict[str, Any]],
    *,
    interval: str,
    kline_mode: str = KLINE_MODE_PROVIDER_KLINE,
    price_source: str = DISPLAY_PRICE_SOURCE_KLINE_CLOSE,
    updated_at_ms: int,
) -> Optional[dict[str, Any]]:
    if not _is_provider_kline_row(latest_kline):
        return None
    time_ms = _latest_kline_open_time_ms(latest_kline)
    close_price = _kline_decimal(latest_kline, "close", "c", "last", "p")
    if time_ms is None or close_price is None:
        return None
    open_price = _kline_decimal(latest_kline, "open", "o") or close_price
    high_price = _kline_decimal(latest_kline, "high", "h") or max(open_price, close_price)
    low_price = _kline_decimal(latest_kline, "low", "l") or min(open_price, close_price)
    volume = _kline_decimal(latest_kline, "volume", "v", "qty", "amount") or Decimal("0")
    return _format_kline_candle(
        time_ms=time_ms,
        interval=interval,
        open_price=open_price,
        high_price=high_price,
        low_price=low_price,
        close_price=close_price,
        volume=volume,
        kline_mode=kline_mode,
        price_source=price_source,
        updated_at_ms=updated_at_ms,
    )


def build_contract_kline_current_candle(
    symbol: str,
    *,
    interval: str = DEFAULT_KLINE_INTERVAL,
    latest_kline: Optional[dict[str, Any]] = None,
    live_mid: Optional[Decimal] = None,
    quote_driven: bool = False,
    price_source: str = DISPLAY_PRICE_SOURCE_KLINE_CLOSE,
    now: Optional[datetime] = None,
    mutate_quote_driven_state: bool = True,
) -> Optional[dict[str, Any]]:
    now_dt = now or datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    else:
        now_dt = now_dt.astimezone(timezone.utc)
    normalized_interval = _normalize_interval(interval)
    return _provider_kline_candle(
        latest_kline,
        interval=normalized_interval,
        kline_mode=KLINE_MODE_PROVIDER_KLINE,
        price_source=price_source,
        updated_at_ms=int(now_dt.timestamp() * 1000),
    )


def _kline_source(
    latest_kline: Optional[dict[str, Any]],
    kline_current_candle: Optional[dict[str, Any]],
) -> Optional[str]:
    if not isinstance(kline_current_candle, dict):
        return None
    if isinstance(latest_kline, dict):
        raw_source = latest_kline.get("kline_mode") or latest_kline.get("source") or latest_kline.get("quote_source")
        source = _optional_normalized(raw_source)
        if source:
            return source
    return _optional_normalized(kline_current_candle.get("kline_mode") or kline_current_candle.get("price_source"))


def _kline_freshness(latest_kline: Optional[dict[str, Any]]) -> Optional[str]:
    if not isinstance(latest_kline, dict):
        return None
    return _optional_normalized(latest_kline.get("freshness") or latest_kline.get("quote_freshness"))


def apply_quote_driven_kline_overlays(
    symbol: str,
    interval: str,
    rows: list[dict[str, Any]],
    *,
    limit: Optional[int] = None,
    include_missing: bool = True,
    now: Optional[datetime] = None,
) -> list[dict[str, Any]]:
    merged_rows = [
        dict(item)
        for item in (rows or [])
        if isinstance(item, dict) and _is_provider_kline_row(item)
    ]
    if limit is not None:
        try:
            safe_limit = max(1, int(limit))
            merged_rows = merged_rows[-safe_limit:]
        except (TypeError, ValueError):
            pass
    return merged_rows


def reset_contract_kline_current_candle_state_for_tests() -> None:
    return None


def _last_good_time(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> Optional[datetime]:
    return (
        _to_datetime((quote or {}).get("last_good_at"))
        or _to_datetime((depth or {}).get("last_good_at"))
        or _payload_time(quote)
        or _payload_time(depth)
    )


def _market_status(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    return _normalized((quote or {}).get("market_status") or (depth or {}).get("market_status") or "UNKNOWN")


def _market_session_type(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    return _normalized((quote or {}).get("market_session_type") or (depth or {}).get("market_session_type"))


def _is_non_realtime_bbo_window(
    *,
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
    market_status: str,
) -> bool:
    if market_status in _CLOSED_MARKET_STATUSES:
        return True
    return _market_session_type(quote, depth) in _NON_REALTIME_BBO_SESSION_TYPES


def _closed_market_execution_mode(contract_symbol: Any, quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    return _normalized(
        _attr(contract_symbol, "closed_market_execution_mode")
        or (quote or {}).get("closed_market_execution_mode")
        or (depth or {}).get("closed_market_execution_mode")
        or "DISABLED"
    )


def _explicit_last_good_valid(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> Optional[bool]:
    for payload in (quote, depth):
        value = (payload or {}).get("last_good_bbo_valid")
        if isinstance(value, bool):
            return value
    return None


def _has_last_good_bbo_source(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> bool:
    return _payload_source(quote) == QUOTE_SOURCE_LAST_GOOD_BBO or _payload_source(depth) == QUOTE_SOURCE_LAST_GOOD_BBO


def _last_good_bbo_valid(
    *,
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
    market_status: str,
    bid: Optional[Decimal],
    ask: Optional[Decimal],
    now: datetime,
) -> bool:
    if market_status not in _CLOSED_MARKET_STATUSES:
        return False
    if bid is None or ask is None or bid <= 0 or ask <= 0 or ask < bid:
        return False
    if not _has_last_good_bbo_source(quote, depth):
        return False
    explicit = _explicit_last_good_valid(quote, depth)
    if explicit is not None:
        return explicit
    age = _price_age_ms(_last_good_time(quote, depth), now)
    return age is not None and age <= _LAST_GOOD_BBO_MAX_AGE_MS


def _last_good_bbo_older_than_latest_kline(
    *,
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
    market_status: str,
    latest_kline: Optional[dict[str, Any]],
) -> bool:
    if not _has_last_good_bbo_source(quote, depth):
        return False
    if not _is_non_realtime_bbo_window(quote=quote, depth=depth, market_status=market_status):
        return False
    last_good_at = _last_good_time(quote, depth)
    latest_kline_time = _latest_kline_open_time(latest_kline)
    return last_good_at is not None and latest_kline_time is not None and latest_kline_time > last_good_at


def _raw_executable(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> Optional[bool]:
    for payload in (quote, depth):
        value = (payload or {}).get("executable")
        if isinstance(value, bool):
            return value
    return None


def _raw_source_summary(
    *,
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
    executable: Optional[bool],
    market_status: str,
    latest_kline: Optional[dict[str, Any]],
    latest_trade: Optional[dict[str, Any]],
    trading_session: Any,
    last_good_bbo_valid_raw: bool,
) -> dict[str, Any]:
    latest_kline_open_time = _latest_kline_open_time(latest_kline)
    latest_kline_close = _latest_kline_close(latest_kline)
    latest_trade_time = _latest_trade_time(latest_trade)
    latest_trade_price = _latest_trade_price(latest_trade)
    latest_trade_freshness = _latest_trade_freshness(latest_trade)
    return {
        "quote_source": (quote or {}).get("quote_source") or (quote or {}).get("source"),
        "depth_source": (depth or {}).get("quote_source") or (depth or {}).get("source"),
        "latest_trade_source": (latest_trade or {}).get("source"),
        "latest_trade_price_source": (latest_trade or {}).get("price_source"),
        "latest_trade_freshness": latest_trade_freshness,
        "quote_freshness": (quote or {}).get("quote_freshness") or (depth or {}).get("quote_freshness"),
        "executable": executable,
        "market_status": market_status,
        "market_session_type": getattr(trading_session, "session_type", None),
        "trading_allowed": getattr(trading_session, "trading_allowed", None),
        "trading_session_reason_code": getattr(trading_session, "reason_code", None),
        "closed_market_execution_mode": _closed_market_execution_mode(contract_symbol=None, quote=quote, depth=depth),
        "last_good_bbo_source": _has_last_good_bbo_source(quote, depth),
        "last_good_bbo_valid_raw": last_good_bbo_valid_raw,
        "latest_kline_open_time": latest_kline_open_time.isoformat() if latest_kline_open_time else None,
        "latest_kline_close": _format_decimal(latest_kline_close),
        "kline_source": (latest_kline or {}).get("kline_mode") or (latest_kline or {}).get("source"),
        "kline_freshness": _kline_freshness(latest_kline),
        "latest_trade_time": latest_trade_time.isoformat() if latest_trade_time else None,
        "latest_trade_price": _format_decimal(latest_trade_price),
    }


def _append_warning_once(warnings: list[str], value: str) -> None:
    if value not in warnings:
        warnings.append(value)


def _should_load_latest_kline_for_last_good_check(
    *,
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
    contract_symbol: Any,
    now: Optional[datetime] = None,
) -> bool:
    category = _contract_category(contract_symbol, quote, depth)
    market_status = _market_status(quote, depth)
    trading_session = resolve_contract_trading_session(
        contract_symbol=contract_symbol,
        quote=quote,
        depth=depth,
        now=now,
    )
    return (
        category in _TRADFI_CATEGORIES
        and not _is_crypto_contract(contract_symbol, quote, depth)
        and (
            trading_session.session_type in {SESSION_PRE_MARKET, SESSION_AFTER_HOURS}
            or (
                _has_last_good_bbo_source(quote, depth)
                and _is_non_realtime_bbo_window(quote=quote, depth=depth, market_status=market_status)
            )
        )
    )


def build_contract_market_view(
    symbol: str,
    *,
    quote: Optional[dict[str, Any]] = None,
    depth: Optional[dict[str, Any]] = None,
    latest_kline: Optional[dict[str, Any]] = None,
    latest_trade: Optional[dict[str, Any]] = None,
    contract_symbol: Any = None,
    interval: str = DEFAULT_KLINE_INTERVAL,
    warnings: Optional[list[str]] = None,
    now: Optional[datetime] = None,
    mutate_quote_driven_state: bool = True,
) -> dict[str, Any]:
    normalized_symbol = _normalized(symbol)
    now_dt = now or datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    else:
        now_dt = now_dt.astimezone(timezone.utc)

    category = _contract_category(contract_symbol, quote, depth)
    is_crypto = _is_crypto_contract(contract_symbol, quote, depth)
    market_status = _market_status(quote, depth)
    trading_session = resolve_contract_trading_session(
        contract_symbol=contract_symbol,
        quote=quote,
        depth=depth,
        now=now_dt,
    )
    bid, ask, bbo_payload = _bbo_from_payloads(quote, depth)
    spread = ask - bid if bid is not None and ask is not None else None
    mid = (bid + ask) / Decimal("2") if bid is not None and ask is not None else None
    latest_kline_close = _latest_kline_close(latest_kline)
    latest_trade_price = _latest_trade_price(latest_trade)
    latest_trade_time = _latest_trade_time(latest_trade)
    mark_price = _first_payload_decimal(quote, key="mark_price")
    index_price = _first_payload_decimal(quote, key="index_price")
    reference_price_source = _payload_source_or_none(quote)
    bbo_freshness = _payload_freshness(bbo_payload)
    quote_freshness = _payload_freshness(quote)
    raw_executable = _raw_executable(quote, depth)
    has_bbo = bid is not None and ask is not None and ask >= bid
    is_closed = market_status in _CLOSED_MARKET_STATUSES
    last_good_older_than_kline = _last_good_bbo_older_than_latest_kline(
        quote=quote,
        depth=depth,
        market_status=market_status,
        latest_kline=latest_kline,
    )
    last_good_valid_raw = _last_good_bbo_valid(
        quote=quote,
        depth=depth,
        market_status=market_status,
        bid=bid,
        ask=ask,
        now=now_dt,
    )
    last_good_valid = last_good_valid_raw and not last_good_older_than_kline

    display_state = DISPLAY_STATE_UNAVAILABLE
    display_price_source = DISPLAY_PRICE_SOURCE_NONE
    execution_mode = EXECUTION_MODE_DISABLED
    executable = False
    reason_code = "BBO_UNAVAILABLE"
    display_price = None
    execution_bid = None
    execution_ask = None

    if not quote and not depth:
        display_state = DISPLAY_STATE_UNAVAILABLE
        reason_code = "NO_MARKET_DATA"
    elif is_crypto:
        if not is_closed and bbo_freshness == QUOTE_FRESHNESS_LIVE and raw_executable is not False:
            display_state = DISPLAY_STATE_LIVE_TRADABLE
            display_price_source = DISPLAY_PRICE_SOURCE_LIVE_MID
            execution_mode = EXECUTION_MODE_LIVE_BBO
            executable = True
            reason_code = "LIVE_BBO"
            display_price = mid
            execution_bid = bid
            execution_ask = ask
        else:
            display_state = DISPLAY_STATE_EXPIRED if quote_freshness or bbo_freshness else DISPLAY_STATE_UNAVAILABLE
            reason_code = "CRYPTO_BBO_NOT_LIVE" if display_state == DISPLAY_STATE_EXPIRED else "CRYPTO_BBO_UNAVAILABLE"
            display_price = mid if display_state == DISPLAY_STATE_EXPIRED else None
            display_price_source = DISPLAY_PRICE_SOURCE_LIVE_MID if display_price is not None else DISPLAY_PRICE_SOURCE_NONE
    elif not trading_session.trading_allowed:
        session_state = trading_session.session_type
        display_state = session_state if session_state in _NON_TRADING_DISPLAY_STATES else DISPLAY_STATE_UNAVAILABLE
        reason_code = trading_session.reason_code or "NON_TRADING_SESSION"
        if session_state in {SESSION_PRE_MARKET, SESSION_AFTER_HOURS} and latest_kline_close is not None:
            display_price = latest_kline_close
            display_price_source = DISPLAY_PRICE_SOURCE_KLINE_CLOSE
        elif display_state == DISPLAY_STATE_UNAVAILABLE:
            reason_code = "NON_TRADING_SESSION"
    elif not has_bbo:
        display_state = DISPLAY_STATE_UNAVAILABLE
        reason_code = "BBO_UNAVAILABLE"
    elif bbo_freshness == QUOTE_FRESHNESS_LIVE and raw_executable is not False:
        display_state = DISPLAY_STATE_LIVE_TRADABLE
        display_price_source = DISPLAY_PRICE_SOURCE_LIVE_MID
        execution_mode = EXECUTION_MODE_LIVE_BBO
        executable = True
        reason_code = "LIVE_BBO"
        display_price = mid
        execution_bid = bid
        execution_ask = ask
    elif last_good_older_than_kline or (is_closed and _has_last_good_bbo_source(quote, depth)):
        display_state = DISPLAY_STATE_EXPIRED
        reason_code = "LAST_GOOD_BBO_OLDER_THAN_KLINE" if last_good_older_than_kline else "LAST_GOOD_BBO_DIAGNOSTIC_ONLY"
    else:
        display_state = DISPLAY_STATE_EXPIRED if quote_freshness or bbo_freshness else DISPLAY_STATE_UNAVAILABLE
        display_price = mid if display_state == DISPLAY_STATE_EXPIRED else None
        display_price_source = DISPLAY_PRICE_SOURCE_LIVE_MID if display_price is not None else DISPLAY_PRICE_SOURCE_NONE
        reason_code = "QUOTE_STALE" if display_state == DISPLAY_STATE_EXPIRED else "BBO_UNAVAILABLE"

    quote_time = _payload_time(bbo_payload) or _payload_time(quote) or _payload_time(depth)
    current_price_source = display_price_source
    if not is_crypto and latest_trade_price is not None:
        display_price = latest_trade_price
        display_price_source = DISPLAY_PRICE_SOURCE_TRADE_TICK
        current_price_source = DISPLAY_PRICE_SOURCE_TRADE_TICK
    elif not is_crypto and latest_kline_close is not None and display_price is None:
        display_price = latest_kline_close
        display_price_source = DISPLAY_PRICE_SOURCE_KLINE_CLOSE
        current_price_source = DISPLAY_PRICE_SOURCE_KLINE_CLOSE

    kline_current_candle = build_contract_kline_current_candle(
        normalized_symbol,
        interval=interval,
        latest_kline=latest_kline,
        live_mid=mid,
        quote_driven=False,
        price_source=DISPLAY_PRICE_SOURCE_KLINE_CLOSE,
        now=now_dt,
        mutate_quote_driven_state=mutate_quote_driven_state,
    )
    ticker_source = _payload_source_or_none(quote)
    ticker_freshness = _payload_freshness_or_none(quote)
    depth_source = _payload_source_or_none(depth)
    depth_freshness = _payload_freshness_or_none(depth)
    trades_source = _latest_trade_source(latest_trade)
    trades_freshness = _latest_trade_freshness(latest_trade)
    kline_source = _kline_source(latest_kline, kline_current_candle)
    kline_freshness = _kline_freshness(latest_kline)

    source_warnings = list(warnings or [])
    if last_good_older_than_kline:
        _append_warning_once(source_warnings, "KLINE_QUOTE_SESSION_MISMATCH")
        _append_warning_once(source_warnings, "LAST_GOOD_BBO_OLDER_THAN_KLINE")
    if not trading_session.trading_allowed and display_state != DISPLAY_STATE_UNAVAILABLE:
        _append_warning_once(source_warnings, "non_trading_session")
    if _has_last_good_bbo_source(quote, depth):
        _append_warning_once(source_warnings, "last_good_bbo_diagnostic_only")
    if display_state == DISPLAY_STATE_EXPIRED:
        _append_warning_once(source_warnings, "market_price_expired")
    if not has_bbo:
        _append_warning_once(source_warnings, "missing_bbo")

    spread_x = _first_payload_decimal(bbo_payload, quote, depth, key="spread_x") or Decimal("0")
    manual_spread_x = _first_payload_decimal(bbo_payload, quote, depth, key="manual_spread_x") or Decimal("0")
    effective_total_spread = _first_payload_decimal(bbo_payload, quote, depth, key="effective_total_spread") or spread_x
    single_side_spread_fee_price = (
        _first_payload_decimal(bbo_payload, quote, depth, key="single_side_spread_fee_price")
        or (effective_total_spread / Decimal("2") if effective_total_spread is not None else Decimal("0"))
    )

    return {
        "symbol": normalized_symbol,
        "display_symbol": _display_symbol(normalized_symbol, contract_symbol),
        "view_version": "2",
        "authority_source": "LEGACY_COMPAT",
        "snapshot_authority": False,
        "market_type": MARKET_TYPE_CONTRACT,
        "category": category,
        "market_status": market_status,
        "display_state": display_state,
        "display_price": _format_decimal(display_price),
        "display_price_source": display_price_source,
        "current_price_source": current_price_source,
        "mark_price": _format_decimal(mark_price),
        "mark_price_source": reference_price_source,
        "index_price": _format_decimal(index_price),
        "index_price_source": reference_price_source,
        "ticker_source": ticker_source,
        "ticker_freshness": ticker_freshness,
        "depth_source": depth_source,
        "depth_freshness": depth_freshness,
        "trades_source": trades_source,
        "trades_freshness": trades_freshness,
        "kline_source": kline_source,
        "kline_freshness": kline_freshness,
        "last_trade_price": _format_decimal(latest_trade_price),
        "last_trade_time": latest_trade_time,
        "best_bid": _format_decimal(bid),
        "best_ask": _format_decimal(ask),
        "spread": _format_decimal(spread),
        "spread_x": _format_decimal(spread_x),
        "manual_spread_x": _format_decimal(manual_spread_x),
        "effective_total_spread": _format_decimal(effective_total_spread),
        "single_side_spread_fee_price": _format_decimal(single_side_spread_fee_price),
        "executable": executable,
        "execution_bid": _format_decimal(execution_bid),
        "execution_ask": _format_decimal(execution_ask),
        "execution_mode": execution_mode,
        "last_good_bbo_valid": False,
        "price_age_ms": _price_age_ms(quote_time, now_dt),
        "quote_time": quote_time,
        "last_good_at": _last_good_time(quote, depth),
        "reason_code": reason_code,
        "warnings": source_warnings,
        "kline_current_candle": kline_current_candle,
        "ticker": deepcopy(quote) if isinstance(quote, dict) else None,
        "depth": deepcopy(depth) if isinstance(depth, dict) else None,
        "trades": [deepcopy(latest_trade)] if isinstance(latest_trade, dict) else [],
        "kline": deepcopy(latest_kline) if isinstance(latest_kline, dict) else None,
        "snapshot_metadata": {},
        "raw_source_summary": _raw_source_summary(
            quote=quote,
            depth=depth,
            executable=raw_executable,
            market_status=market_status,
            latest_kline=latest_kline,
            latest_trade=latest_trade,
            trading_session=trading_session,
            last_good_bbo_valid_raw=last_good_valid_raw,
        ),
    }


def _snapshot_domain_payload(
    snapshot: Optional[ContractMarketDomainSnapshot[Any]],
    *,
    expected_domain: ContractMarketDomainName,
    symbol: str,
    warnings: list[str],
    now: datetime,
) -> Any:
    domain_name = expected_domain.value
    if snapshot is None:
        _append_warning_once(warnings, f"{domain_name}_snapshot_missing")
        return None
    metadata = snapshot.metadata
    if metadata.domain != expected_domain or _normalized(metadata.symbol) != symbol:
        _append_warning_once(warnings, f"{domain_name}_snapshot_identity_mismatch")
        return None
    observed_at_ms = next(
        (
            value
            for value in (
                metadata.received_at_ms,
                metadata.cache_updated_at_ms,
                metadata.db_updated_at_ms,
            )
            if value is not None
        ),
        None,
    )
    dynamically_stale = bool(
        metadata.stale
        or (
            observed_at_ms is not None
            and metadata.ttl_ms is not None
            and int(now.timestamp() * 1000) - observed_at_ms > metadata.ttl_ms
        )
    )
    if dynamically_stale:
        _append_warning_once(warnings, f"{domain_name}_snapshot_stale")
    completeness = metadata.completeness.status.value.lower()
    if completeness != "complete":
        _append_warning_once(
            warnings,
            f"{domain_name}_snapshot_{completeness}",
        )
    payload = deepcopy(snapshot.data)
    if isinstance(payload, dict):
        payload.setdefault("source", metadata.source.value)
        payload.setdefault("quote_source", metadata.source.value)
        payload.setdefault("freshness", metadata.freshness.value)
        payload.setdefault("quote_freshness", metadata.freshness.value)
        if dynamically_stale:
            payload["freshness"] = "STALE"
            payload["quote_freshness"] = "STALE"
            if expected_domain in {
                ContractMarketDomainName.TICKER,
                ContractMarketDomainName.DEPTH,
            }:
                payload["executable"] = False
        if metadata.provider is not None:
            payload.setdefault("provider", metadata.provider)
        if metadata.provider_symbol is not None:
            payload.setdefault("provider_symbol", metadata.provider_symbol)
    return payload


def _trades_from_snapshot_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [deepcopy(item) for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("trades", "items", "rows"):
            values = payload.get(key)
            if isinstance(values, list):
                return [deepcopy(item) for item in values if isinstance(item, dict)]
        if payload.get("price") is not None:
            return [deepcopy(payload)]
    return []


def _latest_kline_from_snapshot_payload(payload: Any) -> Optional[dict[str, Any]]:
    if isinstance(payload, list):
        rows = [item for item in payload if isinstance(item, dict)]
        return deepcopy(rows[-1]) if rows else None
    if isinstance(payload, dict):
        for key in ("items", "klines", "rows"):
            values = payload.get(key)
            if isinstance(values, list):
                rows = [item for item in values if isinstance(item, dict)]
                return deepcopy(rows[-1]) if rows else None
        return deepcopy(payload)
    return None


def _snapshot_metadata_payload(
    snapshots: dict[str, Optional[ContractMarketDomainSnapshot[Any]]],
) -> dict[str, Any]:
    return {
        domain: snapshot.metadata.model_dump(mode="json")
        for domain, snapshot in snapshots.items()
        if snapshot is not None
    }


def build_contract_market_view_v2(
    symbol: str,
    *,
    ticker_snapshot: Optional[ContractMarketDomainSnapshot[Any]],
    depth_snapshot: Optional[ContractMarketDomainSnapshot[Any]],
    trades_snapshot: Optional[ContractMarketDomainSnapshot[Any]],
    kline_snapshot: Optional[ContractMarketDomainSnapshot[Any]],
    contract_symbol: Any = None,
    interval: str = DEFAULT_KLINE_INTERVAL,
    warnings: Optional[list[str]] = None,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Build public Contract MarketView exclusively from accepted snapshots."""

    normalized_symbol = _normalized(symbol)
    now_dt = now or datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    else:
        now_dt = now_dt.astimezone(timezone.utc)
    source_warnings = list(warnings or [])
    ticker = _snapshot_domain_payload(
        ticker_snapshot,
        expected_domain=ContractMarketDomainName.TICKER,
        symbol=normalized_symbol,
        warnings=source_warnings,
        now=now_dt,
    )
    depth = _snapshot_domain_payload(
        depth_snapshot,
        expected_domain=ContractMarketDomainName.DEPTH,
        symbol=normalized_symbol,
        warnings=source_warnings,
        now=now_dt,
    )
    trades_payload = _snapshot_domain_payload(
        trades_snapshot,
        expected_domain=ContractMarketDomainName.TRADES,
        symbol=normalized_symbol,
        warnings=source_warnings,
        now=now_dt,
    )
    kline_payload = _snapshot_domain_payload(
        kline_snapshot,
        expected_domain=ContractMarketDomainName.KLINE,
        symbol=normalized_symbol,
        warnings=source_warnings,
        now=now_dt,
    )
    trades = _trades_from_snapshot_payload(trades_payload)
    latest_trade = trades[0] if trades else None
    latest_kline = _latest_kline_from_snapshot_payload(kline_payload)
    view = build_contract_market_view(
        normalized_symbol,
        quote=ticker if isinstance(ticker, dict) else None,
        depth=depth if isinstance(depth, dict) else None,
        latest_kline=latest_kline,
        latest_trade=latest_trade,
        contract_symbol=contract_symbol,
        interval=interval,
        warnings=source_warnings,
        now=now_dt,
        mutate_quote_driven_state=False,
    )
    snapshots = {
        "ticker": ticker_snapshot,
        "depth": depth_snapshot,
        "trades": trades_snapshot,
        "kline": kline_snapshot,
    }
    view.update(
        {
            "view_version": "2",
            "authority_source": "SNAPSHOT_AUTHORITY",
            "snapshot_authority": True,
            "ticker": ticker if isinstance(ticker, dict) else None,
            "depth": depth if isinstance(depth, dict) else None,
            "trades": trades,
            "kline": latest_kline,
            "snapshot_metadata": _snapshot_metadata_payload(snapshots),
        }
    )
    return view


def get_contract_market_snapshot_authority(*args: Any, **kwargs: Any) -> dict[str, Any]:
    from app.services.contract_market_service import (
        get_contract_market_snapshot_authority as load_snapshot_authority,
    )

    return load_snapshot_authority(*args, **kwargs)


def get_contract_market_view_legacy_inputs(*args: Any, **kwargs: Any) -> dict[str, Any]:
    from app.services.contract_market_service import (
        get_contract_market_view_legacy_inputs as load_legacy_inputs,
    )

    return load_legacy_inputs(*args, **kwargs)


def get_contract_market_view(db: Session, symbol: str) -> dict[str, Any]:
    normalized_symbol = _normalized(symbol)
    contract_symbol = (
        db.query(ContractSymbol)
        .filter(ContractSymbol.symbol == normalized_symbol)
        .first()
    )
    authority = get_contract_market_snapshot_authority(
        normalized_symbol,
        interval=DEFAULT_KLINE_INTERVAL,
    )
    snapshots = (
        authority.get("ticker"),
        authority.get("depth"),
        authority.get("trades"),
        authority.get("kline"),
    )
    if contract_symbol is None and not any(snapshot is not None for snapshot in snapshots):
        raise ContractSymbolNotFound(f"contract symbol {normalized_symbol} not found")
    return build_contract_market_view_v2(
        normalized_symbol,
        ticker_snapshot=authority.get("ticker"),
        depth_snapshot=authority.get("depth"),
        trades_snapshot=authority.get("trades"),
        kline_snapshot=authority.get("kline"),
        contract_symbol=contract_symbol,
        interval=DEFAULT_KLINE_INTERVAL,
        warnings=authority.get("warnings") or [],
    )


def get_contract_execution_view(db: Session, symbol: str) -> dict[str, Any]:
    legacy_inputs = get_contract_market_view_legacy_inputs(db, symbol)
    view = build_contract_market_view(
        legacy_inputs["symbol"],
        quote=legacy_inputs.get("quote"),
        depth=legacy_inputs.get("depth"),
        latest_kline=legacy_inputs.get("latest_kline"),
        latest_trade=legacy_inputs.get("latest_trade"),
        contract_symbol=legacy_inputs.get("contract_symbol"),
        interval=DEFAULT_KLINE_INTERVAL,
        warnings=legacy_inputs.get("warnings") or [],
        mutate_quote_driven_state=False,
    )
    keys = (
        "symbol",
        "executable",
        "execution_bid",
        "execution_ask",
        "display_price",
        "display_state",
        "execution_mode",
        "reason_code",
        "warnings",
        "raw_source_summary",
        "spread",
        "spread_x",
        "manual_spread_x",
        "effective_total_spread",
        "single_side_spread_fee_price",
        "price_age_ms",
        "quote_time",
        "last_good_at",
    )
    return {key: view.get(key) for key in keys}
