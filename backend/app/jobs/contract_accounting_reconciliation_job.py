from __future__ import annotations

import logging
import os
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional

from app.db.session import SessionLocal
from app.services.contract_accounting_reconciliation_service import (
    build_contract_accounting_reconciliation_report,
)


logger = logging.getLogger(__name__)
DEFAULT_RESULT_TTL_SECONDS = 7 * 24 * 3600
QUEUE_MAINTENANCE = "maintenance"


def _parse_day(value: Optional[str]) -> date:
    if value:
        return datetime.strptime(value, "%Y-%m-%d").date()
    return (datetime.utcnow() - timedelta(days=1)).date()


def _day_window(day: date) -> tuple[datetime, datetime]:
    start = datetime(day.year, day.month, day.day)
    return start, start + timedelta(days=1)


def run_contract_accounting_reconciliation_job(day: Optional[str] = None) -> Dict[str, Any]:
    target_day = _parse_day(day)
    start_at, end_at = _day_window(target_day)
    db = SessionLocal()
    started_at = time.perf_counter()
    try:
        report = build_contract_accounting_reconciliation_report(db, start_at=start_at, end_at=end_at)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        summary = report.get("summary") or {}
        log_payload = {
            "day": target_day.isoformat(),
            "ok": report.get("ok"),
            "trade_count": summary.get("trade_count"),
            "mismatch_count": summary.get("mismatch_count"),
            "duplicate_count": summary.get("duplicate_count"),
            "duration_ms": duration_ms,
        }
        if report.get("ok"):
            logger.info("[contract_accounting_reconciliation] ok payload=%s", log_payload)
        else:
            logger.warning("[contract_accounting_reconciliation] mismatch payload=%s report=%s", log_payload, report)
        return {"status": "OK", "day": target_day.isoformat(), "duration_ms": duration_ms, **report}
    except Exception as exc:
        logger.exception("[contract_accounting_reconciliation] failed day=%s", target_day.isoformat())
        return {"status": "FAILED", "day": target_day.isoformat(), "error": repr(exc)}
    finally:
        db.close()


def enqueue_contract_accounting_reconciliation_job(
    *,
    day: Optional[str] = None,
    force: bool = False,
) -> Dict[str, Any]:
    from app.core.rq import get_queue, get_redis_connection

    target_day = _parse_day(day)
    day_key = target_day.isoformat()
    job_id = f"contract_accounting_reconciliation_{day_key}"
    lock_key = f"contract_accounting_reconciliation:enqueue:{day_key}"
    redis = get_redis_connection()
    lock_seconds = max(3600, int(os.getenv("CONTRACT_ACCOUNTING_RECONCILIATION_LOCK_SECONDS", "86400") or "86400"))

    if not force:
        acquired = redis.set(lock_key, job_id, nx=True, ex=lock_seconds)
        if not acquired:
            return {
                "ok": True,
                "enqueued": False,
                "queue": QUEUE_MAINTENANCE,
                "job_id": job_id,
                "day": day_key,
                "reason": "DUPLICATE_DAY",
            }

    queue = get_queue(QUEUE_MAINTENANCE)
    try:
        job = queue.enqueue_call(
            func=run_contract_accounting_reconciliation_job,
            kwargs={"day": day_key},
            timeout=600,
            result_ttl=DEFAULT_RESULT_TTL_SECONDS,
            failure_ttl=DEFAULT_RESULT_TTL_SECONDS,
            job_id=job_id,
            description=f"contract accounting reconciliation day={day_key}",
        )
    except Exception:
        if force:
            raise
        redis.delete(lock_key)
        raise

    return {
        "ok": True,
        "enqueued": True,
        "queue": QUEUE_MAINTENANCE,
        "job_id": str(job.id),
        "day": day_key,
    }
