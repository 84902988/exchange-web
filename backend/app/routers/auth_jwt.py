from __future__ import annotations

import base64
import html
import os
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from jose import JWTError
from passlib.exc import UnknownHashError
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.cookie_policy import clear_auth_cookies, set_access_cookie, set_refresh_cookie
from app.core.redis import get_redis, get_refresh_jti_owner, revoke_refresh_jti, set_refresh_jti
from app.core.request_utils import get_user_agent
from app.core.security import (
    create_access_token,
    create_refresh_token,
    hash_refresh_token,
    verify_password,
    verify_refresh_token,
)
from app.db.models import User, UserLoginLog, UserSession
from app.db.session import get_db

router = APIRouter(prefix="/auth", tags=["auth"])
ACCOUNT_DISABLED_MESSAGE = "账户已被停用，请联系平台运营人员"
INVALID_CREDENTIALS_MESSAGE = "账号或密码错误"
INVALID_CREDENTIALS_CAPTCHA_MESSAGE = "账号或密码错误，请输入图形验证码"
CAPTCHA_REQUIRED_MESSAGE = "请完成图形验证"
CAPTCHA_INVALID_MESSAGE = "验证码错误"
LOGIN_LOCKED_MESSAGE = "登录失败次数过多，请稍后再试"

LOGIN_FAIL_TTL_SECONDS = int(getattr(settings, "LOGIN_FAIL_TTL_SECONDS", 15 * 60))
LOGIN_LOCK_SECONDS = int(getattr(settings, "LOGIN_LOCK_SECONDS", 15 * 60))
LOGIN_CAPTCHA_TTL_SECONDS = int(getattr(settings, "LOGIN_CAPTCHA_TTL_SECONDS", 5 * 60))
LOGIN_CAPTCHA_THRESHOLD = int(getattr(settings, "LOGIN_CAPTCHA_THRESHOLD", 3))
LOGIN_CAPTCHA_STAGE_MAX_ATTEMPTS = int(os.getenv("LOGIN_CAPTCHA_STAGE_MAX_ATTEMPTS", "3"))
LOGIN_LOCK_THRESHOLD = LOGIN_CAPTCHA_THRESHOLD + LOGIN_CAPTCHA_STAGE_MAX_ATTEMPTS
REMEMBER_ME_REFRESH_TTL_SECONDS = int(settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS) * 24 * 3600
SESSION_REFRESH_TTL_SECONDS = int(getattr(settings, "JWT_SESSION_REFRESH_TOKEN_EXPIRE_SECONDS", 12 * 60 * 60))


# =========================
# Helpers
# =========================
def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _refresh_ttl_seconds(remember_me: bool) -> int:
    return REMEMBER_ME_REFRESH_TTL_SECONDS if remember_me else SESSION_REFRESH_TTL_SECONDS


def _create_refresh_token_for_session(user_id: int, remember_me: bool):
    return create_refresh_token(
        user_id=user_id,
        extra={"remember_me": remember_me},
        expires_in_seconds=_refresh_ttl_seconds(remember_me),
    )


def get_client_ip(request: Request) -> str:
    """
    Login security uses the original client IP when the API is behind Nginx.
    Required Nginx headers:
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
    """
    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        first_ip = x_forwarded_for.split(",")[0].strip()
        if first_ip:
            return first_ip

    x_real_ip = request.headers.get("x-real-ip")
    if x_real_ip:
        real_ip = x_real_ip.strip()
        if real_ip:
            return real_ip

    if request.client and request.client.host:
        return request.client.host

    return "unknown"


def _redis_key(key: str) -> str:
    prefix = getattr(settings, "REDIS_KEY_PREFIX", "exchange")
    return f"{prefix}:{key}"


def _login_email_failure_key(email_key: str) -> str:
    return _redis_key(f"login_fail:email:{email_key}")


def _login_ip_failure_key(ip: str) -> str:
    return _redis_key(f"login_fail:ip:{ip}")


def _login_email_lock_key(email_key: str) -> str:
    return _redis_key(f"login_lock:email:{email_key}")


def _login_ip_lock_key(ip: str) -> str:
    return _redis_key(f"login_lock:ip:{ip}")


def _captcha_key(captcha_id: str) -> str:
    return _redis_key(f"captcha:{captcha_id}")


def _decode_redis_value(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8")
    return str(value or "")


def _read_failure_count(key: str) -> int:
    value = get_redis().get(key)
    try:
        return int(_decode_redis_value(value) or "0")
    except ValueError:
        return 0


def _get_failure_counts(email_key: str, ip: str) -> tuple[int, int]:
    return (
        _read_failure_count(_login_email_failure_key(email_key)),
        _read_failure_count(_login_ip_failure_key(ip)),
    )


def _record_login_failure(email_key: str, ip: str) -> tuple[int, int]:
    redis = get_redis()
    email_key_name = _login_email_failure_key(email_key)
    ip_key_name = _login_ip_failure_key(ip)
    email_count = int(redis.incr(email_key_name))
    ip_count = int(redis.incr(ip_key_name))
    redis.expire(email_key_name, LOGIN_FAIL_TTL_SECONDS)
    redis.expire(ip_key_name, LOGIN_FAIL_TTL_SECONDS)
    if _counts_locked(email_count, ip_count):
        redis.setex(_login_email_lock_key(email_key), LOGIN_LOCK_SECONDS, "1")
        redis.setex(_login_ip_lock_key(ip), LOGIN_LOCK_SECONDS, "1")
    return email_count, ip_count


def _clear_login_failures(email_key: str, ip: str) -> None:
    get_redis().delete(
        _login_email_failure_key(email_key),
        _login_ip_failure_key(ip),
        _login_email_lock_key(email_key),
        _login_ip_lock_key(ip),
    )


def _counts_locked(email_fail: int, ip_fail: int) -> bool:
    return email_fail >= LOGIN_LOCK_THRESHOLD or ip_fail >= LOGIN_LOCK_THRESHOLD


def _counts_need_captcha(email_fail: int, ip_fail: int) -> bool:
    return email_fail >= LOGIN_CAPTCHA_THRESHOLD or ip_fail >= LOGIN_CAPTCHA_THRESHOLD


def _remaining_attempts_before_lock(email_fail: int, ip_fail: int) -> int:
    return max(0, LOGIN_LOCK_THRESHOLD - max(email_fail, ip_fail))


def _failed_login_detail(code: str, message: str, email_fail: int, ip_fail: int) -> Dict[str, Any]:
    # email_fail/ip_fail must be the fresh values returned by Redis INCR.
    need_captcha = _counts_need_captcha(email_fail, ip_fail)
    response_message = INVALID_CREDENTIALS_CAPTCHA_MESSAGE if code == "INVALID_CREDENTIALS" and need_captcha else message
    return {
        "code": code,
        "message": response_message,
        "need_captcha": need_captcha,
        "locked": False,
        "remaining_attempts": _remaining_attempts_before_lock(email_fail, ip_fail),
        "lock_seconds": LOGIN_LOCK_SECONDS,
    }


def _is_login_locked(email_key: str, ip: str) -> bool:
    redis = get_redis()
    if redis.exists(_login_email_lock_key(email_key)) or redis.exists(_login_ip_lock_key(ip)):
        return True

    email_fail, ip_fail = _get_failure_counts(email_key, ip)
    if _counts_locked(email_fail, ip_fail):
        redis.setex(_login_email_lock_key(email_key), LOGIN_LOCK_SECONDS, "1")
        redis.setex(_login_ip_lock_key(ip), LOGIN_LOCK_SECONDS, "1")
        return True

    return False


def _captcha_required(email_key: str, ip: str) -> bool:
    return _counts_need_captcha(*_get_failure_counts(email_key, ip))


def _raise_failed_login(
    email_key: str,
    ip: str,
    *,
    code: str = "INVALID_CREDENTIALS",
    message: str = INVALID_CREDENTIALS_MESSAGE,
    status_code: int = 401,
) -> None:
    email_fail, ip_fail = _record_login_failure(email_key, ip)
    if _counts_locked(email_fail, ip_fail):
        raise HTTPException(
            status_code=429,
            detail={
                "code": "LOGIN_LOCKED",
                "message": LOGIN_LOCKED_MESSAGE,
                "need_captcha": True,
                "locked": True,
                "remaining_attempts": 0,
                "lock_seconds": LOGIN_LOCK_SECONDS,
            },
        )

    raise HTTPException(
        status_code=status_code,
        detail=_failed_login_detail(code, message, email_fail, ip_fail),
    )


def _raise_captcha_failure(email_key: str, ip: str, *, code: str, message: str) -> None:
    _raise_failed_login(email_key, ip, code=code, message=message, status_code=400)


def _generate_captcha_code(length: int = 5) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _build_captcha_image(code: str) -> str:
    escaped = html.escape(code)
    lines = []
    for _ in range(6):
        x1 = secrets.randbelow(130)
        y1 = 12 + secrets.randbelow(30)
        x2 = secrets.randbelow(130)
        y2 = 12 + secrets.randbelow(30)
        color = secrets.choice(["#8bb8ff", "#f6c76f", "#7dd3fc", "#c084fc"])
        lines.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1.2" opacity="0.65" />')

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44">
<rect width="132" height="44" rx="6" fill="#10141c"/>
{''.join(lines)}
<text x="66" y="29" text-anchor="middle" font-family="Consolas, Menlo, monospace" font-size="24" font-weight="700" fill="#f8fafc" letter-spacing="4">{escaped}</text>
</svg>"""
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def _verify_captcha_or_raise(body: "LoginIn", email_key: str, ip: str) -> None:
    captcha_id = (body.captcha_id or "").strip()
    captcha_code = (body.captcha_code or "").strip().upper()
    if not captcha_id or not captcha_code:
        _raise_captcha_failure(
            email_key,
            ip,
            code="CAPTCHA_REQUIRED",
            message=CAPTCHA_REQUIRED_MESSAGE,
        )

    redis = get_redis()
    key = _captcha_key(captcha_id)
    expected = _decode_redis_value(redis.get(key)).upper()
    redis.delete(key)
    if not expected or not secrets.compare_digest(expected, captcha_code):
        _raise_captcha_failure(
            email_key,
            ip,
            code="CAPTCHA_INVALID",
            message=CAPTCHA_INVALID_MESSAGE,
        )


def _device_name(user_agent: str) -> str:
    ua = user_agent or ""
    if "Edg" in ua:
        browser = "Edge"
    elif "Chrome" in ua:
        browser = "Chrome"
    elif "Firefox" in ua:
        browser = "Firefox"
    elif "Safari" in ua:
        browser = "Safari"
    else:
        browser = "Unknown browser"

    if "Windows" in ua:
        os_name = "Windows"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        os_name = "macOS"
    elif "Android" in ua:
        os_name = "Android"
    elif "iPhone" in ua or "iPad" in ua:
        os_name = "iOS"
    elif "Linux" in ua:
        os_name = "Linux"
    else:
        os_name = "Unknown OS"

    return f"{browser} / {os_name}"


def _add_login_log(
    db: Session,
    *,
    request: Request,
    email: str,
    status: str,
    user_id: Optional[int] = None,
    failure_reason: Optional[str] = None,
) -> None:
    ua = get_user_agent(request) or ""
    db.add(
        UserLoginLog(
            user_id=user_id,
            email=email or None,
            ip_address=get_client_ip(request) or "",
            user_agent=ua[:512],
            device_name=_device_name(ua)[:128],
            login_status=status,
            failure_reason=failure_reason,
            created_at=_utcnow(),
        )
    )


def _commit_failed_login_log(
    db: Session,
    *,
    request: Request,
    email: str,
    failure_reason: str,
) -> None:
    try:
        _add_login_log(
            db,
            request=request,
            email=email,
            status="FAILED",
            failure_reason=failure_reason,
        )
        db.commit()
    except Exception:
        db.rollback()


def _get_refresh_token(request: Request, body_token: Optional[str]) -> Optional[str]:
    """
    ✅ 大交易所 Web 标准：
    - Web：refresh_token 存在 HttpOnly Cookie，前端 JS 拿不到，因此后端必须从 Cookie 读
    - APP/Postman：可以通过 body 传 refresh_token
    """
    cookie_name = getattr(settings, "REFRESH_TOKEN_COOKIE_NAME", "refresh_token")
    return request.cookies.get(cookie_name) or body_token


# =========================
# Swagger / Schemas
# =========================
class ApiError(BaseModel):
    code: str = Field(..., example="INVALID_CREDENTIALS")
    message: str = Field(..., example=INVALID_CREDENTIALS_MESSAGE)


class ApiResponse(BaseModel):
    """
    统一响应结构（前端只需要处理 ok / data / error / trace_id）。
    """
    ok: bool = Field(..., example=True)
    data: Optional[Dict[str, Any]] = Field(default=None)
    error: Optional[ApiError] = Field(default=None)
    trace_id: Optional[str] = Field(default=None, example="c6f0d85f764f40128a6d6ee4442683d7")


class LoginIn(BaseModel):
    account: str = Field(
        ...,
        description="登录账号：当前实现为邮箱（后续可扩展为 phone）",
        example="test@example.com",
    )
    password: str = Field(
        ...,
        description="登录密码",
        example="Abc12345",
        min_length=6,
    )
    captcha_id: Optional[str] = Field(default=None, description="图形验证码 ID")
    captcha_code: Optional[str] = Field(default=None, description="图形验证码")
    remember_me: bool = Field(default=False, description="Keep refresh login after browser restart")


class RefreshIn(BaseModel):
    # ✅ 改为可选：Web（Cookie）不需要 body；APP/Postman 可传
    refresh_token: Optional[str] = Field(
        default=None,
        description="刷新令牌（refresh_token）。Web 优先从 HttpOnly Cookie 读取；APP/Postman 可从 body 传。",
        example="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    )


class LogoutIn(BaseModel):
    # ✅ 改为可选：Web（Cookie）不需要 body；APP/Postman 可传
    refresh_token: Optional[str] = Field(
        default=None,
        description="刷新令牌（refresh_token）。Web 优先从 HttpOnly Cookie 读取；APP/Postman 可从 body 传。",
        example="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    )


# =========================
# Routes
# =========================
@router.get(
    "/captcha",
    summary="获取登录图形验证码",
    response_model=ApiResponse,
)
def captcha(request: Request):
    captcha_id = secrets.token_urlsafe(24)
    code = _generate_captcha_code()
    get_redis().setex(_captcha_key(captcha_id), LOGIN_CAPTCHA_TTL_SECONDS, code)

    return {
        "ok": True,
        "data": {
            "captcha_id": captcha_id,
            "image": _build_captcha_image(code),
            "expires_in": LOGIN_CAPTCHA_TTL_SECONDS,
        },
        "error": None,
        "trace_id": getattr(request.state, "trace_id", None),
    }


@router.post(
    "/login",
    summary="用户登录",
    description=(
        "用于用户登录（当前 account 以 email 为准）。\n\n"
        "成功后返回 access/refresh（兼容 APP/Postman），同时写入 HttpOnly Cookie（Web 门禁用）。\n"
        "refresh_token 会写入 Redis 白名单 + MySQL 会话表（UserSession）。\n"
    ),
    response_model=ApiResponse,
)
def login(request: Request, body: LoginIn, response: Response, db: Session = Depends(get_db)):
    trace_id = getattr(request.state, "trace_id", None)

    email_key = (body.account or "").lower().strip()
    ip = get_client_ip(request)
    if not email_key:
        _commit_failed_login_log(
            db,
            request=request,
            email=email_key,
            failure_reason="Account is required",
        )
        raise HTTPException(
            status_code=400,
            detail={"code": "VALIDATION_ERROR", "message": "Account is required"},
        )

    user = db.query(User).filter(User.email == email_key).first()
    password_ok = False
    if user:
        try:
            password_ok = verify_password(body.password, user.password_hash)
        except UnknownHashError:
            password_ok = False

    if user and password_ok and int(user.status) != 1:
        _commit_failed_login_log(
            db,
            request=request,
            email=email_key,
            failure_reason=ACCOUNT_DISABLED_MESSAGE,
        )
        raise HTTPException(
            status_code=403,
            detail={"code": "USER_DISABLED", "message": ACCOUNT_DISABLED_MESSAGE},
        )

    if _is_login_locked(email_key, ip):
        _commit_failed_login_log(
            db,
            request=request,
            email=email_key,
            failure_reason=LOGIN_LOCKED_MESSAGE,
        )
        raise HTTPException(
            status_code=429,
            detail={
                "code": "LOGIN_LOCKED",
                "message": LOGIN_LOCKED_MESSAGE,
                "need_captcha": True,
                "locked": True,
                "remaining_attempts": 0,
                "lock_seconds": LOGIN_LOCK_SECONDS,
            },
        )

    current_email_fail, current_ip_fail = _get_failure_counts(email_key, ip)
    captcha_required_before_login = _counts_need_captcha(current_email_fail, current_ip_fail)
    if captcha_required_before_login:
        _verify_captcha_or_raise(body, email_key, ip)

    if not user or not password_ok:
        _commit_failed_login_log(
            db,
            request=request,
            email=email_key,
            failure_reason="User not found" if not user else "Password incorrect",
        )
        _raise_failed_login(
            email_key,
            ip,
            code="INVALID_CREDENTIALS",
            message=INVALID_CREDENTIALS_MESSAGE,
            status_code=401,
        )

    # 签发 token
    access_token, access_expires_in = create_access_token(user_id=user.id)
    remember_me = bool(body.remember_me)
    refresh_token, jti, refresh_exp_ts = _create_refresh_token_for_session(user.id, remember_me)

    # ✅ Redis 白名单
    set_refresh_jti(jti=jti, user_id=str(user.id), exp_ts=refresh_exp_ts)

    # ✅ MySQL 会话落库
    ua = get_user_agent(request)
    rt_hash = hash_refresh_token(refresh_token)
    expires_at = datetime.utcfromtimestamp(int(refresh_exp_ts))

    sess = UserSession(
        user_id=int(user.id),
        refresh_token_hash=rt_hash,
        expires_at=expires_at,
        revoked_at=None,
        last_used_at=_utcnow(),
        ip=ip,
        user_agent=ua,
        created_at=_utcnow(),
    )
    db.add(sess)
    _add_login_log(
        db,
        request=request,
        email=email_key,
        status="SUCCESS",
        user_id=int(user.id),
    )

    # 更新 last_login_at（可选）
    user.last_login_at = _utcnow()
    db.commit()
    _clear_login_failures(email_key, ip)

    # ✅ 写入 HttpOnly Cookie（Web 门禁用）
    set_refresh_cookie(response, request, refresh_token, remember_me=remember_me)
    set_access_cookie(response, request, access_token)

    return {
        "ok": True,
        "data": {
            "token_type": "bearer",
            "access_token": access_token,
            "access_expires_in": access_expires_in,
            "refresh_token": refresh_token,  # APP/调试用，Web 实际用 cookie
        },
        "error": None,
        "trace_id": trace_id,
    }


@router.post(
    "/refresh",
    summary="刷新登录态",
    description=(
        "使用 refresh_token 换取新的 access_token（并旋转 refresh_token）。\n\n"
        "✅ Web：优先从 HttpOnly Cookie 读取 refresh_token（前端不传 body）\n"
        "✅ APP/Postman：可在 body 传 refresh_token\n"
    ),
    response_model=ApiResponse,
)
def refresh(request: Request, body: Optional[RefreshIn] = None, response: Response = None, db: Session = Depends(get_db)):
    trace_id = getattr(request.state, "trace_id", None)

    rt = _get_refresh_token(request, body.refresh_token if body else None)
    if not rt:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Missing refresh token"},
        )

    try:
        payload = verify_refresh_token(rt)
    except JWTError:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Invalid or expired refresh token"},
        )

    jti = str(payload.get("jti"))
    sub = str(payload.get("sub"))

    # ✅ 1) Redis 白名单校验
    owner = get_refresh_jti_owner(jti)
    if (not owner) or owner != sub:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Refresh token revoked"},
        )

    # ✅ 2) DB 用户状态校验
    user = db.query(User).filter(User.id == int(sub)).first()
    if not user:
        revoke_refresh_jti(jti)
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "User not found"},
        )
    if int(user.status) != 1:
        revoke_refresh_jti(jti)
        raise HTTPException(
            status_code=403,
            detail={"code": "USER_DISABLED", "message": ACCOUNT_DISABLED_MESSAGE},
        )

    # ✅ 3) 旧会话标记 revoked + last_used（基于 refresh_token_hash）
    old_rt_hash = hash_refresh_token(rt)
    now = _utcnow()

    old_sess = (
        db.query(UserSession)
        .filter(
            UserSession.user_id == int(user.id),
            UserSession.refresh_token_hash == old_rt_hash,
            UserSession.revoked_at.is_(None),
        )
        .first()
    )
    if old_sess:
        old_sess.revoked_at = now
        old_sess.last_used_at = now

    # ✅ 4) 旋转 refresh：撤销旧 jti
    revoke_refresh_jti(jti)

    # ✅ 5) 签发新 token
    remember_me = bool(payload.get("remember_me"))
    access_token, access_expires_in = create_access_token(user_id=user.id)
    new_refresh_token, new_jti, new_refresh_exp_ts = _create_refresh_token_for_session(user.id, remember_me)

    # ✅ Redis 写入新 jti
    set_refresh_jti(jti=new_jti, user_id=str(user.id), exp_ts=new_refresh_exp_ts)

    # ✅ MySQL 写入新 session
    ip = get_client_ip(request)
    ua = get_user_agent(request)

    new_rt_hash = hash_refresh_token(new_refresh_token)
    new_expires_at = datetime.utcfromtimestamp(int(new_refresh_exp_ts))

    new_sess = UserSession(
        user_id=int(user.id),
        refresh_token_hash=new_rt_hash,
        expires_at=new_expires_at,
        revoked_at=None,
        last_used_at=now,
        ip=ip,
        user_agent=ua,
        created_at=now,
    )
    db.add(new_sess)

    db.commit()

    # ✅ 更新 HttpOnly Cookie（Web 门禁用）
    set_refresh_cookie(response, request, new_refresh_token, remember_me=remember_me)
    set_access_cookie(response, request, access_token)

    return {
        "ok": True,
        "data": {
            "token_type": "bearer",
            "access_token": access_token,
            "access_expires_in": access_expires_in,
            "refresh_token": new_refresh_token,  # APP/调试用，Web 实际用 cookie
        },
        "error": None,
        "trace_id": trace_id,
    }


@router.post(
    "/logout",
    summary="退出登录",
    description=(
        "退出登录（幂等）。\n\n"
        "✅ Web：优先从 HttpOnly Cookie 读取 refresh_token（前端不传 body）\n"
        "✅ APP/Postman：可在 body 传 refresh_token\n"
        "后端会撤销 Redis 白名单 jti + 标记 DB session revoked，并清除 Cookie。\n"
    ),
    response_model=ApiResponse,
)
def logout(request: Request, body: Optional[LogoutIn] = None, response: Response = None, db: Session = Depends(get_db)):
    trace_id = getattr(request.state, "trace_id", None)
    now = _utcnow()

    rt = _get_refresh_token(request, body.refresh_token if body else None)

    try:
        if rt:
            payload = verify_refresh_token(rt)
            jti = str(payload.get("jti"))
            sub = str(payload.get("sub"))

            # 撤销 Redis jti
            revoke_refresh_jti(jti)

            # 标记 session revoked
            rt_hash = hash_refresh_token(rt)
            sess = (
                db.query(UserSession)
                .filter(
                    UserSession.user_id == int(sub),
                    UserSession.refresh_token_hash == rt_hash,
                    UserSession.revoked_at.is_(None),
                )
                .first()
            )
            if sess:
                sess.revoked_at = now
                sess.last_used_at = now
                db.commit()
    except Exception:
        # 幂等：无论如何都 ok
        pass

    # ✅ 清 cookie（无论是否异常都清）
    clear_auth_cookies(response, request)

    return {
        "ok": True,
        "data": {"message": "logged out"},
        "error": None,
        "trace_id": trace_id,
    }
