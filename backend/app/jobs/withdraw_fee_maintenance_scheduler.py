from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import text

from app.db.session import SessionLocal
from app.jobs.withdraw_fee_maintenance_rq_job import enqueue_withdraw_fee_maintenance_job


DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 600
DEFAULT_SCHEDULER_POLL_SECONDS = 60
logger = logging.getLogger(__name__)

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None
_scheduler_health_lock = threading.Lock()
_scheduler_health: Dict[str, Any] = {
    "last_tick_at": None,
    "last_tick_ok": None,
    "last_tick_error": "",
    "consecutive_failures": 0,
}


def _scheduler_tick_timestamp() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _record_scheduler_tick(result: Dict[str, Any]) -> None:
    ok = bool(result.get("ok"))
    error = str(result.get("error") or "")[:240]
    if not error and not ok:
        for item in result.get("results") or []:
            if item.get("error"):
                error = str(item.get("error"))[:240]
                break
    with _scheduler_health_lock:
        failures = 0 if ok else int(_scheduler_health.get("consecutive_failures") or 0) + 1
        _scheduler_health.update(
            {
                "last_tick_at": _scheduler_tick_timestamp(),
                "last_tick_ok": ok,
                "last_tick_error": error,
                "consecutive_failures": failures,
            }
        )


def get_withdraw_fee_scheduler_heartbeat_payload() -> Dict[str, Any]:
    with _scheduler_health_lock:
        return dict(_scheduler_health)


def _close_scheduler_session(db: Any) -> None:
    if db is None:
        return
    try:
        db.close()
    except Exception:
        # Session cleanup is best-effort. A broken connection must not replace
        # the tick result or terminate the long-running scheduler loop.
        logger.warning("[withdraw_fee_maintenance_scheduler] session close failed", exc_info=True)


def _global_maintenance_interval_seconds() -> int:
    raw = (
        os.getenv("WITHDRAW_FEE_MAINTENANCE_INTERVAL_SECONDS", "").strip()
        or os.getenv("WITHDRAW_FEE_MAINTENANCE_ENQUEUE_INTERVAL_SECONDS", "").strip()
    )
    try:
        value = int(raw) if raw else DEFAULT_MAINTENANCE_INTERVAL_SECONDS
    except ValueError:
        value = DEFAULT_MAINTENANCE_INTERVAL_SECONDS
    return max(300, value)


def _poll_interval_seconds() -> int:
    raw = os.getenv("WITHDRAW_FEE_MAINTENANCE_SCHEDULER_POLL_SECONDS", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_SCHEDULER_POLL_SECONDS
    except ValueError:
        value = DEFAULT_SCHEDULER_POLL_SECONDS
    return max(10, value)


def _chain_interval_seconds(value: Any) -> int:
    try:
        parsed = int(value) if value not in (None, "") else 0
    except (TypeError, ValueError):
        parsed = 0
    if parsed <= 0:
        return _global_maintenance_interval_seconds()
    return max(300, parsed)


def _chain_is_due(last_updated_at: Any, interval_seconds: int, now: datetime) -> bool:
    if last_updated_at is None:
        return True
    if isinstance(last_updated_at, datetime):
        return (now - last_updated_at).total_seconds() >= interval_seconds
    return True


def process_withdraw_fee_maintenance_scheduler_once() -> Dict[str, Any]:
    db = None
    try:
        db = SessionLocal()
        rows = db.execute(
            text(
                """
                SELECT chain_key, withdraw_fee_maintenance_interval_sec, withdraw_fee_last_updated_at
                FROM chains
                WHERE enabled = 1
                  AND COALESCE(withdraw_fee_auto_enabled, 0) = 1
                ORDER BY chain_key ASC, id ASC
                """
            )
        ).mappings().all()
        now = datetime.utcnow()
        results = []
        enqueued_count = 0
        duplicate_count = 0
        not_due_count = 0
        failed_count = 0
        for row in rows:
            chain_key = str(row.get("chain_key") or "").strip().lower()
            if not chain_key:
                continue
            interval = _chain_interval_seconds(row.get("withdraw_fee_maintenance_interval_sec"))
            if not _chain_is_due(row.get("withdraw_fee_last_updated_at"), interval, now):
                not_due_count += 1
                results.append({"chain_key": chain_key, "enqueued": False, "reason": "NOT_DUE", "interval": interval})
                continue
            try:
                result = enqueue_withdraw_fee_maintenance_job(chain_keys=[chain_key], interval_seconds=interval)
                result["chain_key"] = chain_key
                result["interval"] = interval
                if result.get("enqueued"):
                    enqueued_count += 1
                elif result.get("reason") == "DUPLICATE_WINDOW":
                    duplicate_count += 1
                logger.debug("[withdraw_fee_maintenance_scheduler] enqueue detail=%s", result)
                results.append(result)
            except Exception as exc:
                failed_count += 1
                logger.exception("[withdraw_fee_maintenance_scheduler] enqueue failed chain=%s", chain_key)
                results.append({"chain_key": chain_key, "ok": False, "enqueued": False, "error": repr(exc)})
        if enqueued_count:
            logger.info(
                "[withdraw_fee_maintenance_scheduler] enqueue summary scanned=%s enqueued=%s duplicate=%s not_due=%s failed=%s",
                len(rows),
                enqueued_count,
                duplicate_count,
                not_due_count,
                failed_count,
            )
        else:
            logger.debug(
                "[withdraw_fee_maintenance_scheduler] enqueue summary scanned=%s enqueued=0 duplicate=%s not_due=%s failed=%s",
                len(rows),
                duplicate_count,
                not_due_count,
                failed_count,
            )
        result = {
            "ok": failed_count == 0,
            "scanned": len(rows),
            "enqueued_count": enqueued_count,
            "duplicate_count": duplicate_count,
            "not_due_count": not_due_count,
            "failed_count": failed_count,
            "results": results,
        }
        _record_scheduler_tick(result)
        return result
    except Exception as exc:
        logger.exception("[withdraw_fee_maintenance_scheduler] enqueue failed")
        result = {"ok": False, "enqueued": False, "error": repr(exc)}
        _record_scheduler_tick(result)
        return result
    finally:
        _close_scheduler_session(db)


def start_withdraw_fee_maintenance_scheduler() -> None:
    global _thread, _stop_event

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()
    poll_interval = _poll_interval_seconds()

    def _worker() -> None:
        logger.info("[withdraw_fee_maintenance_scheduler] started poll_interval=%ss", poll_interval)
        while not stop_event.is_set():
            process_withdraw_fee_maintenance_scheduler_once()
            stop_event.wait(poll_interval)
        logger.info("[withdraw_fee_maintenance_scheduler] stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="withdraw-fee-maintenance-scheduler", daemon=True)
    _thread.start()


def stop_withdraw_fee_maintenance_scheduler() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None


def run_withdraw_fee_maintenance_scheduler_forever() -> None:
    poll_interval = _poll_interval_seconds()
    stop_event = threading.Event()
    logger.info("[withdraw_fee_maintenance_scheduler] foreground started poll_interval=%ss", poll_interval)
    try:
        while not stop_event.is_set():
            process_withdraw_fee_maintenance_scheduler_once()
            stop_event.wait(poll_interval)
    except KeyboardInterrupt:
        logger.info("[withdraw_fee_maintenance_scheduler] interrupted")
