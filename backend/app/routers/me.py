from __future__ import annotations

import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from pydantic import BaseModel, Field, validator
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.security import hash_password, verify_password
from app.deps.auth import get_current_user_id
from app.db.models import User, UserLoginLog, UserProfile, UserSetting
from app.db.session import get_db

router = APIRouter(prefix="/me", tags=["me"])
profile_router = APIRouter(tags=["user-profile"])

PHONE_PATTERN = re.compile(r"^[+\d][+\d\s-]{5,19}$")
BACKEND_DIR = Path(__file__).resolve().parents[2]
AVATAR_UPLOAD_DIR = BACKEND_DIR / "static" / "uploads" / "avatars"
AVATAR_MAX_BYTES = 2 * 1024 * 1024
AVATAR_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


# =========================
# Swagger / Schemas
# =========================
class ApiError(BaseModel):
    code: str = Field(..., example="UNAUTHORIZED")
    message: str = Field(..., example="User not found")


class ApiResponse(BaseModel):
    ok: bool = Field(..., example=True)
    data: Optional[Dict[str, Any]] = Field(default=None)
    error: Optional[ApiError] = Field(default=None)
    trace_id: Optional[str] = Field(default=None, example="c6f0d85f764f40128a6d6ee4442683d7")


def _ensure_profile_and_settings(db: Session, user: User) -> None:
    changed = False

    if user.profile is None:
        db.add(UserProfile(user_id=user.id, kyc_level=0, kyc_status="NONE", updated_at=datetime.utcnow()))
        changed = True

    if user.settings is None:
        db.add(UserSetting(user_id=user.id))
        changed = True

    if changed:
        db.commit()
        db.refresh(user)


def _me_payload(user: User, trace_id: Optional[str]) -> Dict[str, Any]:
    profile = user.profile
    settings = user.settings
    kyc_level = int(getattr(user, "kyc_level", None) or profile.kyc_level or 0)
    kyc_status = getattr(user, "kyc_status", None) or getattr(profile, "kyc_status", None) or "NONE"
    profile_phone = getattr(profile, "phone", None)

    return {
        "ok": True,
        "data": {
            "id": user.id,
            "email": user.email,
            "phone": user.phone or profile_phone,
            "status": int(user.status),
            "withdraw_locked": bool(getattr(user, "withdraw_locked", False)),
            "withdraw_locked_reason": (
                (getattr(user, "withdraw_locked_reason", None) or "此账户涉嫌交易风险，请联系平台运营人员")
                if bool(getattr(user, "withdraw_locked", False))
                else ""
            ),
            "withdraw_locked_at": getattr(user, "withdraw_locked_at", None),
            "withdraw_locked_by": getattr(user, "withdraw_locked_by", None),
            "email_verified_at": user.email_verified_at,
            "phone_verified_at": user.phone_verified_at,
            "last_login_at": user.last_login_at,
            "created_at": user.created_at,
            "updated_at": user.updated_at,
            # ✅ 前端常用：扁平字段（你 DetailInfoCard 直接用）
            "username": profile.username,
            "nickname": profile.nickname,
            "avatar_url": profile.avatar_url,
            "country_code": profile.country_code,
            "invite_code": user.invite_code,
            "kyc_level": kyc_level,
            "kyc_status": kyc_status,
            # ✅ 同时保留结构化字段（以后也能用）
            "profile": {
                "username": profile.username,
                "nickname": profile.nickname,
                "phone": profile_phone,
                "avatar_url": profile.avatar_url,
                "country_code": profile.country_code,
                "invite_code": user.invite_code,
                "kyc_level": kyc_level,
                "kyc_status": kyc_status,
            },
            "settings": {
                "language": settings.language,
                "timezone": settings.timezone,
                "theme": settings.theme,
            },
        },
        "error": None,
        "trace_id": trace_id,
    }


@router.get(
    "",
    summary="获取当前登录用户信息",
    response_model=ApiResponse,
)
def me(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)

    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "User not found"},
        )

    _ensure_profile_and_settings(db, user)
    db.refresh(user)

    return _me_payload(user, trace_id)


# =========================
# Update Me (username / nickname / phone)
# =========================
class MeUpdateIn(BaseModel):
    username: Optional[str] = None
    nickname: Optional[str] = None
    phone: Optional[str] = None  # 你说电话先不开通：前端不展示编辑按钮也行，但接口我先给你留好

    @validator("username")
    def v_username(cls, v: Optional[str]):
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("username is empty")
        if len(v) > 64:
            raise ValueError("username too long")
        return v

    @validator("nickname")
    def v_nickname(cls, v: Optional[str]):
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("nickname is empty")
        if len(v) > 64:
            raise ValueError("nickname too long")
        return v

    @validator("phone")
    def v_phone(cls, v: Optional[str]):
        if v is None:
            return v
        v = v.strip()
        if not v:
            return None
        if len(v) < 6 or len(v) > 20 or not PHONE_PATTERN.match(v):
            raise ValueError("invalid phone")
        return v


class PhoneUpdateIn(BaseModel):
    phone: Optional[str] = Field(default=None, max_length=32)

    @validator("phone")
    def v_phone(cls, v: Optional[str]):
        if v is None:
            return None
        phone = (v or "").strip()
        if not phone:
            return None
        if len(phone) < 6 or len(phone) > 20 or not PHONE_PATTERN.match(phone):
            raise ValueError("invalid phone")
        return phone


class PasswordChangeIn(BaseModel):
    old_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)

    @validator("new_password")
    def v_new_password(cls, v: str):
        password = (v or "").strip()
        if len(password) < 8:
            raise ValueError("new password too short")
        if not any(ch.islower() for ch in password):
            raise ValueError("new password requires lowercase letter")
        if not any(ch.isupper() for ch in password):
            raise ValueError("new password requires uppercase letter")
        if not any(ch.isdigit() for ch in password):
            raise ValueError("new password requires number")
        if not any(not ch.isalnum() for ch in password):
            raise ValueError("new password requires special character")
        return password


@router.patch(
    "",
    summary="更新当前登录用户资料（username/nickname/phone）",
    response_model=ApiResponse,
)
def update_me(
    payload: MeUpdateIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)

    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "User not found"})

    _ensure_profile_and_settings(db, user)
    profile = user.profile

    # username 唯一
    if payload.username is not None:
        exists = (
            db.query(UserProfile)
            .filter(UserProfile.username == payload.username, UserProfile.user_id != user.id)
            .first()
        )
        if exists:
            raise HTTPException(status_code=400, detail={"code": "USERNAME_TAKEN", "message": "Username already exists"})
        profile.username = payload.username

    # nickname
    if payload.nickname is not None:
        profile.nickname = payload.nickname

    # phone 唯一（可选）
    if "phone" in payload.__fields_set__:
        _set_profile_phone(db, user, payload.phone)
        # phone_verified_at 这里不自动写（等你短信验证流程上线后再写）

    profile.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(user)

    return _me_payload(user, trace_id)


@router.patch(
    "/phone",
    summary="更新当前登录用户手机号",
    response_model=ApiResponse,
)
def update_phone(
    payload: PhoneUpdateIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)

    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "User not found"})

    _set_profile_phone(db, user, payload.phone)

    db.commit()
    db.refresh(user)

    return _me_payload(user, trace_id)


@router.patch(
    "/password",
    summary="修改当前登录用户密码",
    response_model=ApiResponse,
)
def change_password(
    payload: PasswordChangeIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)

    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "User not found"})

    if not verify_password(payload.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail={"code": "INVALID_OLD_PASSWORD", "message": "Old password is incorrect"})

    if verify_password(payload.new_password, user.password_hash):
        raise HTTPException(status_code=400, detail={"code": "PASSWORD_UNCHANGED", "message": "New password must be different"})

    now = datetime.utcnow()
    user.password_hash = hash_password(payload.new_password)
    user.password_changed_at = now
    user.updated_at = now

    db.commit()

    return {
        "ok": True,
        "data": {"password_changed_at": now.isoformat()},
        "error": None,
        "trace_id": trace_id,
    }


def _ensure_phone_available(db: Session, user: User, phone: str) -> None:
    exists_user = db.query(User).filter(User.phone == phone, User.id != user.id).first()
    exists_profile = db.query(UserProfile).filter(UserProfile.phone == phone, UserProfile.user_id != user.id).first()
    if exists_user or exists_profile:
        raise HTTPException(status_code=400, detail={"code": "PHONE_TAKEN", "message": "Phone already exists"})


def _set_profile_phone(db: Session, user: User, phone: Optional[str]) -> None:
    _ensure_profile_and_settings(db, user)

    now = datetime.utcnow()
    profile = user.profile
    next_phone = (phone or "").strip() or None

    if next_phone is not None:
        _ensure_phone_available(db, user, next_phone)

    profile.phone = next_phone

    if user.email:
        # users has a DB constraint that allows either email or phone, not both.
        user.phone = None
    elif next_phone is not None:
        user.phone = next_phone
    else:
        # Phone-only accounts keep users.phone as the login identifier.
        user.phone = user.phone

    user.updated_at = now
    profile.updated_at = now


@router.get(
    "/login-logs",
    summary="获取当前登录用户最近登录日志",
    response_model=ApiResponse,
)
def login_logs(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)

    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "User not found"})

    filters = [UserLoginLog.user_id == int(user.id)]
    if user.email:
        filters.append(UserLoginLog.email == user.email)

    rows = (
        db.query(UserLoginLog)
        .filter(or_(*filters))
        .order_by(UserLoginLog.created_at.desc(), UserLoginLog.id.desc())
        .limit(limit)
        .all()
    )

    return {
        "ok": True,
        "data": {
            "items": [
                {
                    "id": int(item.id),
                    "user_id": int(item.user_id) if item.user_id is not None else None,
                    "email": item.email,
                    "ip_address": item.ip_address,
                    "user_agent": item.user_agent,
                    "device_name": item.device_name,
                    "login_status": item.login_status,
                    "failure_reason": item.failure_reason,
                    "created_at": item.created_at.isoformat() if item.created_at else None,
                }
                for item in rows
            ]
        },
        "error": None,
        "trace_id": trace_id,
    }


# =========================
# Upload Avatar
# =========================
@router.post(
    "/avatar",
    summary="上传头像",
    response_model=ApiResponse,
)
def upload_avatar(
    request: Request,
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)

    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "User not found"})

    _ensure_profile_and_settings(db, user)
    profile = user.profile

    # 简单校验
    content_type = (file.content_type or "").split(";")[0].lower()
    ext = AVATAR_CONTENT_TYPES.get(content_type)
    if not ext:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_FILE_TYPE", "message": "仅支持 JPG、PNG 或 WebP 图片"},
        )

    # 保存到本地 uploads（你后面换 OSS/CDN：把 avatar_url 换成 OSS url 就行）
    content = file.file.read(AVATAR_MAX_BYTES + 1)
    if len(content) > AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail={"code": "FILE_TOO_LARGE", "message": "头像图片不能超过 2MB"},
        )
    if not content:
        raise HTTPException(
            status_code=400,
            detail={"code": "EMPTY_FILE", "message": "请选择要上传的头像图片"},
        )

    AVATAR_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    fname = f"user_{int(user.id)}_{timestamp}_{uuid.uuid4().hex[:10]}{ext}"
    path = AVATAR_UPLOAD_DIR / fname

    with open(path, "wb") as f:
        f.write(content)

    # 这里返回一个可访问 URL：按你 Nginx/Static 配置自行调整
    # 比如你把 /uploads 映射到静态：avatar_url = f"/uploads/{fname}"
    profile.avatar_url = f"/static/uploads/avatars/{fname}"
    profile.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(user)

    return _me_payload(user, trace_id)


@profile_router.post(
    "/user/profile/avatar",
    summary="上传个人资料头像",
    response_model=ApiResponse,
)
def upload_profile_avatar(
    request: Request,
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    return upload_avatar(request=request, file=file, user_id=user_id, db=db)
