from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from jose import JWTError
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_token
from app.db.models import User, UserInviteCommissionRecord, UserInviteRelation
from app.db.session import get_db
from app.services.referral_source_service import SOURCE_USER_INVITE
from app.services.user_invite_service import (
    get_user_invite_commission_config,
    normalize_invite_code,
    validate_user_invite_code_for_register,
)

router = APIRouter(prefix="/user/invite", tags=["user-invite"])


def _decimal_to_str(value: Optional[Decimal], places: int = 8) -> str:
    amount = value if isinstance(value, Decimal) else Decimal(str(value or "0"))
    quant = Decimal("1").scaleb(-places)
    return format(amount.quantize(quant, rounding=ROUND_HALF_UP), "f")


def _datetime_to_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _optional_user_id_from_request(request: Request, db: Session) -> Optional[int]:
    auth = request.headers.get("Authorization") or ""
    token = None
    if auth:
        parts = auth.split(" ", 1)
        if len(parts) == 2 and parts[0].strip().lower() == "bearer":
            token = parts[1].strip() or None
    if token is None:
        cookie_name = getattr(settings, "ACCESS_TOKEN_COOKIE_NAME", "access_token")
        token = request.cookies.get(cookie_name) or None
    if not token:
        return None

    try:
        payload = decode_token(token, audience="user")
    except JWTError:
        return None
    if payload.get("type") != "access" or not payload.get("sub"):
        return None

    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError):
        return None

    user_exists = (
        db.query(User.id)
        .filter(User.id == user_id, User.status == 1)
        .first()
    )
    return user_id if user_exists else None


def _sum_commission_rcb(db: Session, user_id: int, status: Optional[str] = None) -> Decimal:
    query = db.query(func.coalesce(func.sum(UserInviteCommissionRecord.commission_rcb_amount), Decimal("0"))).filter(
        UserInviteCommissionRecord.inviter_user_id == user_id
    )
    if status:
        query = query.filter(UserInviteCommissionRecord.status == status)
    value = query.scalar()
    return value if isinstance(value, Decimal) else Decimal(str(value or "0"))


def _empty_overview_payload(commission_config: dict[str, str]) -> dict[str, Any]:
    return {
        "invite_code": None,
        "invite_link": None,
        "commission_rate": commission_config["commission_rate"],
        "commission_percent": commission_config["commission_percent"],
        "summary": {
            "invited_count": 0,
            "total_commission_rcb": _decimal_to_str(Decimal("0")),
            "pending_commission_rcb": _decimal_to_str(Decimal("0")),
            "paid_commission_rcb": _decimal_to_str(Decimal("0")),
            "source_type": SOURCE_USER_INVITE,
            "source_label": "普通分享",
            "commission_rate": commission_config["commission_rate"],
            "commission_percent": commission_config["commission_percent"],
        },
        "recent_records": [],
    }


@router.get("/validate")
def validate_user_invite(
    request: Request,
    invite_code: str,
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        inviter = validate_user_invite_code_for_register(db, invite_code)
        code = normalize_invite_code(invite_code)
        inviter_name = inviter.email or f"UID {int(inviter.id)}"
        return {
            "ok": True,
            "data": {
                "type": "user",
                "valid": True,
                "invite_code": code,
                "inviter_name": inviter_name,
                "message": "邀请信息有效",
                **get_user_invite_commission_config(db),
            },
            "error": None,
            "trace_id": trace_id,
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": "INVITE_VALIDATE_FAILED", "message": "邀请信息校验失败，请稍后重试"},
        )


@router.get("/overview")
def get_my_invite_overview(
    request: Request,
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    commission_config = get_user_invite_commission_config(db)
    current_user_id = _optional_user_id_from_request(request, db)
    if current_user_id is None:
        return {
            "ok": True,
            "data": _empty_overview_payload(commission_config),
            "error": None,
            "trace_id": trace_id,
        }

    user = db.query(User).filter(User.id == current_user_id).first()
    if not user:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "User not found"},
        )

    invited_count = (
        db.query(func.count(func.distinct(UserInviteRelation.invitee_user_id)))
        .filter(
            UserInviteRelation.inviter_user_id == current_user_id,
            UserInviteRelation.status == "ACTIVE",
        )
        .scalar()
        or 0
    )

    total_commission_rcb = _sum_commission_rcb(db, current_user_id)
    pending_commission_rcb = _sum_commission_rcb(db, current_user_id, "PENDING")
    paid_commission_rcb = _sum_commission_rcb(db, current_user_id, "PAID")

    recent_rows = (
        db.query(UserInviteCommissionRecord)
        .filter(UserInviteCommissionRecord.inviter_user_id == current_user_id)
        .order_by(UserInviteCommissionRecord.created_at.desc(), UserInviteCommissionRecord.id.desc())
        .limit(10)
        .all()
    )

    return {
        "ok": True,
        "data": {
            "invite_code": user.invite_code,
            "invite_link": None,
            "commission_rate": commission_config["commission_rate"],
            "commission_percent": commission_config["commission_percent"],
            "summary": {
                "invited_count": int(invited_count),
                "total_commission_rcb": _decimal_to_str(total_commission_rcb),
                "pending_commission_rcb": _decimal_to_str(pending_commission_rcb),
                "paid_commission_rcb": _decimal_to_str(paid_commission_rcb),
                "source_type": SOURCE_USER_INVITE,
                "source_label": "普通分享",
                "commission_rate": commission_config["commission_rate"],
                "commission_percent": commission_config["commission_percent"],
            },
            "recent_records": [
                {
                    "id": int(record.id),
                    "invitee_user_id": int(record.invitee_user_id),
                    "fee_coin_symbol": record.fee_coin_symbol,
                    "fee_amount": _decimal_to_str(record.fee_amount),
                    "fee_usdt_value": _decimal_to_str(record.fee_usdt_value),
                    "commission_rate": _decimal_to_str(record.commission_rate, 6),
                    "commission_rcb_amount": _decimal_to_str(record.commission_rcb_amount),
                    "status": record.status,
                    "created_at": _datetime_to_str(record.created_at),
                    "paid_at": _datetime_to_str(record.paid_at),
                }
                for record in recent_rows
            ],
        },
        "error": None,
        "trace_id": trace_id,
    }
