from __future__ import annotations

import os
import sys
from dataclasses import dataclass


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.core.config import settings  # noqa: E402
from app.core.redis import get_redis  # noqa: E402


@dataclass(frozen=True)
class PatternCheck:
    name: str
    pattern: str


def _prefixed(pattern: str) -> str:
    prefix = getattr(settings, "REDIS_KEY_PREFIX", "exchange")
    return f"{prefix}:{pattern}"


CHECKS = [
    PatternCheck("email failure counter", _prefixed("login_fail:email:*")),
    PatternCheck("IP failure counter", _prefixed("login_fail:ip:*")),
    PatternCheck("email lock", _prefixed("login_lock:email:*")),
    PatternCheck("IP lock", _prefixed("login_lock:ip:*")),
    PatternCheck("captcha", _prefixed("captcha:*")),
]


def _decode_key(key: object) -> str:
    if isinstance(key, (bytes, bytearray)):
        return key.decode("utf-8", errors="replace")
    return str(key)


def main() -> int:
    redis = get_redis()
    failed = False

    print("Login security Redis TTL check")
    print(f"Redis key prefix: {getattr(settings, 'REDIS_KEY_PREFIX', 'exchange')}")
    print("")

    for check in CHECKS:
        keys = list(redis.scan_iter(match=check.pattern, count=200))
        missing_ttl: list[str] = []
        permanent_keys: list[str] = []

        for key in keys:
            ttl = int(redis.ttl(key))
            if ttl == -2:
                missing_ttl.append(_decode_key(key))
            elif ttl == -1:
                permanent_keys.append(_decode_key(key))

        print(f"[{check.name}]")
        print(f"  pattern: {check.pattern}")
        print(f"  keys: {len(keys)}")

        if not keys:
            print("  note: no matching keys currently exist")

        if missing_ttl:
            failed = True
            print(f"  missing during scan: {len(missing_ttl)}")
            for key in missing_ttl[:10]:
                print(f"    - {key}")

        if permanent_keys:
            failed = True
            print(f"  keys without TTL: {len(permanent_keys)}")
            for key in permanent_keys[:10]:
                print(f"    - {key}")

        if keys and not missing_ttl and not permanent_keys:
            print("  ok: every matching key has a TTL")

        print("")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
