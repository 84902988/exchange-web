from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


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
