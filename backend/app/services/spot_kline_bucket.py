from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional


MINUTE_MS = 60_000
HOUR_MS = 60 * MINUTE_MS
DAY_MS = 24 * HOUR_MS
WEEK_MS = 7 * DAY_MS
OKX_SPOT_1D_ANCHOR_OFFSET_MS = 8 * HOUR_MS

SPOT_KLINE_INTERVAL_MS = {
    "1m": MINUTE_MS,
    "5m": 5 * MINUTE_MS,
    "15m": 15 * MINUTE_MS,
    "1h": HOUR_MS,
    "4h": 4 * HOUR_MS,
    "1d": DAY_MS,
    "1w": WEEK_MS,
    "1M": 30 * DAY_MS,
}


def normalize_spot_kline_bucket_interval(interval: Any) -> str:
    normalized = str(interval or "1m").strip()
    if normalized == "1M":
        return normalized
    if normalized.upper() in {"1H", "4H", "1D", "1W"}:
        normalized = normalized.lower()
    return normalized


def spot_kline_interval_ms(interval: Any) -> int:
    normalized = normalize_spot_kline_bucket_interval(interval)
    try:
        return SPOT_KLINE_INTERVAL_MS[normalized]
    except KeyError as exc:
        raise ValueError("invalid interval") from exc


def okx_spot_1d_bucket_start_ms(ts_ms: Any) -> int:
    ts = int(ts_ms)
    return ((ts + OKX_SPOT_1D_ANCHOR_OFFSET_MS) // DAY_MS) * DAY_MS - OKX_SPOT_1D_ANCHOR_OFFSET_MS


def _datetime_utc_from_ms(ts_ms: Any) -> datetime:
    return datetime.fromtimestamp(int(ts_ms) / 1000, tz=timezone.utc)


def _ms_from_datetime_utc(value: datetime) -> int:
    return int(value.timestamp() * 1000)


def okx_spot_1w_bucket_start_ms(ts_ms: Any) -> int:
    local_dt = _datetime_utc_from_ms(ts_ms) + timedelta(hours=8)
    local_start = (local_dt - timedelta(days=local_dt.weekday())).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    return _ms_from_datetime_utc(local_start - timedelta(hours=8))


def okx_spot_1M_bucket_start_ms(ts_ms: Any) -> int:
    local_dt = _datetime_utc_from_ms(ts_ms) + timedelta(hours=8)
    local_start = local_dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return _ms_from_datetime_utc(local_start - timedelta(hours=8))


def spot_kline_bucket_start_ms(
    ts_ms: Any,
    interval: Any,
    *,
    provider: Optional[str] = None,
) -> int:
    normalized_interval = normalize_spot_kline_bucket_interval(interval)
    ts = int(ts_ms)
    if str(provider or "").strip().upper() == "OKX_SPOT":
        if normalized_interval == "1d":
            return okx_spot_1d_bucket_start_ms(ts)
        if normalized_interval == "1w":
            return okx_spot_1w_bucket_start_ms(ts)
        if normalized_interval == "1M":
            return okx_spot_1M_bucket_start_ms(ts)
    step_ms = spot_kline_interval_ms(normalized_interval)
    return (ts // step_ms) * step_ms


def is_okx_spot_1d_open_time(open_time_ms: Any) -> bool:
    try:
        open_time = int(open_time_ms)
    except Exception:
        return False
    if open_time <= 0:
        return False
    return okx_spot_1d_bucket_start_ms(open_time) == open_time


def is_okx_spot_1w_open_time(open_time_ms: Any) -> bool:
    try:
        open_time = int(open_time_ms)
    except Exception:
        return False
    if open_time <= 0:
        return False
    return okx_spot_1w_bucket_start_ms(open_time) == open_time


def is_okx_spot_1M_open_time(open_time_ms: Any) -> bool:
    try:
        open_time = int(open_time_ms)
    except Exception:
        return False
    if open_time <= 0:
        return False
    return okx_spot_1M_bucket_start_ms(open_time) == open_time


def okx_spot_open_time_validator(interval: Any):
    normalized = normalize_spot_kline_bucket_interval(interval)
    if normalized == "1d":
        return is_okx_spot_1d_open_time
    if normalized == "1w":
        return is_okx_spot_1w_open_time
    if normalized == "1M":
        return is_okx_spot_1M_open_time
    return None
