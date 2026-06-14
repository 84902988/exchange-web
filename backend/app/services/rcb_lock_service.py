from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.user_rcb_lock import UserRcbLock
from app.db.models.vip_fee_level import VipFeeLevel
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.vip_service import calculate_user_vip_snapshot


Q18 = Decimal("0.000000000000000001")
RCB_SYMBOL = "RCB"


class RcbLockError(ValueError):
    pass


def _q18(value: Any) -> Decimal:
    try:
        return Decimal(str(value).strip()).quantize(Q18, rounding=ROUND_DOWN)
    except (InvalidOperation, TypeError, ValueError):
        raise RcbLockError("锁仓数量格式不正确")


def _normalize_amount(value: Any) -> Decimal:
    amount = _q18(value)
    if amount <= Decimal("0"):
        raise RcbLockError("锁仓数量必须大于 0")
    return amount


def _fmt_decimal(value: Any) -> str:
    amount = value if isinstance(value, Decimal) else Decimal(str(value or "0"))
    return format(amount.quantize(Q18, rounding=ROUND_DOWN), "f")


def _fmt_datetime(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _get_funding_rcb_balance_for_update(db: Session, user_id: int) -> Optional[UserBalance]:
    return (
        db.query(UserBalance)
        .filter(
            UserBalance.user_id == int(user_id),
            UserBalance.coin_symbol == RCB_SYMBOL,
            UserBalance.chain_key == FUNDING_BALANCE_CHAIN_KEY,
        )
        .with_for_update()
        .first()
    )


def _load_active_rcb_locks_for_update(db: Session, user_id: int) -> list[UserRcbLock]:
    return (
        db.query(UserRcbLock)
        .filter(UserRcbLock.user_id == int(user_id))
        .filter(UserRcbLock.asset_symbol == RCB_SYMBOL)
        .filter(UserRcbLock.status == "LOCKED")
        .with_for_update()
        .all()
    )


def _sum_lock_amount(lock_items: list[UserRcbLock]) -> Decimal:
    return sum((Decimal(str(item.lock_amount or "0")) for item in lock_items), Decimal("0"))


def get_enabled_svip_lock_period_days(db: Session) -> set[int]:
    levels = (
        db.query(VipFeeLevel)
        .options(joinedload(VipFeeLevel.condition))
        .filter(VipFeeLevel.vip_type == "SVIP", VipFeeLevel.is_enabled.is_(True))
        .all()
    )
    periods: set[int] = set()
    for level in levels:
        condition = level.condition
        if condition is None or condition.lock_period_days is None:
            continue
        period_days = int(condition.lock_period_days or 0)
        if period_days > 0:
            periods.add(period_days)
    return periods


def get_allowed_lock_days_by_target_level(level_code: Optional[str]) -> int:
    if not level_code:
        return 365
    if level_code == "LP":
        return 1095
    if level_code in {"SVIP6", "SVIP7", "SVIP8"}:
        return 720
    if level_code in {"SVIP1", "SVIP2", "SVIP3", "SVIP4", "SVIP5"}:
        return 365
    return 365


def _load_current_rcb_locked(db: Session, user_id: int) -> Decimal:
    total = (
        db.query(func.coalesce(func.sum(UserRcbLock.lock_amount), Decimal("0")))
        .filter(UserRcbLock.user_id == int(user_id))
        .filter(UserRcbLock.asset_symbol == RCB_SYMBOL)
        .filter(UserRcbLock.status == "LOCKED")
        .scalar()
    )
    return Decimal(str(total or "0"))


def _pick_svip_by_total_locked(db: Session, total_locked: Decimal) -> Optional[VipFeeLevel]:
    levels = (
        db.query(VipFeeLevel)
        .options(joinedload(VipFeeLevel.condition))
        .filter(VipFeeLevel.vip_type == "SVIP", VipFeeLevel.is_enabled.is_(True))
        .order_by(VipFeeLevel.sort_order.asc(), VipFeeLevel.id.asc())
        .all()
    )
    matched: list[VipFeeLevel] = []
    for level in levels:
        condition = level.condition
        if condition is None:
            continue
        min_lock_amount = Decimal(str(condition.min_lock_amount or 0))
        if min_lock_amount > 0 and total_locked >= min_lock_amount:
            matched.append(level)
    if not matched:
        return None
    return max(matched, key=lambda level: (level.sort_order, level.id))


def validate_svip_lock_period_days(
    db: Session,
    *,
    user_id: int,
    amount: Decimal,
    lock_period_days: int,
    active_locks: Optional[list[UserRcbLock]] = None,
) -> int:
    period_days = int(lock_period_days or 0)
    current_locked = _sum_lock_amount(active_locks) if active_locks is not None else _load_current_rcb_locked(db, user_id)
    target_level = _pick_svip_by_total_locked(db, current_locked + amount)
    allowed_period = get_allowed_lock_days_by_target_level(target_level.level_code if target_level else None)
    if period_days != allowed_period:
        target_text = target_level.level_code if target_level else "未达标"
        raise RcbLockError(f"锁仓周期不支持，预计等级 {target_text} 只能选择 {allowed_period} 天")
    return period_days


def _pick_svip_for_lock(db: Session, lock_amount: Decimal, lock_period_days: int) -> Optional[VipFeeLevel]:
    levels = (
        db.query(VipFeeLevel)
        .options(joinedload(VipFeeLevel.condition))
        .filter(VipFeeLevel.vip_type == "SVIP", VipFeeLevel.is_enabled.is_(True))
        .order_by(VipFeeLevel.sort_order.asc(), VipFeeLevel.id.asc())
        .all()
    )
    matched: list[VipFeeLevel] = []
    for level in levels:
        condition = level.condition
        if condition is None:
            matched.append(level)
            continue
        min_lock_amount = Decimal(str(condition.min_lock_amount or 0))
        required_days = int(condition.lock_period_days or 0)
        if lock_amount >= min_lock_amount and (required_days <= 0 or lock_period_days == required_days):
            matched.append(level)
    if not matched:
        return None
    return max(matched, key=lambda level: (level.sort_order, level.id))


def create_user_rcb_lock(
    db: Session,
    *,
    user_id: int,
    amount: Any,
    lock_period_days: int,
) -> dict[str, Any]:
    amount_decimal = _normalize_amount(amount)
    active_locks = _load_active_rcb_locks_for_update(db, int(user_id))
    period_days = validate_svip_lock_period_days(
        db,
        user_id=int(user_id),
        amount=amount_decimal,
        lock_period_days=int(lock_period_days or 0),
        active_locks=active_locks,
    )

    now = datetime.utcnow()
    balance = _get_funding_rcb_balance_for_update(db, int(user_id))
    if balance is None:
        raise RcbLockError("RCB 资金账户余额不足")

    before_available = _q18(balance.available_amount)
    before_frozen = _q18(balance.frozen_amount)
    if before_available < amount_decimal:
        raise RcbLockError("RCB 资金账户余额不足")

    lock_item = UserRcbLock(
        user_id=int(user_id),
        asset_symbol=RCB_SYMBOL,
        lock_amount=amount_decimal,
        lock_period_days=period_days,
        start_time=now,
        end_time=now + timedelta(days=period_days),
        status="LOCKED",
        source="USER_LOCK",
        created_at=now,
        updated_at=now,
    )
    db.add(lock_item)
    db.flush()

    # 高等级 SVIP 追加锁仓采用升级续期模式，避免总锁仓量达标但周期不达标。
    if period_days > 365:
        renewed_end_time = now + timedelta(days=period_days)
        for active_lock in active_locks:
            if int(active_lock.lock_period_days or 0) >= period_days:
                continue
            active_lock.lock_period_days = period_days
            active_lock.end_time = renewed_end_time
            active_lock.status = "LOCKED"
            active_lock.updated_at = now
        db.flush()

    after_available = _q18(before_available - amount_decimal)
    balance.available_amount = after_available
    balance.version = int(balance.version or 0) + 1
    balance.updated_at = now

    db.add(
        BalanceLog(
            user_id=int(user_id),
            coin_symbol=RCB_SYMBOL,
            chain_key=FUNDING_BALANCE_CHAIN_KEY,
            change_type="RCB_LOCK",
            direction=-1,
            change_amount=amount_decimal,
            before_available=before_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=before_frozen,
            biz_type="RCB_LOCK",
            biz_id=str(lock_item.id),
            request_id=None,
            remark=f"RCB lock {period_days} days",
            created_at=now,
        )
    )
    db.flush()

    snapshot = calculate_user_vip_snapshot(db=db, user_id=int(user_id))
    return {
        "lock": serialize_rcb_lock(
            lock_item,
            current_svip=snapshot.svip_level_code,
        ),
        "summary": {
            "rcb_funding_available": _fmt_decimal(after_available),
            "rcb_locked": _fmt_decimal(snapshot.rcb_locked),
            "svip_level_code": snapshot.svip_level_code,
            "effective_level_code": snapshot.effective_level_code,
            "effective_fee_source": snapshot.effective_fee_source,
            "effective_spot_maker_fee": _fmt_decimal(snapshot.effective_spot_maker_fee)
            if snapshot.effective_spot_maker_fee is not None
            else None,
            "effective_spot_taker_fee": _fmt_decimal(snapshot.effective_spot_taker_fee)
            if snapshot.effective_spot_taker_fee is not None
            else None,
        },
    }


def serialize_rcb_lock(lock_item: UserRcbLock, *, current_svip: Optional[str] = None) -> dict[str, Any]:
    return {
        "id": int(lock_item.id),
        "asset_symbol": lock_item.asset_symbol,
        "lock_amount": _fmt_decimal(lock_item.lock_amount),
        "lock_period_days": int(lock_item.lock_period_days or 0),
        "start_time": _fmt_datetime(lock_item.start_time),
        "end_time": _fmt_datetime(lock_item.end_time),
        "status": lock_item.status,
        "current_svip": current_svip,
        "created_at": _fmt_datetime(lock_item.created_at),
    }


def list_user_rcb_locks(db: Session, *, user_id: int, limit: int = 200) -> dict[str, Any]:
    locks = (
        db.query(UserRcbLock)
        .filter(UserRcbLock.user_id == int(user_id), UserRcbLock.asset_symbol == RCB_SYMBOL)
        .order_by(UserRcbLock.created_at.desc(), UserRcbLock.id.desc())
        .limit(max(1, min(int(limit or 200), 500)))
        .all()
    )
    items = []
    for item in locks:
        svip_level = _pick_svip_for_lock(db, _q18(item.lock_amount), int(item.lock_period_days or 0))
        items.append(serialize_rcb_lock(item, current_svip=svip_level.level_code if svip_level else None))
    return {"items": items}
