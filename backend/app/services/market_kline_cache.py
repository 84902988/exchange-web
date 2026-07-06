from __future__ import annotations

import calendar
import logging
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Iterable, Optional

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.db.models.market_kline import MarketKline
from app.services.market_cache_metrics import (
    record_error,
    record_kline_db_hit,
    record_kline_external_fetch,
)
from app.services.spot_kline_bucket import normalize_spot_kline_bucket_interval


logger = logging.getLogger(__name__)

OpenTimeValidator = Callable[[int], bool]

KLINE_CACHE_ORIGIN_DB_CACHE = "DB_CACHE"
KLINE_CACHE_ORIGIN_REST_FETCH = "REST_FETCH"
KLINE_CACHE_ORIGIN_STALE_CACHE = "STALE_CACHE"
KLINE_CACHE_ORIGIN_EMPTY = "EMPTY"

KLINE_CACHE_STATUS_HIT = "HIT"
KLINE_CACHE_STATUS_MISS = "MISS"
KLINE_CACHE_STATUS_SHORT = "SHORT"
KLINE_CACHE_STATUS_CONTINUITY_INVALID = "CONTINUITY_INVALID"
KLINE_CACHE_STATUS_STALE_OPEN = "STALE_OPEN"
KLINE_CACHE_STATUS_PROVIDER_EMPTY = "PROVIDER_EMPTY"

KLINE_PROVIDER_ERROR_TIMEOUT = "TIMEOUT"
KLINE_PROVIDER_ERROR_COOLDOWN = "COOLDOWN"
KLINE_PROVIDER_ERROR_HTTP = "HTTP_ERROR"
KLINE_PROVIDER_ERROR_EMPTY = "EMPTY"
KLINE_PROVIDER_ERROR_UNKNOWN = "UNKNOWN"
_KLINE_PROVIDER_ERROR_CODES = {
    KLINE_PROVIDER_ERROR_TIMEOUT,
    KLINE_PROVIDER_ERROR_COOLDOWN,
    KLINE_PROVIDER_ERROR_HTTP,
    KLINE_PROVIDER_ERROR_EMPTY,
    KLINE_PROVIDER_ERROR_UNKNOWN,
}


class KlineProviderFetchError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        provider_error_code: str = KLINE_PROVIDER_ERROR_UNKNOWN,
        provider_error_provider: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.provider_error_code = _normalize_provider_error_code(provider_error_code)
        self.provider_error_provider = _sanitize_provider_error_provider(provider_error_provider)


class KlineCacheResult(list):
    def __init__(
        self,
        items: Iterable[Any] = (),
        *,
        origin: str,
        cache_status: str,
        provider_error_code: Optional[str] = None,
        provider_error_provider: Optional[str] = None,
        history_incomplete: bool = False,
    ) -> None:
        super().__init__(items)
        self.origin = origin
        self.cache_status = cache_status
        self.provider_error_code = _normalize_provider_error_code(provider_error_code) if provider_error_code else None
        self.provider_error_provider = _sanitize_provider_error_provider(provider_error_provider)
        self.history_incomplete = bool(history_incomplete)

    @property
    def items(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self if isinstance(item, dict)]


def _normalize_provider_error_code(value: Optional[str]) -> str:
    normalized = str(value or "").strip().upper()
    return normalized if normalized in _KLINE_PROVIDER_ERROR_CODES else KLINE_PROVIDER_ERROR_UNKNOWN


def _sanitize_provider_error_provider(value: Optional[str]) -> Optional[str]:
    normalized = str(value or "").strip().upper()
    if not normalized:
        return None
    return "".join(char for char in normalized if char.isalnum() or char == "_")[:64] or None


def _classify_provider_error(exc: Exception) -> tuple[str, Optional[str]]:
    code = getattr(exc, "provider_error_code", None)
    provider = getattr(exc, "provider_error_provider", None)
    if code:
        return _normalize_provider_error_code(str(code)), _sanitize_provider_error_provider(provider)

    lowered = str(exc or "").lower()
    if "timeout" in lowered or "timed out" in lowered or "over_budget" in lowered:
        code = KLINE_PROVIDER_ERROR_TIMEOUT
    elif "cooldown" in lowered:
        code = KLINE_PROVIDER_ERROR_COOLDOWN
    elif "http " in lowered or "status_code" in lowered:
        code = KLINE_PROVIDER_ERROR_HTTP
    elif "empty" in lowered or "unavailable" in lowered or "no data" in lowered:
        code = KLINE_PROVIDER_ERROR_EMPTY
    else:
        code = KLINE_PROVIDER_ERROR_UNKNOWN
    return code, _sanitize_provider_error_provider(provider)

SUPPORTED_KLINE_INTERVAL_SECONDS = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
    "1d": 24 * 60 * 60,
    "1Dutc": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
    "1Wutc": 7 * 24 * 60 * 60,
    "1M": 30 * 24 * 60 * 60,
    "1Mutc": 30 * 24 * 60 * 60,
}

OPEN_KLINE_TTL_SECONDS = 10
LATEST_KLINE_REFRESH_TTL_SECONDS = {
    "1m": 10,
    "5m": 20,
    "15m": 30,
    "1h": 60,
    "4h": 120,
    "1d": 300,
    "1Dutc": 300,
    "1w": 900,
    "1Wutc": 900,
    "1M": 1800,
    "1Mutc": 1800,
}


def normalize_kline_interval(interval: str) -> str:
    normalized = normalize_spot_kline_bucket_interval(interval)
    if normalized not in SUPPORTED_KLINE_INTERVAL_SECONDS:
        raise ValueError("invalid interval")
    return normalized


def normalize_kline_limit(limit: int) -> int:
    try:
        value = int(limit)
    except Exception:
        value = 200
    return max(1, min(value, 1000))


def interval_ms(interval: str) -> int:
    return SUPPORTED_KLINE_INTERVAL_SECONDS[normalize_kline_interval(interval)] * 1000


def _item_open_time_ms(item: Any) -> Optional[int]:
    for key in ("open_time", "open_time_ms", "time"):
        value = _get_item_value(item, key, None)
        if value in (None, ""):
            continue
        try:
            open_time = int(value)
        except Exception:
            return None
        return open_time if open_time > 0 else None
    return None


def _add_one_calendar_month(value: datetime) -> datetime:
    month = value.month + 1
    year = value.year
    if month > 12:
        month = 1
        year += 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def _next_month_open_time_ms(open_time_ms: int) -> int:
    value = datetime.fromtimestamp(int(open_time_ms) / 1000, tz=timezone.utc)
    if (
        value.day == 1
        and value.hour == 0
        and value.minute == 0
        and value.second == 0
        and value.microsecond == 0
    ):
        return int(_add_one_calendar_month(value).timestamp() * 1000)

    local_value = value + timedelta(hours=8)
    if (
        local_value.day == 1
        and local_value.hour == 0
        and local_value.minute == 0
        and local_value.second == 0
        and local_value.microsecond == 0
    ):
        return int((_add_one_calendar_month(local_value) - timedelta(hours=8)).timestamp() * 1000)

    return int(_add_one_calendar_month(value).timestamp() * 1000)


def _validate_cached_klines_continuity(items: Iterable[Any], interval: str) -> bool:
    normalized_interval = normalize_kline_interval(interval)
    open_times: list[int] = []
    previous_open_time: Optional[int] = None
    seen_open_times: set[int] = set()

    for item in items:
        open_time = _item_open_time_ms(item)
        if open_time is None:
            return False
        if open_time in seen_open_times:
            return False
        if previous_open_time is not None and open_time <= previous_open_time:
            return False
        seen_open_times.add(open_time)
        open_times.append(open_time)
        previous_open_time = open_time

    if len(open_times) <= 1:
        return True

    if normalized_interval in {"1M", "1Mutc"}:
        for previous, current in zip(open_times, open_times[1:]):
            if current != _next_month_open_time_ms(previous):
                return False
        return True

    expected_delta = interval_ms(normalized_interval)
    for previous, current in zip(open_times, open_times[1:]):
        if current - previous != expected_delta:
            return False
    return True


def _normalize_symbol(symbol: str) -> str:
    return str(symbol or "").strip().upper()


def _decimal_or_zero(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _decimal_to_text(value: Any) -> str:
    decimal_value = _decimal_or_zero(value)
    return format(decimal_value.normalize(), "f") if decimal_value != 0 else "0"


def _get_item_value(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _is_closed(open_time: int, interval: str, now_ms: Optional[int] = None) -> bool:
    if now_ms is None:
        now_ms = int(datetime.utcnow().timestamp() * 1000)
    return int(open_time) + interval_ms(interval) <= now_ms


def serialize_kline_item(item: Any, interval: Optional[str] = None) -> dict[str, Any]:
    open_time = _get_item_value(item, "open_time", _get_item_value(item, "time", 0))
    close_time = _get_item_value(item, "close_time", None)
    try:
        open_time_int = int(open_time or 0)
    except Exception:
        open_time_int = 0
    try:
        close_time_int = int(close_time) if close_time not in (None, "") else 0
    except Exception:
        close_time_int = 0
    if close_time_int <= 0 and interval:
        close_time_int = open_time_int + interval_ms(interval)

    return {
        "open_time": open_time_int,
        "close_time": close_time_int,
        "open": _decimal_to_text(_get_item_value(item, "open")),
        "high": _decimal_to_text(_get_item_value(item, "high")),
        "low": _decimal_to_text(_get_item_value(item, "low")),
        "close": _decimal_to_text(_get_item_value(item, "close")),
        "volume": _decimal_to_text(_get_item_value(item, "volume", "0")),
        "quote_volume": _decimal_to_text(_get_item_value(item, "quote_volume", "0")),
    }


def _normalize_item(item: Any, interval: str) -> Optional[dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    try:
        open_time = int(item.get("open_time") or item.get("time") or 0)
    except Exception:
        return None
    if open_time <= 0:
        return None

    close_time = item.get("close_time")
    try:
        close_time_int = int(close_time) if close_time not in (None, "") else open_time + interval_ms(interval)
    except Exception:
        close_time_int = open_time + interval_ms(interval)

    return {
        "open_time": open_time,
        "close_time": close_time_int,
        "open": _decimal_or_zero(item.get("open")),
        "high": _decimal_or_zero(item.get("high")),
        "low": _decimal_or_zero(item.get("low")),
        "close": _decimal_or_zero(item.get("close")),
        "volume": _decimal_or_zero(item.get("volume")),
        "quote_volume": _decimal_or_zero(item.get("quote_volume")),
    }


def _item_matches_open_time_validator(
    item: Any,
    open_time_validator: Optional[OpenTimeValidator],
) -> bool:
    if open_time_validator is None:
        return True
    try:
        open_time = int(_get_item_value(item, "open_time", _get_item_value(item, "time", 0)) or 0)
    except Exception:
        return False
    return open_time_validator(open_time)


def _filter_items_by_open_time(
    items: Iterable[Any],
    open_time_validator: Optional[OpenTimeValidator],
) -> list[Any]:
    if open_time_validator is None:
        return list(items)
    return [
        item
        for item in items
        if _item_matches_open_time_validator(item, open_time_validator)
    ]


def _item_before_end_time(item: Any, end_time_ms: Optional[int]) -> bool:
    if end_time_ms is None:
        return True
    try:
        open_time = int(_get_item_value(item, "open_time", _get_item_value(item, "time", 0)) or 0)
    except Exception:
        return False
    return open_time > 0 and open_time < int(end_time_ms)


def _filter_items_before_end_time(
    items: Iterable[Any],
    end_time_ms: Optional[int],
) -> list[Any]:
    if end_time_ms is None:
        return list(items)
    return [item for item in items if _item_before_end_time(item, end_time_ms)]


def _is_missing_table_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "market_klines" in message and (
        "doesn't exist" in message
        or "does not exist" in message
        or "no such table" in message
        or "unknown table" in message
    )


def _is_duplicate_entry_error(exc: Exception) -> bool:
    orig = getattr(exc, "orig", None)
    args = getattr(orig, "args", ())
    if args:
        try:
            return int(args[0]) == 1062
        except (TypeError, ValueError):
            pass
    message = str(exc).lower()
    return "1062" in message and "duplicate" in message


def _read_cached_klines(
    db: Session,
    *,
    market_type: str,
    symbol: str,
    interval: str,
    limit: int,
    end_time_ms: Optional[int] = None,
    allow_stale_open: bool = False,
    open_time_validator: Optional[OpenTimeValidator] = None,
) -> list[dict[str, Any]]:
    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = normalize_kline_interval(interval)
    normalized_limit = normalize_kline_limit(limit)
    now = datetime.utcnow()

    try:
        query = (
            db.query(MarketKline)
            .filter(
                MarketKline.market_type == market_type,
                MarketKline.symbol == normalized_symbol,
                MarketKline.interval == normalized_interval,
            )
        )
        if end_time_ms:
            query = query.filter(MarketKline.open_time < int(end_time_ms))

        query_limit = normalized_limit
        if open_time_validator is not None:
            query_limit = min(max(normalized_limit * 3, normalized_limit), 3000)

        rows = (
            query.order_by(MarketKline.open_time.desc())
            .limit(query_limit)
            .all()
        )
    except (ProgrammingError, OperationalError) as exc:
        db.rollback()
        if _is_missing_table_error(exc):
            record_error(provider="DB", symbol=normalized_symbol, endpoint="kline_db_read", error=exc)
            logger.warning("market_klines table missing, skip kline db cache")
            return []
        record_error(provider="DB", symbol=normalized_symbol, endpoint="kline_db_read", error=exc)
        logger.warning("market_klines read failed symbol=%s interval=%s error=%s", normalized_symbol, normalized_interval, exc)
        return []
    except SQLAlchemyError as exc:
        db.rollback()
        record_error(provider="DB", symbol=normalized_symbol, endpoint="kline_db_read", error=exc)
        logger.warning("market_klines read failed symbol=%s interval=%s error=%s", normalized_symbol, normalized_interval, exc)
        return []

    items: list[dict[str, Any]] = []
    for row in reversed(rows):
        if not _item_matches_open_time_validator(row, open_time_validator):
            continue
        if (
            not allow_stale_open
            and not bool(row.is_closed)
            and row.updated_at
            and now - row.updated_at > timedelta(seconds=OPEN_KLINE_TTL_SECONDS)
        ):
            continue
        items.append(serialize_kline_item(row, normalized_interval))
    return items[-normalized_limit:]


def _latest_cache_is_fresh(
    db: Session,
    *,
    market_type: str,
    symbol: str,
    interval: str,
    open_time_validator: Optional[OpenTimeValidator] = None,
) -> bool:
    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = normalize_kline_interval(interval)
    ttl_seconds = LATEST_KLINE_REFRESH_TTL_SECONDS.get(normalized_interval, 30)

    try:
        query = (
            db.query(MarketKline)
            .filter(
                MarketKline.market_type == market_type,
                MarketKline.symbol == normalized_symbol,
                MarketKline.interval == normalized_interval,
            )
            .order_by(MarketKline.open_time.desc())
        )
        if open_time_validator is None:
            latest = query.first()
        else:
            latest = None
            for row in query.limit(100).all():
                if _item_matches_open_time_validator(row, open_time_validator):
                    latest = row
                    break
    except (ProgrammingError, OperationalError) as exc:
        db.rollback()
        if _is_missing_table_error(exc):
            return False
        logger.warning("market_klines latest check failed symbol=%s interval=%s error=%s", normalized_symbol, normalized_interval, exc)
        return False
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("market_klines latest check failed symbol=%s interval=%s error=%s", normalized_symbol, normalized_interval, exc)
        return False

    if latest is None or latest.updated_at is None:
        return False
    return datetime.utcnow() - latest.updated_at <= timedelta(seconds=ttl_seconds)


def upsert_klines(
    db: Session,
    *,
    market_type: str,
    symbol: str,
    interval: str,
    items: Iterable[Any],
    source: str,
) -> int:
    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = normalize_kline_interval(interval)
    now = datetime.utcnow()
    now_ms = int(now.timestamp() * 1000)

    normalized_items = [
        item
        for item in (_normalize_item(raw_item, normalized_interval) for raw_item in items)
        if item is not None
    ]
    if not normalized_items:
        return 0

    try:
        rows = []
        for item in normalized_items:
            open_time = int(item["open_time"])
            rows.append(
                {
                    "market_type": market_type,
                    "symbol": normalized_symbol,
                    "interval": normalized_interval,
                    "open_time": open_time,
                    "close_time": int(item["close_time"]),
                    "open": item["open"],
                    "high": item["high"],
                    "low": item["low"],
                    "close": item["close"],
                    "volume": item["volume"],
                    "quote_volume": item["quote_volume"],
                    "source": source,
                    "is_closed": _is_closed(open_time, normalized_interval, now_ms),
                    "fetched_at": now,
                    "created_at": now,
                    "updated_at": now,
                }
            )

        stmt = mysql_insert(MarketKline).values(rows)
        stmt = stmt.on_duplicate_key_update(
            close_time=stmt.inserted.close_time,
            open=stmt.inserted.open,
            high=stmt.inserted.high,
            low=stmt.inserted.low,
            close=stmt.inserted.close,
            volume=stmt.inserted.volume,
            quote_volume=stmt.inserted.quote_volume,
            source=stmt.inserted.source,
            is_closed=stmt.inserted.is_closed,
            fetched_at=stmt.inserted.fetched_at,
            updated_at=stmt.inserted.updated_at,
        )
        db.execute(stmt)
        db.commit()
        return len(normalized_items)
    except IntegrityError as exc:
        db.rollback()
        if _is_duplicate_entry_error(exc):
            logger.debug(
                "market_klines duplicate key ignored after upsert symbol=%s interval=%s",
                normalized_symbol,
                normalized_interval,
            )
            return 0
        logger.warning("market_klines upsert integrity failed symbol=%s interval=%s error=%s", normalized_symbol, normalized_interval, exc)
        return 0
    except (ProgrammingError, OperationalError) as exc:
        db.rollback()
        if _is_missing_table_error(exc):
            record_error(provider="DB", symbol=normalized_symbol, endpoint="kline_db_upsert", error=exc)
            logger.warning("market_klines table missing, skip kline db upsert")
            return 0
        record_error(provider="DB", symbol=normalized_symbol, endpoint="kline_db_upsert", error=exc)
        logger.warning("market_klines upsert failed symbol=%s interval=%s error=%s", normalized_symbol, normalized_interval, exc)
        return 0
    except SQLAlchemyError as exc:
        db.rollback()
        record_error(provider="DB", symbol=normalized_symbol, endpoint="kline_db_upsert", error=exc)
        logger.warning("market_klines upsert failed symbol=%s interval=%s error=%s", normalized_symbol, normalized_interval, exc)
        return 0


def get_klines_cache_first(
    db: Session,
    *,
    market_type: str,
    symbol: str,
    interval: str,
    limit: int,
    source: str,
    fetch_external: Callable[[int, Optional[int]], Iterable[Any]],
    end_time_ms: Optional[int] = None,
    external_budget_seconds: Optional[float] = None,
    open_time_validator: Optional[OpenTimeValidator] = None,
) -> KlineCacheResult:
    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = normalize_kline_interval(interval)
    normalized_limit = normalize_kline_limit(limit)

    cached = _read_cached_klines(
        db,
        market_type=market_type,
        symbol=normalized_symbol,
        interval=normalized_interval,
        limit=normalized_limit,
        end_time_ms=end_time_ms,
        open_time_validator=open_time_validator,
    )
    cached_continuous = _validate_cached_klines_continuity(cached, normalized_interval)
    latest_cache_fresh = True
    if end_time_ms is None and len(cached) >= normalized_limit and cached_continuous:
        latest_cache_fresh = _latest_cache_is_fresh(
            db,
            market_type=market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
            open_time_validator=open_time_validator,
        )
    if len(cached) >= normalized_limit and cached_continuous and (end_time_ms or latest_cache_fresh):
        record_kline_db_hit(
            market_type=market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
            count=len(cached),
        )
        return KlineCacheResult(
            cached[-normalized_limit:],
            origin=KLINE_CACHE_ORIGIN_DB_CACHE,
            cache_status=KLINE_CACHE_STATUS_HIT,
        )

    cache_status = KLINE_CACHE_STATUS_MISS
    if cached and not cached_continuous:
        cache_status = KLINE_CACHE_STATUS_CONTINUITY_INVALID
        logger.debug(
            "kline_db_cache_continuity_failed market_type=%s symbol=%s interval=%s count=%s",
            market_type,
            normalized_symbol,
            normalized_interval,
            len(cached),
        )
    elif cached and len(cached) < normalized_limit:
        cache_status = KLINE_CACHE_STATUS_SHORT
    elif cached and not latest_cache_fresh:
        cache_status = KLINE_CACHE_STATUS_STALE_OPEN

    def stale_cached(
        *,
        cache_status_override: Optional[str] = None,
        provider_error_code: Optional[str] = None,
        provider_error_provider: Optional[str] = None,
    ) -> KlineCacheResult:
        result_cache_status = cache_status_override or cache_status
        rows = cached or _read_cached_klines(
            db,
            market_type=market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
            limit=normalized_limit,
            end_time_ms=end_time_ms,
            allow_stale_open=True,
            open_time_validator=open_time_validator,
        )
        if rows and _validate_cached_klines_continuity(rows, normalized_interval):
            return KlineCacheResult(
                rows,
                origin=KLINE_CACHE_ORIGIN_STALE_CACHE,
                cache_status=result_cache_status,
                provider_error_code=provider_error_code,
                provider_error_provider=provider_error_provider,
                history_incomplete=bool(end_time_ms is not None and len(rows) < normalized_limit),
            )
        if not rows:
            return KlineCacheResult(
                [],
                origin=KLINE_CACHE_ORIGIN_EMPTY,
                cache_status=result_cache_status,
                provider_error_code=provider_error_code,
                provider_error_provider=provider_error_provider,
                history_incomplete=bool(end_time_ms is not None),
            )
        logger.debug(
            "kline_db_stale_cache_continuity_failed market_type=%s symbol=%s interval=%s count=%s",
            market_type,
            normalized_symbol,
            normalized_interval,
            len(rows),
        )
        return KlineCacheResult(
            [],
            origin=KLINE_CACHE_ORIGIN_EMPTY,
            cache_status=KLINE_CACHE_STATUS_CONTINUITY_INVALID,
            provider_error_code=provider_error_code,
            provider_error_provider=provider_error_provider,
            history_incomplete=bool(end_time_ms is not None),
        )

    if external_budget_seconds is not None and external_budget_seconds <= 0:
        return stale_cached()

    started_at = time.monotonic()

    try:
        record_kline_external_fetch(
            source=source,
            market_type=market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
        )
        external_items = _filter_items_before_end_time(
            _filter_items_by_open_time(
                fetch_external(normalized_limit, end_time_ms) or [],
                open_time_validator,
            ),
            end_time_ms,
        )
    except Exception as exc:
        provider_error_code, provider_error_provider = _classify_provider_error(exc)
        record_error(
            provider=source,
            symbol=normalized_symbol,
            endpoint=f"kline:{normalized_interval}",
            error=exc,
        )
        logger.warning(
            "kline_external_fetch_failed market_type=%s symbol=%s interval=%s reason=%s",
            market_type,
            normalized_symbol,
            normalized_interval,
            exc,
        )
        return stale_cached(
            provider_error_code=provider_error_code,
            provider_error_provider=provider_error_provider,
        )

    if external_budget_seconds is not None:
        elapsed = time.monotonic() - started_at
        if elapsed > external_budget_seconds:
            logger.warning(
                "kline_external_fetch_over_budget market_type=%s symbol=%s interval=%s elapsed=%.3fs budget=%.3fs",
                market_type,
                normalized_symbol,
                normalized_interval,
                elapsed,
                external_budget_seconds,
            )
            return stale_cached(provider_error_code=KLINE_PROVIDER_ERROR_TIMEOUT)

    if not external_items:
        return stale_cached(
            cache_status_override=KLINE_CACHE_STATUS_PROVIDER_EMPTY,
            provider_error_code=KLINE_PROVIDER_ERROR_EMPTY,
        )

    upsert_klines(
        db,
        market_type=market_type,
        symbol=normalized_symbol,
        interval=normalized_interval,
        items=external_items,
        source=source,
    )

    refreshed = _read_cached_klines(
        db,
        market_type=market_type,
        symbol=normalized_symbol,
        interval=normalized_interval,
        limit=normalized_limit,
        end_time_ms=end_time_ms,
        open_time_validator=open_time_validator,
    )
    refreshed_continuous = _validate_cached_klines_continuity(refreshed, normalized_interval)
    if refreshed and not refreshed_continuous:
        logger.debug(
            "kline_db_refreshed_cache_continuity_failed market_type=%s symbol=%s interval=%s count=%s",
            market_type,
            normalized_symbol,
            normalized_interval,
            len(refreshed),
        )
    if refreshed and refreshed_continuous and len(refreshed) >= normalized_limit:
        return KlineCacheResult(
            refreshed[-normalized_limit:],
            origin=KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status=cache_status,
            history_incomplete=False,
        )

    return KlineCacheResult(
        [
        serialize_kline_item(item, normalized_interval)
        for item in (
            _normalize_item(raw_item, normalized_interval) for raw_item in external_items
        )
        if item is not None
        ][-normalized_limit:],
        origin=KLINE_CACHE_ORIGIN_REST_FETCH,
        cache_status=cache_status,
        history_incomplete=False,
    )
