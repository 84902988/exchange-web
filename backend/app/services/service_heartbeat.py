from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from app.core.rq import get_redis_connection


logger = logging.getLogger(__name__)

SERVICE_HEARTBEAT_PREFIX = "service:heartbeat:"
DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 10
DEFAULT_HEARTBEAT_TTL_SECONDS = 30
DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 30

_process_started_at = datetime.now(timezone.utc)
_warning_last_at: dict[tuple[str, str], float] = {}
_warning_cooldown_seconds = 60


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso_utc(value: Any) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _warn_with_cooldown(event: str, service_name: str, message: str, *args: Any) -> None:
    key = (str(event or ""), str(service_name or ""))
    now = time.monotonic()
    last_at = _warning_last_at.get(key)
    if last_at is None or now - last_at >= _warning_cooldown_seconds:
        _warning_last_at[key] = now
        logger.warning(message, *args)
        return
    logger.debug(message, *args)


def service_heartbeat_key(service_name: str) -> str:
    return f"{SERVICE_HEARTBEAT_PREFIX}{str(service_name or '').strip()}"


def beat_service_heartbeat(
    redis_conn: Any,
    service_name: str,
    interval_sec: int = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    ttl_sec: int = DEFAULT_HEARTBEAT_TTL_SECONDS,
    *,
    started_at: Optional[datetime] = None,
    extra_payload: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    normalized_service = str(service_name or "").strip()
    now = _utc_now()
    last_seen = _iso_utc(now)
    payload = {
        "service": normalized_service,
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "started_at": _iso_utc(started_at or _process_started_at),
        "last_seen": last_seen,
        "last_seen_at": last_seen,
        "interval_sec": int(interval_sec or DEFAULT_HEARTBEAT_INTERVAL_SECONDS),
    }
    if extra_payload:
        payload.update(extra_payload)
    redis_conn.set(
        service_heartbeat_key(normalized_service),
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ex=int(ttl_sec or DEFAULT_HEARTBEAT_TTL_SECONDS),
    )
    return payload


def read_service_heartbeat(redis_conn: Any, service_name: str) -> dict[str, Any]:
    normalized_service = str(service_name or "").strip()
    key = service_heartbeat_key(normalized_service)
    raw = redis_conn.get(key)
    if raw is None:
        return {"service": normalized_service, "key": key, "exists": False, "parse_error": False}
    if isinstance(raw, bytes):
        raw_text = raw.decode("utf-8", errors="replace")
    else:
        raw_text = str(raw)
    try:
        payload = json.loads(raw_text)
    except Exception as exc:
        return {
            "service": normalized_service,
            "key": key,
            "exists": True,
            "parse_error": True,
            "error": str(exc)[:200],
            "raw": raw_text[:240],
        }
    if not isinstance(payload, dict):
        return {
            "service": normalized_service,
            "key": key,
            "exists": True,
            "parse_error": True,
            "error": "heartbeat payload is not an object",
            "raw": raw_text[:240],
        }
    payload = dict(payload)
    payload.setdefault("service", normalized_service)
    payload["key"] = key
    payload["exists"] = True
    payload["parse_error"] = False
    return payload


def heartbeat_age_seconds(payload: dict[str, Any], *, now: Optional[datetime] = None) -> Optional[int]:
    last_seen = _parse_iso_utc(payload.get("last_seen_at") if isinstance(payload, dict) else None)
    if last_seen is None:
        return None
    current = now or _utc_now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return max(0, int((current.astimezone(timezone.utc) - last_seen).total_seconds()))


def is_heartbeat_alive(payload: dict[str, Any], timeout_sec: int = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS) -> bool:
    if not isinstance(payload, dict) or not payload.get("exists") or payload.get("parse_error"):
        return False
    age = heartbeat_age_seconds(payload)
    return age is not None and age <= int(timeout_sec or DEFAULT_HEARTBEAT_TIMEOUT_SECONDS)


def start_heartbeat_thread(
    service_name: str,
    interval_sec: int = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    ttl_sec: int = DEFAULT_HEARTBEAT_TTL_SECONDS,
    *,
    stop_event: Optional[threading.Event] = None,
    extra_payload_factory: Optional[Callable[[], dict[str, Any]]] = None,
) -> threading.Event:
    normalized_service = str(service_name or "").strip()
    heartbeat_stop_event = stop_event or threading.Event()
    started_at = _utc_now()

    def _worker() -> None:
        redis_conn = None
        while not heartbeat_stop_event.is_set():
            try:
                if redis_conn is None:
                    redis_conn = get_redis_connection()
                beat_service_heartbeat(
                    redis_conn,
                    normalized_service,
                    interval_sec=interval_sec,
                    ttl_sec=ttl_sec,
                    started_at=started_at,
                    extra_payload=extra_payload_factory() if extra_payload_factory else None,
                )
            except Exception as exc:
                redis_conn = None
                _warn_with_cooldown(
                    "heartbeat_write_failed",
                    normalized_service,
                    "service heartbeat write failed service=%s reason=%r",
                    normalized_service,
                    exc,
                )
            heartbeat_stop_event.wait(max(1, int(interval_sec or DEFAULT_HEARTBEAT_INTERVAL_SECONDS)))

    thread = threading.Thread(target=_worker, name=f"{normalized_service}-heartbeat", daemon=True)
    thread.start()
    return heartbeat_stop_event
