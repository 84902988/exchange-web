from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from app.jobs.contract_accounting_reconciliation_job import enqueue_contract_accounting_reconciliation_job


logger = logging.getLogger(__name__)
DEFAULT_POLL_SECONDS = 300

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None


def _poll_interval_seconds() -> int:
    raw = os.getenv("CONTRACT_ACCOUNTING_RECONCILIATION_SCHEDULER_POLL_SECONDS", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_POLL_SECONDS
    except ValueError:
        value = DEFAULT_POLL_SECONDS
    return max(60, value)


def _target_day() -> str:
    return (datetime.utcnow() - timedelta(days=1)).date().isoformat()


def process_contract_accounting_reconciliation_scheduler_once() -> Dict[str, Any]:
    day = _target_day()
    try:
        result = enqueue_contract_accounting_reconciliation_job(day=day)
        logger.debug("[contract_accounting_reconciliation_scheduler] enqueue result=%s", result)
        return {"ok": True, **result}
    except Exception as exc:
        logger.exception("[contract_accounting_reconciliation_scheduler] enqueue failed day=%s", day)
        return {"ok": False, "enqueued": False, "day": day, "error": repr(exc)}


def start_contract_accounting_reconciliation_scheduler() -> None:
    global _thread, _stop_event

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()
    poll_interval = _poll_interval_seconds()

    def _worker() -> None:
        logger.info("[contract_accounting_reconciliation_scheduler] started poll_interval=%ss", poll_interval)
        while not stop_event.is_set():
            process_contract_accounting_reconciliation_scheduler_once()
            stop_event.wait(poll_interval)
        logger.info("[contract_accounting_reconciliation_scheduler] stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="contract-accounting-reconciliation-scheduler", daemon=True)
    _thread.start()


def stop_contract_accounting_reconciliation_scheduler() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None


def run_contract_accounting_reconciliation_scheduler_forever() -> None:
    poll_interval = _poll_interval_seconds()
    stop_event = threading.Event()
    logger.info("[contract_accounting_reconciliation_scheduler] foreground started poll_interval=%ss", poll_interval)
    try:
        while not stop_event.is_set():
            process_contract_accounting_reconciliation_scheduler_once()
            stop_event.wait(poll_interval)
    except KeyboardInterrupt:
        logger.info("[contract_accounting_reconciliation_scheduler] interrupted")
