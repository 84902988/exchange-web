from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from math import ceil
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.models.stock_token_convert_record import StockTokenConvertRecord
from app.db.models.stock_token_lock_config import StockTokenLockConfig
from app.db.models.user_stock_token_lock import UserStockTokenLock
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.services.stock_token_lock_service import (
    StockTokenLockError,
    calculate_stock_token_release_progress,
    convert_released_stock_token,
    get_stock_token_unlock_at,
    is_stock_token_lock_in_lock_period,
)


router = APIRouter(prefix="/stock-token", tags=["stock-token"])
Q18 = Decimal("0.000000000000000001")


class StockTokenConvertIn(BaseModel):
    lock_item_id: int = Field(..., ge=1)
    amount: str


def _decimal_to_str(value: Any) -> str:
    amount = value if isinstance(value, Decimal) else Decimal(str(value or "0"))
    return format(amount.quantize(Q18, rounding=ROUND_DOWN), "f")


def _datetime_to_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _stock_token_release_days(daily_release_rate: Any) -> int:
    try:
        rate = Decimal(str(daily_release_rate or "0"))
    except (InvalidOperation, TypeError, ValueError):
        return 0
    if rate <= Decimal("0"):
        return 0
    return max(1, int(ceil(Decimal("1") / rate)))


def _parse_decimal_amount(value: str) -> Decimal:
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_AMOUNT", "message": "amount 格式不正确"},
        )


@router.get("/locks")
def get_my_stock_token_locks(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(UserStockTokenLock, StockTokenLockConfig)
        .outerjoin(StockTokenLockConfig, StockTokenLockConfig.id == UserStockTokenLock.config_id)
        .filter(UserStockTokenLock.user_id == int(user_id))
        .order_by(UserStockTokenLock.created_at.desc(), UserStockTokenLock.id.desc())
        .all()
    )
    items = []
    for lock_item, config in rows:
        in_lock_period = is_stock_token_lock_in_lock_period(lock_item, config=config)
        lock_days = int(config.lock_days or 0) if config else 0
        daily_release_rate = getattr(lock_item, "daily_release_rate_snapshot", None) or (
            config.daily_release_rate if config else 0
        )
        release_days = _stock_token_release_days(daily_release_rate)
        lock_start_at = lock_item.start_at
        lock_end_at = (lock_start_at + timedelta(days=lock_days)) if lock_start_at and lock_days > 0 else None
        release_start_at = lock_end_at
        release_finish_at = (
            release_start_at + timedelta(days=release_days)
            if release_start_at and release_days > 0
            else None
        )
        items.append(
            {
                "id": int(lock_item.id),
                "lock_symbol": lock_item.lock_symbol,
                "trade_symbol": config.trade_symbol if config else None,
                "total_amount": _decimal_to_str(lock_item.total_amount),
                "locked_amount": _decimal_to_str(lock_item.locked_amount),
                "available_amount": _decimal_to_str(lock_item.available_amount),
                "converted_amount": _decimal_to_str(lock_item.converted_amount),
                "conversion_rate_snapshot": _decimal_to_str(
                    getattr(lock_item, "conversion_rate_snapshot", None) or (config.conversion_rate if config else 1)
                ),
                "daily_release_rate": _decimal_to_str(daily_release_rate),
                "lock_days": lock_days,
                "release_days": release_days,
                "unlock_at": _datetime_to_str(get_stock_token_unlock_at(lock_item, config)),
                "lock_start_at": _datetime_to_str(lock_start_at),
                "lock_end_at": _datetime_to_str(lock_end_at),
                "release_start_at": _datetime_to_str(release_start_at),
                "release_finish_at": _datetime_to_str(release_finish_at),
                "release_started": not in_lock_period,
                "progress_percent": str(calculate_stock_token_release_progress(lock_item, config=config)),
                "status": "LOCKED" if in_lock_period and str(lock_item.status or "").upper() == "ACTIVE" else lock_item.status,
                "start_at": _datetime_to_str(lock_item.start_at),
                "end_at": _datetime_to_str(lock_item.end_at),
            }
        )
    return {"items": items}


@router.get("/converts")
def get_my_stock_token_converts(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(StockTokenConvertRecord)
        .filter(StockTokenConvertRecord.user_id == int(user_id))
        .order_by(StockTokenConvertRecord.created_at.desc(), StockTokenConvertRecord.id.desc())
        .limit(200)
        .all()
    )
    return {
        "items": [
            {
                "id": int(record.id),
                "from_symbol": record.from_symbol,
                "to_symbol": record.to_symbol,
                "from_amount": _decimal_to_str(record.from_amount),
                "to_amount": _decimal_to_str(record.to_amount),
                "conversion_rate": _decimal_to_str(record.conversion_rate),
                "status": record.status,
                "created_at": _datetime_to_str(record.created_at),
            }
            for record in rows
        ]
    }


@router.post("/convert")
def convert_stock_token(
    payload: StockTokenConvertIn,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    amount = _parse_decimal_amount(payload.amount)
    try:
        record = convert_released_stock_token(
            db,
            user_id=int(user_id),
            lock_item_id=payload.lock_item_id,
            amount=amount,
        )
        db.commit()
        db.refresh(record)
        return {
            "success": True,
            "record_id": int(record.id),
            "from_symbol": record.from_symbol,
            "to_symbol": record.to_symbol,
            "from_amount": _decimal_to_str(record.from_amount),
            "to_amount": _decimal_to_str(record.to_amount),
        }
    except StockTokenLockError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": "STOCK_TOKEN_CONVERT_ERROR", "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail={"code": "INTERNAL_ERROR", "message": "stock token convert failed"})
