from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models.dividend import DividendPool, UserDividendRecord
from app.db.models.user_vip_snapshot import UserVipSnapshot


def _fmt_decimal(value: Any) -> str:
    if value is None:
        return "0"
    dec = value if isinstance(value, Decimal) else Decimal(str(value))
    return format(dec.normalize(), "f") if dec != 0 else "0"


def _fmt_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (date, datetime)):
        return value.strftime("%Y-%m-%d")
    return str(value)


def _fmt_datetime(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value)


def _next_month_start(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


def _get_current_svip_level(db: Session, user_id: int) -> Optional[str]:
    snapshot = (
        db.query(UserVipSnapshot.svip_level_code)
        .filter(UserVipSnapshot.user_id == user_id)
        .first()
    )
    return snapshot[0] if snapshot else None


def _is_dividend_eligible(svip_level_code: Optional[str]) -> bool:
    # NORMAL 是当前 SVIP 普通档位；SVIP0 作为前向兼容兜底。
    if not svip_level_code:
        return False
    return svip_level_code not in {"NORMAL", "SVIP0"}


def get_my_dividend_summary(db: Session, user_id: int) -> dict[str, Any]:
    today = datetime.utcnow().date()
    month_start = date(today.year, today.month, 1)
    next_month_start = _next_month_start(month_start)

    total_rcb = (
        db.query(func.coalesce(func.sum(UserDividendRecord.dividend_rcb), Decimal("0")))
        .filter(UserDividendRecord.user_id == user_id)
        .scalar()
    )

    month_rcb = (
        db.query(func.coalesce(func.sum(UserDividendRecord.dividend_rcb), Decimal("0")))
        .join(DividendPool, DividendPool.id == UserDividendRecord.pool_id)
        .filter(
            UserDividendRecord.user_id == user_id,
            DividendPool.dividend_date >= month_start,
            DividendPool.dividend_date < next_month_start,
        )
        .scalar()
    )

    latest = (
        db.query(UserDividendRecord, DividendPool.dividend_date)
        .join(DividendPool, DividendPool.id == UserDividendRecord.pool_id)
        .filter(UserDividendRecord.user_id == user_id)
        .order_by(DividendPool.dividend_date.desc(), UserDividendRecord.id.desc())
        .first()
    )

    current_svip_level = _get_current_svip_level(db, user_id)
    latest_record = latest[0] if latest else None
    latest_dividend_date = latest[1] if latest else None

    return {
        "total_rcb": _fmt_decimal(total_rcb),
        "month_rcb": _fmt_decimal(month_rcb),
        "latest_amount_rcb": _fmt_decimal(latest_record.dividend_rcb) if latest_record else None,
        "latest_dividend_date": _fmt_date(latest_dividend_date),
        "latest_status": latest_record.status if latest_record else None,
        "current_svip_level": current_svip_level,
        "eligible": _is_dividend_eligible(current_svip_level),
    }


def get_my_dividend_records(
    db: Session,
    user_id: int,
    page: int = 1,
    page_size: int = 20,
) -> dict[str, Any]:
    page = max(int(page or 1), 1)
    page_size = min(max(int(page_size or 20), 1), 100)

    query = (
        db.query(UserDividendRecord, DividendPool.dividend_date)
        .join(DividendPool, DividendPool.id == UserDividendRecord.pool_id)
        .filter(UserDividendRecord.user_id == user_id)
    )
    total = query.count()
    rows = (
        query.order_by(DividendPool.dividend_date.desc(), UserDividendRecord.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    items = []
    for record, dividend_date in rows:
        items.append(
            {
                "id": int(record.id),
                "dividend_date": _fmt_date(dividend_date),
                "svip_level_code": record.level_code,
                "amount_rcb": _fmt_decimal(record.dividend_rcb),
                "amount_usdt": _fmt_decimal(record.dividend_usdt),
                "status": record.status,
                "paid_at": _fmt_datetime(record.paid_at),
            }
        )

    return {
        "items": items,
        "total": int(total),
        "page": page,
        "page_size": page_size,
    }
