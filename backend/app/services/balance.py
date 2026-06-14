# app/services/balance.py
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import uuid4

from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog, UserBalance

SPOT_BALANCE_CHAIN_KEY = "spot"
FUNDING_BALANCE_CHAIN_KEY = "funding"


def _find_locked_balance(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str,
) -> Optional[UserBalance]:
    return (
        db.query(UserBalance)
        .filter(UserBalance.user_id == user_id)
        .filter(UserBalance.coin_symbol == coin_symbol)
        .filter(UserBalance.chain_key == chain_key)
        .with_for_update()
        .first()
    )


def _get_locked_balance(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str,
    now: datetime,
) -> UserBalance:
    """
    Lock and load a balance row.
    If the row does not exist, create it inside the same transaction.
    user_balances unique key: (user_id, coin_symbol, chain_key)
    """
    bal = _find_locked_balance(
        db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
    )
    if bal:
        return bal

    bal = UserBalance(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=0,
        created_at=now,
        updated_at=now,
    )
    db.add(bal)
    db.flush()
    return bal


def credit_available(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str,
    amount: Decimal,
    biz_type: str,
    biz_id: str,
    change_type: str = "DEPOSIT",
    remark: Optional[str] = None,
    request_id: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    """
    Credit available balance: available += amount.

    Idempotency depends on the unique key in balance_logs:
    (user_id, coin_symbol, chain_key, biz_type, biz_id)
    """
    if amount <= 0:
        raise ValueError("amount must be > 0")

    now = now or datetime.utcnow()

    bal = _get_locked_balance(
        db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        now=now,
    )

    before_avail = bal.available_amount
    before_frozen = bal.frozen_amount
    after_avail = before_avail + amount

    bal.available_amount = after_avail
    bal.version += 1
    bal.updated_at = now

    log = BalanceLog(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        change_type=change_type,
        direction=1,
        change_amount=amount,
        before_available=before_avail,
        after_available=after_avail,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        biz_type=biz_type,
        biz_id=biz_id,
        request_id=request_id,
        remark=remark,
        created_at=now,
    )
    db.add(log)

    # Trigger unique-key validation here so callers get conflicts immediately.
    db.flush()


def transfer_available(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    from_chain_key: str,
    to_chain_key: str,
    amount: Decimal,
    biz_id: Optional[str] = None,
    remark: Optional[str] = None,
    request_id: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    """
    Transfer available balance between two account buckets of the same coin:
    from.available -= amount, to.available += amount
    """
    if amount <= 0:
        raise ValueError("amount must be > 0")

    if from_chain_key == to_chain_key:
        raise ValueError("SAME_ACCOUNT_TRANSFER")

    now = now or datetime.utcnow()
    biz_id = biz_id or uuid4().hex

    balances = {}
    for chain_key in sorted([from_chain_key, to_chain_key]):
        if chain_key == from_chain_key:
            bal = _find_locked_balance(
                db,
                user_id=user_id,
                coin_symbol=coin_symbol,
                chain_key=chain_key,
            )
            if not bal:
                raise ValueError("INSUFFICIENT_AVAILABLE_BALANCE")
        else:
            bal = _get_locked_balance(
                db,
                user_id=user_id,
                coin_symbol=coin_symbol,
                chain_key=chain_key,
                now=now,
            )
        balances[chain_key] = bal

    from_bal = balances[from_chain_key]
    to_bal = balances[to_chain_key]

    from_before_avail = from_bal.available_amount
    from_before_frozen = from_bal.frozen_amount
    if from_before_avail < amount:
        raise ValueError("INSUFFICIENT_AVAILABLE_BALANCE")

    to_before_avail = to_bal.available_amount
    to_before_frozen = to_bal.frozen_amount

    from_after_avail = from_before_avail - amount
    to_after_avail = to_before_avail + amount

    from_bal.available_amount = from_after_avail
    from_bal.version += 1
    from_bal.updated_at = now

    to_bal.available_amount = to_after_avail
    to_bal.version += 1
    to_bal.updated_at = now

    db.add(
        BalanceLog(
            user_id=user_id,
            coin_symbol=coin_symbol,
            chain_key=from_chain_key,
            change_type="TRANSFER_OUT",
            direction=-1,
            change_amount=amount,
            before_available=from_before_avail,
            after_available=from_after_avail,
            before_frozen=from_before_frozen,
            after_frozen=from_before_frozen,
            biz_type="TRANSFER",
            biz_id=biz_id,
            request_id=request_id,
            remark=remark,
            created_at=now,
        )
    )
    db.add(
        BalanceLog(
            user_id=user_id,
            coin_symbol=coin_symbol,
            chain_key=to_chain_key,
            change_type="TRANSFER_IN",
            direction=1,
            change_amount=amount,
            before_available=to_before_avail,
            after_available=to_after_avail,
            before_frozen=to_before_frozen,
            after_frozen=to_before_frozen,
            biz_type="TRANSFER",
            biz_id=biz_id,
            request_id=request_id,
            remark=remark,
            created_at=now,
        )
    )

    db.flush()


def freeze_balance(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str,
    amount: Decimal,
    biz_type: str,
    biz_id: str,
    remark: Optional[str] = None,
    request_id: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    """
    Freeze balance: available -= amount, frozen += amount.
    """
    if amount <= 0:
        raise ValueError("amount must be > 0")

    now = now or datetime.utcnow()

    bal = _get_locked_balance(
        db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        now=now,
    )

    before_avail = bal.available_amount
    before_frozen = bal.frozen_amount
    if before_avail < amount:
        raise ValueError("INSUFFICIENT_AVAILABLE_BALANCE")

    after_avail = before_avail - amount
    after_frozen = before_frozen + amount

    bal.available_amount = after_avail
    bal.frozen_amount = after_frozen
    bal.version += 1
    bal.updated_at = now

    log = BalanceLog(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        change_type="FREEZE",
        direction=-1,
        change_amount=amount,
        before_available=before_avail,
        after_available=after_avail,
        before_frozen=before_frozen,
        after_frozen=after_frozen,
        biz_type=biz_type,
        biz_id=biz_id,
        request_id=request_id,
        remark=remark,
        created_at=now,
    )
    db.add(log)
    db.flush()


def unfreeze_balance(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str,
    amount: Decimal,
    biz_type: str,
    biz_id: str,
    remark: Optional[str] = None,
    request_id: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    """
    Unfreeze balance: frozen -= amount, available += amount.
    """
    if amount <= 0:
        raise ValueError("amount must be > 0")

    now = now or datetime.utcnow()

    bal = _get_locked_balance(
        db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        now=now,
    )

    before_avail = bal.available_amount
    before_frozen = bal.frozen_amount
    if before_frozen < amount:
        raise ValueError("INSUFFICIENT_FROZEN_BALANCE")

    after_frozen = before_frozen - amount
    after_avail = before_avail + amount

    bal.available_amount = after_avail
    bal.frozen_amount = after_frozen
    bal.version += 1
    bal.updated_at = now

    log = BalanceLog(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        change_type="UNFREEZE",
        direction=1,
        change_amount=amount,
        before_available=before_avail,
        after_available=after_avail,
        before_frozen=before_frozen,
        after_frozen=after_frozen,
        biz_type=biz_type,
        biz_id=biz_id,
        request_id=request_id,
        remark=remark,
        created_at=now,
    )
    db.add(log)
    db.flush()
