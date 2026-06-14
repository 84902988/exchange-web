from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Optional

from app.db.models.stock_token_lock_config import StockTokenLockConfig
from app.db.models.user_stock_token_lock import UserStockTokenLock
from app.db.session import SessionLocal
from app.services.stock_token_lock_service import calculate_stock_token_releasable_amount, record_stock_token_release_log
from app.tasks.stock_token_release_tasks import enqueue_stock_token_release


STOCK_TOKEN_RELEASE_JOB_INTERVAL_SECONDS = 60
STOCK_TOKEN_RELEASE_JOB_BATCH_LIMIT = 500
STOCK_TOKEN_RELEASE_SCANNER_LOCK_KEY = "stock_token_release:scanner:owner"
logger = logging.getLogger(__name__)

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None
_run_lock = threading.Lock()


def _utc_now() -> datetime:
    return datetime.utcnow()


def _log(message: str) -> None:
    logger.info("[stock_token_release_job] %s", message)


def _scanner_lock_ttl_seconds() -> int:
    return max(STOCK_TOKEN_RELEASE_JOB_INTERVAL_SECONDS * 2, 120)


def _acquire_scanner_owner(owner_token: str) -> bool:
    try:
        from app.core.rq import get_redis_connection

        redis = get_redis_connection()
        current = redis.get(STOCK_TOKEN_RELEASE_SCANNER_LOCK_KEY)
        current_text = current.decode("utf-8") if isinstance(current, bytes) else str(current or "")
        ttl = _scanner_lock_ttl_seconds()
        if current_text == owner_token:
            redis.expire(STOCK_TOKEN_RELEASE_SCANNER_LOCK_KEY, ttl)
            return True
        return bool(redis.set(STOCK_TOKEN_RELEASE_SCANNER_LOCK_KEY, owner_token, nx=True, ex=ttl))
    except Exception:
        logger.debug("[stock_token_release_job] scanner owner lock unavailable; using local thread guard", exc_info=True)
        return True


def _release_scanner_owner(owner_token: str) -> None:
    try:
        from app.core.rq import get_redis_connection

        redis = get_redis_connection()
        current = redis.get(STOCK_TOKEN_RELEASE_SCANNER_LOCK_KEY)
        current_text = current.decode("utf-8") if isinstance(current, bytes) else str(current or "")
        if current_text == owner_token:
            redis.delete(STOCK_TOKEN_RELEASE_SCANNER_LOCK_KEY)
    except Exception:
        logger.debug("[stock_token_release_job] scanner owner unlock skipped", exc_info=True)


def process_stock_token_release_job_once(limit: int = STOCK_TOKEN_RELEASE_JOB_BATCH_LIMIT) -> dict:
    if not _run_lock.acquire(blocking=False):
        db = SessionLocal()
        try:
            result = {
                "scanned_count": 0,
                "released_count": 0,
                "total_release_amount": 0,
                "item_ids": [],
            }
            record_stock_token_release_log(
                db,
                trigger_type="AUTO",
                status="SKIPPED",
                result=result,
                message="previous stock token release job is still running",
            )
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.exception("[stock_token_release_job] release skip log failed")
        finally:
            db.close()
        return {
            "status": "SKIPPED_IN_PROCESS",
            "scanned_count": 0,
            "released_count": 0,
            "total_release_amount": 0,
            "item_ids": [],
        }

    db = SessionLocal()
    try:
        batch_limit = min(max(int(limit or STOCK_TOKEN_RELEASE_JOB_BATCH_LIMIT), 1), 5000)
        now_value = _utc_now()
        rows = (
            db.query(UserStockTokenLock, StockTokenLockConfig)
            .join(StockTokenLockConfig, UserStockTokenLock.config_id == StockTokenLockConfig.id)
            .filter(
                UserStockTokenLock.status.in_(("ACTIVE", "RELEASING")),
                UserStockTokenLock.locked_amount > 0,
            )
            .order_by(UserStockTokenLock.id.asc())
            .limit(batch_limit)
            .all()
        )
        lock_ids: list[int] = []
        seen_lock_ids: set[int] = set()
        for lock_item, config in rows:
            lock_id = int(lock_item.id)
            if lock_id in seen_lock_ids:
                continue
            seen_lock_ids.add(lock_id)
            if calculate_stock_token_releasable_amount(lock_item, now=now_value, config=config) > 0:
                lock_ids.append(lock_id)
        job_ids = []
        for lock_id in lock_ids:
            job_id = enqueue_stock_token_release(lock_id, trigger_type="AUTO_RQ")
            if job_id:
                job_ids.append(job_id)
        result = {
            "scanned_count": len(rows),
            "released_count": 0,
            "total_release_amount": 0,
            "item_ids": lock_ids,
            "job_ids": job_ids,
        }
        if job_ids:
            record_stock_token_release_log(
                db,
                trigger_type="AUTO",
                status="ENQUEUED",
                result=result,
                message=f"automatic stock token release enqueue finished: enqueued={len(job_ids)}",
            )
        db.commit()
        if job_ids:
            logger.info(
                "[stock_token_release_job] enqueued releases scanned=%s enqueued=%s",
                result.get("scanned_count"),
                len(job_ids),
            )
            logger.debug(
                "[stock_token_release_job] enqueued release item_ids=%s job_ids=%s",
                result.get("item_ids"),
                job_ids,
            )
        return {"status": "ENQUEUED" if job_ids else "NOOP", **result}
    except Exception as exc:
        db.rollback()
        try:
            record_stock_token_release_log(
                db,
                trigger_type="AUTO",
                status="FAILED",
                result={
                    "scanned_count": 0,
                    "released_count": 0,
                    "total_release_amount": 0,
                    "item_ids": [],
                },
                message="automatic stock token release job failed",
                error_message=repr(exc),
            )
            db.commit()
        except Exception as log_exc:
            db.rollback()
            logger.exception("[stock_token_release_job] release failure log failed")
        logger.exception("[stock_token_release_job] release job failed")
        return {
            "status": "FAILED",
            "scanned_count": 0,
            "released_count": 0,
            "total_release_amount": 0,
            "item_ids": [],
            "error": repr(exc),
        }
    finally:
        db.close()
        _run_lock.release()


def start_stock_token_release_job() -> None:
    global _thread, _stop_event

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()
    owner_token = f"{os.getpid()}:{id(stop_event)}"

    def _worker() -> None:
        logger.info(
            "[stock_token_release_job] started interval=%ss limit=%s",
            STOCK_TOKEN_RELEASE_JOB_INTERVAL_SECONDS,
            STOCK_TOKEN_RELEASE_JOB_BATCH_LIMIT,
        )
        try:
            while not stop_event.is_set():
                if _acquire_scanner_owner(owner_token):
                    process_stock_token_release_job_once(limit=STOCK_TOKEN_RELEASE_JOB_BATCH_LIMIT)
                else:
                    logger.debug("[stock_token_release_job] skipped because another owner is active")
                stop_event.wait(STOCK_TOKEN_RELEASE_JOB_INTERVAL_SECONDS)
        finally:
            _release_scanner_owner(owner_token)
            logger.debug("[stock_token_release_job] stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="stock-token-release-job", daemon=True)
    _thread.start()


def stop_stock_token_release_job() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None
