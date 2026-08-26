from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import time
from typing import Any, Optional


ADMIN_SESSION_VERSION = 1
ADMIN_SESSION_TOKEN_PREFIX = "v1"
ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60
ADMIN_SESSION_FUTURE_IAT_LEEWAY_SECONDS = 60
ADMIN_SESSION_MAX_TOKEN_LENGTH = 4096
ADMIN_SESSION_MIN_SECRET_BYTES = 32

_ADMIN_SESSION_SIGNING_CONTEXT = b"exchange-web/admin-session/v1\x00"
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_PAYLOAD_KEYS = {"v", "admin_id", "username", "iat", "exp"}
_KNOWN_WEAK_SECRETS = {
    b"change-me",
    b"change-me-long-random-string",
    b"changeme",
    b"default",
    b"replace-with-at-least-32-random-bytes",
    b"secret",
    b"your-secret-key",
}


class AdminSessionConfigurationError(RuntimeError):
    pass


def _secret_bytes(secret: Any) -> Optional[bytes]:
    if isinstance(secret, str):
        value = secret.encode("utf-8")
    elif isinstance(secret, bytes):
        value = secret
    else:
        return None
    normalized = value.strip()
    if (
        len(normalized) < ADMIN_SESSION_MIN_SECRET_BYTES
        or normalized.lower() in _KNOWN_WEAK_SECRETS
    ):
        return None
    return normalized


def is_admin_session_secret_strong(secret: Any) -> bool:
    return _secret_bytes(secret) is not None


def _valid_username(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= 255
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )


def _timestamp(value: Optional[int]) -> int:
    if value is None:
        return int(time.time())
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("admin session timestamp must be an integer")
    return value


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    if not value or _B64URL_RE.fullmatch(value) is None:
        raise ValueError("invalid base64url value")
    padding = "=" * (-len(value) % 4)
    return base64.b64decode(value + padding, altchars=b"-_", validate=True)


def _signature(secret: bytes, signing_input: bytes) -> bytes:
    return hmac.new(
        secret,
        _ADMIN_SESSION_SIGNING_CONTEXT + signing_input,
        hashlib.sha256,
    ).digest()


def create_admin_session_token(
    *,
    admin_id: int,
    username: str,
    secret: Any,
    now: Optional[int] = None,
    max_age_seconds: int = ADMIN_SESSION_MAX_AGE_SECONDS,
) -> str:
    secret_value = _secret_bytes(secret)
    if secret_value is None:
        raise AdminSessionConfigurationError("admin session secret must be configured")
    if isinstance(admin_id, bool) or not isinstance(admin_id, int) or admin_id <= 0:
        raise ValueError("admin_id must be a positive integer")
    if not _valid_username(username):
        raise ValueError("username is invalid")
    if (
        isinstance(max_age_seconds, bool)
        or not isinstance(max_age_seconds, int)
        or max_age_seconds <= 0
    ):
        raise ValueError("max_age_seconds must be a positive integer")

    issued_at = _timestamp(now)
    payload = {
        "v": ADMIN_SESSION_VERSION,
        "admin_id": admin_id,
        "username": username,
        "iat": issued_at,
        "exp": issued_at + max_age_seconds,
    }
    payload_bytes = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    encoded_payload = _b64url_encode(payload_bytes)
    signing_input = f"{ADMIN_SESSION_TOKEN_PREFIX}.{encoded_payload}".encode("ascii")
    encoded_signature = _b64url_encode(_signature(secret_value, signing_input))
    return f"{ADMIN_SESSION_TOKEN_PREFIX}.{encoded_payload}.{encoded_signature}"


def verify_admin_session_token(
    token: Any,
    *,
    secret: Any,
    now: Optional[int] = None,
    max_age_seconds: int = ADMIN_SESSION_MAX_AGE_SECONDS,
) -> Optional[dict[str, Any]]:
    secret_value = _secret_bytes(secret)
    if secret_value is None:
        return None
    if not isinstance(token, str) or not token or len(token) > ADMIN_SESSION_MAX_TOKEN_LENGTH:
        return None
    if (
        isinstance(max_age_seconds, bool)
        or not isinstance(max_age_seconds, int)
        or max_age_seconds <= 0
    ):
        return None

    try:
        prefix, encoded_payload, encoded_signature = token.split(".")
        if prefix != ADMIN_SESSION_TOKEN_PREFIX:
            return None
        signing_input = f"{prefix}.{encoded_payload}".encode("ascii")
        supplied_signature = _b64url_decode(encoded_signature)
        if len(supplied_signature) != hashlib.sha256().digest_size:
            return None
        expected_signature = _signature(secret_value, signing_input)
        if not hmac.compare_digest(expected_signature, supplied_signature):
            return None

        payload = json.loads(_b64url_decode(encoded_payload).decode("utf-8"))
        if not isinstance(payload, dict) or set(payload) != _PAYLOAD_KEYS:
            return None

        version = payload.get("v")
        admin_id = payload.get("admin_id")
        username = payload.get("username")
        issued_at = payload.get("iat")
        expires_at = payload.get("exp")
        if (
            isinstance(version, bool)
            or not isinstance(version, int)
            or version != ADMIN_SESSION_VERSION
        ):
            return None
        if isinstance(admin_id, bool) or not isinstance(admin_id, int) or admin_id <= 0:
            return None
        if not _valid_username(username):
            return None
        if (
            isinstance(issued_at, bool)
            or not isinstance(issued_at, int)
            or isinstance(expires_at, bool)
            or not isinstance(expires_at, int)
        ):
            return None
        if issued_at < 0 or expires_at <= issued_at:
            return None
        if expires_at - issued_at > max_age_seconds:
            return None

        current_time = _timestamp(now)
        if issued_at > current_time + ADMIN_SESSION_FUTURE_IAT_LEEWAY_SECONDS:
            return None
        if current_time >= expires_at:
            return None
    except (ValueError, TypeError, UnicodeError, binascii.Error, json.JSONDecodeError):
        return None

    return {
        "id": admin_id,
        "username": username,
        "issued_at": issued_at,
        "expires_at": expires_at,
    }
