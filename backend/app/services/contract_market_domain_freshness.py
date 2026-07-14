from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from app.schemas.contract_market_domain_snapshot import (
    ContractMarketDomainCacheOrigin,
    ContractMarketDomainFallbackReason,
    ContractMarketDomainFreshness,
    ContractMarketDomainFreshnessBasis,
    ContractMarketDomainName,
    ContractMarketDomainSource,
    ContractMarketDomainTransport,
)


@dataclass(frozen=True)
class ContractMarketDomainFreshnessContext:
    domain: ContractMarketDomainName
    symbol: str
    transport: ContractMarketDomainTransport
    cache_origin: ContractMarketDomainCacheOrigin
    source: ContractMarketDomainSource
    interval: Optional[str] = None
    provider_event_time_ms: Optional[int] = None
    received_at_ms: Optional[int] = None
    cache_updated_at_ms: Optional[int] = None
    db_updated_at_ms: Optional[int] = None
    ttl_ms: Optional[int] = None
    fallback_reason: Optional[ContractMarketDomainFallbackReason] = None


@dataclass(frozen=True)
class ContractMarketDomainFreshnessResolution:
    freshness: ContractMarketDomainFreshness
    age_ms: Optional[int]
    ttl_ms: Optional[int]
    stale: bool
    freshness_basis: ContractMarketDomainFreshnessBasis


_CACHE_ORIGINS = {
    ContractMarketDomainCacheOrigin.L1_MEMORY,
    ContractMarketDomainCacheOrigin.REDIS,
    ContractMarketDomainCacheOrigin.PROCESS_MEMORY,
    ContractMarketDomainCacheOrigin.LAST_GOOD_MEMORY,
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
    context: ContractMarketDomainFreshnessContext,
) -> tuple[tuple[Optional[int], ContractMarketDomainFreshnessBasis], ...]:
    received = (
        context.received_at_ms,
        ContractMarketDomainFreshnessBasis.RECEIVED_AT,
    )
    cached = (
        context.cache_updated_at_ms,
        ContractMarketDomainFreshnessBasis.CACHE_UPDATED_AT,
    )
    database = (
        context.db_updated_at_ms,
        ContractMarketDomainFreshnessBasis.DB_UPDATED_AT,
    )
    if (
        context.transport == ContractMarketDomainTransport.DB_READ
        or context.cache_origin == ContractMarketDomainCacheOrigin.DATABASE
    ):
        return database, cached, received
    if (
        context.transport == ContractMarketDomainTransport.CACHE_READ
        or context.cache_origin in _CACHE_ORIGINS
    ):
        return cached, database, received
    return received, cached, database


def _resolve_local_time(
    context: ContractMarketDomainFreshnessContext,
    *,
    now_ms: int,
) -> tuple[Optional[int], ContractMarketDomainFreshnessBasis]:
    for value, basis in _local_time_candidates(context):
        resolved = _valid_local_time(value, now_ms=now_ms)
        if resolved is not None:
            return resolved, basis
    return None, ContractMarketDomainFreshnessBasis.NOT_APPLICABLE


def _provider_lag_ms(
    context: ContractMarketDomainFreshnessContext,
    *,
    local_time_ms: int,
    now_ms: int,
) -> Optional[int]:
    provider_event_time_ms = _optional_non_negative_int(
        context.provider_event_time_ms
    )
    if provider_event_time_ms is None or provider_event_time_ms > now_ms:
        return None
    received_at_ms = _valid_local_time(context.received_at_ms, now_ms=now_ms)
    reference_ms = received_at_ms if received_at_ms is not None else local_time_ms
    if provider_event_time_ms > reference_ms:
        return None
    return reference_ms - provider_event_time_ms


def _resolution(
    *,
    freshness: ContractMarketDomainFreshness,
    age_ms: Optional[int],
    ttl_ms: Optional[int],
    stale: bool,
    freshness_basis: ContractMarketDomainFreshnessBasis,
) -> ContractMarketDomainFreshnessResolution:
    return ContractMarketDomainFreshnessResolution(
        freshness=freshness,
        age_ms=age_ms,
        ttl_ms=ttl_ms,
        stale=stale,
        freshness_basis=freshness_basis,
    )


def resolve_contract_market_domain_freshness(
    context: ContractMarketDomainFreshnessContext,
    *,
    now_ms: Optional[int] = None,
) -> ContractMarketDomainFreshnessResolution:
    """Resolve freshness from locally observed timestamps only.

    Provider event time is a lag guard. It is never used as the local age clock,
    so an old provider frame cannot become LIVE merely because it arrived now.
    """

    current_ms = (
        int(time.time() * 1000)
        if now_ms is None
        else _optional_non_negative_int(now_ms)
    )
    if current_ms is None:
        raise ValueError("now_ms must be a non-negative integer")

    if (
        context.cache_origin == ContractMarketDomainCacheOrigin.HISTORY_BOUNDARY
        or context.fallback_reason
        == ContractMarketDomainFallbackReason.HISTORY_BOUNDARY
    ):
        return _resolution(
            freshness=ContractMarketDomainFreshness.MISSING,
            age_ms=None,
            ttl_ms=None,
            stale=False,
            freshness_basis=ContractMarketDomainFreshnessBasis.NOT_APPLICABLE,
        )

    ttl_ms = _optional_non_negative_int(context.ttl_ms)
    local_time_ms, freshness_basis = _resolve_local_time(
        context,
        now_ms=current_ms,
    )
    age_ms = current_ms - local_time_ms if local_time_ms is not None else None

    if context.source == ContractMarketDomainSource.LAST_GOOD:
        return _resolution(
            freshness=ContractMarketDomainFreshness.LAST_GOOD,
            age_ms=age_ms,
            ttl_ms=ttl_ms,
            stale=True,
            freshness_basis=freshness_basis,
        )
    if context.source == ContractMarketDomainSource.MISSING:
        return _resolution(
            freshness=ContractMarketDomainFreshness.MISSING,
            age_ms=age_ms,
            ttl_ms=ttl_ms,
            stale=True,
            freshness_basis=freshness_basis,
        )
    if local_time_ms is None or ttl_ms is None:
        return _resolution(
            freshness=ContractMarketDomainFreshness.MISSING,
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
        freshness = ContractMarketDomainFreshness.STALE
    elif context.transport in {
        ContractMarketDomainTransport.PROVIDER_WS,
        ContractMarketDomainTransport.INTERNAL_EVENT,
    }:
        freshness = ContractMarketDomainFreshness.LIVE
    else:
        freshness = ContractMarketDomainFreshness.RECENT

    return _resolution(
        freshness=freshness,
        age_ms=age_ms,
        ttl_ms=ttl_ms,
        stale=stale,
        freshness_basis=freshness_basis,
    )


__all__ = [
    "ContractMarketDomainFreshnessContext",
    "ContractMarketDomainFreshnessResolution",
    "resolve_contract_market_domain_freshness",
]
