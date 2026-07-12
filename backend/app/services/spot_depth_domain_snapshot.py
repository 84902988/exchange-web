from __future__ import annotations

import time
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Optional, Union
from uuid import uuid4

from pydantic import BaseModel

from app.schemas.spot_domain_snapshot import (
    DepthDomainSnapshot,
    DomainCacheOrigin,
    DomainCompleteness,
    DomainCompletenessStatus,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainName,
    DomainRevision,
    DomainSnapshotMetadata,
    DomainSource,
    DomainTransport,
)


DepthPayload = Union[Mapping[str, Any], BaseModel]

# Fixed translations for fields already present in legacy depth payloads. Source
# and freshness are never inferred from transport, provider, cache origin, or age.
_LEGACY_DEPTH_SOURCE_MAP = {
    "LIVE_WS": DomainSource.LIVE_WS,
    "REST_SNAPSHOT": DomainSource.REST_SNAPSHOT,
    "EXTERNAL": DomainSource.REST_SNAPSHOT,
    "BINANCE": DomainSource.REST_SNAPSHOT,
    "ITICK": DomainSource.REST_SNAPSHOT,
    "INTERNAL": DomainSource.INTERNAL,
    "LAST_GOOD": DomainSource.LAST_GOOD,
    "MISSING": DomainSource.MISSING,
}

_LEGACY_DEPTH_FRESHNESS_MAP = {
    "LIVE": DomainFreshness.LIVE,
    "RECENT": DomainFreshness.RECENT,
    "STALE": DomainFreshness.STALE,
    "LAST_GOOD": DomainFreshness.LAST_GOOD,
    "LAST_VALID": DomainFreshness.LAST_GOOD,
    "MISSING": DomainFreshness.MISSING,
}


def _payload_dict(depth: Any) -> tuple[Optional[dict[str, Any]], bool]:
    if depth is None:
        return None, True
    if isinstance(depth, Mapping):
        return dict(depth), True
    if isinstance(depth, BaseModel):
        if hasattr(depth, "model_dump"):
            return depth.model_dump(), True
        return depth.dict(), True
    return None, False


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_non_negative_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _first_non_negative_int(*values: Any) -> Optional[int]:
    for value in values:
        parsed = _optional_non_negative_int(value)
        if parsed is not None:
            return parsed
    return None


def _source_from_payload(payload: Optional[Mapping[str, Any]]) -> DomainSource:
    raw_source = _optional_text(payload.get("source")) if payload is not None else None
    if raw_source is None:
        return DomainSource.MISSING
    return _LEGACY_DEPTH_SOURCE_MAP.get(raw_source.upper(), DomainSource.MISSING)


def _freshness_from_payload(payload: Optional[Mapping[str, Any]]) -> DomainFreshness:
    if payload is None:
        return DomainFreshness.MISSING
    raw_freshness = _optional_text(payload.get("freshness"))
    if raw_freshness is None:
        raw_freshness = _optional_text(payload.get("quote_freshness"))
    if raw_freshness is None:
        return DomainFreshness.MISSING
    return _LEGACY_DEPTH_FRESHNESS_MAP.get(raw_freshness.upper(), DomainFreshness.MISSING)


def _positive_decimal(value: Any) -> bool:
    if value is None or isinstance(value, bool):
        return False
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return parsed.is_finite() and parsed > 0


def _valid_depth_level(level: Any) -> bool:
    if isinstance(level, BaseModel):
        level = level.model_dump() if hasattr(level, "model_dump") else level.dict()
    if isinstance(level, Mapping):
        price = level.get("price")
        amount = level.get("amount")
    elif isinstance(level, (list, tuple)) and len(level) >= 2:
        price, amount = level[0], level[1]
    else:
        return False
    return _positive_decimal(price) and _positive_decimal(amount)


def _depth_completeness(
    payload: Optional[Mapping[str, Any]],
    *,
    payload_format_valid: bool,
) -> DomainCompleteness:
    if not payload_format_valid:
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            missing_fields=["bids", "asks"],
            details={"reason": "depth_payload_not_mapping"},
        )
    if payload is None:
        return DomainCompleteness(
            status=DomainCompletenessStatus.EMPTY,
            has_data=False,
            item_count=0,
            missing_fields=["bids", "asks"],
        )
    if "bids" not in payload or "asks" not in payload:
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            missing_fields=[field for field in ("bids", "asks") if field not in payload],
            details={"reason": "depth_side_missing"},
        )

    bids = payload.get("bids")
    asks = payload.get("asks")
    if not isinstance(bids, (list, tuple)) or not isinstance(asks, (list, tuple)):
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            details={"reason": "depth_side_not_sequence"},
        )
    if any(not _valid_depth_level(level) for level in (*bids, *asks)):
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            details={"reason": "depth_level_invalid"},
        )

    bid_count = len(bids)
    ask_count = len(asks)
    item_count = bid_count + ask_count
    if bid_count and ask_count:
        status = DomainCompletenessStatus.COMPLETE
    elif bid_count or ask_count:
        status = DomainCompletenessStatus.PARTIAL
    else:
        status = DomainCompletenessStatus.EMPTY
    return DomainCompleteness(
        status=status,
        has_data=item_count > 0,
        item_count=item_count,
        missing_fields=(
            ["bids"] if not bid_count and ask_count else ["asks"] if bid_count and not ask_count else []
        ),
        details={"bid_count": bid_count, "ask_count": ask_count},
    )


def map_depth_domain_snapshot(
    *,
    symbol: str,
    depth: Optional[DepthPayload],
    transport: DomainTransport = DomainTransport.NONE,
    cache_origin: DomainCacheOrigin = DomainCacheOrigin.NONE,
    provider: Optional[str] = None,
    provider_symbol: Optional[str] = None,
    source: Optional[DomainSource] = None,
    freshness: Optional[DomainFreshness] = None,
    fallback_reason: Optional[DomainFallbackReason] = None,
    provider_event_time_ms: Optional[int] = None,
    received_at_ms: Optional[int] = None,
    cache_updated_at_ms: Optional[int] = None,
    age_ms: Optional[int] = None,
    ttl_ms: Optional[int] = None,
    stale: Optional[bool] = None,
    provider_generation: Optional[int] = None,
    sequence: Optional[int] = None,
    freshness_basis: DomainFreshnessBasis = DomainFreshnessBasis.NOT_APPLICABLE,
    emitted_at_ms: Optional[int] = None,
    snapshot_id: Optional[str] = None,
) -> DepthDomainSnapshot:
    """Wrap a legacy depth payload without changing display or execution behavior."""

    payload, payload_format_valid = _payload_dict(depth)
    resolved_source = source if source is not None else _source_from_payload(payload)
    resolved_freshness = (
        freshness if freshness is not None else _freshness_from_payload(payload)
    )
    emitted_at = (
        int(time.time() * 1000)
        if emitted_at_ms is None
        else _optional_non_negative_int(emitted_at_ms)
    )
    if emitted_at is None:
        raise ValueError("emitted_at_ms must be a non-negative integer")

    payload_stale = payload.get("stale") if payload is not None else None
    resolved_stale = (
        stale
        if isinstance(stale, bool)
        else payload_stale
        if isinstance(payload_stale, bool)
        else payload is None or not payload_format_valid
    )
    resolved_generation = _first_non_negative_int(
        provider_generation,
        payload.get("provider_generation") if payload is not None else None,
        payload.get("_provider_generation") if payload is not None else None,
        payload.get("generation") if payload is not None else None,
    )
    resolved_sequence = _first_non_negative_int(
        sequence,
        payload.get("sequence") if payload is not None else None,
    )
    revision = (
        DomainRevision(epoch=resolved_generation, sequence=resolved_sequence)
        if resolved_generation is not None or resolved_sequence is not None
        else None
    )

    metadata = DomainSnapshotMetadata(
        domain=DomainName.DEPTH,
        symbol=str(symbol),
        provider=(
            _optional_text(provider)
            if provider is not None
            else (_optional_text(payload.get("provider")) if payload is not None else None)
        ),
        provider_symbol=(
            _optional_text(provider_symbol)
            if provider_symbol is not None
            else (_optional_text(payload.get("provider_symbol")) if payload is not None else None)
        ),
        transport=transport,
        cache_origin=cache_origin,
        source=resolved_source,
        freshness=resolved_freshness,
        fallback_reason=fallback_reason,
        provider_event_time_ms=_first_non_negative_int(
            provider_event_time_ms,
            payload.get("event_time_ms") if payload is not None else None,
            payload.get("ts") if payload is not None else None,
        ),
        received_at_ms=_first_non_negative_int(
            received_at_ms,
            payload.get("received_at_ms") if payload is not None else None,
            payload.get("updated_at_ms") if payload is not None else None,
        ),
        cache_updated_at_ms=_optional_non_negative_int(cache_updated_at_ms),
        age_ms=_optional_non_negative_int(age_ms),
        ttl_ms=_optional_non_negative_int(ttl_ms),
        stale=resolved_stale,
        provider_generation=resolved_generation,
        revision=revision,
        completeness=_depth_completeness(
            payload,
            payload_format_valid=payload_format_valid,
        ),
        freshness_basis=freshness_basis,
    )
    return DepthDomainSnapshot(
        snapshot_id=snapshot_id or uuid4().hex,
        emitted_at_ms=emitted_at,
        data=payload,
        metadata=metadata,
    )
