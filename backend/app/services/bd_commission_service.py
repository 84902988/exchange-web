from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from typing import Optional

from sqlalchemy.orm import Session

from app.db.models.asset import Asset, BalanceLog, UserBalance
from app.db.models.bd_commission_record import BdCommissionRecord
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.fee_service import PLATFORM_USER_ID


Q18 = Decimal("0.000000000000000001")
RCB_SYMBOL = "RCB"
USDT_SYMBOL = "USDT"
SUPPORTED_COMMISSION_ASSETS = {RCB_SYMBOL, USDT_SYMBOL}


class InsufficientPlatformBalanceError(ValueError):
    pass


def _utc_now() -> datetime:
    return datetime.utcnow()


def _decimal_or_zero(value: Optional[Decimal]) -> Decimal:
    return Decimal(str(value or 0))


def _q18(value: Decimal) -> Decimal:
    return _decimal_or_zero(value).quantize(Q18, rounding=ROUND_DOWN)


def _log_direction(change_amount: Decimal) -> int:
    return 1 if _q18(change_amount) >= Decimal("0") else -1


def _get_asset_id(db: Session, symbol: str) -> int:
    normalized_symbol = (symbol or "").upper().strip()
    asset_id = (
        db.query(Asset.id)
        .filter(Asset.symbol == normalized_symbol)
        .scalar()
    )
    if asset_id is None:
        raise ValueError(f"asset not configured: {normalized_symbol}")
    return int(asset_id)


def _commission_asset_symbol(record: BdCommissionRecord) -> str:
    symbol = str(record.commission_asset_symbol or RCB_SYMBOL).upper().strip()
    if symbol not in SUPPORTED_COMMISSION_ASSETS:
        raise ValueError(f"unsupported bd commission asset: {symbol or 'UNKNOWN'}")
    return symbol


def _commission_amount(record: BdCommissionRecord) -> Decimal:
    amount = _q18(_decimal_or_zero(record.commission_amount))
    if amount <= Decimal("0"):
        raise ValueError("bd commission amount must be greater than 0")
    return amount


def _get_funding_balance_for_update(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    now: datetime,
) -> UserBalance:
    balance = (
        db.query(UserBalance)
        .filter(
            UserBalance.user_id == int(user_id),
            UserBalance.coin_symbol == coin_symbol,
            UserBalance.chain_key == FUNDING_BALANCE_CHAIN_KEY,
        )
        .with_for_update()
        .first()
    )
    if balance is not None:
        return balance

    balance = UserBalance(
        user_id=int(user_id),
        coin_symbol=coin_symbol,
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


def _find_existing_credit_log(
    db: Session,
    *,
    record_id: int,
    bd_user_id: int,
    coin_symbol: str,
) -> Optional[BalanceLog]:
    return (
        db.query(BalanceLog)
        .filter(
            BalanceLog.user_id == int(bd_user_id),
            BalanceLog.coin_symbol == coin_symbol,
            BalanceLog.chain_key == FUNDING_BALANCE_CHAIN_KEY,
            BalanceLog.biz_type == "BD_COMMISSION_CREDIT",
            BalanceLog.biz_id == str(record_id),
        )
        .first()
    )


def _add_balance_log(
    db: Session,
    *,
    user_id: int,
    asset_id: int,
    coin_symbol: str,
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
        asset_id=int(asset_id),
        coin_symbol=coin_symbol,
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


def pay_bd_commission_record(db: Session, record_id: int) -> BdCommissionRecord:
    record = (
        db.query(BdCommissionRecord)
        .filter(BdCommissionRecord.id == int(record_id))
        .with_for_update()
        .first()
    )
    if record is None:
        raise ValueError("bd commission record not found")

    now = _utc_now()
    if record.status != "PENDING":
        return record

    commission_asset_symbol = _commission_asset_symbol(record)
    commission_amount = _commission_amount(record)
    commission_asset_id = _get_asset_id(db, commission_asset_symbol)

    if record.paid_balance_log_id is not None:
        record.status = "PAID"
        record.paid_at = record.paid_at or now
        record.updated_at = now
        record.commission_asset_symbol = commission_asset_symbol
        db.add(record)
        db.flush()
        return record

    existing_credit_log = _find_existing_credit_log(
        db,
        record_id=int(record.id),
        bd_user_id=int(record.bd_user_id),
        coin_symbol=commission_asset_symbol,
    )
    if existing_credit_log is not None:
        record.status = "PAID"
        record.paid_balance_log_id = int(existing_credit_log.id)
        record.paid_at = record.paid_at or now
        record.updated_at = now
        record.commission_asset_symbol = commission_asset_symbol
        db.add(record)
        db.flush()
        return record

    bd_balance = _get_funding_balance_for_update(
        db,
        user_id=int(record.bd_user_id),
        coin_symbol=commission_asset_symbol,
        now=now,
    )
    platform_balance = _get_funding_balance_for_update(
        db,
        user_id=PLATFORM_USER_ID,
        coin_symbol=commission_asset_symbol,
        now=now,
    )

    bd_before_available = _q18(_decimal_or_zero(bd_balance.available_amount))
    bd_before_frozen = _q18(_decimal_or_zero(bd_balance.frozen_amount))
    platform_before_available = _q18(_decimal_or_zero(platform_balance.available_amount))
    platform_before_frozen = _q18(_decimal_or_zero(platform_balance.frozen_amount))

    if platform_before_available < commission_amount:
        raise InsufficientPlatformBalanceError(
            f"insufficient platform {commission_asset_symbol} balance for BD commission record {int(record.id)}"
        )

    bd_after_available = _q18(bd_before_available + commission_amount)
    platform_after_available = _q18(platform_before_available - commission_amount)

    bd_balance.available_amount = bd_after_available
    bd_balance.version = int(bd_balance.version or 0) + 1
    bd_balance.updated_at = now
    platform_balance.available_amount = platform_after_available
    platform_balance.version = int(platform_balance.version or 0) + 1
    platform_balance.updated_at = now

    biz_id = str(record.id)
    credit_log = _add_balance_log(
        db,
        user_id=int(record.bd_user_id),
        asset_id=commission_asset_id,
        coin_symbol=commission_asset_symbol,
        change_amount=commission_amount,
        before_available=bd_before_available,
        after_available=bd_after_available,
        before_frozen=bd_before_frozen,
        after_frozen=bd_before_frozen,
        change_type="BD_COMMISSION_CREDIT",
        biz_type="BD_COMMISSION_CREDIT",
        biz_id=biz_id,
        remark=f"BD commission payout {commission_amount} {commission_asset_symbol}; source_type=BD",
        now=now,
    )
    _add_balance_log(
        db,
        user_id=PLATFORM_USER_ID,
        asset_id=commission_asset_id,
        coin_symbol=commission_asset_symbol,
        change_amount=-commission_amount,
        before_available=platform_before_available,
        after_available=platform_after_available,
        before_frozen=platform_before_frozen,
        after_frozen=platform_before_frozen,
        change_type="BD_COMMISSION_DEBIT",
        biz_type="BD_COMMISSION_DEBIT",
        biz_id=biz_id,
        remark=f"BD commission payout {commission_amount} {commission_asset_symbol} to user {int(record.bd_user_id)}; source_type=BD",
        now=now,
    )

    db.add(bd_balance)
    db.add(platform_balance)
    db.flush()

    record.status = "PAID"
    record.paid_balance_log_id = int(credit_log.id)
    record.paid_at = now
    record.updated_at = now
    record.commission_asset_symbol = commission_asset_symbol
    db.add(record)
    db.flush()
    return record


def pay_pending_bd_commissions(db: Session, limit: int = 100) -> dict:
    batch_limit = max(int(limit or 100), 0)
    record_ids = [
        int(record_id)
        for (record_id,) in (
            db.query(BdCommissionRecord.id)
            .filter(BdCommissionRecord.status == "PENDING")
            .order_by(BdCommissionRecord.id.asc())
            .limit(batch_limit)
            .all()
        )
    ]

    result = {
        "paid_count": 0,
        "skipped_count": 0,
        "failed_count": 0,
        "failed_ids": [],
        "paid_totals": {},
    }

    for record_id in record_ids:
        try:
            with db.begin_nested():
                record = pay_bd_commission_record(db, record_id)
                if record.status == "PAID":
                    result["paid_count"] += 1
                    symbol = _commission_asset_symbol(record)
                    result["paid_totals"][symbol] = str(
                        _q18(Decimal(str(result["paid_totals"].get(symbol, "0"))) + _commission_amount(record))
                    )
                else:
                    result["skipped_count"] += 1
        except Exception:
            result["failed_count"] += 1
            result["failed_ids"].append(record_id)

    return result
