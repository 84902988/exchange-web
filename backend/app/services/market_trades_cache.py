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
    DOMAIN_TRADES,
    FRESHNESS_FRESH,
    MarketCacheEnvelope,
    SharedMarketCacheAdapter,
    build_market_cache_key,
    now_ms,
)


logger = logging.getLogger(__name__)

SPOT_TRADES_SHARED_CACHE_TTL_MS = 1500
SPOT_TRADES_SHARED_CACHE_L1_TTL_MS = 250
SPOT_MARKET_TYPE = "spot"
SPOT_EXTERNAL_DATA_SOURCE = "BINANCE"

_spot_trades_market_cache = SharedMarketCacheAdapter(
    l1_ttl_ms=SPOT_TRADES_SHARED_CACHE_L1_TTL_MS,
)


@dataclass(frozen=True)
class MarketTradesCacheMetadata:
    data: dict[str, Any]
    source: str
    provider: str
    updated_at: int
    version: str = CACHE_VERSION
    last_trade_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "data": dict(self.data),
            "source": self.source,
            "provider": self.provider,
            "updated_at": self.updated_at,
            "version": self.version,
            "last_trade_id": self.last_trade_id,
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
            domain="trades",
            data=self.data,
            source=self.source,
            provider=self.provider,
            updated_at=self.updated_at,
            version=self.version,
            max_age_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
            fallback_reason=fallback_reason,
            now_ms=now_ms,
        )


@dataclass(frozen=True)
class SpotTradesCacheHit:
    payload: dict[str, Any]
    metadata: MarketTradesCacheMetadata
    envelope: MarketCacheEnvelope
    cache_origin: str


def should_use_spot_trades_shared_cache(data_source: Any) -> bool:
    return str(data_source or "").strip().upper() == SPOT_EXTERNAL_DATA_SOURCE


def spot_trades_shared_cache_key(symbol: str) -> str:
    return build_market_cache_key(
        market_type=SPOT_MARKET_TYPE,
        symbol=symbol,
        domain=DOMAIN_TRADES,
    )


def get_spot_trades_with_shared_cache(
    *,
    symbol: str,
    data_source: Any,
    loader: Callable[[], Optional[Mapping[str, Any]]],
    cache_adapter: Optional[SharedMarketCacheAdapter] = None,
    ttl_ms: int = SPOT_TRADES_SHARED_CACHE_TTL_MS,
    cache_hit_observer: Optional[Callable[[SpotTradesCacheHit], None]] = None,
) -> Optional[dict[str, Any]]:
    if not should_use_spot_trades_shared_cache(data_source):
        loaded = loader()
        return dict(loaded) if isinstance(loaded, Mapping) else None

    key = spot_trades_shared_cache_key(symbol)
    adapter = cache_adapter or _spot_trades_market_cache
    cache_hit = _get_fresh_cached_trades(adapter, key=key, ttl_ms=ttl_ms)
    if cache_hit is not None:
        if cache_hit_observer is not None:
            try:
                cache_hit_observer(cache_hit)
            except Exception as exc:
                logger.debug(
                    "spot_trades_market_cache_observer_failed key=%s reason=%s",
                    key,
                    exc,
                )
        return cache_hit.payload

    loaded = loader()
    if not isinstance(loaded, Mapping):
        return None

    payload = dict(loaded)
    if _is_cacheable_spot_trades(payload):
        _set_cached_trades(adapter, key=key, payload=payload, ttl_ms=ttl_ms)
    return payload


def _get_fresh_cached_trades(
    adapter: SharedMarketCacheAdapter,
    *,
    key: str,
    ttl_ms: int,
) -> Optional[SpotTradesCacheHit]:
    try:
        if hasattr(adapter, "get_with_origin"):
            lookup = adapter.get_with_origin(key, ttl_ms=ttl_ms)
            envelope = lookup.envelope if lookup is not None else None
            cache_origin = lookup.origin if lookup is not None else None
        else:
            envelope = adapter.get(key, ttl_ms=ttl_ms)
            cache_origin = None
    except Exception as exc:
        logger.debug("spot_trades_market_cache_get_failed key=%s reason=%s", key, exc)
        return None
    if envelope is None or envelope.freshness != FRESHNESS_FRESH:
        return None

    metadata = _metadata_from_envelope(envelope)
    if metadata is None or not _is_cacheable_spot_trades(metadata.data):
        return None
    freshness = resolve_market_freshness(
        source=metadata.source,
        updated_at=metadata.updated_at,
        max_age_ms=ttl_ms,
    )
    if freshness.freshness != "LIVE" or freshness.stale:
        return None

    return SpotTradesCacheHit(
        payload=dict(metadata.data),
        metadata=metadata,
        envelope=envelope,
        cache_origin=str(cache_origin or "NONE"),
    )


def _set_cached_trades(
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
        logger.debug("spot_trades_market_cache_set_failed key=%s reason=%s", key, exc)


def _metadata_from_payload(payload: Mapping[str, Any]) -> MarketTradesCacheMetadata:
    source = str(payload.get("source") or "external")
    provider = str(
        payload.get("provider")
        or payload.get("data_source")
        or SPOT_EXTERNAL_DATA_SOURCE
    )
    return MarketTradesCacheMetadata(
        data=dict(payload),
        source=source,
        provider=provider,
        updated_at=now_ms(),
        last_trade_id=_last_trade_id(payload),
    )


def _metadata_from_envelope(
    envelope: MarketCacheEnvelope,
) -> Optional[MarketTradesCacheMetadata]:
    raw = envelope.data
    if not isinstance(raw, Mapping):
        return None

    nested_data = raw.get("data")
    if isinstance(nested_data, Mapping) and all(
        key in raw
        for key in (
            "source",
            "provider",
            "updated_at",
            "version",
            "last_trade_id",
        )
    ):
        updated_at = _positive_int(raw.get("updated_at"))
        if updated_at is None:
            return None
        return MarketTradesCacheMetadata(
            data=dict(nested_data),
            source=str(raw.get("source") or ""),
            provider=str(raw.get("provider") or ""),
            updated_at=updated_at,
            version=str(raw.get("version") or CACHE_VERSION),
            last_trade_id=_optional_text(raw.get("last_trade_id")),
        )

    # Compatibility with the pre-B-2.3 cache where envelope.data was raw trades.
    updated_at = _positive_int(envelope.updated_at_ms)
    if updated_at is None:
        return None
    return MarketTradesCacheMetadata(
        data=dict(raw),
        source=str(raw.get("source") or envelope.source or ""),
        provider=str(raw.get("provider") or envelope.provider or ""),
        updated_at=updated_at,
        version=str(envelope.version or CACHE_VERSION),
        last_trade_id=_last_trade_id(raw),
    )


def _last_trade_id(payload: Mapping[str, Any]) -> Optional[str]:
    trades = payload.get("trades")
    if not isinstance(trades, (list, tuple)) or not trades:
        return None
    latest = trades[0]
    if not isinstance(latest, Mapping):
        return None
    for field in ("provider_trade_id", "trade_id", "id"):
        value = _optional_text(latest.get(field))
        if value is not None:
            return value
    return None


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _positive_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _is_cacheable_spot_trades(payload: Mapping[str, Any]) -> bool:
    symbol = str(payload.get("symbol") or "").strip()
    provider = str(payload.get("provider") or "").strip().upper()
    if not symbol:
        return False
    if bool(payload.get("stale")) or provider == "LAST_GOOD":
        return False
    return bool(payload.get("trades"))


__all__ = [
    "MarketTradesCacheMetadata",
    "SPOT_TRADES_SHARED_CACHE_TTL_MS",
    "SpotTradesCacheHit",
    "get_spot_trades_with_shared_cache",
    "spot_trades_shared_cache_key",
]
