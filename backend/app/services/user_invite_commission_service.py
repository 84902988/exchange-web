from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.asset import Asset, BalanceLog, UserBalance
from app.db.models.bd_commission_record import BdCommissionRecord
from app.db.models.user import User
from app.db.models.user_invite_commission_record import UserInviteCommissionRecord
from app.db.models.user_invite_relation import UserInviteRelation
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.rcb_price_service import get_rcb_price_usdt
from app.services.user_invite_service import get_effective_user_invite_commission_rate


Q18 = Decimal("0.000000000000000001")
RCB_SYMBOL = "RCB"
USDT_SYMBOL = "USDT"
PLATFORM_USER_ID = 99999999
logger = logging.getLogger(__name__)


def _q18(value: Decimal) -> Decimal:
    return Decimal(str(value or 0)).quantize(Q18, rounding=ROUND_DOWN)


def _normalize_symbol(value: str) -> str:
    return str(value or "").upper().strip()


def _utc_now() -> datetime:
    return datetime.utcnow()


def _log_direction(change_amount: Decimal) -> int:
    return 1 if _q18(change_amount) >= Decimal("0") else -1


def _get_asset_id(db: Session, symbol: str) -> int:
    normalized_symbol = _normalize_symbol(symbol)
    asset_id = db.query(Asset.id).filter(Asset.symbol == normalized_symbol).scalar()
    if asset_id is None:
        raise ValueError(f"asset not configured: {normalized_symbol}")
    return int(asset_id)


def _get_funding_balance_for_update(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    now: datetime,
) -> UserBalance:
    normalized_symbol = _normalize_symbol(coin_symbol)
    balance = (
        db.query(UserBalance)
        .filter(
            UserBalance.user_id == int(user_id),
            UserBalance.coin_symbol == normalized_symbol,
            UserBalance.chain_key == FUNDING_BALANCE_CHAIN_KEY,
        )
        .with_for_update()
        .first()
    )
    if balance is not None:
        return balance

    balance = UserBalance(
        user_id=int(user_id),
        coin_symbol=normalized_symbol,
        chain_key=FUNDING_BALANCE_CHAIN_KEY,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=0,
        created_at=now,
        updated_at=now,
    )
    db.add(balance)
    db.flush()
    return balance


def _add_balance_log(
    db: Session,
    *,
    user_id: int,
    change_amount: Decimal,
    before_available: Decimal,
    after_available: Decimal,
    before_frozen: Decimal,
    after_frozen: Decimal,
    change_type: str,
    biz_type: str,
    biz_id: str,
    remark: str,
    now: datetime,
) -> BalanceLog:
    balance_log = BalanceLog(
        user_id=int(user_id),
        coin_symbol=RCB_SYMBOL,
        chain_key=FUNDING_BALANCE_CHAIN_KEY,
        change_type=change_type,
        direction=_log_direction(change_amount),
        change_amount=_q18(change_amount),
        before_available=_q18(before_available),
        after_available=_q18(after_available),
        before_frozen=_q18(before_frozen),
        after_frozen=_q18(after_frozen),
        biz_type=biz_type,
        biz_id=biz_id,
        request_id=None,
        remark=remark,
        created_at=now,
    )
    db.add(balance_log)
    return balance_log


def _calculate_invite_commission_values(
    *,
    fee_coin_symbol: str,
    fee_amount: Decimal,
    commission_rate: Decimal,
    rcb_price: Decimal,
) -> tuple[Decimal, Decimal, Decimal]:
    normalized_symbol = _normalize_symbol(fee_coin_symbol)
    normalized_price = _q18(rcb_price)
    if normalized_price <= Decimal("0"):
        raise ValueError("RCBUSDT price must be greater than 0")

    if normalized_symbol == USDT_SYMBOL:
        fee_usdt_value = _q18(fee_amount)
        commission_usdt_value = _q18(fee_usdt_value * commission_rate)
        commission_rcb_amount = _q18(commission_usdt_value / normalized_price)
        return fee_usdt_value, commission_usdt_value, commission_rcb_amount

    if normalized_symbol == RCB_SYMBOL:
        fee_usdt_value = _q18(fee_amount * normalized_price)
        commission_usdt_value = _q18(fee_usdt_value * commission_rate)
        commission_rcb_amount = _q18(fee_amount * commission_rate)
        return fee_usdt_value, commission_usdt_value, commission_rcb_amount

    raise ValueError(f"unsupported invite commission fee coin: {normalized_symbol or 'UNKNOWN'}")


def _find_existing_record(
    db: Session,
    *,
    invitee_user_id: int,
    trade_id: Optional[int],
    order_id: Optional[int],
    fee_coin_symbol: str,
    fee_amount: Decimal,
) -> Optional[UserInviteCommissionRecord]:
    normalized_symbol = _normalize_symbol(fee_coin_symbol)

    if trade_id is not None:
        return (
            db.query(UserInviteCommissionRecord)
            .filter(
                UserInviteCommissionRecord.trade_id == int(trade_id),
                UserInviteCommissionRecord.invitee_user_id == int(invitee_user_id),
                UserInviteCommissionRecord.fee_coin_symbol == normalized_symbol,
            )
            .first()
        )

    if order_id is None:
        return None

    return (
        db.query(UserInviteCommissionRecord)
        .filter(
            UserInviteCommissionRecord.trade_id.is_(None),
            UserInviteCommissionRecord.order_id == int(order_id),
            UserInviteCommissionRecord.invitee_user_id == int(invitee_user_id),
            UserInviteCommissionRecord.fee_coin_symbol == normalized_symbol,
            UserInviteCommissionRecord.fee_amount == _q18(fee_amount),
        )
        .first()
    )


def create_user_invite_commission_for_fee(
    db: Session,
    *,
    invitee_user_id: int,
    trade_id: Optional[int],
    order_id: Optional[int],
    fee_asset_id: Optional[int],
    fee_coin_symbol: str,
    fee_amount: Decimal,
) -> Optional[UserInviteCommissionRecord]:
    fee_amount = _q18(Decimal(str(fee_amount or 0)))
    if fee_amount <= Decimal("0"):
        return None

    if trade_id is not None:
        bd_record_exists = (
            db.query(BdCommissionRecord.id)
            .filter(BdCommissionRecord.trade_id == int(trade_id))
            .first()
        )
        if bd_record_exists is not None:
            return None

    relation = (
        db.query(UserInviteRelation)
        .filter(
            UserInviteRelation.invitee_user_id == int(invitee_user_id),
            UserInviteRelation.status == "ACTIVE",
        )
        .first()
    )
    if relation is None:
        return None

    existing = _find_existing_record(
        db,
        invitee_user_id=int(invitee_user_id),
        trade_id=trade_id,
        order_id=order_id,
        fee_coin_symbol=fee_coin_symbol,
        fee_amount=fee_amount,
    )
    if existing is not None:
        return existing

    commission_rate = Decimal(str(get_effective_user_invite_commission_rate(db, relation)))
    try:
        rcb_price = get_rcb_price_usdt(db)
        fee_usdt_value, _commission_usdt_value, commission_rcb_amount = _calculate_invite_commission_values(
            fee_coin_symbol=fee_coin_symbol,
            fee_amount=fee_amount,
            commission_rate=commission_rate,
            rcb_price=rcb_price,
        )
    except Exception as exc:
        logger.warning(
            "skip user invite commission: %s invitee_user_id=%s trade_id=%s order_id=%s fee_coin=%s fee_amount=%s",
            exc,
            invitee_user_id,
            trade_id,
            order_id,
            fee_coin_symbol,
            fee_amount,
        )
        return None

    if commission_rcb_amount <= Decimal("0"):
        return None

    record = UserInviteCommissionRecord(
        inviter_user_id=int(relation.inviter_user_id),
        invitee_user_id=int(invitee_user_id),
        trade_id=int(trade_id) if trade_id is not None else None,
        order_id=int(order_id) if order_id is not None else None,
        fee_asset_id=int(fee_asset_id) if fee_asset_id is not None else None,
        fee_coin_symbol=_normalize_symbol(fee_coin_symbol),
        fee_amount=fee_amount,
        fee_usdt_value=fee_usdt_value,
        rcb_price_used=_q18(rcb_price),
        commission_asset_symbol=RCB_SYMBOL,
        commission_rate=commission_rate,
        commission_amount=commission_rcb_amount,
        commission_rcb_amount=commission_rcb_amount,
        status="PENDING",
    )

    try:
        with db.begin_nested():
            db.add(record)
            db.flush()
    except IntegrityError:
        return _find_existing_record(
            db,
            invitee_user_id=int(invitee_user_id),
            trade_id=trade_id,
            order_id=order_id,
            fee_coin_symbol=fee_coin_symbol,
            fee_amount=fee_amount,
        )

    return record


def _mark_user_invite_commission_failed(
    db: Session,
    record: UserInviteCommissionRecord,
    reason: str,
) -> UserInviteCommissionRecord:
    record.status = "FAILED"
    record.fail_reason = str(reason or "普通邀请分成发放失败")[:500]
    record.updated_at = _utc_now()
    db.add(record)
    db.flush()
    return record


def pay_user_invite_commission_record(
    db: Session,
    *,
    record_id: int,
) -> UserInviteCommissionRecord:
    record = (
        db.query(UserInviteCommissionRecord)
        .filter(UserInviteCommissionRecord.id == int(record_id))
        .with_for_update()
        .first()
    )
    if record is None:
        raise ValueError("user invite commission record not found")

    if record.status != "PENDING":
        return record

    if _normalize_symbol(record.commission_asset_symbol) != RCB_SYMBOL:
        return _mark_user_invite_commission_failed(db, record, "普通邀请分成资产必须为 RCB")

    pay_amount = _q18(Decimal(str(record.commission_rcb_amount or record.commission_amount or 0)))
    if pay_amount <= Decimal("0"):
        return _mark_user_invite_commission_failed(db, record, "普通邀请分成金额必须大于 0")

    inviter_exists = db.query(User.id).filter(User.id == int(record.inviter_user_id)).first()
    if inviter_exists is None:
        return _mark_user_invite_commission_failed(db, record, "邀请人用户不存在")

    _get_asset_id(db, RCB_SYMBOL)
    now = _utc_now()
    inviter_balance = _get_funding_balance_for_update(
        db,
        user_id=int(record.inviter_user_id),
        coin_symbol=RCB_SYMBOL,
        now=now,
    )
    platform_balance = _get_funding_balance_for_update(
        db,
        user_id=PLATFORM_USER_ID,
        coin_symbol=RCB_SYMBOL,
        now=now,
    )

    inviter_before_available = _q18(Decimal(str(inviter_balance.available_amount or 0)))
    inviter_before_frozen = _q18(Decimal(str(inviter_balance.frozen_amount or 0)))
    platform_before_available = _q18(Decimal(str(platform_balance.available_amount or 0)))
    platform_before_frozen = _q18(Decimal(str(platform_balance.frozen_amount or 0)))

    inviter_after_available = _q18(inviter_before_available + pay_amount)
    if platform_before_available < pay_amount:
        return _mark_user_invite_commission_failed(db, record, "平台 RCB 余额不足，无法发放普通邀请分成")

    platform_after_available = _q18(platform_before_available - pay_amount)

    inviter_balance.available_amount = inviter_after_available
    inviter_balance.version = int(inviter_balance.version or 0) + 1
    inviter_balance.updated_at = now

    platform_balance.available_amount = platform_after_available
    platform_balance.version = int(platform_balance.version or 0) + 1
    platform_balance.updated_at = now

    biz_id = str(int(record.id))
    _add_balance_log(
        db,
        user_id=int(record.inviter_user_id),
        change_amount=pay_amount,
        before_available=inviter_before_available,
        after_available=inviter_after_available,
        before_frozen=inviter_before_frozen,
        after_frozen=inviter_before_frozen,
        change_type="USER_INVITE_COMMISSION_CREDIT",
        biz_type="USER_INVITE_COMMISSION_CREDIT",
        biz_id=biz_id,
        remark="普通邀请分成发放; source_type=USER_INVITE",
        now=now,
    )
    _add_balance_log(
        db,
        user_id=PLATFORM_USER_ID,
        change_amount=-pay_amount,
        before_available=platform_before_available,
        after_available=platform_after_available,
        before_frozen=platform_before_frozen,
        after_frozen=platform_before_frozen,
        change_type="USER_INVITE_COMMISSION_DEBIT",
        biz_type="USER_INVITE_COMMISSION_DEBIT",
        biz_id=biz_id,
        remark="普通邀请分成支出; source_type=USER_INVITE",
        now=now,
    )

    db.add(inviter_balance)
    db.add(platform_balance)

    record.status = "PAID"
    record.paid_at = now
    record.fail_reason = None
    record.updated_at = now
    db.add(record)
    db.flush()
    return record


def pay_pending_user_invite_commissions(
    db: Session,
    *,
    limit: int = 100,
) -> dict:
    batch_limit = max(int(limit or 100), 0)
    record_ids = [
        int(record_id)
        for (record_id,) in (
            db.query(UserInviteCommissionRecord.id)
            .filter(UserInviteCommissionRecord.status == "PENDING")
            .order_by(UserInviteCommissionRecord.id.asc())
            .limit(batch_limit)
            .all()
        )
    ]

    result = {
        "total": len(record_ids),
        "paid": 0,
        "failed": 0,
        "record_ids": [],
        "errors": [],
    }

    for record_id in record_ids:
        try:
            with db.begin_nested():
                record = pay_user_invite_commission_record(db, record_id=record_id)
                if record.status == "PAID":
                    result["paid"] += 1
                    result["record_ids"].append(record_id)
                elif record.status == "FAILED":
                    result["failed"] += 1
                    result["errors"].append(
                        {"record_id": record_id, "error": record.fail_reason or "FAILED"}
                    )
        except Exception as exc:
            result["failed"] += 1
            result["errors"].append({"record_id": record_id, "error": str(exc)})

    return result
