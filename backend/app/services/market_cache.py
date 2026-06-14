from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable, Iterable, Optional, TypeVar

from pydantic import BaseModel

from app.core.config import settings
from app.core.redis import get_redis
from app.services.market_cache_metrics import (
    record_cache_hit,
    record_cache_miss,
    record_error,
    record_external_api_call,
    record_last_good_used,
    register_market_cache_key,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")

_memory_cache: dict[str, tuple[float, Any]] = {}
_last_good_memory_cache: dict[str, Any] = {}


def stable_hash(value: Any) -> str:
    raw = json.dumps(_to_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def market_cache_key(namespace: str, payload: Any) -> str:
    key = f"{namespace}:{stable_hash(payload)}"
    register_market_cache_key(key, namespace, payload)
    return key


def cache_fetch_json(
    key: str,
    ttl_seconds: int,
    loader: Callable[[], T],
    *,
    last_good_ttl_seconds: int = 24 * 60 * 60,
    fallback_on_error: bool = True,
) -> T:
    cached = cache_get_json(key)
    if cached is not None:
        record_cache_hit(key)
        return cached
    record_cache_miss(key)
    record_external_api_call(key)

    try:
        value = loader()
    except Exception as exc:
        record_error(key=key, error=exc)
        if fallback_on_error:
            fallback = cache_get_last_good_json(key)
            if fallback is not None:
                record_last_good_used(key)
                logger.warning("market_cache_last_good_fallback key=%s", key, exc_info=True)
                return fallback
        raise

    cache_set_json(key, value, ttl_seconds, last_good_ttl_seconds=last_good_ttl_seconds)
    return value


def cache_get_json(key: str) -> Optional[Any]:
    redis_value = _redis_get(_active_key(key))
    if redis_value is not None:
        return redis_value

    cached = _memory_cache.get(key)
    if cached is None:
        return None
    expires_at, value = cached
    if time.time() >= expires_at:
        _memory_cache.pop(key, None)
        return None
    return value


def cache_get_last_good_json(key: str) -> Optional[Any]:
    redis_value = _redis_get(_last_good_key(key))
    if redis_value is not None:
        return redis_value
    return _last_good_memory_cache.get(key)


def cache_set_json(
    key: str,
    value: Any,
    ttl_seconds: int,
    *,
    last_good_ttl_seconds: int = 24 * 60 * 60,
) -> None:
    jsonable = _to_jsonable(value)
    ttl = max(1, int(ttl_seconds or 1))
    last_good_ttl = max(ttl, int(last_good_ttl_seconds or ttl))

    _memory_cache[key] = (time.time() + ttl, jsonable)
    _last_good_memory_cache[key] = jsonable

    _redis_set(_active_key(key), jsonable, ttl)
    _redis_set(_last_good_key(key), jsonable, last_good_ttl)


def clear_market_cache_by_namespace_prefixes(namespace_prefixes: Iterable[str]) -> dict[str, int]:
    prefixes = tuple(str(item or "").strip() for item in namespace_prefixes if str(item or "").strip())
    if not prefixes:
        return {"memory_deleted": 0, "redis_deleted": 0}

    memory_deleted = 0
    for key in list(_memory_cache.keys()):
        if key.startswith(prefixes):
            _memory_cache.pop(key, None)
            memory_deleted += 1
    for key in list(_last_good_memory_cache.keys()):
        if key.startswith(prefixes):
            _last_good_memory_cache.pop(key, None)
            memory_deleted += 1

    redis_deleted = 0
    try:
        redis_client = get_redis()
        for prefix in prefixes:
            for key_prefix in (_active_key(prefix), _last_good_key(prefix)):
                pattern = _prefixed_key(f"{key_prefix}*")
                keys = list(redis_client.scan_iter(match=pattern, count=200))
                if keys:
                    redis_deleted += int(redis_client.delete(*keys) or 0)
    except Exception as exc:
        logger.warning("market_cache_clear_failed prefixes=%s reason=%s", prefixes, exc)

    return {"memory_deleted": memory_deleted, "redis_deleted": redis_deleted}


def clear_market_metadata_cache() -> dict[str, int]:
    return clear_market_cache_by_namespace_prefixes(
        (
            "global_selector:pairs",
            "market:ticker",
        )
    )


def _active_key(key: str) -> str:
    return f"market_cache:{key}"


def _last_good_key(key: str) -> str:
    return f"market_cache:last_good:{key}"


def _prefixed_key(key: str) -> str:
    prefix = getattr(settings, "REDIS_KEY_PREFIX", "exchange")
    return f"{prefix}:{key}"


def _redis_get(key: str) -> Optional[Any]:
    try:
        raw = get_redis().get(_prefixed_key(key))
    except Exception as exc:
        logger.debug("market_cache_redis_get_failed key=%s reason=%s", key, exc)
        return None
    if not raw:
        return None
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8")
    try:
        return json.loads(str(raw))
    except Exception as exc:
        logger.debug("market_cache_redis_decode_failed key=%s reason=%s", key, exc)
        return None


def _redis_set(key: str, value: Any, ttl_seconds: int) -> None:
    try:
        get_redis().set(_prefixed_key(key), json.dumps(value, ensure_ascii=False), ex=max(1, int(ttl_seconds)))
    except Exception as exc:
        logger.debug("market_cache_redis_set_failed key=%s reason=%s", key, exc)


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _to_jsonable(value.model_dump())
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _to_jsonable(val) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(item) for item in value]
    return value
