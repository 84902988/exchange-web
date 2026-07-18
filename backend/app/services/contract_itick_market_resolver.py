from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


ITICK_KLINE_TYPE_BY_INTERVAL = {
    "1m": 1,
    "5m": 2,
    "15m": 3,
    "30m": 4,
    "1h": 5,
    "1d": 8,
    "1w": 9,
    "1M": 10,
}

ITICK_DWM_UTC_PASSTHROUGH = "UTC_PASSTHROUGH"
ITICK_DWM_AMERICA_NEW_YORK_SESSION = "ITICK_AMERICA_NEW_YORK_SESSION"

_ITICK_DWM_BOUNDARY_BY_INTERVAL = {
    "1d": "SESSION_DAY",
    "1w": "SESSION_WEEK_MONDAY",
    "1M": "SESSION_MONTH_START",
}


@dataclass(frozen=True)
class ContractItickKlineProviderEvidence:
    local_symbol: str
    category: str
    provider_symbol: str
    market: str
    region: str
    interval: str
    k_type: int
    endpoint: str
    cursor_parameter: str = "et"


@dataclass(frozen=True)
class ContractItickDwmSessionPolicy:
    code: str
    timezone_name: str
    session_open_hour: int = 0
    session_open_minute: int = 0


_ITICK_DWM_POLICY_BY_CODE = {
    ITICK_DWM_UTC_PASSTHROUGH: ContractItickDwmSessionPolicy(
        code=ITICK_DWM_UTC_PASSTHROUGH,
        timezone_name="UTC",
    ),
    ITICK_DWM_AMERICA_NEW_YORK_SESSION: ContractItickDwmSessionPolicy(
        code=ITICK_DWM_AMERICA_NEW_YORK_SESSION,
        timezone_name="America/New_York",
    ),
}

_ITICK_DWM_PRODUCTION_POLICY_BY_CATEGORY_REGION = {
    ("STOCK", "US"): ITICK_DWM_AMERICA_NEW_YORK_SESSION,
    ("FOREX", "GB"): ITICK_DWM_AMERICA_NEW_YORK_SESSION,
    ("METAL", "GB"): ITICK_DWM_AMERICA_NEW_YORK_SESSION,
    ("COMMODITY", "GB"): ITICK_DWM_AMERICA_NEW_YORK_SESSION,
}


def normalize_contract_itick_category(value: Any) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in {"GOLD", "SILVER", "METAL"}:
        return "METAL"
    if normalized in {"FUTURE", "FUTURES", "COMMODITY"}:
        return "COMMODITY"
    if normalized == "FX":
        return "FOREX"
    return normalized


def resolve_contract_itick_provider_symbol(
    local_symbol: Any,
    provider_symbol: Any,
    category: Any,
) -> str:
    explicit = str(provider_symbol or "").strip().upper()
    if explicit:
        return explicit.split("$", 1)[0]

    normalized_category = normalize_contract_itick_category(category)
    derived = str(local_symbol or "").strip().upper()
    if derived.endswith("_PERP"):
        derived = derived[:-5]

    if normalized_category == "STOCK":
        if derived.endswith("USDT"):
            return derived[:-4]
        if derived.endswith("USD") and len(derived) > 6:
            return derived[:-3]
        return derived

    if normalized_category in {"FOREX", "METAL"}:
        if derived.endswith("USDT"):
            return f"{derived[:-4]}USD"
        if normalized_category == "METAL" and derived in {"XAU", "XAG"}:
            return f"{derived}USD"
    return derived


def resolve_contract_itick_market(category: Any) -> str:
    normalized_category = normalize_contract_itick_category(category)
    if normalized_category == "INDEX":
        return "indices"
    if normalized_category in {"FOREX", "METAL", "COMMODITY"}:
        return "forex"
    return "stock"


def resolve_contract_itick_region(
    category: Any,
    provider_symbol: Any,
    explicit_region: Optional[Any] = None,
) -> str:
    normalized_explicit = str(explicit_region or "").strip().upper()
    if normalized_explicit and normalized_explicit not in {"FOREX", "GLOBAL"}:
        return normalized_explicit

    normalized_category = normalize_contract_itick_category(category)
    if normalized_category == "STOCK":
        return "US"
    if normalized_category in {"FOREX", "METAL", "COMMODITY"}:
        return "GB"
    if normalized_category == "INDEX":
        symbol = str(provider_symbol or "").strip().upper()
        if symbol in {"HSI", "HK50", "HKG33", "HKHSI"}:
            return "HK"
        if symbol in {"DAX", "GER40", "DE40", "DAX40"}:
            return "DE"
        if symbol in {"N225", "NI225", "JP225", "NKY"}:
            return "JP"
        return "US"
    return "US"


def _contract_symbol_metadata(contract_symbol: Any, *names: str) -> str:
    for name in names:
        value = str(getattr(contract_symbol, name, "") or "").strip().upper()
        if value:
            return value
    return ""


def resolve_contract_itick_dwm_session_policy(
    contract_symbol: Any,
) -> Optional[ContractItickDwmSessionPolicy]:
    provider = _contract_symbol_metadata(contract_symbol, "provider")
    if provider != "ITICK":
        return None

    if hasattr(contract_symbol, "_itick_dwm_boundary_policy"):
        explicit_policy = _contract_symbol_metadata(contract_symbol, "_itick_dwm_boundary_policy")
        return _ITICK_DWM_POLICY_BY_CODE.get(explicit_policy)

    category = normalize_contract_itick_category(
        _contract_symbol_metadata(contract_symbol, "category")
    )
    local_symbol = _contract_symbol_metadata(contract_symbol, "symbol")
    provider_symbol = resolve_contract_itick_provider_symbol(
        local_symbol,
        _contract_symbol_metadata(contract_symbol, "provider_symbol"),
        category,
    )
    if not local_symbol or not provider_symbol:
        return None

    explicit_region = _contract_symbol_metadata(
        contract_symbol,
        "_external_region_override",
        "_region_override",
        "external_region",
        "region",
    )
    region = resolve_contract_itick_region(
        category,
        provider_symbol,
        explicit_region or None,
    )
    policy_code = _ITICK_DWM_PRODUCTION_POLICY_BY_CATEGORY_REGION.get((category, region))
    return _ITICK_DWM_POLICY_BY_CODE.get(policy_code or "")


def normalize_contract_itick_dwm_open_time(
    open_time: Any,
    interval: Any,
    policy: ContractItickDwmSessionPolicy,
) -> Optional[int]:
    normalized_interval = str(interval or "").strip()
    boundary = _ITICK_DWM_BOUNDARY_BY_INTERVAL.get(normalized_interval)
    if boundary is None:
        return None

    try:
        value = int(open_time or 0)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None

    try:
        session_timezone = ZoneInfo(policy.timezone_name)
    except (ZoneInfoNotFoundError, ValueError):
        return None

    instant = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    session_time = instant.astimezone(session_timezone)
    if (
        session_time.hour != policy.session_open_hour
        or session_time.minute != policy.session_open_minute
        or session_time.second != 0
        or session_time.microsecond != 0
    ):
        return None
    if boundary == "SESSION_WEEK_MONDAY" and session_time.weekday() != 0:
        return None
    if boundary == "SESSION_MONTH_START" and session_time.day != 1:
        return None

    utc_boundary = datetime(
        session_time.year,
        session_time.month,
        session_time.day,
        tzinfo=timezone.utc,
    )
    return int(utc_boundary.timestamp() * 1000)


def resolve_contract_itick_kline_provider_evidence(
    *,
    local_symbol: Any,
    provider_symbol: Any,
    category: Any,
    interval: Any,
    explicit_region: Optional[Any] = None,
) -> ContractItickKlineProviderEvidence:
    normalized_interval = str(interval or "").strip()
    k_type = ITICK_KLINE_TYPE_BY_INTERVAL.get(normalized_interval)
    if k_type is None:
        raise ValueError(f"unsupported iTick Kline interval: {normalized_interval}")

    normalized_category = normalize_contract_itick_category(category)
    resolved_symbol = resolve_contract_itick_provider_symbol(
        local_symbol,
        provider_symbol,
        normalized_category,
    )
    if not resolved_symbol:
        raise ValueError("iTick provider symbol is required")
    market = resolve_contract_itick_market(normalized_category)
    region = resolve_contract_itick_region(
        normalized_category,
        resolved_symbol,
        explicit_region,
    )
    return ContractItickKlineProviderEvidence(
        local_symbol=str(local_symbol or "").strip().upper(),
        category=normalized_category,
        provider_symbol=resolved_symbol,
        market=market,
        region=region,
        interval=normalized_interval,
        k_type=k_type,
        endpoint=f"/{market}/kline",
    )
