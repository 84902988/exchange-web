from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog
from app.db.models.contract_margin_log import ContractMarginLog


CONTRACT_BALANCE_CHAIN_KEY = "contract"
CONTRACT_MARGIN_ASSET = "USDT"


def _q18(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _direction(value: Decimal) -> int:
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def _pending_balance_log_exists(db: Session, *, trade_id: int, change_type: str, biz_type: str) -> bool:
    for item in db.new:
        if not isinstance(item, BalanceLog):
            continue
        if (
            getattr(item, "trade_id", None) == trade_id
            and getattr(item, "change_type", None) == change_type
            and getattr(item, "biz_type", None) == biz_type
        ):
            return True
    return False


def _pending_margin_log_exists(db: Session, *, trade_id: int, change_type: str) -> bool:
    for item in db.new:
        if not isinstance(item, ContractMarginLog):
            continue
        if getattr(item, "trade_id", None) == trade_id and getattr(item, "change_type", None) == change_type:
            return True
    return False


def add_contract_balance_log(
    db: Session,
    *,
    user_id: int,
    change_type: str,
    biz_type: str,
    biz_id: str,
    change_amount: Any,
    before_available: Any,
    after_available: Any,
    before_frozen: Any,
    after_frozen: Any,
    trade_id: Optional[int] = None,
    coin_symbol: str = CONTRACT_MARGIN_ASSET,
    request_id: Optional[str] = None,
    remark: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    amount = _q18(change_amount)
    normalized_trade_id = int(trade_id) if trade_id is not None else None
    if normalized_trade_id is not None:
        if _pending_balance_log_exists(
            db,
            trade_id=normalized_trade_id,
            change_type=change_type,
            biz_type=biz_type,
        ):
            return
        with db.no_autoflush:
            exists = (
                db.query(BalanceLog.id)
                .filter(BalanceLog.trade_id == normalized_trade_id)
                .filter(BalanceLog.change_type == change_type)
                .filter(BalanceLog.biz_type == biz_type)
                .first()
            )
        if exists:
            return

    db.add(
        BalanceLog(
            user_id=int(user_id),
            coin_symbol=coin_symbol,
            chain_key=CONTRACT_BALANCE_CHAIN_KEY,
            change_type=change_type,
            direction=_direction(amount),
            change_amount=amount,
            before_available=_q18(before_available),
            after_available=_q18(after_available),
            before_frozen=_q18(before_frozen),
            after_frozen=_q18(after_frozen),
            biz_type=biz_type,
            biz_id=str(biz_id),
            trade_id=normalized_trade_id,
            request_id=request_id,
            remark=remark,
            created_at=now or datetime.utcnow(),
        )
    )


def add_contract_margin_log(
    db: Session,
    *,
    user_id: int,
    account_id: int,
    change_type: str,
    change_amount: Any,
    before_available: Any,
    after_available: Any,
    before_frozen: Any,
    after_frozen: Any,
    position_id: Optional[int] = None,
    order_id: Optional[int] = None,
    trade_id: Optional[int] = None,
    symbol: Optional[str] = None,
    remark: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Optional[ContractMarginLog]:
    normalized_trade_id = int(trade_id) if trade_id is not None else None
    if normalized_trade_id is not None:
        if _pending_margin_log_exists(db, trade_id=normalized_trade_id, change_type=change_type):
            return None
        with db.no_autoflush:
            exists = (
                db.query(ContractMarginLog.id)
                .filter(ContractMarginLog.trade_id == normalized_trade_id)
                .filter(ContractMarginLog.change_type == change_type)
                .first()
            )
        if exists:
            return None

    log = ContractMarginLog(
        user_id=int(user_id),
        account_id=int(account_id),
        position_id=int(position_id) if position_id is not None else None,
        order_id=int(order_id) if order_id is not None else None,
        trade_id=normalized_trade_id,
        symbol=symbol,
        change_type=change_type,
        change_amount=_q18(change_amount),
        before_available=_q18(before_available),
        after_available=_q18(after_available),
        before_frozen=_q18(before_frozen),
        after_frozen=_q18(after_frozen),
        remark=remark,
        created_at=now or datetime.utcnow(),
    )
    db.add(log)
    return log
