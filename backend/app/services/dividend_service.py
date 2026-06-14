from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_DOWN
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.bd_commission_record import BdCommissionRecord
from app.db.models.dividend import DividendPool, DividendPoolItem, UserDividendRecord
from app.db.models.system_config import SystemConfig
from app.db.models.user_invite_commission_record import UserInviteCommissionRecord
from app.db.models.user_rcb_lock import UserRcbLock
from app.db.models.vip_fee_level import VipFeeLevel
from app.db.models.vip_fee_level_condition import VipFeeLevelCondition
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.fee_service import PLATFORM_USER_ID
from app.services.rcb_price_service import get_rcb_price_usdt


DIVIDEND_RUN_TIME_KEY = "dividend_run_time_utc"
DIVIDEND_RCB_PRICE_SNAPSHOT_TIME_KEY = "dividend_rcb_price_snapshot_time"
DEFAULT_DIVIDEND_RUN_TIME_UTC = "00:10"
DEFAULT_DIVIDEND_RCB_PRICE_SNAPSHOT_TIME_UTC = "00:00"
RUN_TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
SVIP_DIVIDEND_LEVEL_CODES = (
    "SVIP1",
    "SVIP2",
    "SVIP3",
    "SVIP4",
    "SVIP5",
    "SVIP6",
    "SVIP7",
    "SVIP8",
    "LP",
)
SVIP_DIVIDEND_RATE = Decimal("0.05")
DIVIDEND_COIN_SYMBOL = "RCB"
DIVIDEND_BALANCE_CHAIN_KEY = FUNDING_BALANCE_CHAIN_KEY
Q18 = Decimal("0.000000000000000001")


def _utc_now() -> datetime:
    return datetime.utcnow()


def _validate_run_time(run_time_utc: str, field_name: str = "dividend run time") -> str:
    value = str(run_time_utc or "").strip()
    if not RUN_TIME_PATTERN.match(value):
        raise ValueError(f"{field_name} must be HH:MM in UTC/GMT")
    return value


def get_dividend_config(db: Session) -> dict[str, Any]:
    configs = {
        item.config_key: item
        for item in (
            db.query(SystemConfig)
            .filter(SystemConfig.config_key.in_([
                DIVIDEND_RUN_TIME_KEY,
                DIVIDEND_RCB_PRICE_SNAPSHOT_TIME_KEY,
            ]))
            .all()
        )
    }
    run_time_config = configs.get(DIVIDEND_RUN_TIME_KEY)
    snapshot_time_config = configs.get(DIVIDEND_RCB_PRICE_SNAPSHOT_TIME_KEY)
    run_time = run_time_config.config_value if run_time_config else DEFAULT_DIVIDEND_RUN_TIME_UTC
    snapshot_time = (
        snapshot_time_config.config_value
        if snapshot_time_config
        else DEFAULT_DIVIDEND_RCB_PRICE_SNAPSHOT_TIME_UTC
    )
    return {
        "run_time_utc": run_time,
        "rcb_price_snapshot_time": snapshot_time,
        "description": run_time_config.description if run_time_config else "Daily dividend run time in UTC/GMT",
        "rcb_price_snapshot_description": (
            snapshot_time_config.description
            if snapshot_time_config
            else "Daily RCBUSDT price snapshot time in UTC/GMT"
        ),
    }


def _set_dividend_time_config(
    db: Session,
    *,
    config_key: str,
    config_value: str,
    description: str,
) -> SystemConfig:
    now = _utc_now()
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == config_key)
        .with_for_update()
        .first()
    )
    if config is None:
        config = SystemConfig(
            config_key=config_key,
            config_value=config_value,
            description=description,
            created_at=now,
            updated_at=now,
        )
        db.add(config)
    else:
        config.config_value = config_value
        config.description = description
        config.updated_at = now

    db.flush()
    return config


def set_dividend_run_time(db: Session, run_time_utc: str) -> SystemConfig:
    run_time = _validate_run_time(run_time_utc, "dividend run time")
    return _set_dividend_time_config(
        db,
        config_key=DIVIDEND_RUN_TIME_KEY,
        config_value=run_time,
        description="Daily dividend run time in UTC/GMT, HH:MM",
    )


def set_dividend_rcb_price_snapshot_time(db: Session, snapshot_time_utc: str) -> SystemConfig:
    snapshot_time = _validate_run_time(snapshot_time_utc, "RCB price snapshot time")
    return _set_dividend_time_config(
        db,
        config_key=DIVIDEND_RCB_PRICE_SNAPSHOT_TIME_KEY,
        config_value=snapshot_time,
        description="Daily RCBUSDT price snapshot time in UTC/GMT, HH:MM",
    )


def get_target_dividend_date(now_utc: datetime) -> date:
    # T-day fees are settled at T+1 configured UTC time.
    return now_utc.date() - timedelta(days=1)


def _ensure_dividend_date_finished(dividend_date: date) -> None:
    if dividend_date >= _utc_now().date():
        raise ValueError("dividend date must be earlier than current UTC date")


def is_dividend_already_run(db: Session, dividend_date: date) -> bool:
    return (
        db.query(DividendPool.id)
        .filter(DividendPool.dividend_date == dividend_date)
        .first()
        is not None
    )


def _decimal_or_zero(value: Optional[Decimal]) -> Decimal:
    return Decimal(str(value or 0))


def _q18(value: Decimal) -> Decimal:
    return _decimal_or_zero(value).quantize(Q18, rounding=ROUND_DOWN)


def _parse_trade_fee_biz_id(biz_id: Optional[str]) -> tuple[Optional[int], Optional[int]]:
    parts = str(biz_id or "").split(":")
    if len(parts) < 2:
        return None, None

    try:
        trade_id = int(parts[0])
        order_id = int(parts[1])
    except (TypeError, ValueError):
        return None, None

    return trade_id, order_id


def _find_trade_fee_debit_log(db: Session, credit_log: BalanceLog) -> Optional[BalanceLog]:
    return (
        db.query(BalanceLog)
        .filter(
            BalanceLog.biz_type == credit_log.biz_type,
            BalanceLog.biz_id == credit_log.biz_id,
            BalanceLog.coin_symbol == credit_log.coin_symbol,
            BalanceLog.change_type == "TRADE_FEE_DEBIT",
        )
        .order_by(BalanceLog.id.asc())
        .first()
    )


def _find_bd_commission_record(
    db: Session,
    *,
    source_balance_log_id: Optional[int],
    trade_id: Optional[int],
    order_id: Optional[int],
) -> Optional[BdCommissionRecord]:
    if source_balance_log_id is not None:
        record = (
            db.query(BdCommissionRecord)
            .filter(BdCommissionRecord.source_balance_log_id == source_balance_log_id)
            .order_by(BdCommissionRecord.id.asc())
            .first()
        )
        if record is not None:
            return record

    if trade_id is None:
        return None

    query = db.query(BdCommissionRecord).filter(BdCommissionRecord.trade_id == trade_id)
    if order_id is not None:
        query = query.filter(BdCommissionRecord.order_id == order_id)

    return query.order_by(BdCommissionRecord.id.asc()).first()


def _find_user_invite_commission_record(
    db: Session,
    *,
    invitee_user_id: Optional[int],
    trade_id: Optional[int],
    order_id: Optional[int],
    fee_coin_symbol: Optional[str],
) -> Optional[UserInviteCommissionRecord]:
    if invitee_user_id is None:
        return None

    normalized_symbol = str(fee_coin_symbol or "").upper().strip()
    if not normalized_symbol:
        return None

    if trade_id is not None:
        record = (
            db.query(UserInviteCommissionRecord)
            .filter(
                UserInviteCommissionRecord.trade_id == int(trade_id),
                UserInviteCommissionRecord.invitee_user_id == int(invitee_user_id),
                UserInviteCommissionRecord.fee_coin_symbol == normalized_symbol,
            )
            .order_by(UserInviteCommissionRecord.id.asc())
            .first()
        )
        if record is not None:
            return record

    if order_id is None:
        return None

    return (
        db.query(UserInviteCommissionRecord)
        .filter(
            UserInviteCommissionRecord.order_id == int(order_id),
            UserInviteCommissionRecord.invitee_user_id == int(invitee_user_id),
            UserInviteCommissionRecord.fee_coin_symbol == normalized_symbol,
        )
        .order_by(UserInviteCommissionRecord.id.asc())
        .first()
    )


def _invite_commission_usdt_value(record: Optional[UserInviteCommissionRecord]) -> Decimal:
    if record is None:
        return Decimal("0")

    commission_rcb_amount = _q18(_decimal_or_zero(record.commission_rcb_amount))
    rcb_price = _q18(_decimal_or_zero(record.rcb_price_used))
    if commission_rcb_amount > Decimal("0") and rcb_price > Decimal("0"):
        return _q18(commission_rcb_amount * rcb_price)

    fee_usdt_value = _q18(_decimal_or_zero(record.fee_usdt_value))
    commission_rate = _decimal_or_zero(record.commission_rate)
    if fee_usdt_value > Decimal("0") and commission_rate > Decimal("0"):
        return _q18(fee_usdt_value * commission_rate)

    return Decimal("0")


def _get_dividend_eligible_fee_rows(
    db: Session,
    dividend_date: date,
) -> list[dict[str, Any]]:
    start_at = datetime.combine(dividend_date, datetime.min.time())
    end_at = start_at + timedelta(days=1)

    credit_logs = (
        db.query(BalanceLog)
        .filter(
            BalanceLog.user_id == PLATFORM_USER_ID,
            BalanceLog.change_type == "TRADE_FEE_CREDIT",
            BalanceLog.created_at >= start_at,
            BalanceLog.created_at < end_at,
        )
        .order_by(BalanceLog.id.asc())
        .all()
    )

    rows: list[dict[str, Any]] = []
    for credit_log in credit_logs:
        debit_log = _find_trade_fee_debit_log(db, credit_log)
        trade_id, order_id = _parse_trade_fee_biz_id(credit_log.biz_id)
        record = _find_bd_commission_record(
            db,
            source_balance_log_id=int(debit_log.id) if debit_log is not None else None,
            trade_id=trade_id,
            order_id=order_id,
        )
        invite_record = _find_user_invite_commission_record(
            db,
            invitee_user_id=int(debit_log.user_id) if debit_log is not None else None,
            trade_id=trade_id,
            order_id=order_id,
            fee_coin_symbol=credit_log.coin_symbol,
        )
        invite_commission_usdt_value = _invite_commission_usdt_value(invite_record)

        if record is not None:
            amount = _q18(_decimal_or_zero(record.pool_amount))
            rows.append(
                {
                    "coin_symbol": record.fee_coin_symbol,
                    "amount": amount,
                    "source_type": "BD_POOL",
                    "balance_log_id": int(credit_log.id),
                    "bd_commission_record_id": int(record.id),
                    "user_invite_commission_record_id": (
                        int(invite_record.id) if invite_record is not None else None
                    ),
                    "invite_commission_usdt_value": Decimal("0"),
                }
            )
            continue

        rows.append(
            {
                "coin_symbol": credit_log.coin_symbol,
                "amount": _q18(_decimal_or_zero(credit_log.change_amount)),
                "source_type": "NORMAL_FEE",
                "balance_log_id": int(credit_log.id),
                "bd_commission_record_id": None,
                "user_invite_commission_record_id": (
                    int(invite_record.id) if invite_record is not None else None
                ),
                "invite_commission_usdt_value": invite_commission_usdt_value,
            }
        )

    return rows


def calculate_total_fee_usdt(
    db: Session,
    dividend_date: date,
    rcb_price: Optional[Decimal] = None,
) -> Decimal:
    fee_rows = _get_dividend_eligible_fee_rows(db, dividend_date)
    total_fee_usdt = Decimal("0")
    normalized_rcb_price = _q18(_decimal_or_zero(rcb_price))
    for row in fee_rows:
        symbol = str(row["coin_symbol"] or "").upper()
        amount = _q18(_decimal_or_zero(row["amount"]))
        if symbol == "USDT":
            row_fee_usdt = amount
        elif symbol == "RCB":
            if normalized_rcb_price <= Decimal("0"):
                raise ValueError("rcb_price must be greater than 0 when RCB fee credits exist")
            row_fee_usdt = _q18(amount * normalized_rcb_price)
        else:
            raise ValueError(f"unsupported trade fee coin for dividend stats: {symbol or 'UNKNOWN'}")

        invite_commission_usdt = _q18(_decimal_or_zero(row.get("invite_commission_usdt_value")))
        total_fee_usdt += max(row_fee_usdt - invite_commission_usdt, Decimal("0"))

    return _q18(total_fee_usdt)


def create_dividend_pool_skeleton(
    db: Session,
    dividend_date: date,
    rcb_price: Optional[Decimal] = None,
    source: str = "MANUAL",
) -> DividendPool:
    _ensure_dividend_date_finished(dividend_date)
    existing = (
        db.query(DividendPool)
        .filter(DividendPool.dividend_date == dividend_date)
        .with_for_update()
        .first()
    )
    if existing is not None:
        return existing

    now = _utc_now()
    normalized_rcb_price = (
        get_rcb_price_usdt(db)
        if rcb_price is None
        else _q18(_decimal_or_zero(rcb_price))
    )
    total_fee_usdt = calculate_total_fee_usdt(db, dividend_date, normalized_rcb_price)
    pool = DividendPool(
        dividend_date=dividend_date,
        total_fee_usdt=total_fee_usdt,
        rcb_price_used=normalized_rcb_price,
        total_dividend_usdt=_q18(Decimal("0")),
        total_dividend_rcb=_q18(Decimal("0")),
        status="PENDING",
        source=str(source or "MANUAL").strip().upper()[:20],
        run_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(pool)
    db.flush()
    return pool


def _load_svip_level_rules(db: Session) -> dict[str, dict[str, Any]]:
    rows = (
        db.query(VipFeeLevel, VipFeeLevelCondition)
        .join(VipFeeLevelCondition, VipFeeLevelCondition.vip_fee_level_id == VipFeeLevel.id)
        .filter(
            VipFeeLevel.vip_type == "SVIP",
            VipFeeLevel.is_enabled.is_(True),
            VipFeeLevel.level_code.in_(SVIP_DIVIDEND_LEVEL_CODES),
        )
        .order_by(VipFeeLevel.sort_order.asc(), VipFeeLevel.id.asc())
        .all()
    )
    return {
        level.level_code: {
            "sort_order": int(level.sort_order or 0),
            "min_lock_amount": _decimal_or_zero(condition.min_lock_amount),
            "lock_period_days": int(condition.lock_period_days or 0),
            "user_limit": condition.user_limit,
            "dividend_rate": (
                _decimal_or_zero(condition.dividend_rate)
                if condition.dividend_rate is not None
                else SVIP_DIVIDEND_RATE
            ),
        }
        for level, condition in rows
    }


def _load_eligible_svip_users(db: Session, dividend_date: date) -> dict[str, list[int]]:
    rules = _load_svip_level_rules(db)
    users_by_level: dict[str, list[int]] = {level_code: [] for level_code in SVIP_DIVIDEND_LEVEL_CODES}
    if not rules:
        return users_by_level

    cutoff = datetime.combine(dividend_date, datetime.min.time())
    active_locks = (
        db.query(
            UserRcbLock.user_id,
            UserRcbLock.lock_amount,
            UserRcbLock.lock_period_days,
        )
        .filter(
            UserRcbLock.asset_symbol == "RCB",
            UserRcbLock.status == "LOCKED",
            UserRcbLock.start_time < cutoff,
            UserRcbLock.end_time >= cutoff,
        )
        .all()
    )

    user_period_amounts: dict[int, dict[int, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    for user_id, lock_amount, lock_period_days in active_locks:
        user_period_amounts[int(user_id)][int(lock_period_days or 0)] += _decimal_or_zero(lock_amount)

    sorted_rules = sorted(
        rules.items(),
        key=lambda item: (item[1]["sort_order"], item[0]),
    )
    for user_id, period_amounts in user_period_amounts.items():
        matched_level: Optional[str] = None
        for level_code, rule in sorted_rules:
            eligible_amount = sum(
                amount
                for period_days, amount in period_amounts.items()
                if period_days >= rule["lock_period_days"]
            )
            if eligible_amount >= rule["min_lock_amount"]:
                matched_level = level_code
        if matched_level is not None:
            users_by_level[matched_level].append(user_id)

    for level_code, user_ids in users_by_level.items():
        user_limit = rules.get(level_code, {}).get("user_limit")
        if user_limit is not None and int(user_limit) > 0 and len(user_ids) > int(user_limit):
            raise ValueError(f"{level_code} eligible user count exceeds limit")

    return users_by_level


def calculate_dividend_pool(db: Session, pool_id: int) -> DividendPool:
    pool = (
        db.query(DividendPool)
        .filter(DividendPool.id == pool_id)
        .with_for_update()
        .first()
    )
    if pool is None:
        raise ValueError("dividend pool not found")
    _ensure_dividend_date_finished(pool.dividend_date)
    status = str(pool.status or "").upper()
    if status not in {"PENDING", "FAILED"}:
        if status == "PAID":
            raise ValueError("dividend pool already paid; manual compensation is required")
        raise ValueError("dividend pool already calculated")
    if _decimal_or_zero(pool.rcb_price_used) <= Decimal("0"):
        raise ValueError("Invalid RCBUSDT price")

    existing_item = db.query(DividendPoolItem.id).filter(DividendPoolItem.pool_id == pool.id).first()
    existing_record = db.query(UserDividendRecord.id).filter(UserDividendRecord.pool_id == pool.id).first()
    if existing_item is not None or existing_record is not None:
        paid_record = (
            db.query(UserDividendRecord.id)
            .filter(
                UserDividendRecord.pool_id == pool.id,
                UserDividendRecord.status == "PAID",
            )
            .first()
        )
        if paid_record is not None or status != "FAILED":
            raise ValueError("dividend pool already calculated")
        db.query(UserDividendRecord).filter(UserDividendRecord.pool_id == pool.id).delete(synchronize_session=False)
        db.query(DividendPoolItem).filter(DividendPoolItem.pool_id == pool.id).delete(synchronize_session=False)
        db.flush()

    now = _utc_now()
    level_rules = _load_svip_level_rules(db)
    users_by_level = _load_eligible_svip_users(db, pool.dividend_date)
    total_fee_usdt = calculate_total_fee_usdt(db, pool.dividend_date, _decimal_or_zero(pool.rcb_price_used))
    rcb_price = _decimal_or_zero(pool.rcb_price_used)
    total_dividend_usdt = Decimal("0")
    total_dividend_rcb = Decimal("0")

    for level_code in SVIP_DIVIDEND_LEVEL_CODES:
        user_ids = sorted(set(users_by_level.get(level_code, [])))
        eligible_user_count = len(user_ids)
        level_rule = level_rules.get(level_code, {})
        level_dividend_rate = _decimal_or_zero(level_rule.get("dividend_rate") or SVIP_DIVIDEND_RATE)
        level_fee_usdt = _q18(total_fee_usdt * level_dividend_rate)
        total_dividend_usdt += level_fee_usdt

        if eligible_user_count > 0:
            per_user_usdt = _q18(level_fee_usdt / Decimal(eligible_user_count))
            per_user_rcb = _q18(per_user_usdt / rcb_price)
        else:
            per_user_usdt = _q18(Decimal("0"))
            per_user_rcb = _q18(Decimal("0"))

        db.add(
            DividendPoolItem(
                pool_id=pool.id,
                level_code=level_code,
                level_dividend_rate=level_dividend_rate,
                level_fee_usdt=level_fee_usdt,
                eligible_user_count=eligible_user_count,
                per_user_usdt=per_user_usdt,
                per_user_rcb=per_user_rcb,
                created_at=now,
            )
        )

        for user_id in user_ids:
            total_dividend_rcb += per_user_rcb
            db.add(
                UserDividendRecord(
                    pool_id=pool.id,
                    user_id=user_id,
                    level_code=level_code,
                    dividend_usdt=per_user_usdt,
                    rcb_price_used=_q18(rcb_price),
                    dividend_rcb=per_user_rcb,
                    status="PENDING",
                    paid_at=None,
                    created_at=now,
                    updated_at=now,
                )
            )

    pool.total_dividend_usdt = _q18(total_dividend_usdt)
    pool.total_dividend_rcb = _q18(total_dividend_rcb)
    pool.total_fee_usdt = _q18(total_fee_usdt)
    pool.status = "CALCULATED"
    pool.updated_at = now
    db.add(pool)
    db.flush()
    return pool


def _log_direction(change_amount: Decimal) -> int:
    return 1 if _q18(change_amount) >= Decimal("0") else -1


def _get_dividend_balance_for_update(
    db: Session,
    *,
    user_id: int,
    now: datetime,
) -> UserBalance:
    balance = (
        db.query(UserBalance)
        .filter(
            UserBalance.user_id == user_id,
            UserBalance.coin_symbol == DIVIDEND_COIN_SYMBOL,
            UserBalance.chain_key == DIVIDEND_BALANCE_CHAIN_KEY,
        )
        .with_for_update()
        .first()
    )
    if balance is not None:
        return balance

    balance = UserBalance(
        user_id=user_id,
        coin_symbol=DIVIDEND_COIN_SYMBOL,
        chain_key=DIVIDEND_BALANCE_CHAIN_KEY,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=0,
        created_at=now,
        updated_at=now,
    )
    db.add(balance)
    db.flush()
    return balance


def _apply_dividend_balance_change(
    db: Session,
    *,
    user_id: int,
    amount: Decimal,
    change_type: str,
    biz_id: str,
    remark: str,
    now: datetime,
) -> None:
    balance = _get_dividend_balance_for_update(db, user_id=user_id, now=now)
    before_available = _q18(_decimal_or_zero(balance.available_amount))
    before_frozen = _q18(_decimal_or_zero(balance.frozen_amount))
    after_available = _q18(before_available + amount)

    balance.available_amount = after_available
    balance.frozen_amount = before_frozen
    balance.version = int(balance.version or 0) + 1
    balance.updated_at = now

    db.add(
        BalanceLog(
            user_id=user_id,
            coin_symbol=DIVIDEND_COIN_SYMBOL,
            chain_key=DIVIDEND_BALANCE_CHAIN_KEY,
            change_type=change_type,
            direction=_log_direction(amount),
            change_amount=_q18(amount),
            before_available=before_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=before_frozen,
            biz_type="DIVIDEND",
            biz_id=biz_id,
            request_id=None,
            remark=remark,
            created_at=now,
        )
    )
    db.add(balance)


def distribute_dividend_pool(db: Session, pool_id: int) -> DividendPool:
    pool = (
        db.query(DividendPool)
        .filter(DividendPool.id == pool_id)
        .with_for_update()
        .first()
    )
    if pool is None:
        raise ValueError("dividend pool not found")
    _ensure_dividend_date_finished(pool.dividend_date)
    if pool.status != "CALCULATED":
        if pool.status == "PAID":
            raise ValueError("dividend pool already paid")
        raise ValueError("dividend pool not ready for distribution")

    now = _utc_now()
    records = (
        db.query(UserDividendRecord)
        .filter(
            UserDividendRecord.pool_id == pool.id,
            UserDividendRecord.status == "PENDING",
        )
        .with_for_update()
        .order_by(UserDividendRecord.id.asc())
        .all()
    )

    for record in records:
        amount_rcb = _q18(record.dividend_rcb)
        if amount_rcb > Decimal("0"):
            biz_id = str(record.id)
            _apply_dividend_balance_change(
                db,
                user_id=int(record.user_id),
                amount=amount_rcb,
                change_type="DIVIDEND_CREDIT",
                biz_id=biz_id,
                remark="dividend credit",
                now=now,
            )
            _apply_dividend_balance_change(
                db,
                user_id=PLATFORM_USER_ID,
                amount=-amount_rcb,
                change_type="DIVIDEND_DEBIT",
                biz_id=biz_id,
                remark="dividend debit",
                now=now,
            )

        record.status = "PAID"
        record.paid_at = now
        record.updated_at = now
        db.add(record)

    pool.status = "PAID"
    pool.updated_at = now
    db.add(pool)
    db.flush()
    return pool


def list_dividend_pools(db: Session, limit: int = 50) -> list[DividendPool]:
    return (
        db.query(DividendPool)
        .order_by(DividendPool.dividend_date.desc(), DividendPool.id.desc())
        .limit(limit)
        .all()
    )
