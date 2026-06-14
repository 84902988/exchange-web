from __future__ import annotations

import secrets
import logging
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models.system_config import SystemConfig
from app.db.models.bd_user_relation import BdUserRelation
from app.db.models.user import User
from app.db.models.user_invite_relation import UserInviteRelation


DEFAULT_INVITE_COMMISSION_RATE = Decimal("0.150000")
USER_INVITE_COMMISSION_RATE_CONFIG_KEY = "user_invite_commission_rate"
MAX_USER_INVITE_COMMISSION_RATE = Decimal("1.000000")
logger = logging.getLogger(__name__)


def _decimal_or_none(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _normalize_user_invite_commission_rate(
    value: Any,
    *,
    source: str,
) -> Optional[Decimal]:
    rate = _decimal_or_none(value)
    if rate is None:
        return None
    if rate < Decimal("0") or rate > MAX_USER_INVITE_COMMISSION_RATE:
        logger.warning(
            "ignore abnormal user invite commission rate: source=%s rate=%s max=%s",
            source,
            rate,
            MAX_USER_INVITE_COMMISSION_RATE,
        )
        return None
    return rate.quantize(Decimal("0.000001"))


def _format_rate(value: Decimal) -> str:
    return format(Decimal(str(value or 0)).quantize(Decimal("0.000001")), "f")


def _rate_to_percent_text(value: Decimal) -> str:
    percent = (Decimal(str(value or 0)) * Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return format(percent.normalize(), "f")


def get_configured_user_invite_commission_rate(db: Session) -> Decimal:
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == USER_INVITE_COMMISSION_RATE_CONFIG_KEY)
        .first()
    )
    configured_rate = _normalize_user_invite_commission_rate(
        config.config_value if config is not None else None,
        source=USER_INVITE_COMMISSION_RATE_CONFIG_KEY,
    )
    return configured_rate if configured_rate is not None else DEFAULT_INVITE_COMMISSION_RATE


def get_user_invite_commission_rate(db: Session) -> Decimal:
    return get_configured_user_invite_commission_rate(db)


def get_user_invite_commission_config(db: Session) -> dict[str, str]:
    rate = get_configured_user_invite_commission_rate(db)
    return {
        "commission_rate": _format_rate(rate),
        "commission_percent": _rate_to_percent_text(rate),
    }


def update_user_invite_commission_rate(db: Session, value: Any, *, updated_by_admin_id: Optional[int] = None) -> Decimal:
    raw_rate = _decimal_or_none(value)
    if raw_rate is None:
        raise ValueError("请输入普通用户邀请分成比例")
    if raw_rate > Decimal("1"):
        raw_rate = raw_rate / Decimal("100")
    rate = _normalize_user_invite_commission_rate(raw_rate, source="admin_input")
    if rate is None:
        raise ValueError("普通用户邀请分成比例必须在 0% 到 100% 之间")

    now = datetime.utcnow()
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == USER_INVITE_COMMISSION_RATE_CONFIG_KEY)
        .with_for_update()
        .first()
    )
    description = "普通用户邀请分成比例，0.15 表示 15%"
    if config is None:
        config = SystemConfig(
            config_key=USER_INVITE_COMMISSION_RATE_CONFIG_KEY,
            config_value=_format_rate(rate),
            description=description,
            created_at=now,
            updated_at=now,
        )
    else:
        config.config_value = _format_rate(rate)
        config.description = description
        config.updated_at = now
    db.add(config)
    db.flush()
    return rate


def get_effective_user_invite_commission_rate(
    db: Session,
    relation: Optional[UserInviteRelation] = None,
) -> Decimal:
    config = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == USER_INVITE_COMMISSION_RATE_CONFIG_KEY)
        .first()
    )
    configured_rate = _normalize_user_invite_commission_rate(
        config.config_value if config is not None else None,
        source=USER_INVITE_COMMISSION_RATE_CONFIG_KEY,
    )
    if configured_rate is not None:
        return configured_rate

    relation_rate = _normalize_user_invite_commission_rate(
        getattr(relation, "commission_rate", None),
        source="user_invite_relations.commission_rate",
    )
    return relation_rate if relation_rate is not None else DEFAULT_INVITE_COMMISSION_RATE


def normalize_invite_code(value: Any) -> str:
    return str(value or "").strip().upper()


def ensure_user_invite_code(db: Session, user: User) -> str:
    current_code = normalize_invite_code(user.invite_code)
    if current_code:
        if user.invite_code != current_code:
            user.invite_code = current_code
            db.flush()
        return current_code

    base_code = f"U{int(user.id)}"
    code = base_code
    while db.query(User.id).filter(func.upper(User.invite_code) == code).first():
        code = f"{base_code}{secrets.token_hex(2).upper()}"

    user.invite_code = code
    db.flush()
    return code


def find_inviter_by_code(db: Session, invite_code: Any) -> Optional[User]:
    code = normalize_invite_code(invite_code)
    if not code:
        return None

    return db.query(User).filter(func.upper(User.invite_code) == code).first()


def validate_user_invite_code_for_register(db: Session, invite_code: Any) -> User:
    code = normalize_invite_code(invite_code)
    if not code:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITE_CODE_NOT_FOUND", "message": "邀请链接无效，请联系邀请人重新获取链接"},
        )

    inviter = find_inviter_by_code(db, code)
    if inviter is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITE_CODE_NOT_FOUND", "message": "邀请链接无效，请联系邀请人重新获取链接"},
        )

    if int(inviter.status or 0) != 1:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITER_UNAVAILABLE", "message": "邀请人当前不可用，请联系邀请人"},
        )

    return inviter


def bind_register_invite_relation(db: Session, invitee_user_id: int, invite_code: Any) -> UserInviteRelation:
    code = normalize_invite_code(invite_code)
    if not code:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITE_CODE_NOT_FOUND", "message": "邀请链接无效，请联系邀请人重新获取链接"},
        )

    inviter = find_inviter_by_code(db, code)
    if not inviter:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITE_CODE_NOT_FOUND", "message": "邀请链接无效，请联系邀请人重新获取链接"},
        )

    inviter_user_id = int(inviter.id)
    invitee_id = int(invitee_user_id)
    if inviter_user_id == invitee_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVITE_SELF_BIND", "message": "不能绑定自己的邀请码"},
        )

    existing = (
        db.query(UserInviteRelation)
        .filter(UserInviteRelation.invitee_user_id == invitee_id)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail={"code": "INVITE_ALREADY_BOUND", "message": "你已绑定邀请关系"},
        )
    existing_bd_relation = (
        db.query(BdUserRelation.id)
        .filter(BdUserRelation.user_id == invitee_id)
        .first()
    )
    if existing_bd_relation:
        raise HTTPException(
            status_code=409,
            detail={"code": "INVITE_ALREADY_BOUND", "message": "你已绑定邀请关系"},
        )

    now = datetime.utcnow()
    relation = UserInviteRelation(
        inviter_user_id=inviter_user_id,
        invitee_user_id=invitee_id,
        invite_code=code,
        commission_rate=get_configured_user_invite_commission_rate(db),
        status="ACTIVE",
        created_at=now,
        updated_at=now,
    )
    db.add(relation)
    db.flush()
    return relation
