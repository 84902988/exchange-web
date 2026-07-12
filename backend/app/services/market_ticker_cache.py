from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Optional

from app.services.market_domain_snapshot import (
    MarketDomainSnapshot,
    build_market_domain_snapshot,
)
from app.services.market_freshness import resolve_market_freshness
from app.services.shared_market_cache import (
    CACHE_VERSION,
    DOMAIN_TICKER,
    FRESHNESS_FRESH,
    MarketCacheEnvelope,
    SharedMarketCacheAdapter,
    build_market_cache_key,
    now_ms,
)


logger = logging.getLogger(__name__)

SPOT_TICKER_SHARED_CACHE_TTL_MS = 1500
SPOT_TICKER_SHARED_CACHE_L1_TTL_MS = 250
SPOT_MARKET_TYPE = "spot"
SPOT_EXTERNAL_DATA_SOURCE = "BINANCE"

_spot_ticker_market_cache = SharedMarketCacheAdapter(
    l1_ttl_ms=SPOT_TICKER_SHARED_CACHE_L1_TTL_MS,
)


@dataclass(frozen=True)
class MarketTickerCacheMetadata:
    data: dict[str, Any]
    source: str
    provider: str
    updated_at: int
    version: str = CACHE_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "data": dict(self.data),
            "source": self.source,
            "provider": self.provider,
            "updated_at": self.updated_at,
            "version": self.version,
        }

    def to_domain_snapshot(
        self,
        *,
        symbol: Optional[str] = None,
        fallback_reason: Optional[str] = None,
        now_ms: Optional[int] = None,
    ) -> MarketDomainSnapshot:
        return build_market_domain_snapshot(
            symbol=symbol or self.data.get("symbol"),
            domain="ticker",
            data=self.data,
            source=self.source,
            provider=self.provider,
            updated_at=self.updated_at,
            version=self.version,
            max_age_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
            fallback_reason=fallback_reason,
            now_ms=now_ms,
        )


@dataclass(frozen=True)
class SpotTickerCacheHit:
    payload: dict[str, Any]
    metadata: MarketTickerCacheMetadata
    envelope: MarketCacheEnvelope
    cache_origin: str


def should_use_spot_ticker_shared_cache(data_source: Any) -> bool:
    return str(data_source or "").strip().upper() == SPOT_EXTERNAL_DATA_SOURCE


def spot_ticker_shared_cache_key(symbol: str) -> str:
    return build_market_cache_key(
        market_type=SPOT_MARKET_TYPE,
        symbol=symbol,
        domain=DOMAIN_TICKER,
    )


def get_spot_ticker_with_shared_cache(
    *,
    symbol: str,
    data_source: Any,
    loader: Callable[[], Optional[Mapping[str, Any]]],
    cache_adapter: Optional[SharedMarketCacheAdapter] = None,
    ttl_ms: int = SPOT_TICKER_SHARED_CACHE_TTL_MS,
    cache_hit_observer: Optional[Callable[[SpotTickerCacheHit], None]] = None,
) -> Optional[dict[str, Any]]:
    if not should_use_spot_ticker_shared_cache(data_source):
        loaded = loader()
        return dict(loaded) if isinstance(loaded, Mapping) else None

    key = spot_ticker_shared_cache_key(symbol)
    adapter = cache_adapter or _spot_ticker_market_cache
    cache_hit = _get_fresh_cached_ticker(adapter, key=key, ttl_ms=ttl_ms)
    if cache_hit is not None:
        if cache_hit_observer is not None:
            try:
                cache_hit_observer(cache_hit)
            except Exception as exc:
                logger.debug(
                    "spot_ticker_market_cache_observer_failed key=%s reason=%s",
                    key,
                    exc,
                )
        return cache_hit.payload

    loaded = loader()
    if not isinstance(loaded, Mapping):
        return None

    payload = dict(loaded)
    if _is_cacheable_spot_ticker(payload):
        _set_cached_ticker(adapter, key=key, payload=payload, ttl_ms=ttl_ms)
    return payload


def _get_fresh_cached_ticker(
    adapter: SharedMarketCacheAdapter,
    *,
    key: str,
    ttl_ms: int,
) -> Optional[SpotTickerCacheHit]:
    try:
        if hasattr(adapter, "get_with_origin"):
            lookup = adapter.get_with_origin(key, ttl_ms=ttl_ms)
            envelope = lookup.envelope if lookup is not None else None
            cache_origin = lookup.origin if lookup is not None else None
        else:
            envelope = adapter.get(key, ttl_ms=ttl_ms)
            cache_origin = None
    except Exception as exc:
        logger.debug("spot_ticker_market_cache_get_failed key=%s reason=%s", key, exc)
        return None
    if envelope is None or envelope.freshness != FRESHNESS_FRESH:
        return None

    metadata = _metadata_from_envelope(envelope)
    if metadata is None or not _is_cacheable_spot_ticker(metadata.data):
        return None
    freshness = resolve_market_freshness(
        source=metadata.source,
        updated_at=metadata.updated_at,
        max_age_ms=ttl_ms,
    )
    if freshness.freshness != "LIVE" or freshness.stale:
        return None

    return SpotTickerCacheHit(
        payload=dict(metadata.data),
        metadata=metadata,
        envelope=envelope,
        cache_origin=str(cache_origin or "NONE"),
    )


def _set_cached_ticker(
    adapter: SharedMarketCacheAdapter,
    *,
    key: str,
    payload: Mapping[str, Any],
    ttl_ms: int,
) -> None:
    metadata = _metadata_from_payload(payload)
    try:
        adapter.set(
            key,
            metadata.to_dict(),
            ttl_ms=ttl_ms,
            source=metadata.source,
            provider=metadata.provider,
            updated_at_ms=metadata.updated_at,
            version=metadata.version,
        )
    except Exception as exc:
        logger.debug("spot_ticker_market_cache_set_failed key=%s reason=%s", key, exc)


def _metadata_from_payload(payload: Mapping[str, Any]) -> MarketTickerCacheMetadata:
    source = str(payload.get("source") or "external")
    provider = str(
        payload.get("provider")
        or payload.get("data_source")
        or SPOT_EXTERNAL_DATA_SOURCE
    )
    return MarketTickerCacheMetadata(
        data=dict(payload),
        source=source,
        provider=provider,
        updated_at=now_ms(),
    )


def _metadata_from_envelope(
    envelope: MarketCacheEnvelope,
) -> Optional[MarketTickerCacheMetadata]:
    raw = envelope.data
    if not isinstance(raw, Mapping):
        return None

    nested_data = raw.get("data")
    if isinstance(nested_data, Mapping) and all(
        key in raw
        for key in ("source", "provider", "updated_at", "version")
    ):
        updated_at = _positive_int(raw.get("updated_at"))
        if updated_at is None:
            return None
        return MarketTickerCacheMetadata(
            data=dict(nested_data),
            source=str(raw.get("source") or ""),
            provider=str(raw.get("provider") or ""),
            updated_at=updated_at,
            version=str(raw.get("version") or CACHE_VERSION),
        )

    # Compatibility with the pre-B-2.1 cache where envelope.data was the raw ticker.
    updated_at = _positive_int(envelope.updated_at_ms)
    if updated_at is None:
        return None
    return MarketTickerCacheMetadata(
        data=dict(raw),
        source=str(raw.get("source") or envelope.source or ""),
        provider=str(raw.get("provider") or envelope.provider or ""),
        updated_at=updated_at,
        version=str(envelope.version or CACHE_VERSION),
    )


def _positive_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _is_cacheable_spot_ticker(payload: Mapping[str, Any]) -> bool:
    symbol = str(payload.get("symbol") or "").strip()
    last_price = str(payload.get("last_price") or "").strip()
    provider = str(payload.get("provider") or "").strip().upper()
    if not symbol or not last_price:
        return False
    if bool(payload.get("stale")) or provider == "LAST_GOOD":
        return False
    source = str(payload.get("source") or "").strip()
    return bool(source)


__all__ = [
    "MarketTickerCacheMetadata",
    "SPOT_TICKER_SHARED_CACHE_TTL_MS",
    "SpotTickerCacheHit",
    "get_spot_ticker_with_shared_cache",
    "spot_ticker_shared_cache_key",
]
