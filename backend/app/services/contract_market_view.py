from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.contract_symbol import ContractSymbol
from app.services.contract_market_guard import (
    QUOTE_FRESHNESS_LIVE,
    QUOTE_SOURCE_LAST_GOOD_BBO,
)
from app.services.contract_market_service import (
    ContractSymbolNotFound,
    get_contract_depth,
    get_contract_klines,
    get_contract_quote,
    get_contract_recent_trades,
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
    return {
        "quote_source": (quote or {}).get("quote_source") or (quote or {}).get("source"),
        "depth_source": (depth or {}).get("quote_source") or (depth or {}).get("source"),
        "latest_trade_source": (latest_trade or {}).get("source"),
        "latest_trade_price_source": (latest_trade or {}).get("price_source"),
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
        "market_type": MARKET_TYPE_CONTRACT,
        "category": category,
        "market_status": market_status,
        "display_state": display_state,
        "display_price": _format_decimal(display_price),
        "display_price_source": display_price_source,
        "current_price_source": current_price_source,
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


def get_contract_market_view(db: Session, symbol: str) -> dict[str, Any]:
    normalized_symbol = _normalized(symbol)
    contract_symbol = (
        db.query(ContractSymbol)
        .filter(ContractSymbol.symbol == normalized_symbol)
        .first()
    )
    quote: Optional[dict[str, Any]] = None
    depth: Optional[dict[str, Any]] = None
    latest_kline: Optional[dict[str, Any]] = None
    latest_trade: Optional[dict[str, Any]] = None
    warnings: list[str] = []

    try:
        quote = get_contract_quote(db, normalized_symbol, log_context="contract_market_view_quote")
    except ContractSymbolNotFound:
        if contract_symbol is None:
            raise
        warnings.append("quote_unavailable")
    except Exception as exc:
        warnings.append(f"quote_unavailable:{type(exc).__name__}")

    try:
        depth = get_contract_depth(db, normalized_symbol, limit=5)
    except ContractSymbolNotFound:
        if contract_symbol is None and quote is None:
            raise
        warnings.append("depth_unavailable")
    except Exception as exc:
        warnings.append(f"depth_unavailable:{type(exc).__name__}")

    try:
        recent_trades = get_contract_recent_trades(db, normalized_symbol, limit=1)
        first_trade = recent_trades[0] if recent_trades else None
        if isinstance(first_trade, dict) and _normalized(first_trade.get("price_source")) == DISPLAY_PRICE_SOURCE_TRADE_TICK:
            latest_trade = first_trade
    except Exception as exc:
        warnings.append(f"trade_tick_unavailable:{type(exc).__name__}")

    should_load_current_kline = (
        _contract_category(contract_symbol, quote, depth) in _TRADFI_CATEGORIES
        and not _is_crypto_contract(contract_symbol, quote, depth)
    )
    if should_load_current_kline or _should_load_latest_kline_for_last_good_check(
        quote=quote,
        depth=depth,
        contract_symbol=contract_symbol,
    ):
        try:
            rows = get_contract_klines(db, symbol=normalized_symbol, interval="1m", limit=1)
            latest_kline = rows[-1] if rows else None
        except Exception as exc:
            warnings.append(f"kline_unavailable:{type(exc).__name__}")

    return build_contract_market_view(
        normalized_symbol,
        quote=quote,
        depth=depth,
        latest_kline=latest_kline,
        latest_trade=latest_trade,
        contract_symbol=contract_symbol,
        interval=DEFAULT_KLINE_INTERVAL,
        warnings=warnings,
        mutate_quote_driven_state=False,
    )


def get_contract_execution_view(db: Session, symbol: str) -> dict[str, Any]:
    view = get_contract_market_view(db, symbol)
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
