from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Any, Dict, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.admin_balance_adjust_log import AdminBalanceAdjustLog
from app.db.models.asset import BalanceLog, UserBalance

PLATFORM_ACCOUNT_USER_ID = 99999999
SUPPORTED_DIRECTIONS = {"INCREASE", "DECREASE"}
BALANCE_AMOUNT_SCALE = Decimal("1").scaleb(-18)


class AdminBalanceAdjustError(ValueError):
    pass


def _normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_chain_key(value: Any) -> str:
    chain_key = str(value or "").strip().lower()
    if not chain_key:
        raise AdminBalanceAdjustError("链标识不能为空")
    return chain_key


def _parse_amount(value: Any) -> Decimal:
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        raise AdminBalanceAdjustError("调账数量格式不正确")

    amount = amount.quantize(BALANCE_AMOUNT_SCALE, rounding=ROUND_DOWN)
    if amount <= 0:
        raise AdminBalanceAdjustError("调账数量必须大于 0")
    return amount


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
    balance = _find_locked_balance(
        db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
    )
    if balance:
        return balance

    balance = UserBalance(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=0,
        created_at=now,
        updated_at=now,
    )
    db.add(balance)
    db.flush()
    return balance


def _build_balance_log_remark(
    *,
    admin_user: str,
    reason: str,
    remark: str,
) -> Optional[str]:
    parts = [f"管理员：{admin_user}", f"原因：{reason}"]
    if remark:
        parts.append(f"备注：{remark}")
    text = "；".join(parts)
    return text[:255] if text else None


def _limit_text(value: Any, max_length: int) -> Optional[str]:
    text = str(value or "").strip()
    return text[:max_length] if text else None


def adjust_platform_available_balance(
    db: Session,
    *,
    admin_user: str,
    target_user_id: int,
    coin_symbol: str,
    chain_key: str = "spot",
    direction: str,
    amount: Any,
    reason: str,
    remark: str = "",
    admin_ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    if int(target_user_id) != PLATFORM_ACCOUNT_USER_ID:
        raise AdminBalanceAdjustError("当前仅支持平台账户调账")

    admin_user = str(admin_user or "").strip()
    if not admin_user:
        raise AdminBalanceAdjustError("当前请求缺少管理员身份")

    coin_symbol = _normalize_code(coin_symbol)
    if not coin_symbol:
        raise AdminBalanceAdjustError("币种不能为空")

    chain_key = _normalize_chain_key(chain_key)
    direction = _normalize_code(direction)
    if direction not in SUPPORTED_DIRECTIONS:
        raise AdminBalanceAdjustError("调账方向仅支持 INCREASE 或 DECREASE")

    amount_decimal = _parse_amount(amount)

    reason = str(reason or "").strip()
    if not reason:
        raise AdminBalanceAdjustError("调账原因不能为空")

    remark = str(remark or "").strip()
    admin_ip = _limit_text(admin_ip, 64)
    user_agent = _limit_text(user_agent, 255)
    request_id = _limit_text(request_id, 64) or uuid.uuid4().hex
    now = datetime.utcnow()

    try:
        balance = _get_locked_balance(
            db,
            user_id=PLATFORM_ACCOUNT_USER_ID,
            coin_symbol=coin_symbol,
            chain_key=chain_key,
            now=now,
        )

        before_available = Decimal(str(balance.available_amount or 0))
        before_frozen = Decimal(str(balance.frozen_amount or 0))

        if direction == "INCREASE":
            after_available = before_available + amount_decimal
            balance_direction = 1
        else:
            after_available = before_available - amount_decimal
            balance_direction = -1
            if after_available < 0:
                raise AdminBalanceAdjustError("调减后可用余额不能小于 0")

        balance.available_amount = after_available
        balance.version = int(balance.version or 0) + 1
        balance.updated_at = now

        adjust_log = AdminBalanceAdjustLog(
            admin_user=admin_user,
            target_user_id=PLATFORM_ACCOUNT_USER_ID,
            coin_symbol=coin_symbol,
            chain_key=chain_key,
            direction=direction,
            amount=amount_decimal,
            before_available=before_available,
            after_available=after_available,
            admin_ip=admin_ip,
            user_agent=user_agent,
            request_id=request_id,
            reason=reason,
            remark=remark or None,
            created_at=now,
        )
        db.add(adjust_log)
        db.flush()

        balance_log = BalanceLog(
            user_id=PLATFORM_ACCOUNT_USER_ID,
            coin_symbol=coin_symbol,
            chain_key=chain_key,
            change_type="ADMIN_ADJUST",
            direction=balance_direction,
            change_amount=amount_decimal,
            before_available=before_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=before_frozen,
            biz_type="ADMIN_BALANCE_ADJUST",
            biz_id=str(adjust_log.id),
            remark=_build_balance_log_remark(
                admin_user=admin_user,
                reason=reason,
                remark=remark,
            ),
            created_at=now,
        )
        db.add(balance_log)
        db.flush()
        db.commit()
    except AdminBalanceAdjustError:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise AdminBalanceAdjustError("平台调账保存失败，请稍后重试")
    except Exception:
        db.rollback()
        raise

    db.refresh(balance)
    db.refresh(adjust_log)
    return {
        "log_id": int(adjust_log.id),
        "target_user_id": int(balance.user_id),
        "coin_symbol": balance.coin_symbol,
        "chain_key": balance.chain_key,
        "direction": direction,
        "amount": amount_decimal,
        "before_available": before_available,
        "after_available": after_available,
        "admin_ip": admin_ip,
        "user_agent": user_agent,
        "request_id": request_id,
        "created_at": now,
    }
