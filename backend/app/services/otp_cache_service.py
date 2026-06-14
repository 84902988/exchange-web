from __future__ import annotations

from fastapi import HTTPException
from app.core.redis import redis


def _otp_key(scene: str, email: str) -> str:
    return f"otp:code:{scene}:{email}"


def _attempt_key(scene: str, email: str) -> str:
    return f"otp:attempt:{scene}:{email}"


def normalize_email_scene(email: str, scene: str) -> tuple[str, str]:
    email_n = (email or "").lower().strip()
    scene_n = (scene or "register").strip()
    return email_n, scene_n


def consume_otp_or_raise(scene: str, email: str, code: str) -> None:
    """
    校验 OTP：成功即销毁（一次性使用）
    - 错误次数限制：默认 5 次（与 OTP 同寿命窗口）
    """
    code_in = (code or "").strip()

    otp_key = _otp_key(scene, email)
    attempt_key = _attempt_key(scene, email)

    saved = redis.get(otp_key)
    if saved is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "OTP_EXPIRED", "message": "Verification code expired or not found."},
        )

    ttl = redis.ttl(otp_key)
    if ttl is None or ttl < 0:
        ttl = 600  # fallback

    attempts = redis.get(attempt_key)
    attempts_i = int(attempts) if attempts is not None else 0
    if attempts_i >= 5:
        raise HTTPException(
            status_code=429,
            detail={"code": "OTP_TOO_MANY_TRIES", "message": "Too many attempts. Please request a new code."},
        )

    saved_code = saved.decode() if isinstance(saved, (bytes, bytearray)) else str(saved)

    if saved_code != code_in:
        pipe = redis.pipeline()
        pipe.incr(attempt_key)
        pipe.expire(attempt_key, int(ttl))
        pipe.execute()

        raise HTTPException(
            status_code=400,
            detail={"code": "OTP_INVALID", "message": "Invalid verification code."},
        )

    # ✅ 成功：销毁
    redis.delete(otp_key)
    redis.delete(attempt_key)
