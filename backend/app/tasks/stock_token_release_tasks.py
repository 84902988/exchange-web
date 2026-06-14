from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal

from app.core.rq import QUEUE_RELEASE, get_queue
from app.db.models.stock_token_lock_config import StockTokenLockConfig
from app.db.models.user_stock_token_lock import UserStockTokenLock
from app.db.session import SessionLocal
from app.services.stock_token_lock_service import (
    StockTokenLockError,
    record_stock_token_release_log,
    release_stock_token_lock,
)


logger = logging.getLogger(__name__)

RELEASE_JOB_MAX_RETRIES = 3
ACTIVE_RELEASE_JOB_STATUSES = {"queued", "started", "deferred", "scheduled", "failed"}


def _empty_result() -> dict:
    return {
        "scanned_count": 1,
        "released_count": 0,
        "total_release_amount": Decimal("0"),
        "item_ids": [],
    }


def release_stock_token_lock_job(lock_id: int, trigger_type: str = "RQ") -> dict:
    try:
        lock_item_id = int(lock_id)
    except (TypeError, ValueError):
        logger.error("stock token release job parameter error: invalid lock_id=%r", lock_id)
        return {"ok": False, "status": "FAILED", "retryable": False, "error": "INVALID_LOCK_ID"}

    if lock_item_id <= 0:
        logger.error("stock token release job parameter error: invalid lock_id=%r", lock_id)
        return {"ok": False, "status": "FAILED", "retryable": False, "error": "INVALID_LOCK_ID"}

    db = SessionLocal()
    trigger = str(trigger_type or "RQ").strip().upper()[:20] or "RQ"
    try:
        row = (
            db.query(UserStockTokenLock, StockTokenLockConfig)
            .outerjoin(StockTokenLockConfig, StockTokenLockConfig.id == UserStockTokenLock.config_id)
            .filter(UserStockTokenLock.id == lock_item_id)
            .with_for_update()
            .first()
        )
        if row is None:
            result = _empty_result()
            record_stock_token_release_log(
                db,
                trigger_type=trigger,
                status="SKIPPED",
                result=result,
                message=f"stock token lock not found: {lock_item_id}",
            )
            db.commit()
            logger.warning("stock token release job skipped: lock not found id=%s", lock_item_id)
            return {"ok": False, "status": "SKIPPED", "retryable": False, "error": "LOCK_NOT_FOUND"}

        lock_item, config = row
        if str(lock_item.status or "").upper() not in {"ACTIVE", "RELEASING"} or Decimal(str(lock_item.locked_amount or 0)) <= 0:
            db.commit()
            logger.info(
                "stock token release job noop: lock_id=%s reason=NOT_RELEASABLE status=%s locked_amount=%s",
                lock_item_id,
                lock_item.status,
                lock_item.locked_amount,
            )
            return {
                "ok": True,
                "status": "NOOP",
                "released_count": 0,
                "total_release_amount": "0",
                "item_ids": [],
                "reason": "NOT_RELEASABLE",
            }

        release_amount = release_stock_token_lock(db, lock_item, now=datetime.utcnow(), config=config)
        if release_amount <= Decimal("0"):
            db.commit()
            logger.info("stock token release job noop: lock_id=%s reason=NO_RELEASABLE_AMOUNT", lock_item_id)
            return {
                "ok": True,
                "status": "NOOP",
                "released_count": 0,
                "total_release_amount": "0",
                "item_ids": [],
                "reason": "NO_RELEASABLE_AMOUNT",
            }

        result = {
            "scanned_count": 1,
            "released_count": 1,
            "total_release_amount": release_amount,
            "item_ids": [int(lock_item.id)],
        }
        record_stock_token_release_log(
            db,
            trigger_type=trigger,
            status="SUCCESS",
            result=result,
            message=f"stock token lock release job finished: {lock_item_id}",
        )
        db.commit()
        return {
            "ok": True,
            "status": "SUCCESS",
            "released_count": result["released_count"],
            "total_release_amount": str(release_amount),
            "item_ids": result["item_ids"],
        }
    except StockTokenLockError as exc:
        db.rollback()
        try:
            record_stock_token_release_log(
                db,
                trigger_type=trigger,
                status="FAILED",
                result=_empty_result(),
                message=f"stock token lock release job failed: {lock_item_id}",
                error_message=str(exc),
            )
            db.commit()
        except Exception:
            db.rollback()
        logger.error("stock token release job business failure: lock_id=%s error=%s", lock_item_id, exc)
        return {"ok": False, "status": "FAILED", "retryable": False, "error": str(exc)}
    except Exception as exc:
        db.rollback()
        try:
            record_stock_token_release_log(
                db,
                trigger_type=trigger,
                status="FAILED",
                result=_empty_result(),
                message=f"stock token lock release job failed: {lock_item_id}",
                error_message=repr(exc),
            )
            db.commit()
        except Exception:
            db.rollback()
        logger.exception("stock token release job retryable failure: lock_id=%s", lock_item_id)
        raise
    finally:
        db.close()


def _registry_contains_job(registry: object, job_id: str) -> bool:
    try:
        return job_id in set(registry.get_job_ids())
    except Exception:
        return False


def _release_job_already_pending(queue: object, job_id: str) -> bool:
    try:
        if job_id in set(getattr(queue, "job_ids", []) or []):
            return True
    except Exception:
        pass

    try:
        from rq.registry import DeferredJobRegistry, FailedJobRegistry, StartedJobRegistry
    except ModuleNotFoundError:
        return False

    registry_classes = [StartedJobRegistry, DeferredJobRegistry, FailedJobRegistry]
    try:
        from rq.registry import ScheduledJobRegistry
    except Exception:
        ScheduledJobRegistry = None
    if ScheduledJobRegistry is not None:
        registry_classes.append(ScheduledJobRegistry)

    queue_name = getattr(queue, "name", QUEUE_RELEASE)
    connection = getattr(queue, "connection", None)
    for registry_class in registry_classes:
        try:
            registry = registry_class(queue_name, connection=connection)
        except Exception:
            continue
        if _registry_contains_job(registry, job_id):
            return True
    return False


def enqueue_stock_token_release(lock_id: int, trigger_type: str = "RQ") -> str:
    try:
        lock_item_id = int(lock_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("lock_id must be an integer") from exc
    if lock_item_id <= 0:
        raise ValueError("lock_id must be positive")

    try:
        from rq import Retry
    except ModuleNotFoundError:
        Retry = None

    queue = get_queue(QUEUE_RELEASE)
    job_id = f"stock_token_release_{lock_item_id}"

    existing_job = queue.fetch_job(job_id)
    if existing_job is not None:
        try:
            status = str(existing_job.get_status(refresh=True) or "").lower()
        except Exception:
            status = ""
        if status in ACTIVE_RELEASE_JOB_STATUSES:
            return ""
        try:
            existing_job.delete()
        except Exception:
            logger.debug("stock token release stale job delete skipped job_id=%s", job_id, exc_info=True)

    if _release_job_already_pending(queue, job_id):
        return ""

    enqueue_kwargs = {
        "func": release_stock_token_lock_job,
        "kwargs": {
            "lock_id": lock_item_id,
            "trigger_type": str(trigger_type or "RQ").strip().upper()[:20] or "RQ",
        },
        "job_id": job_id,
        "description": f"check stock token release id={lock_item_id}",
        "result_ttl": 600,
        "failure_ttl": 24 * 3600,
    }
    if Retry is not None:
        enqueue_kwargs["retry"] = Retry(max=RELEASE_JOB_MAX_RETRIES, interval=[60, 300, 900])
    try:
        job = queue.enqueue_call(**enqueue_kwargs)
    except Exception as exc:
        if "exists" in str(exc).lower() or exc.__class__.__name__ in {"DuplicateJobError", "InvalidJobOperation"}:
            return ""
        raise
    return str(job.id)
