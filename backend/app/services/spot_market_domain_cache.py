from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional


LIVE_WS_SOURCE = "LIVE_WS"
LIVE_FRESHNESS = "LIVE"
BITGET_SPOT_PROVIDER = "BITGET_SPOT"

FALLBACK_REASON_MISSING = "missing"
FALLBACK_REASON_MISSING_UPDATED_AT = "missing_updated_at"
FALLBACK_REASON_STALE = "stale"
FALLBACK_REASON_EMPTY = "empty"
FALLBACK_REASON_INVALID = "invalid"
FALLBACK_REASON_FRESH = "fresh"


@dataclass(frozen=True)
class SpotMarketCacheMetadata:
    source: str
    freshness: str
    provider: str
    updated_at_ms: Optional[int]
    age_ms: Optional[int]
    is_stale: bool
    fallback_reason: str


@dataclass(frozen=True)
class SpotMarketFreshnessResult:
    record: Optional[Mapping[str, Any]]
    metadata: SpotMarketCacheMetadata

    @property
    def is_fresh(self) -> bool:
        return not self.metadata.is_stale and self.metadata.fallback_reason == FALLBACK_REASON_FRESH


def _now_ms() -> int:
    return int(time.time() * 1000)


def _metadata(
    record: Optional[Mapping[str, Any]],
    *,
    updated_at_ms: Optional[int],
    age_ms: Optional[int],
    is_stale: bool,
    fallback_reason: str,
) -> SpotMarketCacheMetadata:
    if record is None:
        source = LIVE_WS_SOURCE
        freshness = LIVE_FRESHNESS
        provider = BITGET_SPOT_PROVIDER
    else:
        source = str(record.get("source") or LIVE_WS_SOURCE)
        freshness = str(record.get("freshness") or record.get("quote_freshness") or LIVE_FRESHNESS)
        provider = str(record.get("provider") or BITGET_SPOT_PROVIDER)
    return SpotMarketCacheMetadata(
        source=source,
        freshness=freshness,
        provider=provider,
        updated_at_ms=updated_at_ms,
        age_ms=age_ms,
        is_stale=is_stale,
        fallback_reason=fallback_reason,
    )


def _coerce_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except Exception:
        return None


def _has_empty_domain_payload(record: Mapping[str, Any]) -> bool:
    if "items" in record and not record.get("items"):
        return True
    if "trades" in record and not record.get("trades"):
        return True
    if ("bids" in record or "asks" in record) and (not record.get("bids") or not record.get("asks")):
        return True
    return False


def resolve_cache_metadata(
    record: Optional[Mapping[str, Any]],
    max_age_ms: int,
    now_ms: Optional[int] = None,
) -> SpotMarketFreshnessResult:
    if record is None:
        return SpotMarketFreshnessResult(
            record=None,
            metadata=_metadata(
                None,
                updated_at_ms=None,
                age_ms=None,
                is_stale=True,
                fallback_reason=FALLBACK_REASON_MISSING,
            ),
        )
    if not isinstance(record, Mapping):
        return SpotMarketFreshnessResult(
            record=None,
            metadata=_metadata(
                None,
                updated_at_ms=None,
                age_ms=None,
                is_stale=True,
                fallback_reason=FALLBACK_REASON_INVALID,
            ),
        )
    if _has_empty_domain_payload(record):
        return SpotMarketFreshnessResult(
            record=record,
            metadata=_metadata(
                record,
                updated_at_ms=None,
                age_ms=None,
                is_stale=True,
                fallback_reason=FALLBACK_REASON_EMPTY,
            ),
        )

    updated_at_ms = _coerce_int(record.get("updated_at_ms"))
    if updated_at_ms is None or updated_at_ms <= 0:
        return SpotMarketFreshnessResult(
            record=record,
            metadata=_metadata(
                record,
                updated_at_ms=updated_at_ms,
                age_ms=None,
                is_stale=True,
                fallback_reason=FALLBACK_REASON_MISSING_UPDATED_AT,
            ),
        )

    current_ms = int(now_ms if now_ms is not None else _now_ms())
    age_ms = max(0, current_ms - updated_at_ms)
    allowed_age_ms = max(0, int(max_age_ms or 0))
    if age_ms > allowed_age_ms:
        return SpotMarketFreshnessResult(
            record=record,
            metadata=_metadata(
                record,
                updated_at_ms=updated_at_ms,
                age_ms=age_ms,
                is_stale=True,
                fallback_reason=FALLBACK_REASON_STALE,
            ),
        )

    return SpotMarketFreshnessResult(
        record=record,
        metadata=_metadata(
            record,
            updated_at_ms=updated_at_ms,
            age_ms=age_ms,
            is_stale=False,
            fallback_reason=FALLBACK_REASON_FRESH,
        ),
    )


def is_fresh_record(
    record: Optional[Mapping[str, Any]],
    max_age_ms: int,
    now_ms: Optional[int] = None,
) -> bool:
    return resolve_cache_metadata(record, max_age_ms, now_ms=now_ms).is_fresh


def stale_reason_for(
    record: Optional[Mapping[str, Any]],
    max_age_ms: int,
    now_ms: Optional[int] = None,
) -> str:
    return resolve_cache_metadata(record, max_age_ms, now_ms=now_ms).metadata.fallback_reason


def with_live_ws_defaults(domain: str, record: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(record or {})
    payload.setdefault("source", LIVE_WS_SOURCE)
    payload.setdefault("provider", BITGET_SPOT_PROVIDER)
    if str(domain or "").strip().lower() == "ticker":
        payload.setdefault("quote_freshness", LIVE_FRESHNESS)
    else:
        payload.setdefault("freshness", LIVE_FRESHNESS)
    return payload
