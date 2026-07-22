from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, Response  # ✅ +Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.core.cookie_policy import set_access_cookie, set_refresh_cookie
from app.core.redis import redis, set_refresh_jti  # ✅ 新增 set_refresh_jti
from app.core.request_utils import get_client_ip, get_user_agent  # ✅ 新增
from app.core.security import (
    create_access_token,
    create_refresh_token,
    hash_password,
    hash_refresh_token,  # ✅ 新增
)
from app.db.models import User, UserOtp, UserSession  # ✅ 新增 UserSession
from app.db.session import get_db
from app.tasks.email_tasks import enqueue_send_verify_code_email
from app.services.bd_invite_service import bind_user_to_bd_invite, validate_invite_code_for_register
from app.services.user_invite_service import (
    bind_register_invite_relation,
    ensure_user_invite_code,
    normalize_invite_code as normalize_user_invite_code,
    validate_user_invite_code_for_register,
)

logger = logging.getLogger(__name__)

# =========================
# Routers（一个文件，两个 router）
# =========================
otp_router = APIRouter(prefix="/auth/otp", tags=["auth"])
auth_router = APIRouter(prefix="/auth", tags=["auth"])

# =========================
# Swagger / Schemas
# =========================
class ApiError(BaseModel):
    code: str = Field(..., example="OTP_INVALID")
    message: str = Field(..., example="Invalid OTP")


class ApiResponse(BaseModel):
    """
    统一响应结构（前端只需要处理 ok / data / error / trace_id）。
    """
    ok: bool = Field(..., example=True)
    data: Optional[Dict[str, Any]] = Field(default=None)
    error: Optional[ApiError] = Field(default=None)
    trace_id: Optional[str] = Field(default=None, example="c6f0d85f764f40128a6d6ee4442683d7")


class SendOtpIn(BaseModel):
    email: EmailStr = Field(..., example="test@example.com", description="接收验证码的邮箱")
    scene: str = Field("register", description="验证码用途：register | login | reset", example="register")


class VerifyOtpIn(BaseModel):
    email: EmailStr = Field(..., example="test@example.com", description="接收验证码的邮箱")
    scene: str = Field("register", description="验证码用途：register | login | reset", example="register")
    code: str = Field(..., min_length=4, max_length=8, description="验证码（通常为 6 位数字）", example="123456")


class RegisterIn(BaseModel):
    email: EmailStr = Field(..., example="test@example.com", description="注册邮箱")
    otp: str = Field(..., min_length=4, max_length=8, description="邮箱验证码（来自 /auth/otp/send）", example="123456")
    password: str = Field(..., min_length=6, max_length=64, description="登录密码（建议至少 8 位，包含大小写+数字）", example="Abc12345")

    invite_code: Optional[str] = Field(default=None, max_length=64, description="普通用户邀请码")
    invite_type: Optional[str] = Field(default=None, max_length=32, description="邀请来源：bd 或 user")


class ResetPasswordIn(BaseModel):
    email: EmailStr = Field(..., example="test@example.com", description="重置密码邮箱")
    otp: Optional[str] = Field(default=None, min_length=4, max_length=8, description="邮箱验证码")
    code: Optional[str] = Field(default=None, min_length=4, max_length=8, description="兼容字段：邮箱验证码")
    password: Optional[str] = Field(default=None, min_length=8, max_length=64, description="兼容字段：新密码")
    new_password: Optional[str] = Field(default=None, min_length=8, max_length=64, description="新密码")
    confirm_password: Optional[str] = Field(default=None, min_length=8, max_length=64, description="确认新密码")


class LoginIn(BaseModel):
    email: EmailStr = Field(..., example="test@example.com", description="登录邮箱")
    password: str = Field(..., min_length=6, max_length=64, example="Abc12345")


def _is_invite_not_bd(exc: HTTPException) -> bool:
    detail = exc.detail if isinstance(exc.detail, dict) else {}
    code = str(detail.get("code") or "")
    return code in {"INVITE_CODE_NOT_FOUND", "INVITER_NOT_ACTIVE_BD"}


def _normalize_invite_type(value: Optional[str]) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"bd", "bd_invite"}:
        return "bd"
    if normalized in {"user", "user_invite", "normal", "normal_invite"}:
        return "user"
    return ""


def _resolve_register_invite(
    db: Session,
    invite_code: Optional[str],
    invite_type: Optional[str] = None,
) -> Optional[Dict[str, str]]:
    code = normalize_user_invite_code(invite_code)
    if not code:
        return None

    normalized_type = _normalize_invite_type(invite_type)
    if normalized_type == "user":
        inviter = validate_user_invite_code_for_register(db, code)
        return {"type": "user", "invite_code": normalize_user_invite_code(inviter.invite_code or code)}

    if normalized_type == "bd":
        bd_code = validate_invite_code_for_register(db, code)
        return {"type": "bd", "invite_code": bd_code}

    try:
        bd_code = validate_invite_code_for_register(db, code)
        return {"type": "bd", "invite_code": bd_code}
    except HTTPException as exc:
        if not _is_invite_not_bd(exc):
            raise

    inviter = validate_user_invite_code_for_register(db, code)
    return {"type": "user", "invite_code": normalize_user_invite_code(inviter.invite_code or code)}

# =========================
# Helpers
# =========================
def _gen_code() -> str:
    return f"{random.randint(0, 999999):06d}"


def _rate_key(scene: str, email: str) -> str:
    return f"otp:rl:{scene}:{email}"


def _normalize(email: str, scene: str) -> tuple[str, str]:
    return email.lower().strip(), (scene or "register").strip()


def _scene_to_purpose(scene: str) -> str:
    if scene in ("reset", "reset_password"):
        return "reset_password"
    if scene == "login":
        return "login"
    return "register"


def _hash_otp(code: str) -> str:
    return bcrypt.hashpw(code.encode(), bcrypt.gensalt()).decode()


def _verify_otp(code: str, code_hash: str) -> bool:
    return bcrypt.checkpw(code.encode(), code_hash.encode())


def _validate_password_strength(password: str) -> None:
    if len(password) < 8 or len(password) > 64:
        raise HTTPException(400, {"code": "PASSWORD_WEAK", "message": "密码长度必须为 8-64 位"})
    if not any(ch.islower() for ch in password):
        raise HTTPException(400, {"code": "PASSWORD_WEAK", "message": "密码必须包含小写字母"})
    if not any(ch.isupper() for ch in password):
        raise HTTPException(400, {"code": "PASSWORD_WEAK", "message": "密码必须包含大写字母"})
    if not any(ch.isdigit() for ch in password):
        raise HTTPException(400, {"code": "PASSWORD_WEAK", "message": "密码必须包含数字"})
    if not any(not ch.isalnum() for ch in password):
        raise HTTPException(400, {"code": "PASSWORD_WEAK", "message": "密码必须包含特殊字符"})


def _consume_otp_or_raise_db(db: Session, *, account: str, purpose: str, code: str):
    """
    消费 OTP（一次性使用）：
    - 不存在或过期：OTP_EXPIRED
    - 已使用：OTP_USED
    - 错误次数过多：OTP_LOCKED
    - 校验不通过：OTP_INVALID（并累加 attempts）
    """
    now = datetime.utcnow()

    otp = (
        db.query(UserOtp)
        .filter(UserOtp.account == account, UserOtp.purpose == purpose)
        .order_by(UserOtp.id.desc())
        .first()
    )

    if not otp or otp.expires_at <= now:
        raise HTTPException(400, {"code": "OTP_EXPIRED", "message": "OTP expired"})

    if otp.used_at:
        raise HTTPException(400, {"code": "OTP_USED", "message": "OTP already used"})

    if otp.attempts >= 5:
        raise HTTPException(429, {"code": "OTP_LOCKED", "message": "Too many attempts"})

    if not _verify_otp(code, otp.code_hash):
        otp.attempts += 1
        db.commit()
        raise HTTPException(400, {"code": "OTP_INVALID", "message": "Invalid OTP"})

    otp.used_at = now
    db.commit()


# =========================
# OTP Routes
# =========================
@otp_router.post(
    "/send",
    summary="发送邮箱验证码",
    description=(
        "发送 OTP 验证码到邮箱，用于注册/登录/重置密码等场景。\n\n"
        "前端用法：\n"
        "1) 用户输入邮箱后先调用本接口\n"
        "2) 用户收到验证码后，再调用 `/auth/otp/verify`（可选）或直接调用注册接口 `/auth/register`\n\n"
        "频率限制：同一 email + scene 60 秒内最多 1 次。"
    ),
    response_model=ApiResponse,
)
async def send_otp(request: Request, body: SendOtpIn, db: Session = Depends(get_db)):
    email, scene = _normalize(body.email, body.scene)
    purpose = _scene_to_purpose(scene)

    rl_key = _rate_key(scene, email)
    if redis.exists(rl_key):
        raise HTTPException(429, {"code": "RATE_LIMIT", "message": "Too many requests"})

    redis.setex(rl_key, 60, "1")

    code = _gen_code()
    now = datetime.utcnow()

    otp = UserOtp(
        account=email,
        account_type="email",
        channel="email",
        purpose=purpose,
        code_hash=_hash_otp(code),
        expires_at=now + timedelta(minutes=10),
        cooldown_until=now + timedelta(seconds=60),
        attempts=0,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        created_at=now,
    )

    db.add(otp)
    db.commit()

    try:
        enqueue_send_verify_code_email(to_email=email, code=code, scene=scene, expire_minutes=10)
    except Exception:
        db.delete(otp)
        db.commit()
        raise HTTPException(502, {"code": "EMAIL_SEND_FAILED", "message": "Email send failed"})

    return {"ok": True, "data": {"message": "otp sent"}, "error": None, "trace_id": getattr(request.state, "trace_id", None)}


@otp_router.post(
    "/verify",
    summary="验证邮箱验证码",
    description=(
        "验证 OTP 是否正确（可选步骤）。\n\n"
        "说明：注册接口 `/auth/register` 内部也会消费并校验 OTP，\n"
        "因此前端可以：\n"
        "- 方案A：先 verify 再 register（交互更明确）\n"
        "- 方案B：直接 register（更省一次请求）"
    ),
    response_model=ApiResponse,
)
async def verify_otp(request: Request, body: VerifyOtpIn, db: Session = Depends(get_db)):
    email, scene = _normalize(body.email, body.scene)
    _consume_otp_or_raise_db(db, account=email, purpose=_scene_to_purpose(scene), code=body.code)
    return {"ok": True, "data": {"message": "otp verified"}, "error": None, "trace_id": getattr(request.state, "trace_id", None)}


# =========================
# Auth Routes
# =========================
@auth_router.post(
    "/register",
    summary="用户注册（注册即登录）",
    description=(
        "用户注册账号并返回登录态 token（注册成功后即视为已登录）。\n\n"
        "前端流程建议：\n"
        "1) `/auth/otp/send` 发送验证码\n"
        "2) 用户输入验证码后调用本接口\n"
        "3) 保存返回的 access_token / refresh_token\n"
        "4) 可调用 `/me` 获取用户信息并进入登录态\n\n"
        "注意：OTP 为一次性使用；同一个 OTP 不可重复注册。\n\n"
        "已对齐 login 会话体系：refresh_token 会写入 Redis 白名单 + 落库 UserSession。\n"
        "✅ Step 1（最小改动）：同时把 refresh_token/access_token 写入 HttpOnly Cookie（Web 门禁用）。"
    ),
    response_model=ApiResponse,
)
async def register(request: Request, body: RegisterIn, response: Response, db: Session = Depends(get_db)):  # ✅ +response
    trace_id = getattr(request.state, "trace_id", None)
    email = body.email.lower().strip()
    logger.info("auth_register_attempt trace_id=%s", trace_id)
    invite_info = None
    if body.invite_code is not None:
        invite_info = _resolve_register_invite(db, body.invite_code, body.invite_type)

    # 1) 校验并消费 OTP（一次性使用）
    _consume_otp_or_raise_db(db, account=email, purpose="register", code=body.otp)

    # 2) 唯一性校验
    exists = db.query(User).filter(User.email == email).first()
    if exists:
        raise HTTPException(
            status_code=400,
            detail={"code": "ACCOUNT_EXISTS", "message": "Account already exists."},
        )

    # 3) 创建用户
    user = User(email=email, password_hash=hash_password(body.password), status=1)
    db.add(user)
    db.flush()
    db.refresh(user)

    ensure_user_invite_code(db, user)
    if invite_info is not None:
        if invite_info["type"] == "bd":
            bind_user_to_bd_invite(db, int(user.id), invite_info["invite_code"])
        else:
            relation = bind_register_invite_relation(db, int(user.id), invite_info["invite_code"])
            if relation is None:
                db.rollback()
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "USER_INVITE_BIND_FAILED",
                        "message": "普通邀请关系绑定失败，请联系邀请人重新获取链接",
                    },
                )
    db.commit()
    db.refresh(user)

    # 4) 注册即登录：签发 JWT（字段名与 login 对齐）
    access_token, access_expires_in = create_access_token(user.id)
    refresh_token, refresh_jti, refresh_exp_ts = create_refresh_token(user.id)

    # ✅ Redis 白名单（refresh 才能通过）
    set_refresh_jti(jti=refresh_jti, user_id=str(user.id), exp_ts=refresh_exp_ts)

    # ✅ MySQL 会话落库（与 login 对齐）
    ip = get_client_ip(request)
    ua = get_user_agent(request)

    rt_hash = hash_refresh_token(refresh_token)
    expires_at = datetime.utcfromtimestamp(int(refresh_exp_ts))
    now = datetime.utcnow()

    sess = UserSession(
        user_id=int(user.id),
        refresh_token_hash=rt_hash,
        expires_at=expires_at,
        revoked_at=None,
        last_used_at=now,
        ip=ip,
        user_agent=ua,
        created_at=now,
    )
    db.add(sess)
    db.commit()


    set_refresh_cookie(response, request, refresh_token)
    set_access_cookie(response, request, access_token)

    return {
        "ok": True,
        "data": {
            "token_type": "bearer",
            "access_token": access_token,
            "access_expires_in": access_expires_in,
            "refresh_token": refresh_token,
            # 可选：前端一般不用，但你做 refresh 黑名单/白名单时有用
            "refresh_jti": refresh_jti,
            "refresh_exp_ts": refresh_exp_ts,
            "user": {"id": user.id, "email": user.email, "status": user.status, "invite_code": user.invite_code},
        },
        "error": None,
        "trace_id": trace_id,
    }


@auth_router.post(
    "/reset-password",
    summary="重置登录密码",
    description=(
        "使用邮箱验证码重置用户登录密码。\n\n"
        "流程：\n"
        "1) 调用 `/auth/otp/send`，scene 使用 `reset` 或 `reset_password`\n"
        "2) 用户输入验证码和新密码后调用本接口\n"
        "3) 验证码校验成功后更新 password_hash"
    ),
    response_model=ApiResponse,
)
async def reset_password(request: Request, body: ResetPasswordIn, db: Session = Depends(get_db)):
    trace_id = getattr(request.state, "trace_id", None)
    email = body.email.lower().strip()
    code = str(body.otp or body.code or "").strip()
    password = str(body.new_password or body.password or "").strip()
    confirm_password = str(body.confirm_password or "").strip()

    if not code:
        raise HTTPException(400, {"code": "OTP_REQUIRED", "message": "请输入验证码"})
    if not password:
        raise HTTPException(400, {"code": "PASSWORD_REQUIRED", "message": "请输入新密码"})
    if confirm_password and confirm_password != password:
        raise HTTPException(400, {"code": "PASSWORD_MISMATCH", "message": "两次输入的密码不一致"})

    _validate_password_strength(password)

    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(404, {"code": "ACCOUNT_NOT_FOUND", "message": "账号不存在"})
    if int(user.status or 0) != 1:
        raise HTTPException(403, {"code": "USER_DISABLED", "message": "账户已被停用，请联系平台运营人员"})

    _consume_otp_or_raise_db(db, account=email, purpose="reset_password", code=code)

    user.password_hash = hash_password(password)
    db.add(user)
    db.commit()

    return {
        "ok": True,
        "data": {"message": "密码重置成功，请使用新密码登录"},
        "error": None,
        "trace_id": trace_id,
    }
