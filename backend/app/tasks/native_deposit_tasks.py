from __future__ import annotations

from rq import Retry

from app.core.rq import QUEUE_TX_CONFIRM, get_queue
from app.db.session import SessionLocal
from app.services.deposit_tx_confirm_service import recheck_deposit_chain_confirmation


class NativeDepositPending(RuntimeError):
    pass


def enqueue_native_deposit(deposit_id: int) -> str:
    queue = get_queue(QUEUE_TX_CONFIRM)
    job_id = f"native_deposit_{int(deposit_id)}"
    existing = queue.fetch_job(job_id)
    if existing:
        status = str(existing.get_status(refresh=True)).lower()
        if any(value in status for value in ("queued", "started", "scheduled", "deferred")):
            return job_id
        existing.delete()
    queue.enqueue_call(func=confirm_native_deposit, args=(int(deposit_id),), job_id=job_id,
                       retry=Retry(max=48, interval=[15, 30, 60, 120, 300]),
                       timeout=120, result_ttl=86400, failure_ttl=7 * 86400)
    return job_id


def confirm_native_deposit(deposit_id: int) -> dict:
    db = SessionLocal()
    try:
        result = recheck_deposit_chain_confirmation(db, deposit_id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    if result.status == "PENDING":
        raise NativeDepositPending(result.error_message or "WAITING_CONFIRMATIONS")
    return {"deposit_id": deposit_id, "status": result.status, "credited": result.credited}
