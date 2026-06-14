from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.db.models.user import User
from app.db.models.user_withdraw_lock_log import UserWithdrawLockLog


DEFAULT_WITHDRAW_LOCK_REASON = "此账户涉嫌交易风险，请联系平台运营人员"


def withdraw_lock_reason(user: User) -> str:
    reason = str(getattr(user, "withdraw_locked_reason", "") or "").strip()
    return reason or DEFAULT_WITHDRAW_LOCK_REASON


def get_user_withdraw_lock_state(db: Session, user_id: int) -> dict[str, object]:
    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        return {
            "withdraw_locked": False,
            "withdraw_locked_reason": "",
            "withdraw_locked_at": None,
            "withdraw_locked_by": None,
        }
    locked = bool(getattr(user, "withdraw_locked", False))
    return {
        "withdraw_locked": locked,
        "withdraw_locked_reason": withdraw_lock_reason(user) if locked else "",
        "withdraw_locked_at": user.withdraw_locked_at.isoformat() if getattr(user, "withdraw_locked_at", None) else None,
        "withdraw_locked_by": getattr(user, "withdraw_locked_by", None),
    }


def assert_user_withdraw_unlocked(db: Session, user_id: int) -> None:
    user = db.query(User).filter(User.id == int(user_id)).first()
    if user and bool(getattr(user, "withdraw_locked", False)):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "WITHDRAW_LOCKED",
                "message": withdraw_lock_reason(user),
            },
        )


def set_user_withdraw_lock(
    db: Session,
    *,
    user_id: int,
    locked: bool,
    reason: Optional[str] = None,
    admin_user: Optional[str] = None,
    admin_user_id: Optional[int] = None,
    admin_ip: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> User:
    user = db.query(User).filter(User.id == int(user_id)).with_for_update().first()
    if not user:
        raise ValueError("user not found")

    now = datetime.utcnow()
    normalized_reason = (reason or "").strip() or DEFAULT_WITHDRAW_LOCK_REASON
    if locked:
        user.withdraw_locked = True
        user.withdraw_locked_reason = normalized_reason
        user.withdraw_locked_at = now
        user.withdraw_locked_by = admin_user_id
    else:
        user.withdraw_locked = False
        user.withdraw_locked_reason = None
        user.withdraw_locked_at = None
        user.withdraw_locked_by = None

    db.add(
        UserWithdrawLockLog(
            user_id=int(user.id),
            action="LOCK" if locked else "UNLOCK",
            reason=normalized_reason if locked else (reason or "").strip() or None,
            admin_user=admin_user,
            admin_user_id=admin_user_id,
            admin_ip=admin_ip,
            user_agent=(user_agent or "")[:255] or None,
            created_at=now,
        )
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user
