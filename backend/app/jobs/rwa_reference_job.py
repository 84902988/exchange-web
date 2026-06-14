from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.db.session import SessionLocal
from app.services.rwa_reference_service import refresh_iron62_reference_price


logger = logging.getLogger(__name__)

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None
_run_lock = threading.Lock()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _seconds_until_next_run(now: Optional[datetime] = None) -> float:
    current = now or _utc_now()
    target = current.replace(hour=0, minute=10, second=0, microsecond=0)
    if current >= target:
        target = target + timedelta(days=1)
    return max((target - current).total_seconds(), 1.0)


def process_rwa_reference_job_once() -> dict:
    if not _run_lock.acquire(blocking=False):
        return {"status": "SKIPPED_IN_PROCESS"}

    db = SessionLocal()
    try:
        result = refresh_iron62_reference_price(db)
        db.commit()
        logger.info("[rwa_reference_job] refresh result=%s", result)
        return result
    except Exception as exc:
        db.rollback()
        logger.exception("[rwa_reference_job] refresh failed")
        return {"success": False, "status": "FAILED", "error": repr(exc)}
    finally:
        db.close()
        _run_lock.release()


def start_rwa_reference_job() -> None:
    global _thread, _stop_event

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()

    def _worker() -> None:
        logger.info("[rwa_reference_job] started daily at UTC 00:10")
        while not stop_event.is_set():
            stop_event.wait(_seconds_until_next_run())
            if stop_event.is_set():
                break
            process_rwa_reference_job_once()
        logger.debug("[rwa_reference_job] stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="rwa-reference-job", daemon=True)
    _thread.start()


def stop_rwa_reference_job() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None
