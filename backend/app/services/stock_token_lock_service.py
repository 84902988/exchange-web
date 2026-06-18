from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from math import ceil
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.stock_token_convert_record import StockTokenConvertRecord
from app.db.models.stock_token_lock_config import StockTokenLockConfig
from app.db.models.stock_token_release_log import StockTokenReleaseLog
from app.db.models.user_stock_token_lock import UserStockTokenLock


logger = logging.getLogger(__name__)
Q18 = Decimal("0.000000000000000001")
SPOT_CHAIN_KEY = "spot"
STOCK_TOKEN_CONVERT_BIZ_TYPE = "STOCK_TOKEN_CONVERT"
STOCK_TOKEN_RELEASE_FAILURE_STATUSES = {"FAILED", "ERROR", "PARTIAL_FAILED"}


class StockTokenLockError(ValueError):
    pass


def _normalize_symbol(value: str) -> str:
    return str(value or "").strip().upper()


def _normalize_amount(value: Decimal) -> Decimal:
    try:
        amount = Decimal(str(value).strip()).quantize(Q18, rounding=ROUND_DOWN)
    except (InvalidOperation, ValueError, TypeError):
        raise StockTokenLockError("锁仓数量格式不正确")

    if amount <= Decimal("0"):
        raise StockTokenLockError("锁仓数量必须大于 0")
    return amount


def _decimal_or_zero(value: Any) -> Decimal:
    return Decimal(str(value or 0))


def _q18(value: Any) -> Decimal:
    return _decimal_or_zero(value).quantize(Q18, rounding=ROUND_DOWN)


def _rate_release_days(daily_release_rate: Any) -> int:
    rate = _q18(daily_release_rate)
    if rate <= Decimal("0"):
        return 0
    return max(1, int(ceil(Decimal("1") / rate)))


def get_stock_token_unlock_at(
    lock_item: UserStockTokenLock,
    config: Optional[StockTokenLockConfig] = None,
) -> Optional[datetime]:
    if not lock_item.start_at:
        return None
    lock_days = int(getattr(config, "lock_days", 0) or 0)
    if lock_days <= 0:
        if lock_item.end_at and lock_item.end_at > lock_item.start_at:
            return lock_item.end_at
        return lock_item.start_at
    return lock_item.start_at + timedelta(days=lock_days)


def get_stock_token_release_end_at(
    lock_item: UserStockTokenLock,
    config: Optional[StockTokenLockConfig] = None,
) -> Optional[datetime]:
    unlock_at = get_stock_token_unlock_at(lock_item, config)
    if unlock_at is None:
        return lock_item.end_at

    if lock_item.end_at and lock_item.end_at > unlock_at:
        return lock_item.end_at

    rate = getattr(lock_item, "daily_release_rate_snapshot", None)
    if rate is None and config is not None:
        rate = config.daily_release_rate
    release_days = _rate_release_days(rate or 0)
    return unlock_at + timedelta(days=release_days) if release_days > 0 else (lock_item.end_at or unlock_at)


def is_stock_token_lock_in_lock_period(
    lock_item: UserStockTokenLock,
    now: Optional[datetime] = None,
    config: Optional[StockTokenLockConfig] = None,
) -> bool:
    unlock_at = get_stock_token_unlock_at(lock_item, config)
    return bool(unlock_at and (now or datetime.utcnow()) < unlock_at)


def calculate_stock_token_release_progress(
    lock_item: UserStockTokenLock,
    now: Optional[datetime] = None,
    config: Optional[StockTokenLockConfig] = None,
) -> Decimal:
    now_value = now or datetime.utcnow()
    if is_stock_token_lock_in_lock_period(lock_item, now_value, config):
        return Decimal("0")
    total_amount = _q18(lock_item.total_amount)
    if total_amount <= Decimal("0"):
        return Decimal("0")
    released_amount = _q18(lock_item.available_amount) + _q18(lock_item.converted_amount)
    return ((released_amount / total_amount) * Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_DOWN)


def _remaining_releasable_by_total(lock_item: UserStockTokenLock) -> Decimal:
    total_amount = _q18(lock_item.total_amount)
    released_amount = _q18(lock_item.available_amount) + _q18(lock_item.converted_amount)
    remaining = total_amount - released_amount
    return _q18(remaining if remaining > Decimal("0") else Decimal("0"))


def _apply_release_amount(lock_item: UserStockTokenLock, release_amount: Decimal, now: datetime) -> Decimal:
    locked_amount = _q18(lock_item.locked_amount)
    remaining_by_total = _remaining_releasable_by_total(lock_item)
    capped_amount = min(_q18(release_amount), locked_amount, remaining_by_total)
    if capped_amount <= Decimal("0"):
        if remaining_by_total <= Decimal("0") and locked_amount > Decimal("0"):
            lock_item.locked_amount = Decimal("0")
            lock_item.status = "RELEASED"
            lock_item.updated_at = now
        return Decimal("0")

    lock_item.locked_amount = _q18(locked_amount - capped_amount)
    lock_item.available_amount = _q18(lock_item.available_amount) + capped_amount
    lock_item.updated_at = now
    if _q18(lock_item.locked_amount) <= Decimal("0") or _remaining_releasable_by_total(lock_item) <= Decimal("0"):
        lock_item.locked_amount = Decimal("0")
        lock_item.status = "RELEASED"
    return capped_amount


def calculate_stock_token_releasable_amount(
    lock_item: UserStockTokenLock,
    now: Optional[datetime] = None,
    config: Optional[StockTokenLockConfig] = None,
) -> Decimal:
    now_value = now or datetime.utcnow()
    locked_amount = _q18(lock_item.locked_amount)
    if locked_amount <= Decimal("0"):
        return Decimal("0")

    remaining_by_total = _remaining_releasable_by_total(lock_item)
    if remaining_by_total <= Decimal("0"):
        return Decimal("0")

    if config is None:
        return Decimal("0")

    unlock_at = get_stock_token_unlock_at(lock_item, config)
    if unlock_at is not None and now_value < unlock_at:
        return Decimal("0")

    release_end_at = get_stock_token_release_end_at(lock_item, config)
    if release_end_at and now_value >= release_end_at:
        return min(locked_amount, remaining_by_total)

    if not unlock_at:
        return Decimal("0")

    elapsed_days = int((now_value - unlock_at).total_seconds() // 86400)
    if elapsed_days <= 0:
        return Decimal("0")

    daily_release_rate = _q18(
        getattr(lock_item, "daily_release_rate_snapshot", None) or config.daily_release_rate
    )
    if daily_release_rate <= Decimal("0"):
        return Decimal("0")

    total_amount = _q18(lock_item.total_amount)
    released_amount = _q18(lock_item.available_amount) + _q18(lock_item.converted_amount)
    expected_release_amount = _q18(total_amount * daily_release_rate * Decimal(elapsed_days))
    release_amount = expected_release_amount - released_amount
    if release_amount <= Decimal("0"):
        return Decimal("0")

    return min(_q18(release_amount), locked_amount, remaining_by_total)


def record_stock_token_release_log(
    db: Session,
    *,
    trigger_type: str,
    status: str,
    result: Optional[dict[str, Any]] = None,
    message: str = "",
    error_message: Optional[str] = None,
    run_time: Optional[datetime] = None,
) -> Optional[StockTokenReleaseLog]:
    data = result or {}
    item_ids = data.get("item_ids") or []
    normalized_status = str(status or "SUCCESS").strip().upper()[:30]
    released_count = int(data.get("released_count") or 0)
    if released_count <= 0 and normalized_status not in STOCK_TOKEN_RELEASE_FAILURE_STATUSES and not error_message:
        logger.debug(
            "skip stock token release no-op db log trigger=%s status=%s scanned=%s message=%s",
            trigger_type,
            normalized_status,
            int(data.get("scanned_count") or 0),
            str(message or "")[:120],
        )
        return None

    log = StockTokenReleaseLog(
        run_time=run_time or datetime.utcnow(),
        trigger_type=str(trigger_type or "AUTO").strip().upper()[:20],
        status=normalized_status,
        scanned_count=int(data.get("scanned_count") or 0),
        released_count=released_count,
        total_release_amount=_q18(data.get("total_release_amount") or 0),
        item_ids=json.dumps([int(item) for item in item_ids], ensure_ascii=False),
        message=str(message or "")[:500],
        error_message=error_message,
        created_at=datetime.utcnow(),
    )
    db.add(log)
    db.flush()
    return log


def _get_or_create_spot_balance_for_update(
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
            UserBalance.chain_key == SPOT_CHAIN_KEY,
        )
        .with_for_update()
        .first()
    )
    if balance is not None:
        return balance

    balance = UserBalance(
        user_id=int(user_id),
        coin_symbol=coin_symbol,
        chain_key=SPOT_CHAIN_KEY,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=0,
        created_at=now,
        updated_at=now,
    )
    db.add(balance)
    db.flush()
    return balance


def create_stock_token_lock_from_deposit(
    db: Session,
    user_id: int,
    lock_symbol: str,
    amount: Decimal,
    source_type: str = "OTC_DEPOSIT",
    source_id: Optional[int] = None,
) -> UserStockTokenLock:
    normalized_symbol = _normalize_symbol(lock_symbol)
    if not normalized_symbol:
        raise StockTokenLockError("lock_symbol 不能为空")

    amount_decimal = _normalize_amount(amount)
    source_type_value = str(source_type or "OTC_DEPOSIT").strip().upper() or "OTC_DEPOSIT"

    config = (
        db.query(StockTokenLockConfig)
        .filter(
            StockTokenLockConfig.lock_symbol == normalized_symbol,
            StockTokenLockConfig.is_active == 1,
        )
        .first()
    )
    if config is None:
        raise StockTokenLockError(f"未找到启用的股票锁仓配置：{normalized_symbol}")

    if source_id is not None:
        existing = (
            db.query(UserStockTokenLock)
            .filter(
                UserStockTokenLock.user_id == int(user_id),
                UserStockTokenLock.config_id == int(config.id),
                UserStockTokenLock.source_type == source_type_value,
                UserStockTokenLock.source_id == int(source_id),
            )
            .first()
        )
        if existing is not None:
            return existing

    now = datetime.utcnow()
    lock_days = int(config.lock_days or 0)
    if lock_days <= 0:
        raise StockTokenLockError(f"股票锁仓配置 lock_days 无效：{normalized_symbol}")

    conversion_rate_snapshot = _q18(config.conversion_rate)
    if conversion_rate_snapshot <= Decimal("0"):
        raise StockTokenLockError(f"stock token conversion_rate invalid: {normalized_symbol}")
    daily_release_rate_snapshot = _q18(config.daily_release_rate)
    if daily_release_rate_snapshot <= Decimal("0"):
        raise StockTokenLockError(f"stock token daily_release_rate invalid: {normalized_symbol}")

    unlock_at = now + timedelta(days=lock_days)
    release_days = _rate_release_days(daily_release_rate_snapshot)

    item = UserStockTokenLock(
        user_id=int(user_id),
        config_id=int(config.id),
        lock_symbol=normalized_symbol,
        total_amount=amount_decimal,
        locked_amount=amount_decimal,
        available_amount=Decimal("0"),
        converted_amount=Decimal("0"),
        conversion_rate_snapshot=conversion_rate_snapshot,
        daily_release_rate_snapshot=daily_release_rate_snapshot,
        start_at=now,
        end_at=unlock_at + timedelta(days=release_days),
        status="ACTIVE",
        source_type=source_type_value,
        source_id=int(source_id) if source_id is not None else None,
        created_at=now,
        updated_at=now,
    )
    db.add(item)
    db.flush()
    return item


def release_stock_token_lock(
    db: Session,
    lock_item: UserStockTokenLock,
    now: Optional[datetime] = None,
    config: Optional[StockTokenLockConfig] = None,
) -> Decimal:
    now_value = now or datetime.utcnow()
    locked_amount = _q18(lock_item.locked_amount)
    if locked_amount <= Decimal("0"):
        return Decimal("0")
    if _remaining_releasable_by_total(lock_item) <= Decimal("0"):
        lock_item.locked_amount = Decimal("0")
        lock_item.status = "RELEASED"
        lock_item.updated_at = now_value
        db.flush()
        return Decimal("0")

    if config is None:
        config = db.get(StockTokenLockConfig, int(lock_item.config_id))
    if config is None:
        raise StockTokenLockError(f"股票锁仓配置不存在：{lock_item.config_id}")

    unlock_at = get_stock_token_unlock_at(lock_item, config)
    if unlock_at is not None and now_value < unlock_at:
        return Decimal("0")

    release_end_at = get_stock_token_release_end_at(lock_item, config)
    if release_end_at and now_value >= release_end_at:
        release_amount = locked_amount
    else:
        if not unlock_at:
            return Decimal("0")

        elapsed_days = int((now_value - unlock_at).total_seconds() // 86400)
        if elapsed_days <= 0:
            return Decimal("0")

        daily_release_rate = _q18(
            getattr(lock_item, "daily_release_rate_snapshot", None) or config.daily_release_rate
        )
        if daily_release_rate <= Decimal("0"):
            return Decimal("0")

        total_amount = _q18(lock_item.total_amount)
        released_amount = _q18(lock_item.available_amount) + _q18(lock_item.converted_amount)
        expected_release_amount = _q18(total_amount * daily_release_rate * Decimal(elapsed_days))
        release_amount = expected_release_amount - released_amount
        if release_amount <= Decimal("0"):
            return Decimal("0")
    release_amount = _apply_release_amount(lock_item, release_amount, now_value)
    if release_amount <= Decimal("0"):
        db.flush()
        return Decimal("0")

    db.flush()
    return release_amount


def force_release_stock_token_lock(
    db: Session,
    lock_item_id: int,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    now_value = now or datetime.utcnow()
    lock_item = (
        db.query(UserStockTokenLock)
        .filter(UserStockTokenLock.id == int(lock_item_id))
        .with_for_update()
        .first()
    )
    if lock_item is None:
        raise StockTokenLockError("股票锁仓批次不存在")

    release_amount = _apply_release_amount(lock_item, _q18(lock_item.locked_amount), now_value)
    db.flush()
    return {
        "scanned_count": 1,
        "released_count": 1 if release_amount > Decimal("0") else 0,
        "total_release_amount": release_amount,
        "item_ids": [int(lock_item.id)] if release_amount > Decimal("0") else [],
    }


def release_stock_token_locks(
    db: Session,
    now: Optional[datetime] = None,
    limit: int = 500,
) -> dict[str, Any]:
    now_value = now or datetime.utcnow()
    batch_limit = min(max(int(limit or 500), 1), 5000)
    rows = (
        db.query(UserStockTokenLock, StockTokenLockConfig)
        .join(StockTokenLockConfig, UserStockTokenLock.config_id == StockTokenLockConfig.id)
        .filter(
            UserStockTokenLock.status == "ACTIVE",
            UserStockTokenLock.locked_amount > 0,
        )
        .order_by(UserStockTokenLock.id.asc())
        .limit(batch_limit)
        .all()
    )

    released_count = 0
    total_release_amount = Decimal("0")
    item_ids: list[int] = []

    for lock_item, config in rows:
        release_amount = release_stock_token_lock(db, lock_item, now=now_value, config=config)
        if release_amount <= Decimal("0"):
            continue
        released_count += 1
        total_release_amount = _q18(total_release_amount + release_amount)
        item_ids.append(int(lock_item.id))

    return {
        "scanned_count": len(rows),
        "released_count": released_count,
        "total_release_amount": total_release_amount,
        "item_ids": item_ids,
    }


def convert_released_stock_token(
    db: Session,
    user_id: int,
    lock_item_id: int,
    amount: Decimal,
) -> StockTokenConvertRecord:
    amount_decimal = _normalize_amount(amount)
    now = datetime.utcnow()

    lock_item = (
        db.query(UserStockTokenLock)
        .filter(
            UserStockTokenLock.id == int(lock_item_id),
            UserStockTokenLock.user_id == int(user_id),
        )
        .with_for_update()
        .first()
    )
    if lock_item is None:
        raise StockTokenLockError("锁仓批次不存在或不属于当前用户")

    status = str(lock_item.status or "").strip().upper()
    if status not in {"ACTIVE", "RELEASED"}:
        raise StockTokenLockError("当前锁仓批次状态不允许兑换")

    available_amount = _q18(lock_item.available_amount)
    if amount_decimal > available_amount:
        raise StockTokenLockError("兑换数量不能大于可用锁仓数量")

    config = db.get(StockTokenLockConfig, int(lock_item.config_id))
    if config is None:
        raise StockTokenLockError("股票锁仓配置不存在")

    trade_symbol = _normalize_symbol(config.trade_symbol)
    if not trade_symbol:
        raise StockTokenLockError("股票锁仓配置 trade_symbol 为空")

    conversion_rate = _q18(getattr(lock_item, "conversion_rate_snapshot", None) or config.conversion_rate)
    if conversion_rate <= Decimal("0"):
        raise StockTokenLockError("股票锁仓批次 conversion_rate_snapshot 必须大于 0")

    to_amount = _q18(amount_decimal * conversion_rate)
    if to_amount <= Decimal("0"):
        raise StockTokenLockError("兑换到账数量必须大于 0")

    balance = _get_or_create_spot_balance_for_update(
        db,
        user_id=int(user_id),
        coin_symbol=trade_symbol,
        now=now,
    )

    before_available = _q18(balance.available_amount)
    before_frozen = _q18(balance.frozen_amount)
    after_available = _q18(before_available + to_amount)

    lock_item.available_amount = _q18(available_amount - amount_decimal)
    lock_item.converted_amount = _q18(lock_item.converted_amount) + amount_decimal
    lock_item.updated_at = now

    record = StockTokenConvertRecord(
        user_id=int(user_id),
        config_id=int(config.id),
        from_symbol=_normalize_symbol(lock_item.lock_symbol),
        to_symbol=trade_symbol,
        from_amount=amount_decimal,
        to_amount=to_amount,
        conversion_rate=conversion_rate,
        status="SUCCESS",
        created_at=now,
    )
    db.add(record)
    db.flush()

    balance.available_amount = after_available
    balance.version = int(balance.version or 0) + 1
    balance.updated_at = now

    balance_log = BalanceLog(
        user_id=int(user_id),
        coin_symbol=trade_symbol,
        chain_key=SPOT_CHAIN_KEY,
        change_type="STOCK_TOKEN_CONVERT",
        direction=1,
        change_amount=to_amount,
        before_available=before_available,
        after_available=after_available,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        biz_type=STOCK_TOKEN_CONVERT_BIZ_TYPE,
        biz_id=str(record.id),
        request_id=None,
        remark="股票代币兑换入账",
        created_at=now,
    )
    db.add(balance_log)
    db.flush()
    return record
