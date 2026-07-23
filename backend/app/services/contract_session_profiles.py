from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time as dt_time
from typing import Optional


SESSION_PRE_MARKET = "PRE_MARKET"
SESSION_REGULAR_OPEN = "REGULAR_OPEN"
SESSION_AFTER_HOURS = "AFTER_HOURS"
SESSION_CLOSED = "CLOSED"
SESSION_HOLIDAY = "HOLIDAY"
SESSION_UNKNOWN = "UNKNOWN"

PROFILE_CRYPTO_24_7 = "CRYPTO_24_7"
PROFILE_US_EQUITY = "US_EQUITY"
PROFILE_US_INDEX_EXTENDED = "US_INDEX_EXTENDED"
PROFILE_FOREX_24X5 = "FOREX_24X5"
PROFILE_METAL_23X5 = "METAL_23X5"
PROFILE_ENERGY_CFD = "ENERGY_CFD"

SUPPORTED_SESSION_PROFILE_CODES = frozenset(
    {
        PROFILE_CRYPTO_24_7,
        PROFILE_US_EQUITY,
        PROFILE_US_INDEX_EXTENDED,
        PROFILE_FOREX_24X5,
        PROFILE_METAL_23X5,
        PROFILE_ENERGY_CFD,
    }
)


@dataclass(frozen=True)
class ContractSessionProfile:
    code: str
    timezone_name: str
    trading_hours: str
    holiday_calendar_required: bool
    extended_hours_display_only: bool = True


SESSION_PROFILES = {
    PROFILE_CRYPTO_24_7: ContractSessionProfile(
        code=PROFILE_CRYPTO_24_7,
        timezone_name="UTC",
        trading_hours="24/7",
        holiday_calendar_required=False,
        extended_hours_display_only=False,
    ),
    PROFILE_US_EQUITY: ContractSessionProfile(
        code=PROFILE_US_EQUITY,
        timezone_name="America/New_York",
        trading_hours="04:00-09:30,09:30-16:00,16:00-20:00",
        holiday_calendar_required=True,
    ),
    PROFILE_US_INDEX_EXTENDED: ContractSessionProfile(
        code=PROFILE_US_INDEX_EXTENDED,
        timezone_name="America/New_York",
        trading_hours="04:00-09:30,09:30-16:00,16:00-20:00",
        holiday_calendar_required=True,
    ),
    PROFILE_FOREX_24X5: ContractSessionProfile(
        code=PROFILE_FOREX_24X5,
        timezone_name="America/New_York",
        trading_hours="Sun 17:00-Fri 17:00",
        holiday_calendar_required=False,
        extended_hours_display_only=False,
    ),
    PROFILE_METAL_23X5: ContractSessionProfile(
        code=PROFILE_METAL_23X5,
        timezone_name="America/New_York",
        trading_hours="Sun 18:00-Fri 17:00; daily break 17:00-18:00",
        holiday_calendar_required=False,
        extended_hours_display_only=False,
    ),
    PROFILE_ENERGY_CFD: ContractSessionProfile(
        code=PROFILE_ENERGY_CFD,
        timezone_name="America/New_York",
        trading_hours="Sun 18:00-Fri 17:00; daily break 17:00-18:00",
        holiday_calendar_required=False,
        extended_hours_display_only=False,
    ),
}


def get_contract_session_profile(code: object) -> Optional[ContractSessionProfile]:
    return SESSION_PROFILES.get(str(code or "").strip().upper())


def session_state_for_profile(
    profile: ContractSessionProfile,
    local_now: datetime,
    *,
    regular_close_override: Optional[dt_time] = None,
) -> str:
    if profile.code == PROFILE_CRYPTO_24_7:
        return SESSION_REGULAR_OPEN
    if profile.code in {PROFILE_US_EQUITY, PROFILE_US_INDEX_EXTENDED}:
        return _us_cash_session_state(local_now, regular_close_override=regular_close_override)
    if profile.code == PROFILE_FOREX_24X5:
        return _forex_session_state(local_now)
    if profile.code in {PROFILE_METAL_23X5, PROFILE_ENERGY_CFD}:
        return _daily_break_23x5_session_state(local_now)
    return SESSION_UNKNOWN


def _us_cash_session_state(
    local_now: datetime,
    *,
    regular_close_override: Optional[dt_time],
) -> str:
    if local_now.weekday() >= 5:
        return SESSION_CLOSED
    current = local_now.time().replace(tzinfo=None)
    pre_start = dt_time(4, 0)
    regular_start = dt_time(9, 30)
    regular_end = regular_close_override or dt_time(16, 0)
    after_end = dt_time(20, 0)
    if pre_start <= current < regular_start:
        return SESSION_PRE_MARKET
    if regular_start <= current < regular_end:
        return SESSION_REGULAR_OPEN
    if regular_end <= current < after_end:
        return SESSION_AFTER_HOURS
    return SESSION_CLOSED


def _forex_session_state(local_now: datetime) -> str:
    weekday = local_now.weekday()
    current = local_now.time().replace(tzinfo=None)
    if weekday == 6:
        return SESSION_REGULAR_OPEN if current >= dt_time(17, 0) else SESSION_CLOSED
    if weekday < 4:
        return SESSION_REGULAR_OPEN
    if weekday == 4:
        return SESSION_REGULAR_OPEN if current < dt_time(17, 0) else SESSION_CLOSED
    return SESSION_CLOSED


def _daily_break_23x5_session_state(local_now: datetime) -> str:
    weekday = local_now.weekday()
    current = local_now.time().replace(tzinfo=None)
    if weekday == 6:
        return SESSION_REGULAR_OPEN if current >= dt_time(18, 0) else SESSION_CLOSED
    if weekday < 4:
        if dt_time(17, 0) <= current < dt_time(18, 0):
            return SESSION_CLOSED
        return SESSION_REGULAR_OPEN
    if weekday == 4:
        return SESSION_REGULAR_OPEN if current < dt_time(17, 0) else SESSION_CLOSED
    return SESSION_CLOSED
