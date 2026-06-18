from __future__ import annotations

import re
import threading
from collections import deque
from datetime import datetime
from typing import Any

_lock = threading.Lock()
_recent_errors: deque[dict[str, str]] = deque(maxlen=100)
_key_meta: dict[str, dict[str, str]] = {}
_KEY_META_MAX_SIZE = 2048

_current_date = datetime.now().date().isoformat()
_overall = {}
_by_type: dict[str, dict[str, int]] = {}
_yesterday_snapshot: dict[str, Any] = {}

_TYPE_ORDER = [
    "ticker",
    "pairs",
    "contract_quote",
    "contract_depth",
    "kline_db_hit",
    "kline_external_fetch",
]
_EXTERNAL_CACHE_TYPES = {"ticker", "contract_quote", "contract_depth"}
_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|apikey|access[_-]?token|token|secret|password|signature)(=|:)\s*[^&\s,;]+"
)


def register_market_cache_key(key: str, namespace: str, payload: Any) -> None:
    meta = {
        "endpoint": str(namespace or ""),
        "symbol": _extract_symbol(payload),
        "provider": _provider_from_namespace(namespace),
    }
    with _lock:
        _remember_key_meta_locked(str(key), meta)


def record_cache_hit(key: str) -> None:
    _increment(key, "hit")


def record_cache_miss(key: str) -> None:
    _increment(key, "miss")


def record_last_good_used(key: str) -> None:
    _increment(key, "last_good_used")


def record_stale_hit(key: str) -> None:
    _increment(key, "stale_hit")


def record_loader_success(key: str) -> None:
    _increment(key, "loader_success")


def record_loader_error(key: str) -> None:
    _increment(key, "loader_error")


def record_lock_acquired(key: str) -> None:
    _increment(key, "lock_acquired")


def record_lock_busy(key: str) -> None:
    _increment(key, "lock_busy")


def record_redis_unavailable(key: str) -> None:
    _increment(key, "redis_unavailable")


def record_memory_fallback(key: str) -> None:
    _increment(key, "memory_fallback")


def record_external_api_call(key: str) -> None:
    metric_type = _type_for_key(key)
    if metric_type not in _EXTERNAL_CACHE_TYPES:
        return
    _increment(key, "external_api_calls")


def record_kline_db_hit(*, market_type: str, symbol: str, interval: str, count: int) -> None:
    with _lock:
        _rollover_if_needed_locked()
        _type_bucket("kline_db_hit")["count"] += 1
        _type_bucket("kline_db_hit")["rows"] += max(0, int(count or 0))
        _remember_key_meta_locked(
            f"kline:{market_type}:{symbol}:{interval}",
            {
                "endpoint": f"kline:{interval}",
                "symbol": str(symbol or ""),
                "provider": "DB",
            },
        )


def record_kline_external_fetch(*, source: str, market_type: str, symbol: str, interval: str) -> None:
    with _lock:
        _rollover_if_needed_locked()
        _overall["external_api_calls"] += 1
        bucket = _type_bucket("kline_external_fetch")
        bucket["count"] += 1
        provider = str(source or "").strip().upper() or str(market_type or "").strip().upper() or "EXTERNAL"
        _remember_key_meta_locked(
            f"kline_fetch:{market_type}:{symbol}:{interval}",
            {
                "endpoint": f"kline:{interval}",
                "symbol": str(symbol or ""),
                "provider": provider,
            },
        )


def record_error(
    *,
    provider: str = "",
    symbol: str = "",
    endpoint: str = "",
    error: Any = "",
    key: str = "",
) -> None:
    meta = _meta_for_key(key) if key else {}
    item = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "provider": _clean(provider or meta.get("provider") or "UNKNOWN", 80),
        "symbol": _clean(symbol or meta.get("symbol") or "-", 80),
        "endpoint": _clean(endpoint or meta.get("endpoint") or "-", 120),
        "error": _clean(str(error or ""), 400),
    }
    with _lock:
        _rollover_if_needed_locked()
        _recent_errors.appendleft(item)


def get_market_cache_metrics_snapshot() -> dict[str, Any]:
    with _lock:
        _rollover_if_needed_locked()
        today = _snapshot_locked(_current_date)
        yesterday = _yesterday_snapshot or _empty_snapshot("")
        return {
            "current_date": _current_date,
            "today": today,
            "yesterday": yesterday,
            "overview": dict(today["overview"]),
            "type_rows": list(today["type_rows"]),
            "errors": list(_recent_errors)[:50],
        }


def _increment(key: str, field: str) -> None:
    metric_type = _type_for_key(key)
    with _lock:
        _rollover_if_needed_locked()
        _overall[field] = _overall.get(field, 0) + 1
        _type_bucket(metric_type)[field] += 1


def _rollover_if_needed_locked() -> None:
    global _by_type, _current_date, _overall, _yesterday_snapshot

    today = datetime.now().date().isoformat()
    if today == _current_date:
        if not _overall:
            _overall = _empty_overall()
        return

    _yesterday_snapshot = _snapshot_locked(_current_date)
    _overall = _empty_overall()
    _by_type = {}
    _current_date = today


def _snapshot_locked(snapshot_date: str) -> dict[str, Any]:
    by_type = {key: dict(value) for key, value in _by_type.items()}
    return {
        "date": snapshot_date,
        "overview": {**_empty_overall(), **dict(_overall)},
        "type_rows": [_type_row(key, by_type.get(key, {})) for key in _TYPE_ORDER],
    }


def _empty_snapshot(snapshot_date: str) -> dict[str, Any]:
    return {
        "date": snapshot_date,
        "overview": _empty_overall(),
        "type_rows": [_type_row(key, {}) for key in _TYPE_ORDER],
    }


def _empty_overall() -> dict[str, int]:
    return {
        "hit": 0,
        "miss": 0,
        "stale_hit": 0,
        "last_good_used": 0,
        "loader_success": 0,
        "loader_error": 0,
        "lock_acquired": 0,
        "lock_busy": 0,
        "redis_unavailable": 0,
        "memory_fallback": 0,
        "external_api_calls": 0,
    }


def _remember_key_meta_locked(key: str, meta: dict[str, str]) -> None:
    if key in _key_meta:
        _key_meta[key] = meta
        return
    if len(_key_meta) >= _KEY_META_MAX_SIZE:
        _key_meta.pop(next(iter(_key_meta)), None)
    _key_meta[key] = meta


def _type_bucket(metric_type: str) -> dict[str, int]:
    bucket = _by_type.setdefault(
        metric_type,
        {
            "hit": 0,
            "miss": 0,
            "stale_hit": 0,
            "last_good_used": 0,
            "loader_success": 0,
            "loader_error": 0,
            "lock_acquired": 0,
            "lock_busy": 0,
            "redis_unavailable": 0,
            "memory_fallback": 0,
            "external_api_calls": 0,
            "count": 0,
            "rows": 0,
        },
    )
    return bucket


def _type_row(key: str, bucket: dict[str, int]) -> dict[str, Any]:
    return {
        "key": key,
        "label": key,
        "hit": int(bucket.get("hit", 0)),
        "miss": int(bucket.get("miss", 0)),
        "stale_hit": int(bucket.get("stale_hit", 0)),
        "last_good_used": int(bucket.get("last_good_used", 0)),
        "loader_success": int(bucket.get("loader_success", 0)),
        "loader_error": int(bucket.get("loader_error", 0)),
        "lock_acquired": int(bucket.get("lock_acquired", 0)),
        "lock_busy": int(bucket.get("lock_busy", 0)),
        "redis_unavailable": int(bucket.get("redis_unavailable", 0)),
        "memory_fallback": int(bucket.get("memory_fallback", 0)),
        "external_api_calls": int(bucket.get("external_api_calls", 0)),
        "count": int(bucket.get("count", 0)),
        "rows": int(bucket.get("rows", 0)),
    }


def _type_for_key(key: str) -> str:
    endpoint = _meta_for_key(key).get("endpoint", "")
    if endpoint.startswith("market:ticker") or endpoint.startswith("contract:ticker"):
        return "ticker"
    if endpoint.startswith("global_selector:pairs"):
        return "pairs"
    if endpoint.startswith("contract:quote"):
        return "contract_quote"
    if endpoint.startswith("contract:depth"):
        return "contract_depth"
    return "other"


def _meta_for_key(key: str) -> dict[str, str]:
    return _key_meta.get(str(key), {})


def _provider_from_namespace(namespace: str) -> str:
    prefix = str(namespace or "").split(":", 1)[0].strip().upper()
    if prefix == "MARKET":
        return "SPOT"
    if prefix == "CONTRACT":
        return "CONTRACT"
    if prefix == "GLOBAL_SELECTOR":
        return "DB"
    return prefix or "UNKNOWN"


def _extract_symbol(payload: Any) -> str:
    if not isinstance(payload, dict):
        return "-"
    symbol = payload.get("symbol")
    if symbol:
        return str(symbol)
    symbols = payload.get("symbols")
    if isinstance(symbols, (list, tuple, set)) and symbols:
        return ",".join(str(item) for item in list(symbols)[:5])
    return "-"


def _clean(value: str, max_len: int) -> str:
    cleaned = _SECRET_RE.sub(r"\1\2***", str(value or ""))
    cleaned = cleaned.replace("\r", " ").replace("\n", " ").strip()
    if len(cleaned) > max_len:
        return f"{cleaned[: max_len - 3]}..."
    return cleaned
