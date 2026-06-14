from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Optional

from app.db.session import SessionLocal
from app.services.stock_dealer_trade_service import run_stock_dealer_trade_once

logger = logging.getLogger(__name__)

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None
_run_lock = threading.Lock()


def _utc_now() -> datetime:
    return datetime.utcnow()


def _log(message: str) -> None:
    logger.info("[stock_dealer_trade_job] %s", message)


def _interval_seconds() -> int:
    try:
        value = int(os.getenv("STOCK_DEALER_TRADE_INTERVAL_SECONDS", "3"))
    except Exception:
        value = 3
    return min(max(value, 2), 30)


def process_stock_dealer_trade_job_once() -> dict:
    if not _run_lock.acquire(blocking=False):
        return {
            "status": "SKIPPED_IN_PROCESS",
            "scanned_count": 0,
            "created_count": 0,
            "skipped_count": 0,
            "failed_count": 0,
            "orders": [],
            "errors": [],
        }

    db = SessionLocal()
    try:
        result = run_stock_dealer_trade_once(db, allow_skip=True)
        return {"status": "SUCCESS", **result}
    except Exception as exc:
        db.rollback()
        logger.warning("stock dealer trade job failed: %r", exc)
        return {
            "status": "FAILED",
            "scanned_count": 0,
            "created_count": 0,
            "skipped_count": 0,
            "failed_count": 1,
            "orders": [],
            "errors": [{"error": repr(exc)}],
        }
    finally:
        db.close()
        _run_lock.release()


def start_stock_dealer_trade_job() -> None:
    global _thread, _stop_event

    if os.getenv("ENABLE_STOCK_DEALER_TRADE_JOB", "0") != "1":
        _log("disabled")
        return

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()
    interval = _interval_seconds()

    def _worker() -> None:
        _log(f"started, interval={interval}s")
        while not stop_event.is_set():
            result = process_stock_dealer_trade_job_once()
            created_count = int(result.get("created_count") or 0)
            skipped_count = int(result.get("skipped_count") or 0)
            failed_count = int(result.get("failed_count") or 0)
            if created_count or failed_count:
                logger.info(
                    "[stock_dealer_trade_job] round finished created=%s skipped=%s failed=%s",
                    created_count,
                    skipped_count,
                    failed_count,
                )
            elif skipped_count:
                logger.debug(
                    "[stock_dealer_trade_job] round skipped=%s",
                    skipped_count,
                )
            stop_event.wait(interval)
        logger.debug("[stock_dealer_trade_job] stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="stock-dealer-trade-job", daemon=True)
    _thread.start()


def stop_stock_dealer_trade_job() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None
