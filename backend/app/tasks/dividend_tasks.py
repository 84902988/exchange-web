from __future__ import annotations

import logging
from typing import Callable

from app.core.rq import QUEUE_PAYOUT, get_queue
from app.db.models.dividend import UserDividendRecord
from app.db.session import SessionLocal
from app.services import dividend_service


logger = logging.getLogger(__name__)

DIVIDEND_JOB_MAX_RETRIES = 3
DIVIDEND_RETRY_INTERVALS = [60, 300, 900]


def _normalize_trigger_type(trigger_type: str) -> str:
    return str(trigger_type or "RQ").strip().upper()[:20] or "RQ"


def _single_record_service() -> Callable | None:
    for name in (
        "pay_user_dividend_record",
        "distribute_user_dividend_record",
        "pay_dividend_record",
    ):
        service = getattr(dividend_service, name, None)
        if callable(service):
            return service
    return None


def pay_user_dividend_record_job(record_id: int, trigger_type: str = "RQ") -> dict:
    try:
        dividend_record_id = int(record_id)
    except (TypeError, ValueError):
        logger.error("dividend payout job parameter error: invalid record_id=%r", record_id)
        return {"ok": False, "status": "FAILED", "retryable": False, "error": "INVALID_RECORD_ID"}

    trigger = _normalize_trigger_type(trigger_type)
    if dividend_record_id <= 0:
        logger.error("dividend payout job parameter error: invalid record_id=%r", record_id)
        return {"ok": False, "status": "FAILED", "retryable": False, "error": "INVALID_RECORD_ID"}

    logger.info(
        "dividend payout job start: record_id=%s trigger_type=%s",
        dividend_record_id,
        trigger,
    )
    db = SessionLocal()
    try:
        record = (
            db.query(UserDividendRecord)
            .filter(UserDividendRecord.id == dividend_record_id)
            .with_for_update()
            .first()
        )
        if record is None:
            logger.info("dividend payout job skipped: record not found id=%s", dividend_record_id)
            return {
                "ok": True,
                "status": "SKIPPED",
                "retryable": False,
                "record_id": dividend_record_id,
                "reason": "NOT_FOUND",
            }

        normalized_status = str(record.status or "").upper()
        if normalized_status == "PAID":
            logger.info("dividend payout job noop: already paid id=%s", dividend_record_id)
            return {
                "ok": True,
                "status": "NOOP",
                "retryable": False,
                "record_id": dividend_record_id,
                "reason": "ALREADY_PAID",
            }
        if normalized_status != "PENDING":
            logger.info(
                "dividend payout job skipped: record_id=%s status=%s",
                dividend_record_id,
                normalized_status,
            )
            return {
                "ok": True,
                "status": "SKIPPED",
                "retryable": False,
                "record_id": dividend_record_id,
                "reason": f"STATUS_{normalized_status or 'UNKNOWN'}",
            }

        service = _single_record_service()
        if service is None:
            try:
                raise RuntimeError("SINGLE_RECORD_DIVIDEND_SERVICE_NOT_FOUND")
            except RuntimeError:
                logger.exception(
                    "dividend payout job failed: single-record dividend payout service is not implemented "
                    "record_id=%s",
                    dividend_record_id,
                )
            return {
                "ok": False,
                "status": "FAILED",
                "retryable": False,
                "record_id": dividend_record_id,
                "error": "SINGLE_RECORD_DIVIDEND_SERVICE_NOT_FOUND",
            }

        paid_record = service(db, record_id=dividend_record_id)
        db.commit()
        paid_status = str(paid_record.status or "").upper()
        if paid_status == "PAID":
            logger.info("dividend payout job success: record_id=%s", dividend_record_id)
            return {
                "ok": True,
                "status": "SUCCESS",
                "record_id": dividend_record_id,
                "trigger_type": trigger,
            }

        logger.info(
            "dividend payout job skipped after service call: record_id=%s status=%s",
            dividend_record_id,
            paid_status,
        )
        return {
            "ok": True,
            "status": "SKIPPED",
            "retryable": False,
            "record_id": dividend_record_id,
            "reason": f"STATUS_{paid_status or 'UNKNOWN'}",
        }
    except Exception:
        db.rollback()
        logger.exception("dividend payout job failed: record_id=%s", dividend_record_id)
        raise
    finally:
        db.close()


def enqueue_pay_user_dividend_record(record_id: int, trigger_type: str = "RQ") -> str:
    try:
        dividend_record_id = int(record_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("record_id must be an integer") from exc
    if dividend_record_id <= 0:
        raise ValueError("record_id must be positive")

    try:
        from rq import Retry
    except ModuleNotFoundError:
        Retry = None

    queue = get_queue(QUEUE_PAYOUT)
    enqueue_kwargs = {
        "func": pay_user_dividend_record_job,
        "kwargs": {
            "record_id": dividend_record_id,
            "trigger_type": _normalize_trigger_type(trigger_type),
        },
        "description": f"dividend payout record id={dividend_record_id}",
    }
    if Retry is not None:
        enqueue_kwargs["retry"] = Retry(max=DIVIDEND_JOB_MAX_RETRIES, interval=DIVIDEND_RETRY_INTERVALS)
    job = queue.enqueue_call(**enqueue_kwargs)
    return str(job.id)
