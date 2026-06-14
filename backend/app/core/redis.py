from __future__ import annotations

import time
import redis as redis_lib
from typing import Optional

from app.core.config import settings

_redis: Optional[redis_lib.Redis] = None


def get_redis() -> redis_lib.Redis:
    """
    Get singleton Redis client (sync).
    Used for:
    - auth / jwt refresh jti
    - otp / rate limit
    - short-lived session data
    """
    global _redis
    if _redis is None:
        _redis = redis_lib.Redis(
            host=getattr(settings, "REDIS_HOST", "127.0.0.1"),
            port=int(getattr(settings, "REDIS_PORT", 6379)),
            db=int(getattr(settings, "REDIS_DB", 0)),
            password=getattr(settings, "REDIS_PASSWORD", None) or None,
            decode_responses=False,  # 返回 bytes，避免隐式编码问题
        )
    return _redis


# =====================
# Key helpers
# =====================
def _k(key: str) -> str:
    """
    Add global redis key prefix.
    Example:
        exchange:auth:refresh:jti:xxxx
    """
    prefix = getattr(settings, "REDIS_KEY_PREFIX", "exchange")
    return f"{prefix}:{key}"


# =====================
# Refresh Token (JWT jti) helpers
# =====================
def set_refresh_jti(jti: str, user_id: str | int, exp_ts: int) -> None:
    """
    Store refresh token jti in Redis (white-list).

    key:   exchange:auth:refresh:jti:{jti}
    value: user_id
    ttl:   exp_ts - now
    """
    now = int(time.time())
    ttl = max(exp_ts - now, 1)

    redis = get_redis()
    redis.set(
        _k(f"auth:refresh:jti:{jti}"),
        str(user_id),
        ex=ttl,
    )


def get_refresh_jti_owner(jti: str) -> Optional[str]:
    """
    Return user_id if refresh jti exists, else None.
    """
    redis = get_redis()
    val = redis.get(_k(f"auth:refresh:jti:{jti}"))
    if not val:
        return None
    if isinstance(val, (bytes, bytearray)):
        return val.decode("utf-8")
    return str(val)


def revoke_refresh_jti(jti: str) -> None:
    """
    Revoke refresh token (logout / kick).
    """
    redis = get_redis()
    redis.delete(_k(f"auth:refresh:jti:{jti}"))


# =====================
# Direct instance export (backward compatible)
# =====================
redis = get_redis()
