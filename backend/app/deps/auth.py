from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_token  # ✅ 关键：统一走 decode_token（带 audience）
from app.db.models import User
from app.db.session import get_db


ACCOUNT_DISABLED_MESSAGE = "账户已被停用，请联系平台运营人员"


def _get_bearer_token(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization") or ""
    if not auth:
        return None
    parts = auth.split(" ", 1)
    if len(parts) != 2:
        return None
    scheme, token = parts[0].strip().lower(), parts[1].strip()
    if scheme != "bearer" or not token:
        return None
    return token


def _get_cookie_token(request: Request) -> Optional[str]:
    # 兼容你在后端 set_cookie 用的 key（默认 access_token）
    cookie_name = getattr(settings, "ACCESS_TOKEN_COOKIE_NAME", "access_token")
    token = request.cookies.get(cookie_name)
    return token or None


def get_optional_current_user_id(request: Request) -> Optional[int]:
    token = _get_bearer_token(request) or _get_cookie_token(request)
    if not token:
        return None
    try:
        payload = decode_token(token, audience="user")
    except JWTError:
        return None
    if payload.get("type") != "access":
        return None
    sub = payload.get("sub")
    if not sub:
        return None
    try:
        return int(sub)
    except (TypeError, ValueError):
        return None


def get_current_user_id(request: Request, db: Session = Depends(get_db)) -> str:
    """
    ✅ 同时支持两种鉴权来源：
    1) Authorization: Bearer <access_token> （给 APP / Postman）
    2) Cookie: access_token=<access_token> （给 Web，HttpOnly）
    """
    token = _get_bearer_token(request) or _get_cookie_token(request)
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Missing access token"},
        )

    try:
        # ✅ 关键：你的 token payload 里有 aud="user"
        # python-jose 在 token 带 aud 时，decode 必须传 audience，否则会抛 JWTError
        payload = decode_token(token, audience="user")
    except JWTError:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Invalid or expired access token"},
        )

    # （可选但强烈建议）校验 token type，避免 refresh_token 被当 access 用
    if payload.get("type") != "access":
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Invalid token type"},
        )

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Invalid token payload"},
        )

    try:
        user_id = int(sub)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Invalid token payload"},
        )

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "User not found"},
        )
    if int(getattr(user, "status", 1) or 0) != 1:
        raise HTTPException(
            status_code=403,
            detail={"code": "USER_DISABLED", "message": ACCOUNT_DISABLED_MESSAGE},
        )

    return str(sub)
