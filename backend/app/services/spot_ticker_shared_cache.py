from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any, Optional

from app.services.shared_market_cache import (
    DOMAIN_TICKER,
    FRESHNESS_FRESH,
    SharedMarketCacheAdapter,
    build_market_cache_key,
)


logger = logging.getLogger(__name__)

SPOT_TICKER_SHARED_CACHE_TTL_MS = 1500
SPOT_TICKER_SHARED_CACHE_L1_TTL_MS = 250
SPOT_MARKET_TYPE = "spot"
SPOT_EXTERNAL_DATA_SOURCE = "BINANCE"

_spot_ticker_shared_cache = SharedMarketCacheAdapter(
    l1_ttl_ms=SPOT_TICKER_SHARED_CACHE_L1_TTL_MS,
)


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
) -> Optional[dict[str, Any]]:
    if not should_use_spot_ticker_shared_cache(data_source):
        loaded = loader()
        return dict(loaded) if isinstance(loaded, Mapping) else None

    key = spot_ticker_shared_cache_key(symbol)
    adapter = cache_adapter or _spot_ticker_shared_cache
    cached = _get_fresh_cached_ticker(adapter, key=key, ttl_ms=ttl_ms)
    if cached is not None:
        return cached

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
) -> Optional[dict[str, Any]]:
    try:
        envelope = adapter.get(key, ttl_ms=ttl_ms)
    except Exception as exc:
        logger.debug("spot_ticker_shared_cache_get_failed key=%s reason=%s", key, exc)
        return None
    if envelope is None or envelope.freshness != FRESHNESS_FRESH:
        return None
    if not isinstance(envelope.data, Mapping):
        return None
    payload = dict(envelope.data)
    if not _is_cacheable_spot_ticker(payload):
        return None
    return payload


def _set_cached_ticker(
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
        logger.debug("spot_ticker_shared_cache_set_failed key=%s reason=%s", key, exc)


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
