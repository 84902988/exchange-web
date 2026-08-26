from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.core.redis import redis
from app.core.request_utils import get_client_ip, get_user_agent
from app.core.security import verify_password
from app.db.models import User, UserOtp, UserSecurityEvent, UserSession
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.tasks.email_tasks import enqueue_send_verify_code_email


router = APIRouter(prefix="/me/email", tags=["account-email"])

OTP_EXPIRE_MINUTES = 10
OTP_ATTEMPT_LIMIT = 5
OTP_COOLDOWN_SECONDS = 60


class ApiError(BaseModel):
    code: str
    message: str


class ApiResponse(BaseModel):
    ok: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[ApiError] = None
    trace_id: Optional[str] = None


class EmailOtpConfirmIn(BaseModel):
    code: str = Field(..., min_length=4, max_length=8)


class EmailChangeSendIn(BaseModel):
    new_email: EmailStr
    current_password: str = Field(..., min_length=1, max_length=128)


class EmailChangeConfirmIn(EmailChangeSendIn):
    code: str = Field(..., min_length=4, max_length=8)


def _success(request: Request, data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ok": True,
        "data": data,
        "error": None,
        "trace_id": getattr(request.state, "trace_id", None),
    }


def _normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def _mask_email(value: str) -> str:
    local, _, domain = _normalize_email(value).partition("@")
    if not local or not domain:
        return "***"
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}***@{domain}"


def _otp_rate_key(user_id: int, purpose: str, email: str) -> str:
    return f"otp:rl:account:{int(user_id)}:{purpose}:{email}"


def _generate_code() -> str:
    return f"{random.randint(0, 999999):06d}"


def _hash_code(code: str) -> str:
    return bcrypt.hashpw(code.encode(), bcrypt.gensalt()).decode()


def _load_user(db: Session, user_id: str, *, for_update: bool = False) -> User:
    query = db.query(User).filter(User.id == int(user_id))
    if for_update:
        query = query.with_for_update()
    user = query.first()
    if not user or int(user.status or 0) != 1:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "User not found"},
        )
    return user


def _ensure_email_available(db: Session, email: str, user_id: int) -> None:
    exists = db.query(User.id).filter(User.email == email, User.id != int(user_id)).first()
    if exists:
        raise HTTPException(
            status_code=400,
            detail={"code": "EMAIL_TAKEN", "message": "Email already exists"},
        )


def _create_email_otp(
    db: Session,
    request: Request,
    *,
    user_id: int,
    email: str,
    purpose: str,
) -> None:
    rate_key = _otp_rate_key(user_id, purpose, email)
    if redis.exists(rate_key):
        raise HTTPException(
            status_code=429,
            detail={"code": "RATE_LIMIT", "message": "Too many requests"},
        )

    code = _generate_code()
    now = datetime.utcnow()
    otp = UserOtp(
        account=email,
        account_type="email",
        channel="email",
        purpose=purpose,
        code_hash=_hash_code(code),
        expires_at=now + timedelta(minutes=OTP_EXPIRE_MINUTES),
        cooldown_until=now + timedelta(seconds=OTP_COOLDOWN_SECONDS),
        attempts=0,
        ip=get_client_ip(request),
        user_agent=get_user_agent(request),
        created_at=now,
    )
    db.add(otp)
    db.commit()

    try:
        enqueue_send_verify_code_email(
            to_email=email,
            code=code,
            scene=purpose,
            expire_minutes=OTP_EXPIRE_MINUTES,
        )
    except Exception:
        db.delete(otp)
        db.commit()
        raise HTTPException(
            status_code=502,
            detail={"code": "EMAIL_SEND_FAILED", "message": "Email send failed"},
        )

    redis.setex(rate_key, OTP_COOLDOWN_SECONDS, "1")


def _consume_email_otp(
    db: Session,
    *,
    email: str,
    purpose: str,
    code: str,
) -> UserOtp:
    now = datetime.utcnow()
    otp = (
        db.query(UserOtp)
        .filter(UserOtp.account == email, UserOtp.purpose == purpose)
        .order_by(UserOtp.id.desc())
        .with_for_update()
        .first()
    )
    if not otp or otp.expires_at <= now:
        raise HTTPException(
            status_code=400,
            detail={"code": "OTP_EXPIRED", "message": "OTP expired"},
        )
    if otp.used_at:
        raise HTTPException(
            status_code=400,
            detail={"code": "OTP_USED", "message": "OTP already used"},
        )
    if int(otp.attempts or 0) >= OTP_ATTEMPT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail={"code": "OTP_LOCKED", "message": "Too many attempts"},
        )
    if not bcrypt.checkpw(code.strip().encode(), otp.code_hash.encode()):
        otp.attempts = int(otp.attempts or 0) + 1
        db.commit()
        raise HTTPException(
            status_code=400,
            detail={"code": "OTP_INVALID", "message": "Invalid OTP"},
        )
    otp.used_at = now
    return otp


def _record_event(
    db: Session,
    request: Request,
    *,
    user_id: int,
    event_type: str,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    db.add(
        UserSecurityEvent(
            user_id=int(user_id),
            event_type=event_type,
            ip=get_client_ip(request),
            user_agent=get_user_agent(request),
            details=details,
            created_at=datetime.utcnow(),
        )
    )


@router.post("/verification/send", response_model=ApiResponse)
def send_current_email_verification(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = _load_user(db, user_id)
    email = _normalize_email(user.email or "")
    if not email:
        raise HTTPException(
            status_code=400,
            detail={"code": "EMAIL_NOT_BOUND", "message": "Email is not bound"},
        )
    if user.email_verified_at is not None:
        raise HTTPException(
            status_code=409,
            detail={"code": "EMAIL_ALREADY_VERIFIED", "message": "Email already verified"},
        )
    _create_email_otp(
        db,
        request,
        user_id=int(user.id),
        email=email,
        purpose="verify_email",
    )
    return _success(request, {"message": "verification code sent", "email": _mask_email(email)})


@router.post("/verification/confirm", response_model=ApiResponse)
def confirm_current_email_verification(
    body: EmailOtpConfirmIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = _load_user(db, user_id, for_update=True)
    email = _normalize_email(user.email or "")
    if not email:
        raise HTTPException(
            status_code=400,
            detail={"code": "EMAIL_NOT_BOUND", "message": "Email is not bound"},
        )
    if user.email_verified_at is not None:
        return _success(
            request,
            {"email": email, "email_verified_at": user.email_verified_at.isoformat()},
        )

    _consume_email_otp(
        db,
        email=email,
        purpose="verify_email",
        code=body.code,
    )
    now = datetime.utcnow()
    user.email_verified_at = now
    user.updated_at = now
    _record_event(
        db,
        request,
        user_id=int(user.id),
        event_type="EMAIL_VERIFIED",
        details={"email": _mask_email(email)},
    )
    db.commit()
    return _success(request, {"email": email, "email_verified_at": now.isoformat()})


@router.post("/change/send", response_model=ApiResponse)
def send_email_change_verification(
    body: EmailChangeSendIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = _load_user(db, user_id)
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_PASSWORD", "message": "Password is incorrect"},
        )
    new_email = _normalize_email(body.new_email)
    if new_email == _normalize_email(user.email or ""):
        raise HTTPException(
            status_code=400,
            detail={"code": "EMAIL_UNCHANGED", "message": "New email must be different"},
        )
    _ensure_email_available(db, new_email, int(user.id))
    _create_email_otp(
        db,
        request,
        user_id=int(user.id),
        email=new_email,
        purpose="change_email",
    )
    return _success(request, {"message": "verification code sent", "email": _mask_email(new_email)})


@router.post("/change/confirm", response_model=ApiResponse)
def confirm_email_change(
    body: EmailChangeConfirmIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = _load_user(db, user_id, for_update=True)
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_PASSWORD", "message": "Password is incorrect"},
        )
    old_email = _normalize_email(user.email or "")
    new_email = _normalize_email(body.new_email)
    if new_email == old_email:
        raise HTTPException(
            status_code=400,
            detail={"code": "EMAIL_UNCHANGED", "message": "New email must be different"},
        )
    _ensure_email_available(db, new_email, int(user.id))
    _consume_email_otp(
        db,
        email=new_email,
        purpose="change_email",
        code=body.code,
    )

    now = datetime.utcnow()
    user.email = new_email
    user.email_verified_at = now
    user.updated_at = now
    (
        db.query(UserSession)
        .filter(UserSession.user_id == int(user.id), UserSession.revoked_at.is_(None))
        .update(
            {UserSession.revoked_at: now, UserSession.last_used_at: now},
            synchronize_session=False,
        )
    )
    _record_event(
        db,
        request,
        user_id=int(user.id),
        event_type="EMAIL_CHANGED",
        details={"old_email": _mask_email(old_email), "new_email": _mask_email(new_email)},
    )
    db.commit()
    return _success(
        request,
        {
            "email": new_email,
            "email_verified_at": now.isoformat(),
            "reauthenticate": True,
        },
    )
