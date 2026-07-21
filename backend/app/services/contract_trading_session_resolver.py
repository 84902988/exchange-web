from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time as dt_time, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SESSION_PRE_MARKET = "PRE_MARKET"
SESSION_REGULAR_OPEN = "REGULAR_OPEN"
SESSION_AFTER_HOURS = "AFTER_HOURS"
SESSION_CLOSED = "CLOSED"
SESSION_HOLIDAY = "HOLIDAY"
SESSION_UNKNOWN = "UNKNOWN"

REASON_REGULAR_OPEN = "REGULAR_OPEN"
REASON_PRE_MARKET = "PRE_MARKET"
REASON_AFTER_HOURS = "AFTER_HOURS"
REASON_MARKET_CLOSED = "MARKET_CLOSED"
REASON_HOLIDAY = "HOLIDAY"
REASON_NON_TRADING_SESSION = "NON_TRADING_SESSION"
REASON_CRYPTO_24_7 = "CRYPTO_24_7"
REASON_TRADING_SESSION_UNKNOWN = "TRADING_SESSION_UNKNOWN"

_US_EQUITY_CATEGORIES = {"STOCK"}
_PROVIDER_SESSION_CATEGORIES = {
    "CFD",
    "INDEX",
    "FOREX",
    "METAL",
    "GOLD",
    "COMMODITY",
    "FUTURES",
}
_CRYPTO_CATEGORIES = {"CRYPTO"}
_OPEN_MARKET_STATUSES = {"OPEN", "TRADING"}
_CLOSED_MARKET_STATUSES = {"CLOSED", "SUSPENDED"}
_HOLIDAY_MARKET_STATUSES = {"HOLIDAY"}


@dataclass(frozen=True)
class ContractTradingSession:
    session_type: str
    is_regular_open: bool
    is_extended_hours: bool
    is_holiday: bool
    trading_allowed: bool
    reason_code: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "session_type": self.session_type,
            "is_regular_open": self.is_regular_open,
            "is_extended_hours": self.is_extended_hours,
            "is_holiday": self.is_holiday,
            "trading_allowed": self.trading_allowed,
            "reason_code": self.reason_code,
        }


def _normalized(value: Any) -> str:
    return str(value or "").strip().upper()


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
    if category in {"SILVER", "METALS"}:
        return "METAL"
    if category == "GOLD":
        return "METAL"
    if category in {"FUTURE", "OIL", "ENERGY"}:
        return "COMMODITY"
    return category


def _provider(contract_symbol: Any, quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    return _normalized(
        _attr(contract_symbol, "provider")
        or (quote or {}).get("provider")
        or (depth or {}).get("provider")
    )


def _first_payload_value(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]], key: str) -> Any:
    quote_value = (quote or {}).get(key)
    if quote_value not in (None, ""):
        return quote_value
    return (depth or {}).get(key)


def _raw_session_type(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    return _normalized(_first_payload_value(quote, depth, "market_session_type"))


def _market_status(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    return _normalized(_first_payload_value(quote, depth, "market_status"))


def _session_from_raw(value: str) -> Optional[str]:
    normalized = _normalized(value)
    if normalized in {"REGULAR", "REGULAR_OPEN", "OPEN"}:
        return SESSION_REGULAR_OPEN
    if normalized in {"PRE_MARKET", "PREMARKET"}:
        return SESSION_PRE_MARKET
    if normalized in {"AFTER_HOURS", "POST_MARKET", "POSTMARKET"}:
        return SESSION_AFTER_HOURS
    if normalized == "HOLIDAY":
        return SESSION_HOLIDAY
    if normalized == "CLOSED":
        return SESSION_CLOSED
    return None


def _session_result(session_type: str, *, reason_code: Optional[str] = None) -> ContractTradingSession:
    is_regular_open = session_type == SESSION_REGULAR_OPEN
    is_extended_hours = session_type in {SESSION_PRE_MARKET, SESSION_AFTER_HOURS}
    is_holiday = session_type == SESSION_HOLIDAY
    if reason_code is None:
        reason_code = {
            SESSION_REGULAR_OPEN: REASON_REGULAR_OPEN,
            SESSION_PRE_MARKET: REASON_PRE_MARKET,
            SESSION_AFTER_HOURS: REASON_AFTER_HOURS,
            SESSION_HOLIDAY: REASON_HOLIDAY,
            SESSION_CLOSED: REASON_MARKET_CLOSED,
        }.get(session_type, REASON_TRADING_SESSION_UNKNOWN)
    return ContractTradingSession(
        session_type=session_type,
        is_regular_open=is_regular_open,
        is_extended_hours=is_extended_hours,
        is_holiday=is_holiday,
        trading_allowed=is_regular_open,
        reason_code=reason_code,
    )


def _timezone_name(quote: Optional[dict[str, Any]], depth: Optional[dict[str, Any]]) -> str:
    raw = str(_first_payload_value(quote, depth, "market_timezone") or "").strip()
    aliases = {
        "EST": "America/New_York",
        "EDT": "America/New_York",
    }
    return aliases.get(raw.upper(), raw or "America/New_York")


def _now_in_timezone(timezone_name: str, now: Optional[datetime]) -> datetime:
    base = now or datetime.now(timezone.utc)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    try:
        return base.astimezone(ZoneInfo(timezone_name))
    except ZoneInfoNotFoundError:
        return base.astimezone(timezone.utc)


def _us_equity_session_from_clock(current_time: dt_time) -> str:
    if dt_time(4, 0) <= current_time < dt_time(9, 30):
        return SESSION_PRE_MARKET
    if dt_time(9, 30) <= current_time < dt_time(16, 0):
        return SESSION_REGULAR_OPEN
    if dt_time(16, 0) <= current_time < dt_time(20, 0):
        return SESSION_AFTER_HOURS
    return SESSION_CLOSED


def _resolve_us_equity_session(
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
    now: Optional[datetime],
) -> ContractTradingSession:
    market_status = _market_status(quote, depth)
    raw_session = _session_from_raw(_raw_session_type(quote, depth))
    if raw_session == SESSION_REGULAR_OPEN:
        return _session_result(SESSION_REGULAR_OPEN)
    if raw_session == SESSION_PRE_MARKET:
        return _session_result(SESSION_PRE_MARKET)
    if raw_session == SESSION_AFTER_HOURS:
        return _session_result(SESSION_AFTER_HOURS)
    if raw_session == SESSION_HOLIDAY or market_status in _HOLIDAY_MARKET_STATUSES:
        return _session_result(SESSION_HOLIDAY)
    if raw_session == SESSION_CLOSED:
        return _session_result(SESSION_CLOSED)

    if market_status in _OPEN_MARKET_STATUSES:
        return _session_result(SESSION_REGULAR_OPEN)
    if market_status == "SUSPENDED":
        return _session_result(SESSION_CLOSED)
    if market_status in _CLOSED_MARKET_STATUSES:
        current = _now_in_timezone(_timezone_name(quote, depth), now)
        return _session_result(_us_equity_session_from_clock(current.time()))

    return _session_result(SESSION_UNKNOWN, reason_code=REASON_TRADING_SESSION_UNKNOWN)


def _resolve_provider_session(
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
) -> ContractTradingSession:
    market_status = _market_status(quote, depth)
    if market_status in _HOLIDAY_MARKET_STATUSES:
        return _session_result(SESSION_HOLIDAY)
    if market_status in _OPEN_MARKET_STATUSES:
        return _session_result(SESSION_REGULAR_OPEN)
    if market_status in _CLOSED_MARKET_STATUSES:
        return _session_result(SESSION_CLOSED)
    return _session_result(SESSION_UNKNOWN, reason_code=REASON_TRADING_SESSION_UNKNOWN)


def resolve_contract_trading_session(
    *,
    contract_symbol: Any = None,
    quote: Optional[dict[str, Any]] = None,
    depth: Optional[dict[str, Any]] = None,
    now: Optional[datetime] = None,
) -> ContractTradingSession:
    category = _contract_category(contract_symbol, quote, depth)
    provider = _provider(contract_symbol, quote, depth)
    if category in _CRYPTO_CATEGORIES or provider == "BINANCE":
        return ContractTradingSession(
            session_type=SESSION_REGULAR_OPEN,
            is_regular_open=True,
            is_extended_hours=False,
            is_holiday=False,
            trading_allowed=True,
            reason_code=REASON_CRYPTO_24_7,
        )
    if category in _US_EQUITY_CATEGORIES:
        return _resolve_us_equity_session(quote, depth, now)
    if category in _PROVIDER_SESSION_CATEGORIES:
        return _resolve_provider_session(quote, depth)
    return _resolve_provider_session(quote, depth)
