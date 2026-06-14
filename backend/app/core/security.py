from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple, Union

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# =====================
# Password
# =====================
def hash_password(raw: str) -> str:
    return pwd_context.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    return pwd_context.verify(raw, hashed)


# =====================
# Time helpers
# =====================
def _now_utc_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def _encode(payload: Dict[str, Any]) -> str:
    return jwt.encode(
        payload,
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )



def decode_token(token: str, audience: Optional[str] = None) -> Dict[str, Any]:
    """
    Decode and verify JWT signature + exp + aud.
    python-jose will fail if token has 'aud' but decode() doesn't receive 'audience'.
    """
    aud = audience or "user"  # ✅ 默认和我们签发时一致
    return jwt.decode(
        token,
        settings.JWT_SECRET,
        algorithms=[settings.JWT_ALGORITHM],
        audience=aud,
    )



# =====================
# JWT (Access / Refresh)
# =====================
def create_access_token(
    user_id: Union[int, str],
    aud: str = "user",
    extra: Optional[Dict[str, Any]] = None,
) -> Tuple[str, int]:
    """
    Create access token.
    Return: (token, expires_in_seconds)
    """
    now = _now_utc_ts()
    access_ttl_seconds = int(getattr(settings, "ACCESS_TOKEN_MAX_AGE", 60 * 15))
    exp_ts = now + access_ttl_seconds

    payload: Dict[str, Any] = {
        "sub": str(user_id),
        "type": "access",
        "aud": aud,
        "iat": now,
        "exp": exp_ts,
    }
    if extra:
        payload.update(extra)

    token = _encode(payload)
    return token, exp_ts - now


def create_refresh_token(
    user_id: Union[int, str],
    aud: str = "user",
    extra: Optional[Dict[str, Any]] = None,
    expires_in_seconds: Optional[int] = None,
) -> Tuple[str, str, int]:
    """
    Create refresh token (JWT).
    Return: (refresh_token, jti, exp_ts)
    """
    jti = uuid.uuid4().hex
    now = _now_utc_ts()
    ttl_seconds = (
        int(expires_in_seconds)
        if expires_in_seconds is not None
        else int(settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS) * 24 * 3600
    )
    exp_ts = now + ttl_seconds

    payload: Dict[str, Any] = {
        "sub": str(user_id),
        "type": "refresh",
        "aud": aud,
        "jti": jti,
        "iat": now,
        "exp": exp_ts,
    }
    if extra:
        payload.update(extra)

    token = _encode(payload)
    return token, jti, exp_ts


def verify_refresh_token(token: str) -> Dict[str, Any]:
    """
    Verify refresh token and return payload.
    """
    payload = decode_token(token)

    if payload.get("type") != "refresh":
        raise JWTError("invalid token type")

    if not payload.get("jti"):
        raise JWTError("missing jti")

    if not payload.get("sub"):
        raise JWTError("missing sub")

    return payload


# =====================
# OTP / Legacy helpers
# （保持兼容你现有代码）
# =====================
def new_refresh_token() -> str:
    """
    Legacy random refresh token (deprecated).
    Kept for backward compatibility.
    """
    return secrets.token_urlsafe(48)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def hash_refresh_token(rt: str) -> str:
    """
    Legacy refresh token hash (deprecated).
    """
    pepper = settings.SECURITY_PEPPER or ""
    return sha256_hex(rt + pepper)


def hash_otp_code(account: str, code: str, purpose: str) -> str:
    pepper = settings.SECURITY_PEPPER or ""
    return sha256_hex(f"{account}|{purpose}|{code}|{pepper}")
