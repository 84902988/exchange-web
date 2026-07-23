from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
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
    record_loader_error,
    record_loader_success,
    record_lock_acquired,
    record_lock_busy,
    record_memory_fallback,
    record_redis_unavailable,
    record_stale_hit,
    register_market_cache_key,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")

_memory_cache: dict[str, tuple[float, Any]] = {}
_last_good_memory_cache: dict[str, Any] = {}
_cache_metadata_memory: dict[str, dict[str, Any]] = {}
_lock_busy_log_last_at: dict[str, float] = {}

LOCK_TTL_SECONDS = 5
LOCK_WAIT_SECONDS = 0.15
LOCK_BUSY_LOG_INTERVAL_SECONDS = 30

# Public market cache boundary:
# allowed: ticker, depth, trades, kline, market pairs, contract symbols, market list snapshots.
# forbidden: user balances, user orders, positions, KYC, withdrawals, assets, private WS payloads,
# and admin personal permission/session state.


def _should_log_lock_busy(key: str) -> bool:
    now = time.monotonic()
    last_at = _lock_busy_log_last_at.get(key, 0.0)
    if now - last_at < LOCK_BUSY_LOG_INTERVAL_SECONDS:
        return False
    _lock_busy_log_last_at[key] = now
    return True


def stable_hash(value: Any) -> str:
    raw = json.dumps(_to_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def market_cache_key(
    namespace: str,
    payload: Any = None,
    *,
    version: str | int | None = None,
    symbol: str | None = None,
    symbols: Iterable[str] | str | None = None,
    market_type: str | None = None,
    asset_type: str | None = None,
    category: str | None = None,
    provider_code: str | None = None,
    provider_version: str | int | None = None,
    field_version: str | int | None = None,
    query_params: Any = None,
) -> str:
    key_namespace = _versioned_namespace(namespace, version)
    key_payload = _build_key_payload(
        payload,
        version=version,
        symbol=symbol,
        symbols=symbols,
        market_type=market_type,
        asset_type=asset_type,
        category=category,
        provider_code=provider_code,
        provider_version=provider_version,
        field_version=field_version,
        query_params=query_params,
    )
    key = f"{key_namespace}:{stable_hash(key_payload)}"
    register_market_cache_key(key, key_namespace, key_payload)
    return key


def cache_fetch_json(
    key: str,
    ttl_seconds: int,
    loader: Callable[[], T],
    *,
    last_good_ttl_seconds: int = 24 * 60 * 60,
    fallback_on_error: bool = True,
    lock_ttl_seconds: int = LOCK_TTL_SECONDS,
    lock_wait_seconds: float = LOCK_WAIT_SECONDS,
) -> T:
    cached = cache_get_json(key)
    if cached is not None:
        record_cache_hit(key)
        return cached
    record_cache_miss(key)

    lock_token, lock_error = _try_acquire_lock(key, ttl_seconds=lock_ttl_seconds)
    if lock_token:
        record_lock_acquired(key)
        try:
            cached = cache_get_json(key)
            if cached is not None:
                record_cache_hit(key)
                return cached
            return _load_and_store_json(
                key,
                ttl_seconds,
                loader,
                last_good_ttl_seconds=last_good_ttl_seconds,
                fallback_on_error=fallback_on_error,
            )
        finally:
            _release_lock(key, lock_token)

    if lock_error is not None:
        record_redis_unavailable(key)
        record_memory_fallback(key)
        return _load_and_store_json(
            key,
            ttl_seconds,
            loader,
            last_good_ttl_seconds=last_good_ttl_seconds,
            fallback_on_error=fallback_on_error,
        )

    record_lock_busy(key)
    fallback = cache_get_last_good_json(key)
    if fallback is not None:
        record_last_good_used(key)
        record_stale_hit(key)
        if _should_log_lock_busy(key):
            logger.info("market_cache_last_good_lock_busy key=%s", key)
        return _mark_stale(fallback, key=key, stale_reason="lock_busy")

    if lock_wait_seconds > 0:
        time.sleep(float(lock_wait_seconds))
        cached = cache_get_json(key)
        if cached is not None:
            record_cache_hit(key)
            return cached

    return _load_and_store_json(
        key,
        ttl_seconds,
        loader,
        last_good_ttl_seconds=last_good_ttl_seconds,
        fallback_on_error=fallback_on_error,
    )


def _load_and_store_json(
    key: str,
    ttl_seconds: int,
    loader: Callable[[], T],
    *,
    last_good_ttl_seconds: int,
    fallback_on_error: bool,
) -> T:
    record_external_api_call(key)

    try:
        value = loader()
    except Exception as exc:
        record_loader_error(key)
        record_error(key=key, error=exc)
        # A cached public snapshot must never resurrect a symbol that the
        # administrative control plane removed or disabled.
        error_code = str(getattr(exc, "code", "") or "").strip().upper()
        if fallback_on_error and error_code != "CONTRACT_SYMBOL_NOT_FOUND":
            fallback = cache_get_last_good_json(key)
            if fallback is not None:
                record_last_good_used(key)
                record_stale_hit(key)
                logger.warning("market_cache_last_good_fallback key=%s", key, exc_info=True)
                return _mark_stale(fallback, key=key, stale_reason="loader_error")
        raise

    record_loader_success(key)
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
    _cache_metadata_memory[key] = _cache_metadata()

    _redis_set(_active_key(key), jsonable, ttl)
    _redis_set(_last_good_key(key), jsonable, last_good_ttl)
    _redis_set(_metadata_key(key), _cache_metadata_memory[key], last_good_ttl)


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
    for key in list(_cache_metadata_memory.keys()):
        if key.startswith(prefixes):
            _cache_metadata_memory.pop(key, None)
            memory_deleted += 1

    redis_deleted = 0
    try:
        redis_client = get_redis()
        for prefix in prefixes:
            for key_prefix in (_active_key(prefix), _last_good_key(prefix), _metadata_key(prefix)):
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


def _metadata_key(key: str) -> str:
    return f"market_cache:meta:{key}"


def _lock_key(key: str) -> str:
    return f"market_cache:lock:{stable_hash({'key': key})}"


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


def _try_acquire_lock(key: str, *, ttl_seconds: int) -> tuple[Optional[str], Optional[Exception]]:
    token = uuid.uuid4().hex
    try:
        acquired = get_redis().set(
            _prefixed_key(_lock_key(key)),
            token,
            nx=True,
            ex=max(1, int(ttl_seconds or LOCK_TTL_SECONDS)),
        )
    except Exception as exc:
        logger.debug("market_cache_lock_acquire_failed key=%s reason=%s", key, exc)
        return None, exc
    return (token if acquired else None), None


def _release_lock(key: str, token: str) -> None:
    script = """
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    end
    return 0
    """
    try:
        get_redis().eval(script, 1, _prefixed_key(_lock_key(key)), token)
    except Exception as exc:
        logger.debug("market_cache_lock_release_failed key=%s reason=%s", key, exc)


def _cache_metadata() -> dict[str, Any]:
    updated_at = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    return {"cache_updated_at": updated_at}


def _cache_updated_at(key: str) -> str:
    redis_meta = _redis_get(_metadata_key(key))
    if isinstance(redis_meta, dict) and redis_meta.get("cache_updated_at"):
        return str(redis_meta["cache_updated_at"])
    memory_meta = _cache_metadata_memory.get(key) or {}
    if memory_meta.get("cache_updated_at"):
        return str(memory_meta["cache_updated_at"])
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _mark_stale(value: Any, *, key: str, stale_reason: str) -> Any:
    jsonable = _to_jsonable(value)
    cache_updated_at = _cache_updated_at(key)
    if isinstance(jsonable, list):
        return [_mark_stale_item(item, stale_reason=stale_reason, cache_updated_at=cache_updated_at) for item in jsonable]
    if isinstance(jsonable, dict):
        data = dict(jsonable)
        items = data.get("items")
        if isinstance(items, list):
            data["items"] = [
                _mark_stale_item(item, stale_reason=stale_reason, cache_updated_at=cache_updated_at)
                for item in items
            ]
            data["_cache"] = {
                "is_stale": True,
                "stale_reason": stale_reason,
                "cache_updated_at": cache_updated_at,
            }
            return data
        return _mark_stale_item(data, stale_reason=stale_reason, cache_updated_at=cache_updated_at)
    return jsonable


def _mark_stale_item(item: Any, *, stale_reason: str, cache_updated_at: str) -> Any:
    if not isinstance(item, dict):
        return item
    data = dict(item)
    data["is_stale"] = True
    data["stale_reason"] = stale_reason
    data["cache_updated_at"] = cache_updated_at
    if not data.get("source_updated_at") and data.get("updated_at"):
        data["source_updated_at"] = data.get("updated_at")
    return data


def _versioned_namespace(namespace: str, version: str | int | None) -> str:
    base = str(namespace or "market").strip() or "market"
    if version is None or str(version).strip() == "":
        return base
    version_text = str(version).strip()
    if version_text.lower().startswith("v"):
        return f"{base}:{version_text}"
    return f"{base}:v{version_text}"


def _build_key_payload(
    payload: Any,
    *,
    version: str | int | None,
    symbol: str | None,
    symbols: Iterable[str] | str | None,
    market_type: str | None,
    asset_type: str | None,
    category: str | None,
    provider_code: str | None,
    provider_version: str | int | None,
    field_version: str | int | None,
    query_params: Any,
) -> Any:
    if not any(
        value is not None
        for value in (
            version,
            symbol,
            symbols,
            market_type,
            asset_type,
            category,
            provider_code,
            provider_version,
            field_version,
            query_params,
        )
    ):
        return payload

    key_payload: dict[str, Any] = {}
    if isinstance(payload, dict):
        key_payload.update(payload)
    elif payload is not None:
        key_payload["payload"] = payload

    optional_parts = {
        "version": version,
        "symbol": symbol,
        "symbols": _normalize_symbols(symbols),
        "market_type": market_type,
        "asset_type": asset_type,
        "category": category,
        "provider_code": provider_code,
        "provider_version": provider_version,
        "field_version": field_version,
        "query_params": query_params,
    }
    for field, value in optional_parts.items():
        if value is not None:
            key_payload[field] = value
    return key_payload


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


def _normalize_symbols(symbols: Iterable[str] | str | None) -> Optional[list[str]]:
    if symbols is None:
        return None
    if isinstance(symbols, str):
        values = symbols.split(",")
    else:
        values = list(symbols)
    normalized = sorted({str(item).strip().upper() for item in values if str(item).strip()})
    return normalized
