from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models.bd_account import BdAccount
from app.db.models.bd_user_relation import BdUserRelation
from app.db.models.user_invite_relation import UserInviteRelation
from app.db.models.user import User
from app.db.models.profile import UserProfile


def normalize_invite_code(value: Any) -> str:
    return str(value or "").strip().upper()


def _find_bd_account_by_invite_code(db: Session, invite_code: str) -> Optional[BdAccount]:
    code = normalize_invite_code(invite_code)
    if not code:
        return None

    account = (
        db.query(BdAccount)
        .filter(func.upper(BdAccount.invite_code) == code)
        .first()
    )
    if account:
        return account

    profile = (
        db.query(UserProfile)
        .filter(func.upper(UserProfile.invite_code) == code)
        .first()
    )
    if not profile:
        user = (
            db.query(User)
            .filter(func.upper(User.invite_code) == code)
            .first()
        )
        if not user:
            return None
        return db.query(BdAccount).filter(BdAccount.user_id == int(user.id)).first()

    return db.query(BdAccount).filter(BdAccount.user_id == int(profile.user_id)).first()


def _raise_invite_not_found() -> None:
    raise HTTPException(
        status_code=400,
        detail={"code": "INVITE_CODE_NOT_FOUND", "message": "邀请链接无效，请联系邀请人重新获取链接"},
    )


def _raise_inviter_unavailable() -> None:
    raise HTTPException(
        status_code=400,
        detail={"code": "INVITER_NOT_ACTIVE_BD", "message": "邀请人当前不可用，请联系邀请人"},
    )


def get_active_bd_invite_account(db: Session, invite_code: Any) -> BdAccount:
    code = normalize_invite_code(invite_code)
    if not code:
        _raise_invite_not_found()

    account = (
        db.query(BdAccount)
        .filter(func.upper(BdAccount.invite_code) == code)
        .first()
    )
    if account is None:
        profile = (
            db.query(UserProfile)
            .filter(func.upper(UserProfile.invite_code) == code)
            .first()
        )
        if profile is None:
            user = (
                db.query(User)
                .filter(func.upper(User.invite_code) == code)
                .first()
            )
            if user is None:
                _raise_invite_not_found()
            account = db.query(BdAccount).filter(BdAccount.user_id == int(user.id)).first()
        else:
            account = db.query(BdAccount).filter(BdAccount.user_id == int(profile.user_id)).first()
        if account is None:
            _raise_inviter_unavailable()

    if str(account.status or "").upper() != "ACTIVE":
        _raise_inviter_unavailable()
    return account


def validate_invite_code_for_register(db: Session, invite_code: Any) -> str:
    account = get_active_bd_invite_account(db, invite_code)
    return normalize_invite_code(account.invite_code)


def bind_user_to_bd_invite(db: Session, user_id: int, invite_code: Any) -> Dict[str, Any]:
    code = normalize_invite_code(invite_code)
    if not code:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITE_CODE_REQUIRED", "message": "请输入邀请码"},
        )

    account = get_active_bd_invite_account(db, code)
    bd_user_id = int(account.user_id)
    current_user_id = int(user_id)

    if bd_user_id == current_user_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITE_SELF_BIND", "message": "不能绑定自己的邀请码"},
        )

    existing = db.query(BdUserRelation).filter(BdUserRelation.user_id == current_user_id).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail={"code": "INVITE_ALREADY_BOUND", "message": "你已绑定邀请关系"},
        )

    existing_user_invite = (
        db.query(UserInviteRelation.id)
        .filter(UserInviteRelation.invitee_user_id == current_user_id)
        .first()
    )
    if existing_user_invite:
        raise HTTPException(
            status_code=409,
            detail={"code": "INVITE_ALREADY_BOUND", "message": "invite relation already bound"},
        )

    now = datetime.utcnow()
    relation = BdUserRelation(
        bd_user_id=bd_user_id,
        user_id=current_user_id,
        invite_code=account.invite_code or code,
        bound_at=now,
        status="ACTIVE",
        created_at=now,
        updated_at=now,
    )
    db.add(relation)
    db.flush()

    return {
        "bound": True,
        "message": "绑定成功",
        "bd_user_id": bd_user_id,
        "user_id": current_user_id,
        "invite_code": relation.invite_code,
    }
