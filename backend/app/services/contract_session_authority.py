from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.services.contract_session_profiles import (
    SESSION_AFTER_HOURS,
    SESSION_CLOSED,
    SESSION_HOLIDAY,
    SESSION_PRE_MARKET,
    SESSION_REGULAR_OPEN,
    SESSION_UNKNOWN,
    get_contract_session_profile,
    session_state_for_profile,
)
from app.services.itick_holiday_service import (
    HOLIDAY_DAY_EARLY_CLOSE,
    HOLIDAY_DAY_HOLIDAY,
    HOLIDAY_DAY_UNKNOWN,
    ItickHolidayService,
    itick_holiday_service,
)


FEED_LIVE = "LIVE"
FEED_STALE = "STALE"
FEED_UNAVAILABLE = "UNAVAILABLE"

INSTRUMENT_NORMAL = "NORMAL"
INSTRUMENT_SUSPENDED = "SUSPENDED"
INSTRUMENT_DELISTED = "DELISTED"
INSTRUMENT_CIRCUIT_BREAKER = "CIRCUIT_BREAKER"
INSTRUMENT_UNKNOWN = "UNKNOWN"

EXECUTION_TRADABLE = "TRADABLE"
EXECUTION_DISPLAY_ONLY = "DISPLAY_ONLY"
EXECUTION_BLOCKED = "BLOCKED"


@dataclass(frozen=True)
class ContractSessionDecision:
    session_state: str
    feed_state: str
    instrument_state: str
    execution_state: str
    trading_allowed: bool
    reason_code: str
    session_profile_code: Optional[str]
    holiday_calendar_code: Optional[str]
    timezone_name: Optional[str]
    holiday_name: Optional[str] = None
    trading_hours: Optional[str] = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "market_session_type": self.session_state,
            "feed_state": self.feed_state,
            "instrument_state": self.instrument_state,
            "execution_state": self.execution_state,
            "trading_allowed": self.trading_allowed,
            "session_reason_code": self.reason_code,
            "session_profile_code": self.session_profile_code,
            "holiday_calendar_code": self.holiday_calendar_code,
            "market_timezone": self.timezone_name,
            "market_trading_hours": self.trading_hours,
            "holiday_name": self.holiday_name,
        }


class ContractSessionAuthority:
    """Single backend owner for Contract session and tradability state.

    Provider routing, quote freshness and exchange sessions are deliberately
    separate inputs. The hot-path resolver only reads the prewarmed holiday
    cache; it never performs an iTick HTTP request.
    """

    def __init__(self, holiday_service: Optional[ItickHolidayService] = None) -> None:
        self._holiday_service = holiday_service or itick_holiday_service

    def resolve(
        self,
        *,
        contract_symbol: Any,
        quote: Optional[dict[str, Any]] = None,
        now: Optional[datetime] = None,
        feed_state: Optional[str] = None,
        instrument_state: Optional[str] = None,
    ) -> ContractSessionDecision:
        profile_code = _normalized(_attr(contract_symbol, "session_profile_code"))
        calendar_code = _normalized(_attr(contract_symbol, "holiday_calendar_code")) or None
        profile = get_contract_session_profile(profile_code)
        normalized_feed = _resolve_feed_state(feed_state, quote)
        normalized_instrument = _resolve_instrument_state(
            instrument_state,
            quote,
            provider=_normalized(_attr(contract_symbol, "provider")),
            feed_state=normalized_feed,
        )
        extended_hours_mode = _normalized(
            _attr(contract_symbol, "extended_hours_execution_mode") or "DISPLAY_ONLY"
        )
        if profile is None:
            return self._blocked_unknown(
                feed_state=normalized_feed,
                instrument_state=normalized_instrument,
                profile_code=profile_code or None,
                calendar_code=calendar_code,
                timezone_name=None,
                reason_code="SESSION_PROFILE_MISSING_OR_UNSUPPORTED",
            )

        timezone_name = str(_attr(contract_symbol, "session_timezone_override") or "").strip()
        timezone_name = timezone_name or profile.timezone_name
        current = _now_in_timezone(timezone_name, now)
        if current is None:
            return self._blocked_unknown(
                feed_state=normalized_feed,
                instrument_state=normalized_instrument,
                profile_code=profile.code,
                calendar_code=calendar_code,
                timezone_name=timezone_name,
                reason_code="SESSION_TIMEZONE_INVALID",
            )

        holiday_name: Optional[str] = None
        regular_close_override = None
        if profile.holiday_calendar_required:
            if not calendar_code:
                return self._blocked_unknown(
                    feed_state=normalized_feed,
                    instrument_state=normalized_instrument,
                    profile_code=profile.code,
                    calendar_code=None,
                    timezone_name=timezone_name,
                    reason_code="HOLIDAY_CALENDAR_MISSING",
                )
            holiday_day = self._holiday_service.get_holiday_day(
                calendar_code,
                current.date(),
                allow_network=False,
            )
            holiday_name = holiday_day.holiday_name
            if holiday_day.state == HOLIDAY_DAY_UNKNOWN:
                return self._blocked_unknown(
                    feed_state=normalized_feed,
                    instrument_state=normalized_instrument,
                    profile_code=profile.code,
                    calendar_code=calendar_code,
                    timezone_name=timezone_name,
                    reason_code="HOLIDAY_CALENDAR_UNAVAILABLE",
                )
            if holiday_day.state == HOLIDAY_DAY_HOLIDAY:
                session_state = SESSION_HOLIDAY
            else:
                if holiday_day.state == HOLIDAY_DAY_EARLY_CLOSE:
                    regular_close_override = holiday_day.regular_close_time
                session_state = session_state_for_profile(
                    profile,
                    current,
                    regular_close_override=regular_close_override,
                )
        else:
            session_state = session_state_for_profile(profile, current)

        execution_state, reason_code = _execution_state(
            session_state=session_state,
            feed_state=normalized_feed,
            instrument_state=normalized_instrument,
            extended_hours_mode=extended_hours_mode,
        )
        return ContractSessionDecision(
            session_state=session_state,
            feed_state=normalized_feed,
            instrument_state=normalized_instrument,
            execution_state=execution_state,
            trading_allowed=execution_state == EXECUTION_TRADABLE,
            reason_code=reason_code,
            session_profile_code=profile.code,
            holiday_calendar_code=calendar_code,
            timezone_name=timezone_name,
            holiday_name=holiday_name,
            trading_hours=profile.trading_hours,
        )

    def _blocked_unknown(
        self,
        *,
        feed_state: str,
        instrument_state: str,
        profile_code: Optional[str],
        calendar_code: Optional[str],
        timezone_name: Optional[str],
        reason_code: str,
    ) -> ContractSessionDecision:
        return ContractSessionDecision(
            session_state=SESSION_UNKNOWN,
            feed_state=feed_state,
            instrument_state=instrument_state,
            execution_state=EXECUTION_BLOCKED,
            trading_allowed=False,
            reason_code=reason_code,
            session_profile_code=profile_code,
            holiday_calendar_code=calendar_code,
            timezone_name=timezone_name,
        )


def _attr(source: Any, name: str) -> Any:
    if source is None:
        return None
    if isinstance(source, dict):
        return source.get(name)
    return getattr(source, name, None)


def _normalized(value: Any) -> str:
    return str(value or "").strip().upper()


def _now_in_timezone(timezone_name: str, now: Optional[datetime]) -> Optional[datetime]:
    base = now or datetime.now(timezone.utc)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    try:
        return base.astimezone(ZoneInfo(timezone_name))
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _resolve_feed_state(value: Optional[str], quote: Optional[dict[str, Any]]) -> str:
    normalized = _normalized(value or (quote or {}).get("feed_state") or (quote or {}).get("quote_freshness"))
    if normalized in {"LIVE", "REALTIME", "FRESH"}:
        return FEED_LIVE
    if normalized in {"STALE", "LAST_VALID", "LAST_GOOD_BBO", "FALLBACK", "DELAYED"}:
        return FEED_STALE
    return FEED_UNAVAILABLE


def _resolve_instrument_state(
    value: Optional[str],
    quote: Optional[dict[str, Any]],
    *,
    provider: str,
    feed_state: str,
) -> str:
    normalized = _normalized(value or (quote or {}).get("instrument_state"))
    if normalized in {
        INSTRUMENT_NORMAL,
        INSTRUMENT_SUSPENDED,
        INSTRUMENT_DELISTED,
        INSTRUMENT_CIRCUIT_BREAKER,
        INSTRUMENT_UNKNOWN,
    }:
        return normalized
    raw_ts = (quote or {}).get("provider_trading_status")
    if raw_ts is None:
        raw_ts = (quote or {}).get("ts")
    mapping = {
        "0": INSTRUMENT_NORMAL,
        "1": INSTRUMENT_SUSPENDED,
        "2": INSTRUMENT_DELISTED,
        "3": INSTRUMENT_CIRCUIT_BREAKER,
    }
    if raw_ts is not None and str(raw_ts).strip() in mapping:
        return mapping[str(raw_ts).strip()]
    if provider == "BINANCE":
        return INSTRUMENT_NORMAL
    # Several iTick FX/CFD channels omit the optional provider status field.
    # A current provider-native frame is positive active-instrument evidence;
    # explicit suspension/delisting/circuit-breaker codes above still win.
    if provider == "ITICK" and feed_state == FEED_LIVE and isinstance(quote, dict):
        return INSTRUMENT_NORMAL
    return INSTRUMENT_UNKNOWN


def _execution_state(
    *,
    session_state: str,
    feed_state: str,
    instrument_state: str,
    extended_hours_mode: str,
) -> tuple[str, str]:
    if instrument_state in {
        INSTRUMENT_SUSPENDED,
        INSTRUMENT_DELISTED,
        INSTRUMENT_CIRCUIT_BREAKER,
    }:
        return EXECUTION_BLOCKED, f"INSTRUMENT_{instrument_state}"
    if session_state in {SESSION_PRE_MARKET, SESSION_AFTER_HOURS}:
        if extended_hours_mode == "BLOCKED":
            return EXECUTION_BLOCKED, f"{session_state}_BLOCKED"
        return EXECUTION_DISPLAY_ONLY, session_state
    if session_state in {SESSION_CLOSED, SESSION_HOLIDAY}:
        return EXECUTION_DISPLAY_ONLY, session_state
    if session_state == SESSION_UNKNOWN:
        return EXECUTION_BLOCKED, "TRADING_SESSION_UNKNOWN"
    if feed_state == FEED_UNAVAILABLE:
        return EXECUTION_BLOCKED, "FEED_UNAVAILABLE"
    if feed_state != FEED_LIVE:
        return EXECUTION_BLOCKED, "FEED_NOT_LIVE"
    if instrument_state != INSTRUMENT_NORMAL:
        return EXECUTION_BLOCKED, f"INSTRUMENT_{instrument_state}"
    if session_state == SESSION_REGULAR_OPEN:
        return EXECUTION_TRADABLE, "REGULAR_OPEN"
    return EXECUTION_BLOCKED, "TRADING_SESSION_UNKNOWN"


contract_session_authority = ContractSessionAuthority()
