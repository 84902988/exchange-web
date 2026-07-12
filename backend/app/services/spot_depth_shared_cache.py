from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Optional

from app.services.shared_market_cache import (
    DOMAIN_DEPTH,
    FRESHNESS_FRESH,
    MarketCacheEnvelope,
    SharedMarketCacheAdapter,
    build_market_cache_key,
)


logger = logging.getLogger(__name__)

SPOT_DEPTH_SHARED_CACHE_TTL_MS = 1500
SPOT_DEPTH_SHARED_CACHE_L1_TTL_MS = 250
SPOT_MARKET_TYPE = "spot"
SPOT_EXTERNAL_DATA_SOURCE = "BINANCE"

_spot_depth_shared_cache = SharedMarketCacheAdapter(
    l1_ttl_ms=SPOT_DEPTH_SHARED_CACHE_L1_TTL_MS,
)


@dataclass(frozen=True)
class SpotDepthCacheHit:
    payload: dict[str, Any]
    envelope: MarketCacheEnvelope
    cache_origin: str


def should_use_spot_depth_shared_cache(data_source: Any) -> bool:
    return str(data_source or "").strip().upper() == SPOT_EXTERNAL_DATA_SOURCE


def spot_depth_shared_cache_key(symbol: str) -> str:
    return build_market_cache_key(
        market_type=SPOT_MARKET_TYPE,
        symbol=symbol,
        domain=DOMAIN_DEPTH,
    )


def get_spot_depth_with_shared_cache(
    *,
    symbol: str,
    data_source: Any,
    loader: Callable[[], Optional[Mapping[str, Any]]],
    cache_adapter: Optional[SharedMarketCacheAdapter] = None,
    ttl_ms: int = SPOT_DEPTH_SHARED_CACHE_TTL_MS,
    cache_hit_observer: Optional[Callable[[SpotDepthCacheHit], None]] = None,
) -> Optional[dict[str, Any]]:
    if not should_use_spot_depth_shared_cache(data_source):
        loaded = loader()
        return dict(loaded) if isinstance(loaded, Mapping) else None

    key = spot_depth_shared_cache_key(symbol)
    adapter = cache_adapter or _spot_depth_shared_cache
    cache_hit = _get_fresh_cached_depth(adapter, key=key, ttl_ms=ttl_ms)
    if cache_hit is not None:
        if cache_hit_observer is not None:
            try:
                cache_hit_observer(cache_hit)
            except Exception as exc:
                logger.debug(
                    "spot_depth_shared_cache_observer_failed key=%s reason=%s",
                    key,
                    exc,
                )
        return cache_hit.payload

    loaded = loader()
    if not isinstance(loaded, Mapping):
        return None

    payload = dict(loaded)
    if _is_cacheable_spot_depth(payload):
        _set_cached_depth(adapter, key=key, payload=payload, ttl_ms=ttl_ms)
    return payload


def _get_fresh_cached_depth(
    adapter: SharedMarketCacheAdapter,
    *,
    key: str,
    ttl_ms: int,
) -> Optional[SpotDepthCacheHit]:
    try:
        if hasattr(adapter, "get_with_origin"):
            lookup = adapter.get_with_origin(key, ttl_ms=ttl_ms)
            envelope = lookup.envelope if lookup is not None else None
            cache_origin = lookup.origin if lookup is not None else None
        else:
            envelope = adapter.get(key, ttl_ms=ttl_ms)
            cache_origin = None
    except Exception as exc:
        logger.debug("spot_depth_shared_cache_get_failed key=%s reason=%s", key, exc)
        return None
    if envelope is None or envelope.freshness != FRESHNESS_FRESH:
        return None
    if not isinstance(envelope.data, Mapping):
        return None
    payload = dict(envelope.data)
    if not _is_cacheable_spot_depth(payload):
        return None
    return SpotDepthCacheHit(
        payload=payload,
        envelope=envelope,
        cache_origin=str(cache_origin or "NONE"),
    )


def _set_cached_depth(
    adapter: SharedMarketCacheAdapter,
    *,
    key: str,
    payload: Mapping[str, Any],
    ttl_ms: int,
) -> None:
    source = str(payload.get("source") or "external")
    provider = str(payload.get("provider") or payload.get("data_source") or SPOT_EXTERNAL_DATA_SOURCE)
    try:
        adapter.set(
            key,
            dict(payload),
            ttl_ms=ttl_ms,
            source=source,
            provider=provider,
        )
    except Exception as exc:
        logger.debug("spot_depth_shared_cache_set_failed key=%s reason=%s", key, exc)


def _is_cacheable_spot_depth(payload: Mapping[str, Any]) -> bool:
    symbol = str(payload.get("symbol") or "").strip()
    provider = str(payload.get("provider") or "").strip().upper()
    if not symbol:
        return False
    if bool(payload.get("stale")) or provider == "LAST_GOOD":
        return False
    if not payload.get("bids") or not payload.get("asks"):
        return False
    source = str(payload.get("source") or "").strip()
    return bool(source)
