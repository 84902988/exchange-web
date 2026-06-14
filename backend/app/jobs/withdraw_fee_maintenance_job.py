from __future__ import annotations

import logging
import os
import threading
import time
from typing import Iterable, Optional

from app.db.session import SessionLocal
from app.services.withdraw_fee_service import maintain_withdraw_fee_once


logger = logging.getLogger(__name__)

DEFAULT_JOB_INTERVAL_SECONDS = 600

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None
_run_lock = threading.Lock()


def _interval_seconds() -> int:
    raw = os.getenv("WITHDRAW_FEE_MAINTENANCE_INTERVAL_SECONDS", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_JOB_INTERVAL_SECONDS
    except ValueError:
        value = DEFAULT_JOB_INTERVAL_SECONDS
    return max(60, value)


def _log_result_details(result: dict, *, duration_ms: int) -> None:
    logger.debug("[withdraw_fee_maintenance_job] result_detail=%s", result)
    for item in result.get("details") or []:
        if item.get("error"):
            logger.warning(
                "[withdraw_fee_maintenance_job] chain=%s failed error=%s",
                item.get("chain_key"),
                item.get("error"),
            )
            continue
        logger.info(
            "[withdraw_fee_maintenance_job] chain=%s estimated_cost=%s applied_fee=%s duration_ms=%s",
            item.get("chain_key"),
            item.get("estimated_cost") or item.get("real_cost"),
            item.get("applied_fee") or item.get("current_fee"),
            duration_ms,
        )


def process_withdraw_fee_maintenance_job_once(chain_keys: Optional[Iterable[str]] = None) -> dict:
    if not _run_lock.acquire(blocking=False):
        return {"status": "SKIPPED_IN_PROCESS"}

    db = SessionLocal()
    started_at = time.perf_counter()
    try:
        result = maintain_withdraw_fee_once(db, chain_keys=chain_keys)
        db.commit()
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        _log_result_details(result, duration_ms=duration_ms)
        return {"status": "OK", **result}
    except Exception as exc:
        db.rollback()
        logger.exception("[withdraw_fee_maintenance_job] failed")
        return {"status": "FAILED", "error": repr(exc)}
    finally:
        db.close()
        _run_lock.release()


def start_withdraw_fee_maintenance_job() -> None:
    global _thread, _stop_event

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()
    interval = _interval_seconds()

    def _worker() -> None:
        logger.info("[withdraw_fee_maintenance_job] started interval=%ss", interval)
        while not stop_event.is_set():
            process_withdraw_fee_maintenance_job_once()
            stop_event.wait(interval)
        logger.debug("[withdraw_fee_maintenance_job] stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="withdraw-fee-maintenance-job", daemon=True)
    _thread.start()


def stop_withdraw_fee_maintenance_job() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None


def is_withdraw_fee_maintenance_job_enabled() -> bool:
    raw = os.getenv("ENABLE_WITHDRAW_FEE_MAINTENANCE_JOB")
    if raw is None:
        return True
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}
