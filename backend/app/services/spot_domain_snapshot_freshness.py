from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainName,
    DomainSource,
    DomainTransport,
)


@dataclass(frozen=True)
class DomainSnapshotContext:
    """Internal metadata collected before a legacy payload is mapped.

    The context is intentionally transport-neutral and is not exposed through
    legacy HTTP or WebSocket payloads.  Producers must provide observed values;
    this type does not infer provider, source, or fallback metadata.
    """

    domain: DomainName
    symbol: str
    transport: DomainTransport
    cache_origin: DomainCacheOrigin
    source: DomainSource
    interval: Optional[str] = None
    provider: Optional[str] = None
    provider_symbol: Optional[str] = None
    fallback_reason: Optional[DomainFallbackReason] = None
    provider_event_time_ms: Optional[int] = None
    received_at_ms: Optional[int] = None
    cache_updated_at_ms: Optional[int] = None
    db_updated_at_ms: Optional[int] = None
    ttl_ms: Optional[int] = None
    provider_generation: Optional[int] = None


@dataclass(frozen=True)
class DomainSnapshotFreshnessResolution:
    freshness: DomainFreshness
    age_ms: Optional[int]
    ttl_ms: Optional[int]
    stale: bool
    freshness_basis: DomainFreshnessBasis


_CACHE_ORIGINS = {
    DomainCacheOrigin.L1_MEMORY,
    DomainCacheOrigin.REDIS,
    DomainCacheOrigin.LAST_GOOD_MEMORY,
}


def _optional_non_negative_int(value: Optional[int]) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _valid_local_time(value: Optional[int], *, now_ms: int) -> Optional[int]:
    parsed = _optional_non_negative_int(value)
    if parsed is None or parsed > now_ms:
        return None
    return parsed


def _local_time_candidates(
    context: DomainSnapshotContext,
) -> tuple[tuple[Optional[int], DomainFreshnessBasis], ...]:
    received = (context.received_at_ms, DomainFreshnessBasis.RECEIVED_AT)
    cached = (context.cache_updated_at_ms, DomainFreshnessBasis.CACHE_UPDATED_AT)
    database = (context.db_updated_at_ms, DomainFreshnessBasis.DB_UPDATED_AT)

    if (
        context.transport == DomainTransport.DB_READ
        or context.cache_origin == DomainCacheOrigin.DATABASE
    ):
        return database, cached, received
    if (
        context.transport == DomainTransport.CACHE_READ
        or context.cache_origin in _CACHE_ORIGINS
    ):
        return cached, database, received
    return received, cached, database


def _resolve_local_time(
    context: DomainSnapshotContext,
    *,
    now_ms: int,
) -> tuple[Optional[int], DomainFreshnessBasis]:
    for value, basis in _local_time_candidates(context):
        resolved = _valid_local_time(value, now_ms=now_ms)
        if resolved is not None:
            return resolved, basis
    return None, DomainFreshnessBasis.NOT_APPLICABLE


def _provider_lag_ms(
    context: DomainSnapshotContext,
    *,
    local_time_ms: int,
    now_ms: int,
) -> Optional[int]:
    """Return provider lag without making provider time a freshness clock."""

    provider_event_time_ms = _optional_non_negative_int(
        context.provider_event_time_ms
    )
    if provider_event_time_ms is None or provider_event_time_ms > now_ms:
        return None

    received_at_ms = _valid_local_time(context.received_at_ms, now_ms=now_ms)
    lag_reference_ms = received_at_ms if received_at_ms is not None else local_time_ms
    if provider_event_time_ms > lag_reference_ms:
        return None
    return lag_reference_ms - provider_event_time_ms


def _resolution(
    *,
    freshness: DomainFreshness,
    age_ms: Optional[int],
    ttl_ms: Optional[int],
    stale: bool,
    freshness_basis: DomainFreshnessBasis,
) -> DomainSnapshotFreshnessResolution:
    return DomainSnapshotFreshnessResolution(
        freshness=freshness,
        age_ms=age_ms,
        ttl_ms=ttl_ms,
        stale=stale,
        freshness_basis=freshness_basis,
    )


def resolve_domain_snapshot_freshness(
    context: DomainSnapshotContext,
    *,
    now_ms: Optional[int] = None,
) -> DomainSnapshotFreshnessResolution:
    """Resolve snapshot freshness exclusively from local observation times.

    Provider event time is only a lag guard.  It is never selected as the age
    clock and therefore can never replace received, cache, or database time.
    """

    current_ms = (
        int(time.time() * 1000)
        if now_ms is None
        else _optional_non_negative_int(now_ms)
    )
    if current_ms is None:
        raise ValueError("now_ms must be a non-negative integer")

    if (
        context.cache_origin == DomainCacheOrigin.HISTORY_BOUNDARY
        or context.fallback_reason == DomainFallbackReason.HISTORY_BOUNDARY
    ):
        return _resolution(
            freshness=DomainFreshness.MISSING,
            age_ms=None,
            ttl_ms=None,
            stale=False,
            freshness_basis=DomainFreshnessBasis.NOT_APPLICABLE,
        )

    ttl_ms = _optional_non_negative_int(context.ttl_ms)
    local_time_ms, freshness_basis = _resolve_local_time(
        context,
        now_ms=current_ms,
    )
    age_ms = (
        current_ms - local_time_ms
        if local_time_ms is not None
        else None
    )

    if context.source == DomainSource.LAST_GOOD:
        return _resolution(
            freshness=DomainFreshness.LAST_GOOD,
            age_ms=age_ms,
            ttl_ms=ttl_ms,
            stale=True,
            freshness_basis=freshness_basis,
        )

    if context.source == DomainSource.MISSING:
        return _resolution(
            freshness=DomainFreshness.MISSING,
            age_ms=age_ms,
            ttl_ms=ttl_ms,
            stale=True,
            freshness_basis=freshness_basis,
        )

    if local_time_ms is None or ttl_ms is None:
        return _resolution(
            freshness=DomainFreshness.MISSING,
            age_ms=age_ms,
            ttl_ms=ttl_ms,
            stale=True,
            freshness_basis=freshness_basis,
        )

    provider_lag_ms = _provider_lag_ms(
        context,
        local_time_ms=local_time_ms,
        now_ms=current_ms,
    )
    stale = age_ms > ttl_ms or (
        provider_lag_ms is not None and provider_lag_ms > ttl_ms
    )
    if stale:
        freshness = DomainFreshness.STALE
    elif context.transport in {
        DomainTransport.PROVIDER_WS,
        DomainTransport.INTERNAL_EVENT,
    }:
        freshness = DomainFreshness.LIVE
    else:
        freshness = DomainFreshness.RECENT

    return _resolution(
        freshness=freshness,
        age_ms=age_ms,
        ttl_ms=ttl_ms,
        stale=stale,
        freshness_basis=freshness_basis,
    )
