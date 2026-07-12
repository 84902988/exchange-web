from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Literal, Optional


MarketFreshness = Literal["LIVE", "STALE", "MISSING"]


@dataclass(frozen=True)
class MarketFreshnessResult:
    freshness: MarketFreshness
    age_ms: Optional[int]
    stale: bool


_MISSING_SOURCES = {
    "",
    "EMPTY",
    "ERROR",
    "FAILED",
    "MISSING",
    "NONE",
    "NULL",
    "UNAVAILABLE",
}
_STALE_SOURCES = {
    "FALLBACK",
    "LAST_GOOD",
    "LAST_VALID",
    "STALE",
    "STALE_CACHE",
}


def _timestamp_ms(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            parsed = parsed.astimezone(timezone.utc)
        return int(parsed.timestamp() * 1000)

    if isinstance(value, (int, float)):
        numeric = float(value)
        if not isfinite(numeric) or not (numeric > 0):
            return None
        return int(numeric * 1000 if numeric < 100_000_000_000 else numeric)

    text = str(value).strip()
    if not text:
        return None

    try:
        numeric = float(text)
    except (TypeError, ValueError):
        numeric = None
    if numeric is not None:
        if not isfinite(numeric) or not (numeric > 0):
            return None
        return int(numeric * 1000 if numeric < 100_000_000_000 else numeric)

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return int(parsed.timestamp() * 1000)


def _matches_source(source: str, candidates: set[str]) -> bool:
    return source in candidates or any(
        source.startswith(f"{candidate}_")
        for candidate in candidates
        if candidate
    )


def resolve_market_freshness(
    *,
    source: Any,
    updated_at: Any,
    max_age_ms: int,
    now_ms: Optional[int] = None,
) -> MarketFreshnessResult:
    """Resolve canonical market-data freshness without changing legacy payload labels."""

    normalized_source = str(source or "").strip().upper()
    updated_at_ms = _timestamp_ms(updated_at)
    current_time_ms = (
        int(now_ms)
        if now_ms is not None
        else int(datetime.now(timezone.utc).timestamp() * 1000)
    )
    age_ms = max(0, current_time_ms - updated_at_ms) if updated_at_ms is not None else None

    if _matches_source(normalized_source, _MISSING_SOURCES):
        return MarketFreshnessResult(freshness="MISSING", age_ms=age_ms, stale=False)

    if _matches_source(normalized_source, _STALE_SOURCES):
        return MarketFreshnessResult(freshness="STALE", age_ms=age_ms, stale=True)

    if updated_at_ms is None:
        return MarketFreshnessResult(freshness="MISSING", age_ms=None, stale=False)

    try:
        allowed_age_ms = max(0, int(max_age_ms))
    except (TypeError, ValueError):
        allowed_age_ms = 0

    if age_ms is not None and age_ms > allowed_age_ms:
        return MarketFreshnessResult(freshness="STALE", age_ms=age_ms, stale=True)

    return MarketFreshnessResult(freshness="LIVE", age_ms=age_ms, stale=False)


__all__ = [
    "MarketFreshness",
    "MarketFreshnessResult",
    "resolve_market_freshness",
]
