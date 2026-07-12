from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional


logger = logging.getLogger(__name__)

CACHE_VERSION = "v1"

DOMAIN_DEPTH = "depth"
DOMAIN_TICKER = "ticker"
DOMAIN_TRADES = "trades"
DOMAIN_KLINE = "kline"
SUPPORTED_DOMAINS = {DOMAIN_DEPTH, DOMAIN_TICKER, DOMAIN_TRADES, DOMAIN_KLINE}

FRESHNESS_FRESH = "fresh"
FRESHNESS_STALE = "stale"
FRESHNESS_MISSING = "missing"

FALLBACK_REASON_FRESH = "fresh"
FALLBACK_REASON_MISSING = "missing"
FALLBACK_REASON_EMPTY = "empty"
FALLBACK_REASON_MISSING_UPDATED_AT = "missing_updated_at"
FALLBACK_REASON_STALE = "stale"
FALLBACK_REASON_INVALID = "invalid"
FALLBACK_REASON_REDIS_DOWN = "redis_down"

DEFAULT_DOMAIN_TTL_MS = {
    DOMAIN_DEPTH: 1500,
    DOMAIN_TICKER: 1500,
    DOMAIN_TRADES: 1500,
    DOMAIN_KLINE: 1500,
}


@dataclass(frozen=True)
class MarketFreshness:
    freshness: str
    updated_at_ms: Optional[int]
    age_ms: Optional[int]
    is_stale: bool
    ttl_ms: int
    fallback_reason: str

    @property
    def is_fresh(self) -> bool:
        return self.freshness == FRESHNESS_FRESH and not self.is_stale

    @property
    def is_missing(self) -> bool:
        return self.freshness == FRESHNESS_MISSING


@dataclass(frozen=True)
class MarketCacheEnvelope:
    data: Any
    source: str
    provider: str
    freshness: str
    updated_at_ms: Optional[int]
    age_ms: Optional[int]
    is_stale: bool
    ttl_ms: int
    fallback_reason: str
    version: str = CACHE_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "data": _to_jsonable(self.data),
            "source": self.source,
            "provider": self.provider,
            "freshness": self.freshness,
            "updated_at_ms": self.updated_at_ms,
            "age_ms": self.age_ms,
            "is_stale": self.is_stale,
            "ttl_ms": self.ttl_ms,
            "fallback_reason": self.fallback_reason,
            "version": self.version,
        }


@dataclass(frozen=True)
class MarketCacheLookup:
    envelope: MarketCacheEnvelope
    origin: str


CACHE_LOOKUP_ORIGIN_L1_MEMORY = "L1_MEMORY"
CACHE_LOOKUP_ORIGIN_REDIS = "REDIS"


@dataclass
class _L1Entry:
    envelope: MarketCacheEnvelope
    expires_at_ms: int


def now_ms() -> int:
    return int(time.time() * 1000)


def build_market_cache_key(
    *,
    market_type: str,
    symbol: str,
    domain: str,
    interval: Optional[str] = None,
    version: str = CACHE_VERSION,
) -> str:
    normalized_market_type = _normalize_key_part(market_type, lowercase=True)
    normalized_symbol = _normalize_symbol(symbol)
    normalized_domain = _normalize_domain(domain)
    normalized_version = _normalize_version(version)

    if normalized_domain == DOMAIN_KLINE:
        normalized_interval = _normalize_interval(interval)
        return f"market:{normalized_version}:{normalized_market_type}:{normalized_symbol}:kline:{normalized_interval}"
    if interval not in (None, ""):
        raise ValueError("interval is only valid for kline cache keys")
    return f"market:{normalized_version}:{normalized_market_type}:{normalized_symbol}:{normalized_domain}"


def make_market_cache_envelope(
    data: Any,
    *,
    source: str,
    provider: str,
    ttl_ms: int,
    updated_at_ms: Optional[int] = None,
    now_ms_value: Optional[int] = None,
    version: str = CACHE_VERSION,
    fallback_reason: str = FALLBACK_REASON_FRESH,
) -> MarketCacheEnvelope:
    current_ms = int(now_ms_value if now_ms_value is not None else now_ms())
    updated_ms = current_ms if updated_at_ms is None else _coerce_int(updated_at_ms)
    freshness = resolve_market_freshness(
        {"updated_at_ms": updated_ms, "data": data},
        ttl_ms=ttl_ms,
        now_ms_value=current_ms,
    )
    reason = fallback_reason if freshness.is_fresh else freshness.fallback_reason
    return MarketCacheEnvelope(
        data=_to_jsonable(data),
        source=str(source or ""),
        provider=str(provider or ""),
        freshness=freshness.freshness,
        updated_at_ms=freshness.updated_at_ms,
        age_ms=freshness.age_ms,
        is_stale=freshness.is_stale,
        ttl_ms=freshness.ttl_ms,
        fallback_reason=reason,
        version=_normalize_version(version),
    )


def resolve_market_freshness(
    record: Any,
    *,
    domain: Optional[str] = None,
    ttl_ms: Optional[int] = None,
    now_ms_value: Optional[int] = None,
) -> MarketFreshness:
    normalized_domain = _normalize_domain(domain) if domain else None
    allowed_ttl_ms = _resolve_ttl_ms(normalized_domain, ttl_ms)

    if record is None:
        return _freshness_result(
            FRESHNESS_MISSING,
            ttl_ms=allowed_ttl_ms,
            fallback_reason=FALLBACK_REASON_MISSING,
        )
    if isinstance(record, MarketCacheEnvelope):
        payload = record.to_dict()
    elif isinstance(record, Mapping):
        payload = record
    else:
        return _freshness_result(
            FRESHNESS_MISSING,
            ttl_ms=allowed_ttl_ms,
            fallback_reason=FALLBACK_REASON_INVALID,
        )

    data = payload.get("data", payload)
    if _is_empty_domain_payload(data, normalized_domain):
        return _freshness_result(
            FRESHNESS_MISSING,
            ttl_ms=allowed_ttl_ms,
            fallback_reason=FALLBACK_REASON_EMPTY,
        )

    updated_at_ms = _coerce_int(payload.get("updated_at_ms"))
    if updated_at_ms is None or updated_at_ms <= 0:
        return _freshness_result(
            FRESHNESS_MISSING,
            ttl_ms=allowed_ttl_ms,
            updated_at_ms=updated_at_ms,
            fallback_reason=FALLBACK_REASON_MISSING_UPDATED_AT,
        )

    current_ms = int(now_ms_value if now_ms_value is not None else now_ms())
    age_ms = max(0, current_ms - updated_at_ms)
    if age_ms > allowed_ttl_ms:
        return _freshness_result(
            FRESHNESS_STALE,
            ttl_ms=allowed_ttl_ms,
            updated_at_ms=updated_at_ms,
            age_ms=age_ms,
            fallback_reason=FALLBACK_REASON_STALE,
        )

    return _freshness_result(
        FRESHNESS_FRESH,
        ttl_ms=allowed_ttl_ms,
        updated_at_ms=updated_at_ms,
        age_ms=age_ms,
        fallback_reason=FALLBACK_REASON_FRESH,
    )


def is_market_record_fresh(
    record: Any,
    *,
    domain: Optional[str] = None,
    ttl_ms: Optional[int] = None,
    now_ms_value: Optional[int] = None,
) -> bool:
    return resolve_market_freshness(
        record,
        domain=domain,
        ttl_ms=ttl_ms,
        now_ms_value=now_ms_value,
    ).is_fresh


class SharedMarketCacheAdapter:
    def __init__(
        self,
        *,
        redis_client: Any = None,
        redis_client_factory: Optional[Callable[[], Any]] = None,
        l1_ttl_ms: int = 250,
        clock_ms: Callable[[], int] = now_ms,
    ) -> None:
        self._redis_client = redis_client
        self._redis_client_factory = redis_client_factory
        self._l1_ttl_ms = max(1, int(l1_ttl_ms or 1))
        self._clock_ms = clock_ms
        self._l1: dict[str, _L1Entry] = {}
        self._last_redis_error: Optional[Exception] = None

    def get(self, key: str, *, ttl_ms: Optional[int] = None) -> Optional[MarketCacheEnvelope]:
        lookup = self.get_with_origin(key, ttl_ms=ttl_ms)
        return lookup.envelope if lookup is not None else None

    def get_with_origin(
        self,
        key: str,
        *,
        ttl_ms: Optional[int] = None,
    ) -> Optional[MarketCacheLookup]:
        normalized_key = _normalize_cache_key(key)
        current_ms = self._clock_ms()

        cached_l1 = self._get_l1(normalized_key, current_ms=current_ms, ttl_ms=ttl_ms)
        if cached_l1 is not None:
            return MarketCacheLookup(
                envelope=cached_l1,
                origin=CACHE_LOOKUP_ORIGIN_L1_MEMORY,
            )

        redis_envelope = self._get_l2(normalized_key, ttl_ms=ttl_ms, current_ms=current_ms)
        if redis_envelope is not None:
            self._set_l1(normalized_key, redis_envelope, current_ms=current_ms)
            return MarketCacheLookup(
                envelope=redis_envelope,
                origin=CACHE_LOOKUP_ORIGIN_REDIS,
            )
        return None

    def set(
        self,
        key: str,
        data: Any,
        *,
        ttl_ms: int,
        source: str,
        provider: str,
        updated_at_ms: Optional[int] = None,
        version: str = CACHE_VERSION,
        fallback_reason: str = FALLBACK_REASON_FRESH,
    ) -> MarketCacheEnvelope:
        normalized_key = _normalize_cache_key(key)
        current_ms = self._clock_ms()
        envelope = make_market_cache_envelope(
            data,
            source=source,
            provider=provider,
            ttl_ms=ttl_ms,
            updated_at_ms=updated_at_ms,
            now_ms_value=current_ms,
            version=version,
            fallback_reason=fallback_reason,
        )
        redis_stored = self._set_l2(normalized_key, envelope)
        if not redis_stored and envelope.fallback_reason == FALLBACK_REASON_FRESH:
            envelope = MarketCacheEnvelope(
                data=envelope.data,
                source=envelope.source,
                provider=envelope.provider,
                freshness=envelope.freshness,
                updated_at_ms=envelope.updated_at_ms,
                age_ms=envelope.age_ms,
                is_stale=envelope.is_stale,
                ttl_ms=envelope.ttl_ms,
                fallback_reason=FALLBACK_REASON_REDIS_DOWN,
                version=envelope.version,
            )
        self._set_l1(normalized_key, envelope, current_ms=current_ms)
        return envelope

    def get_or_load(
        self,
        key: str,
        loader: Callable[[], Any],
        *,
        ttl_ms: int,
        source: str,
        provider: str,
        updated_at_ms: Optional[int] = None,
        version: str = CACHE_VERSION,
    ) -> MarketCacheEnvelope:
        normalized_key = _normalize_cache_key(key)
        cached = self.get(normalized_key, ttl_ms=ttl_ms)
        if cached is not None and cached.freshness != FRESHNESS_MISSING:
            return cached

        data = loader()
        fallback_reason = (
            FALLBACK_REASON_REDIS_DOWN
            if self._last_redis_error is not None
            else FALLBACK_REASON_FRESH
        )
        return self.set(
            normalized_key,
            data,
            ttl_ms=ttl_ms,
            source=source,
            provider=provider,
            updated_at_ms=updated_at_ms,
            version=version,
            fallback_reason=fallback_reason,
        )

    def clear_l1(self) -> None:
        self._l1.clear()

    def _get_l1(
        self,
        key: str,
        *,
        current_ms: int,
        ttl_ms: Optional[int],
    ) -> Optional[MarketCacheEnvelope]:
        entry = self._l1.get(key)
        if entry is None:
            return None
        if current_ms >= entry.expires_at_ms:
            self._l1.pop(key, None)
            return None
        return _refresh_envelope(entry.envelope, ttl_ms=ttl_ms, now_ms_value=current_ms)

    def _set_l1(self, key: str, envelope: MarketCacheEnvelope, *, current_ms: int) -> None:
        self._l1[key] = _L1Entry(
            envelope=envelope,
            expires_at_ms=current_ms + self._l1_ttl_ms,
        )

    def _get_l2(
        self,
        key: str,
        *,
        ttl_ms: Optional[int],
        current_ms: int,
    ) -> Optional[MarketCacheEnvelope]:
        try:
            redis_client = self._redis()
            raw = redis_client.get(key)
            self._last_redis_error = None
        except Exception as exc:
            self._last_redis_error = exc
            logger.debug("shared_market_cache_redis_get_failed key=%s reason=%s", key, exc)
            return None

        if raw in (None, b"", ""):
            return None
        try:
            payload = _decode_json(raw)
            envelope = envelope_from_mapping(payload)
        except Exception as exc:
            logger.debug("shared_market_cache_redis_decode_failed key=%s reason=%s", key, exc)
            return None
        return _refresh_envelope(envelope, ttl_ms=ttl_ms, now_ms_value=current_ms)

    def _set_l2(self, key: str, envelope: MarketCacheEnvelope) -> bool:
        try:
            redis_client = self._redis()
            redis_client.set(
                key,
                json.dumps(envelope.to_dict(), ensure_ascii=False, separators=(",", ":")),
                px=max(1, int(envelope.ttl_ms or 1)),
            )
            self._last_redis_error = None
            return True
        except Exception as exc:
            self._last_redis_error = exc
            logger.debug("shared_market_cache_redis_set_failed key=%s reason=%s", key, exc)
            return False

    def _redis(self) -> Any:
        if self._redis_client is not None:
            return self._redis_client
        if self._redis_client_factory is not None:
            self._redis_client = self._redis_client_factory()
            return self._redis_client
        self._redis_client = _default_redis_client()
        return self._redis_client


def envelope_from_mapping(value: Mapping[str, Any]) -> MarketCacheEnvelope:
    return MarketCacheEnvelope(
        data=value.get("data"),
        source=str(value.get("source") or ""),
        provider=str(value.get("provider") or ""),
        freshness=str(value.get("freshness") or FRESHNESS_MISSING),
        updated_at_ms=_coerce_int(value.get("updated_at_ms")),
        age_ms=_coerce_int(value.get("age_ms")),
        is_stale=bool(value.get("is_stale")),
        ttl_ms=max(0, int(_coerce_int(value.get("ttl_ms")) or 0)),
        fallback_reason=str(value.get("fallback_reason") or FALLBACK_REASON_MISSING),
        version=_normalize_version(value.get("version") or CACHE_VERSION),
    )


def _refresh_envelope(
    envelope: MarketCacheEnvelope,
    *,
    ttl_ms: Optional[int],
    now_ms_value: int,
) -> MarketCacheEnvelope:
    effective_ttl_ms = int(ttl_ms if ttl_ms is not None else envelope.ttl_ms)
    freshness = resolve_market_freshness(
        envelope.to_dict(),
        ttl_ms=effective_ttl_ms,
        now_ms_value=now_ms_value,
    )
    return MarketCacheEnvelope(
        data=envelope.data,
        source=envelope.source,
        provider=envelope.provider,
        freshness=freshness.freshness,
        updated_at_ms=freshness.updated_at_ms,
        age_ms=freshness.age_ms,
        is_stale=freshness.is_stale,
        ttl_ms=freshness.ttl_ms,
        fallback_reason=freshness.fallback_reason,
        version=envelope.version,
    )


def _freshness_result(
    freshness: str,
    *,
    ttl_ms: int,
    fallback_reason: str,
    updated_at_ms: Optional[int] = None,
    age_ms: Optional[int] = None,
) -> MarketFreshness:
    return MarketFreshness(
        freshness=freshness,
        updated_at_ms=updated_at_ms,
        age_ms=age_ms,
        is_stale=freshness != FRESHNESS_FRESH,
        ttl_ms=ttl_ms,
        fallback_reason=fallback_reason,
    )


def _resolve_ttl_ms(domain: Optional[str], ttl_ms: Optional[int]) -> int:
    if ttl_ms is not None:
        return max(0, int(ttl_ms or 0))
    if domain:
        return DEFAULT_DOMAIN_TTL_MS[domain]
    return DEFAULT_DOMAIN_TTL_MS[DOMAIN_TICKER]


def _is_empty_domain_payload(data: Any, domain: Optional[str]) -> bool:
    if data is None:
        return True
    if not isinstance(data, Mapping):
        return False
    if domain == DOMAIN_DEPTH:
        return not data.get("bids") or not data.get("asks")
    if domain == DOMAIN_TRADES:
        return not data.get("trades")
    if domain == DOMAIN_KLINE:
        return not data.get("items")
    if domain == DOMAIN_TICKER:
        return not any(data.get(name) not in (None, "") for name in ("last_price", "price", "mark_price"))
    if "items" in data and not data.get("items"):
        return True
    if "trades" in data and not data.get("trades"):
        return True
    if ("bids" in data or "asks" in data) and (not data.get("bids") or not data.get("asks")):
        return True
    return False


def _normalize_version(value: Any) -> str:
    text = str(value or CACHE_VERSION).strip().lower()
    if not text:
        return CACHE_VERSION
    return text if text.startswith("v") else f"v{text}"


def _normalize_domain(value: Any) -> str:
    normalized = _normalize_key_part(value, lowercase=True)
    if normalized not in SUPPORTED_DOMAINS:
        raise ValueError(f"unsupported market cache domain: {value}")
    return normalized


def _normalize_interval(value: Any) -> str:
    normalized = _normalize_key_part(value or "1m", lowercase=True)
    if not normalized:
        raise ValueError("interval is required for kline cache keys")
    return normalized


def _normalize_symbol(value: Any) -> str:
    normalized = str(value or "").strip().upper().replace("/", "")
    if not normalized:
        raise ValueError("symbol is required for market cache keys")
    return normalized


def _normalize_key_part(value: Any, *, lowercase: bool) -> str:
    normalized = str(value or "").strip().replace(" ", "_")
    if lowercase:
        normalized = normalized.lower()
    if not normalized or ":" in normalized:
        raise ValueError("market cache key parts cannot be empty or contain ':'")
    return normalized


def _normalize_cache_key(value: Any) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError("cache key is required")
    return normalized


def _coerce_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except Exception:
        return None


def _decode_json(raw: Any) -> Any:
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8")
    return json.loads(str(raw))


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(item) for item in value]
    return value


def _default_redis_client() -> Any:
    from app.core.redis import get_redis

    return get_redis()
