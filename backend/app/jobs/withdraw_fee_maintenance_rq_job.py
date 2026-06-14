from __future__ import annotations

import logging
import os
import re
import time
from typing import Any, Dict, Iterable, Optional

from app.core.rq import QUEUE_MAINTENANCE, get_queue, get_redis_connection
from app.db.session import SessionLocal
from app.services.withdraw_fee_service import maintain_withdraw_fee_once


logger = logging.getLogger(__name__)
DEFAULT_ENQUEUE_INTERVAL_SECONDS = 600


def _enqueue_interval_seconds() -> int:
    raw = os.getenv("WITHDRAW_FEE_MAINTENANCE_ENQUEUE_INTERVAL_SECONDS", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_ENQUEUE_INTERVAL_SECONDS
    except ValueError:
        value = DEFAULT_ENQUEUE_INTERVAL_SECONDS
    return max(60, value)


def _window_id(now_ts: int | None = None, interval_seconds: int | None = None) -> int:
    interval = interval_seconds or _enqueue_interval_seconds()
    return int((now_ts if now_ts is not None else time.time()) // interval)


def _normalize_chain_keys(chain_keys: Optional[Iterable[str]]) -> list[str]:
    return sorted({str(item).strip().lower() for item in (chain_keys or []) if str(item).strip()})


def _job_scope(chain_keys: Optional[Iterable[str]]) -> str:
    keys = _normalize_chain_keys(chain_keys)
    if not keys:
        return "all"
    raw = "-".join(keys)
    return re.sub(r"[^A-Za-z0-9_-]+", "_", raw)[:120] or "chain"


def _log_result_details(result: Dict[str, Any], *, duration_ms: int) -> None:
    logger.debug("[withdraw_fee_maintenance_rq_job] result_detail=%s", result)
    for item in result.get("details") or []:
        payload = {
            "chain_key": item.get("chain_key"),
            "estimated_cost": item.get("estimated_cost") or item.get("real_cost"),
            "applied_fee": item.get("applied_fee") or item.get("current_fee"),
            "error": item.get("error") or "",
        }
        if payload["error"]:
            logger.warning(
                "[withdraw_fee_maintenance_rq_job] chain=%s failed error=%s",
                payload["chain_key"],
                payload["error"],
            )
            continue
        logger.info(
            "[withdraw_fee_maintenance_rq_job] chain=%s estimated_cost=%s applied_fee=%s duration_ms=%s",
            payload["chain_key"],
            payload["estimated_cost"],
            payload["applied_fee"],
            duration_ms,
        )


def run_withdraw_fee_maintenance_job(chain_keys: Optional[Iterable[str]] = None) -> Dict[str, Any]:
    db = SessionLocal()
    started_at = time.perf_counter()
    try:
        result = maintain_withdraw_fee_once(db, chain_keys=_normalize_chain_keys(chain_keys))
        db.commit()
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        _log_result_details(result, duration_ms=duration_ms)
        return {"status": "OK", **result}
    except Exception as exc:
        db.rollback()
        logger.exception("[withdraw_fee_maintenance_rq_job] failed")
        return {"status": "FAILED", "error": repr(exc)}
    finally:
        db.close()


def enqueue_withdraw_fee_maintenance_job(
    *,
    chain_keys: Optional[Iterable[str]] = None,
    interval_seconds: Optional[int] = None,
    force: bool = False,
) -> Dict[str, Any]:
    interval = max(60, int(interval_seconds or _enqueue_interval_seconds()))
    window = _window_id(interval_seconds=interval)
    scope = _job_scope(chain_keys)
    normalized_chain_keys = _normalize_chain_keys(chain_keys)
    job_id = f"withdraw_fee_maintenance_{scope}_{window}"
    lock_key = f"withdraw_fee_maintenance:enqueue:{scope}:{window}"
    redis = get_redis_connection()

    if not force:
        acquired = redis.set(lock_key, job_id, nx=True, ex=interval)
        if not acquired:
            return {
                "ok": True,
                "enqueued": False,
                "queue": QUEUE_MAINTENANCE,
                "job_id": job_id,
                "window": window,
                "scope": scope,
                "chain_keys": normalized_chain_keys,
                "reason": "DUPLICATE_WINDOW",
            }

    queue = get_queue(QUEUE_MAINTENANCE)
    try:
        job = queue.enqueue_call(
            func=run_withdraw_fee_maintenance_job,
            kwargs={"chain_keys": normalized_chain_keys or None},
            timeout=600,
            result_ttl=7 * 24 * 3600,
            failure_ttl=7 * 24 * 3600,
            job_id=job_id,
            description=f"withdraw fee maintenance scope={scope} window={window}",
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
        "window": window,
        "scope": scope,
        "chain_keys": normalized_chain_keys,
    }
