from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog


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
    coin_symbol: str = CONTRACT_MARGIN_ASSET,
    request_id: Optional[str] = None,
    remark: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    amount = _q18(change_amount)
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
            request_id=request_id,
            remark=remark,
            created_at=now or datetime.utcnow(),
        )
    )
