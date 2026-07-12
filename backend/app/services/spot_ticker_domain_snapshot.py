from __future__ import annotations

import time
from typing import Any, Mapping, Optional, Union
from uuid import uuid4

from pydantic import BaseModel

from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainCompleteness,
    DomainCompletenessStatus,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainName,
    DomainSnapshotMetadata,
    DomainSource,
    DomainTransport,
    TickerDomainSnapshot,
)


TickerPayload = Union[Mapping[str, Any], BaseModel]

_TICKER_COMPLETENESS_FIELDS = (
    "symbol",
    "last_price",
    "price_change_percent",
    "volume_24h",
)

# These tables translate fields that already exist on the legacy ticker payload.
# They deliberately do not infer source or freshness from provider/transport.
_LEGACY_TICKER_SOURCE_MAP = {
    "LIVE_WS": DomainSource.LIVE_WS,
    "REST_SNAPSHOT": DomainSource.REST_SNAPSHOT,
    "EXTERNAL": DomainSource.REST_SNAPSHOT,
    "BINANCE": DomainSource.REST_SNAPSHOT,
    "ITICK": DomainSource.REST_SNAPSHOT,
    "INTERNAL": DomainSource.INTERNAL,
    "LAST_GOOD": DomainSource.LAST_GOOD,
    "MISSING": DomainSource.MISSING,
}

_LEGACY_TICKER_FRESHNESS_MAP = {
    "LIVE": DomainFreshness.LIVE,
    "RECENT": DomainFreshness.RECENT,
    "STALE": DomainFreshness.STALE,
    "LAST_GOOD": DomainFreshness.LAST_GOOD,
    "LAST_VALID": DomainFreshness.LAST_GOOD,
    "MISSING": DomainFreshness.MISSING,
}


def _payload_dict(ticker: Optional[TickerPayload]) -> Optional[dict[str, Any]]:
    if ticker is None:
        return None
    if isinstance(ticker, Mapping):
        return dict(ticker)
    if hasattr(ticker, "model_dump"):
        return ticker.model_dump()
    return ticker.dict()


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


def _source_from_payload(payload: Optional[Mapping[str, Any]]) -> DomainSource:
    raw_source = _optional_text(payload.get("source")) if payload is not None else None
    if raw_source is None:
        return DomainSource.MISSING
    return _LEGACY_TICKER_SOURCE_MAP.get(raw_source.upper(), DomainSource.MISSING)


def _freshness_from_payload(payload: Optional[Mapping[str, Any]]) -> DomainFreshness:
    if payload is None:
        return DomainFreshness.MISSING
    raw_freshness = _optional_text(payload.get("freshness"))
    if raw_freshness is None:
        raw_freshness = _optional_text(payload.get("quote_freshness"))
    if raw_freshness is None:
        return DomainFreshness.MISSING
    return _LEGACY_TICKER_FRESHNESS_MAP.get(raw_freshness.upper(), DomainFreshness.MISSING)


def _ticker_completeness(payload: Optional[Mapping[str, Any]]) -> DomainCompleteness:
    if not payload:
        return DomainCompleteness(
            status=DomainCompletenessStatus.EMPTY,
            has_data=False,
            item_count=0,
            missing_fields=list(_TICKER_COMPLETENESS_FIELDS),
        )

    missing_fields = [
        field
        for field in _TICKER_COMPLETENESS_FIELDS
        if payload.get(field) is None or payload.get(field) == ""
    ]
    return DomainCompleteness(
        status=(
            DomainCompletenessStatus.PARTIAL
            if missing_fields
            else DomainCompletenessStatus.COMPLETE
        ),
        has_data=True,
        item_count=1,
        missing_fields=missing_fields,
    )


def map_ticker_domain_snapshot(
    *,
    symbol: str,
    ticker: Optional[TickerPayload],
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
    freshness_basis: DomainFreshnessBasis = DomainFreshnessBasis.NOT_APPLICABLE,
    provider_generation: Optional[int] = None,
    emitted_at_ms: Optional[int] = None,
    snapshot_id: Optional[str] = None,
) -> TickerDomainSnapshot:
    """Wrap a legacy ticker in DomainSnapshot without changing the ticker payload."""

    payload = _payload_dict(ticker)
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
    stale = payload_stale if isinstance(payload_stale, bool) else payload is None

    metadata = DomainSnapshotMetadata(
        domain=DomainName.TICKER,
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
        provider_event_time_ms=(
            _optional_non_negative_int(provider_event_time_ms)
            if provider_event_time_ms is not None
            else (
                _optional_non_negative_int(payload.get("event_time_ms"))
                if payload is not None
                else None
            )
        ),
        received_at_ms=(
            _optional_non_negative_int(received_at_ms)
            if received_at_ms is not None
            else (
                _optional_non_negative_int(payload.get("received_at_ms"))
                if payload is not None
                else None
            )
        ),
        cache_updated_at_ms=_optional_non_negative_int(cache_updated_at_ms),
        age_ms=_optional_non_negative_int(age_ms),
        ttl_ms=_optional_non_negative_int(ttl_ms),
        stale=stale,
        provider_generation=_optional_non_negative_int(provider_generation),
        revision=None,
        completeness=_ticker_completeness(payload),
        freshness_basis=freshness_basis,
    )
    return TickerDomainSnapshot(
        snapshot_id=snapshot_id or uuid4().hex,
        emitted_at_ms=emitted_at,
        data=payload,
        metadata=metadata,
    )
