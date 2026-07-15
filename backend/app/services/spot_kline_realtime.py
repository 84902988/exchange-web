from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Optional

from sqlalchemy import case, func, tuple_
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.exc import OperationalError, ProgrammingError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.db.models.market_kline import MarketKline
from app.services.market_kline_cache import (
    SUPPORTED_KLINE_INTERVAL_SECONDS,
    interval_ms,
    normalize_kline_interval,
    serialize_kline_item,
)


logger = logging.getLogger(__name__)

SPOT_KLINE_MARKET_TYPE = "spot"
SPOT_KLINE_SOURCE_INTERNAL_TRADE = "INTERNAL_TRADE"
SUPPORTED_SPOT_KLINE_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")


def _normalize_symbol(symbol: str) -> str:
    return str(symbol or "").strip().upper()


def _decimal(value: Any, *, field: str) -> Decimal:
    if value in (None, ""):
        raise ValueError(f"{field} is required")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{field} is invalid") from exc
    if result <= 0:
        raise ValueError(f"{field} must be positive")
    return result


def normalize_trade_time_ms(value: Any = None) -> int:
    if value in (None, ""):
        return int(datetime.utcnow().timestamp() * 1000)

    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)

    try:
        ts = int(value)
    except Exception as exc:
        raise ValueError("trade timestamp is invalid") from exc

    if ts <= 0:
        raise ValueError("trade timestamp is invalid")

    if ts < 10_000_000_000:
        return ts * 1000
    return ts


def spot_kline_bucket_bounds(trade_ts_ms: Any, interval: str) -> tuple[int, int]:
    normalized_interval = normalize_kline_interval(interval)
    ts_ms = normalize_trade_time_ms(trade_ts_ms)
    step_ms = interval_ms(normalized_interval)
    open_time = (ts_ms // step_ms) * step_ms
    return open_time, open_time + step_ms


def _item_value(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _decimal_or_default(value: Any, default: Decimal) -> Decimal:
    if value in (None, ""):
        return default
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return default


def apply_trade_to_spot_kline_item(
    existing: Any,
    *,
    interval: str,
    trade_price: Any,
    trade_amount: Any,
    trade_ts_ms: Any,
) -> dict[str, Any]:
    normalized_interval = normalize_kline_interval(interval)
    open_time, close_time = spot_kline_bucket_bounds(trade_ts_ms, normalized_interval)
    price = _decimal(trade_price, field="trade_price")
    amount = _decimal(trade_amount, field="trade_amount")
    quote_volume = price * amount

    existing_open_time = None
    if existing is not None:
        try:
            existing_open_time = int(_item_value(existing, "open_time") or 0)
        except Exception:
            existing_open_time = None

    if existing is None or existing_open_time != open_time:
        return {
            "open_time": open_time,
            "close_time": close_time,
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": amount,
            "quote_volume": quote_volume,
        }

    open_price = _decimal_or_default(_item_value(existing, "open"), price)
    high = max(_decimal_or_default(_item_value(existing, "high"), price), price)
    low = min(_decimal_or_default(_item_value(existing, "low"), price), price)
    volume = _decimal_or_default(_item_value(existing, "volume"), Decimal("0")) + amount
    next_quote_volume = (
        _decimal_or_default(_item_value(existing, "quote_volume"), Decimal("0"))
        + quote_volume
    )

    return {
        "open_time": open_time,
        "close_time": close_time,
        "open": open_price,
        "high": high,
        "low": low,
        "close": price,
        "volume": volume,
        "quote_volume": next_quote_volume,
    }


def build_spot_kline_update_message(
    *,
    symbol: str,
    interval: str,
    kline: Any,
    source: str = SPOT_KLINE_SOURCE_INTERNAL_TRADE,
    updated_at: Optional[str] = None,
) -> dict[str, Any]:
    normalized_interval = normalize_kline_interval(interval)
    normalized_symbol = _normalize_symbol(symbol)
    return {
        "type": "spot_kline_update",
        "symbol": normalized_symbol,
        "interval": normalized_interval,
        "kline": serialize_kline_item(kline, normalized_interval),
        "source": source,
        "updated_at": updated_at or datetime.utcnow().isoformat(),
    }


def apply_spot_trade_to_klines(
    db: Session,
    *,
    symbol: str,
    trade_price: Any,
    trade_amount: Any,
    trade_ts_ms: Any = None,
    intervals: Optional[Iterable[str]] = None,
    source: str = SPOT_KLINE_SOURCE_INTERNAL_TRADE,
) -> list[dict[str, Any]]:
    normalized_symbol = _normalize_symbol(symbol)
    if not normalized_symbol:
        raise ValueError("symbol is required")

    normalized_intervals = tuple(
        normalize_kline_interval(interval)
        for interval in (intervals or SUPPORTED_SPOT_KLINE_INTERVALS)
    )
    if not normalized_intervals:
        return []

    now = datetime.utcnow()
    now_ms = int(now.timestamp() * 1000)
    rows_by_interval: dict[str, dict[str, Any]] = {}

    try:
        insert_rows: list[dict[str, Any]] = []
        for interval in normalized_intervals:
            item = apply_trade_to_spot_kline_item(
                None,
                interval=interval,
                trade_price=trade_price,
                trade_amount=trade_amount,
                trade_ts_ms=trade_ts_ms,
            )
            rows_by_interval[interval] = item
            insert_rows.append(
                {
                    "market_type": SPOT_KLINE_MARKET_TYPE,
                    "symbol": normalized_symbol,
                    "interval": interval,
                    "open_time": int(item["open_time"]),
                    "close_time": int(item["close_time"]),
                    "open": item["open"],
                    "high": item["high"],
                    "low": item["low"],
                    "close": item["close"],
                    "volume": item["volume"],
                    "quote_volume": item["quote_volume"],
                    "source": source,
                    "is_closed": int(item["close_time"]) <= now_ms,
                    "fetched_at": now,
                    "created_at": now,
                    "updated_at": now,
                }
            )

        stmt = mysql_insert(MarketKline).values(insert_rows)
        inserted = stmt.inserted
        stmt = stmt.on_duplicate_key_update(
            close_time=inserted.close_time,
            high=func.greatest(MarketKline.high, inserted.high),
            low=func.least(MarketKline.low, inserted.low),
            close=inserted.close,
            volume=MarketKline.volume + inserted.volume,
            quote_volume=func.coalesce(MarketKline.quote_volume, Decimal("0"))
            + inserted.quote_volume,
            source=inserted.source,
            is_closed=inserted.is_closed,
            fetched_at=inserted.fetched_at,
            updated_at=inserted.updated_at,
        )
        db.execute(stmt)

        exact_keys = [
            (interval, int(rows_by_interval[interval]["open_time"]))
            for interval in normalized_intervals
        ]
        interval_order = case(
            {interval: position for position, interval in enumerate(normalized_intervals)},
            value=MarketKline.interval,
            else_=len(normalized_intervals),
        )
        selected_rows = (
            db.query(MarketKline)
            .filter(
                MarketKline.market_type == SPOT_KLINE_MARKET_TYPE,
                MarketKline.symbol == normalized_symbol,
                tuple_(MarketKline.interval, MarketKline.open_time).in_(exact_keys),
            )
            .order_by(interval_order)
            .all()
        )
        selected_by_key = {
            (str(row.interval), int(row.open_time)): row for row in selected_rows
        }

        messages: list[dict[str, Any]] = []
        for interval in normalized_intervals:
            open_time = int(rows_by_interval[interval]["open_time"])
            row = selected_by_key.get((interval, open_time))
            if row is None:
                raise SQLAlchemyError(
                    "spot kline batch select missing authoritative row "
                    f"symbol={normalized_symbol} interval={interval} open_time={open_time}"
                )
            updated_at = getattr(row, "updated_at", None) or now
            messages.append(
                build_spot_kline_update_message(
                    symbol=normalized_symbol,
                    interval=interval,
                    kline=row,
                    source=source,
                    updated_at=updated_at.isoformat()
                    if hasattr(updated_at, "isoformat")
                    else str(updated_at),
                )
            )

        db.commit()
        return messages
    except (ProgrammingError, OperationalError) as exc:
        db.rollback()
        logger.warning(
            "spot_kline_realtime_db_unavailable symbol=%s error=%s",
            normalized_symbol,
            exc,
        )
        return []
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning(
            "spot_kline_realtime_update_failed symbol=%s error=%s",
            normalized_symbol,
            exc,
        )
        return []
