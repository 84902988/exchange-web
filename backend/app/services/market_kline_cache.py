from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
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
) -> list[dict[str, Any]]:
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
    if len(cached) >= normalized_limit and (
        end_time_ms
        or _latest_cache_is_fresh(
            db,
            market_type=market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
            open_time_validator=open_time_validator,
        )
    ):
        record_kline_db_hit(
            market_type=market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
            count=len(cached),
        )
        return cached[-normalized_limit:]

    stale_cached = lambda: cached or _read_cached_klines(
        db,
        market_type=market_type,
        symbol=normalized_symbol,
        interval=normalized_interval,
        limit=normalized_limit,
        end_time_ms=end_time_ms,
        allow_stale_open=True,
        open_time_validator=open_time_validator,
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
        return stale_cached()

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
            return stale_cached()

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
    if refreshed and (len(refreshed) >= normalized_limit or not external_items):
        return refreshed[-normalized_limit:]

    return [
        serialize_kline_item(item, normalized_interval)
        for item in (
            _normalize_item(raw_item, normalized_interval) for raw_item in external_items
        )
        if item is not None
    ][-normalized_limit:]
