from __future__ import annotations

import logging

from app.core.rq import QUEUE_PAYOUT, get_queue
from app.db.models.user_invite_commission_record import UserInviteCommissionRecord
from app.db.session import SessionLocal
from app.services.user_invite_commission_service import pay_user_invite_commission_record


logger = logging.getLogger(__name__)

USER_INVITE_COMMISSION_JOB_MAX_RETRIES = 3
USER_INVITE_COMMISSION_RETRY_INTERVALS = [60, 300, 900]


def _normalize_trigger_type(trigger_type: str) -> str:
    return str(trigger_type or "RQ").strip().upper()[:20] or "RQ"


def pay_user_invite_commission_record_job(record_id: int, trigger_type: str = "RQ") -> dict:
    try:
        commission_record_id = int(record_id)
    except (TypeError, ValueError):
        logger.error("user invite commission payout job parameter error: invalid record_id=%r", record_id)
        return {"ok": False, "status": "FAILED", "retryable": False, "error": "INVALID_RECORD_ID"}

    trigger = _normalize_trigger_type(trigger_type)
    if commission_record_id <= 0:
        logger.error("user invite commission payout job parameter error: invalid record_id=%r", record_id)
        return {"ok": False, "status": "FAILED", "retryable": False, "error": "INVALID_RECORD_ID"}

    logger.info(
        "user invite commission payout job start: record_id=%s trigger_type=%s",
        commission_record_id,
        trigger,
    )
    db = SessionLocal()
    try:
        record_status = (
            db.query(UserInviteCommissionRecord.status)
            .filter(UserInviteCommissionRecord.id == commission_record_id)
            .scalar()
        )
        if record_status is None:
            logger.info("user invite commission payout job skipped: record not found id=%s", commission_record_id)
            return {
                "ok": True,
                "status": "SKIPPED",
                "retryable": False,
                "record_id": commission_record_id,
                "reason": "NOT_FOUND",
            }

        normalized_status = str(record_status or "").upper()
        if normalized_status == "PAID":
            logger.info("user invite commission payout job noop: already paid id=%s", commission_record_id)
            return {
                "ok": True,
                "status": "NOOP",
                "retryable": False,
                "record_id": commission_record_id,
                "reason": "ALREADY_PAID",
            }
        if normalized_status != "PENDING":
            logger.info(
                "user invite commission payout job skipped: record_id=%s status=%s",
                commission_record_id,
                normalized_status,
            )
            return {
                "ok": True,
                "status": "SKIPPED",
                "retryable": False,
                "record_id": commission_record_id,
                "reason": f"STATUS_{normalized_status or 'UNKNOWN'}",
            }

        record = pay_user_invite_commission_record(db, record_id=commission_record_id)
        db.commit()
        paid_status = str(record.status or "").upper()
        if paid_status == "PAID":
            logger.info("user invite commission payout job success: record_id=%s", commission_record_id)
            return {
                "ok": True,
                "status": "SUCCESS",
                "record_id": commission_record_id,
                "trigger_type": trigger,
            }

        logger.warning(
            "user invite commission payout job failed without retry: record_id=%s status=%s reason=%s",
            commission_record_id,
            paid_status,
            record.fail_reason,
        )
        return {
            "ok": False,
            "status": paid_status or "FAILED",
            "retryable": False,
            "record_id": commission_record_id,
            "error": record.fail_reason or paid_status or "FAILED",
        }
    except Exception:
        db.rollback()
        logger.exception("user invite commission payout job failed: record_id=%s", commission_record_id)
        raise
    finally:
        db.close()


def enqueue_pay_user_invite_commission(record_id: int, trigger_type: str = "RQ") -> str:
    try:
        commission_record_id = int(record_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("record_id must be an integer") from exc
    if commission_record_id <= 0:
        raise ValueError("record_id must be positive")

    try:
        from rq import Retry
    except ModuleNotFoundError:
        Retry = None

    queue = get_queue(QUEUE_PAYOUT)
    enqueue_kwargs = {
        "func": pay_user_invite_commission_record_job,
        "kwargs": {
            "record_id": commission_record_id,
            "trigger_type": _normalize_trigger_type(trigger_type),
        },
        "description": f"user invite commission payout record id={commission_record_id}",
    }
    if Retry is not None:
        enqueue_kwargs["retry"] = Retry(
            max=USER_INVITE_COMMISSION_JOB_MAX_RETRIES,
            interval=USER_INVITE_COMMISSION_RETRY_INTERVALS,
        )
    job = queue.enqueue_call(**enqueue_kwargs)
    return str(job.id)
