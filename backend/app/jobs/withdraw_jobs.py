from __future__ import annotations

import logging
from typing import Any, Dict, Optional
from uuid import uuid4

from sqlalchemy import text

from app.core.rq import QUEUE_WITHDRAW, get_queue, get_redis_connection
from app.db.session import SessionLocal
from app.services.hot_wallet_key_service import get_chain_hot_wallet_private_key
from app.services.withdraw_sender import WithdrawSendError, send_withdraw_once


logger = logging.getLogger(__name__)
SENDABLE_WITHDRAW_STATUSES = {"FROZEN", "APPROVED", "PROCESSING"}


def _update_withdraw_send_error(db, withdraw_log_id: int, message: str, *, stage: str = "PRECHECK") -> None:
    columns = db.execute(
        text(
            """
            SELECT COLUMN_NAME AS column_name
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'withdraw_logs'
              AND COLUMN_NAME IN ('error_message', 'fail_reason', 'reason', 'remark')
            """
        )
    ).mappings().all()
    existing = {str(row.get("column_name") or "") for row in columns}
    for column in ("error_message", "fail_reason", "reason", "remark"):
        if column in existing:
            final_message = f"{stage}:{message}"[:255]
            db.execute(
                text(
                    f"""
                    UPDATE withdraw_logs
                    SET {column} = :message
                    WHERE id = :id
                      AND (tx_hash IS NULL OR tx_hash = '')
                      AND status IN ('FROZEN', 'APPROVED', 'PROCESSING', 'SENDING')
                    """
                ),
                {"id": int(withdraw_log_id), "message": final_message},
            )
            return


def enqueue_withdraw_send(withdraw_log_id: int) -> Dict[str, Any]:
    wid = int(withdraw_log_id)
    lock_key = f"withdraw_send:enqueue:{wid}"
    redis = get_redis_connection()
    acquired = redis.set(lock_key, "1", nx=True, ex=60)
    if not acquired:
        return {
            "ok": True,
            "enqueued": False,
            "queue": QUEUE_WITHDRAW,
            "withdraw_log_id": wid,
            "reason": "DUPLICATE_ENQUEUE_WINDOW",
        }

    queue = get_queue(QUEUE_WITHDRAW)
    try:
        job = queue.enqueue_call(
            func=process_withdraw_send,
            args=(wid,),
            timeout=600,
            result_ttl=24 * 3600,
            failure_ttl=7 * 24 * 3600,
            job_id=f"withdraw_send_{wid}_{uuid4().hex}",
            description=f"withdraw send withdraw_log_id={wid}",
        )
    except Exception:
        redis.delete(lock_key)
        raise

    return {
        "ok": True,
        "enqueued": True,
        "queue": QUEUE_WITHDRAW,
        "job_id": str(job.id),
        "withdraw_log_id": wid,
    }


def process_withdraw_send(withdraw_log_id: int) -> Dict[str, Any]:
    wid = int(withdraw_log_id)
    db = SessionLocal()
    try:
        row = db.execute(
            text(
                """
                SELECT id, status, tx_hash, chain_key
                FROM withdraw_logs
                WHERE id = :id
                FOR UPDATE
                """
            ),
            {"id": wid},
        ).mappings().first()

        if not row:
            db.rollback()
            return {"ok": False, "withdraw_log_id": wid, "status": "", "reason": "NOT_FOUND"}

        status = str(row.get("status") or "").strip().upper()
        tx_hash = str(row.get("tx_hash") or "").strip()
        if tx_hash:
            db.commit()
            return {
                "ok": True,
                "skipped": True,
                "withdraw_log_id": wid,
                "status": status,
                "tx_hash": tx_hash,
                "reason": "TX_HASH_EXISTS",
            }

        if status not in SENDABLE_WITHDRAW_STATUSES:
            db.commit()
            return {
                "ok": True,
                "skipped": True,
                "withdraw_log_id": wid,
                "status": status,
                "reason": "BAD_STATE",
            }

        chain_key = str(row.get("chain_key") or "").strip().lower()
        db.commit()

        try:
            hot_private_key: Optional[str] = get_chain_hot_wallet_private_key(db, chain_key)
        except ValueError as exc:
            db.rollback()
            _update_withdraw_send_error(db, wid, str(exc), stage="PRECHECK")
            db.commit()
            logger.exception("[withdraw-job] hot wallet private key invalid withdraw_id=%s chain=%s", wid, chain_key)
            return {"ok": False, "withdraw_log_id": wid, "status": status, "error": str(exc)}

        if not hot_private_key:
            message = "热钱包私钥未配置，请联系平台处理。"
            _update_withdraw_send_error(db, wid, message, stage="PRECHECK")
            db.commit()
            logger.error("[withdraw-job] hot wallet private key missing withdraw_id=%s chain=%s", wid, chain_key)
            return {"ok": False, "withdraw_log_id": wid, "status": status, "error": message}

        try:
            result = send_withdraw_once(db=db, withdraw_id=wid, hot_private_key=hot_private_key)
            if result and not result.get("ok") and not result.get("tx_hash"):
                message = str(result.get("message") or result.get("error") or "")
                if message:
                    _update_withdraw_send_error(db, wid, message, stage=str(result.get("stage") or "PRECHECK"))
                    db.commit()
            return {"withdraw_log_id": wid, **dict(result or {})}
        except WithdrawSendError as exc:
            db.rollback()
            _update_withdraw_send_error(db, wid, exc.message, stage="PRECHECK")
            db.commit()
            logger.exception("[withdraw-job] send preflight failed withdraw_id=%s code=%s", wid, exc.code)
            return {"ok": False, "withdraw_log_id": wid, "status": status, "code": exc.code, "error": exc.message}
        except Exception as exc:
            db.rollback()
            _update_withdraw_send_error(db, wid, str(exc), stage="BROADCAST")
            db.commit()
            logger.exception("[withdraw-job] send failed withdraw_id=%s", wid)
            return {"ok": False, "withdraw_log_id": wid, "status": status, "error": str(exc)}
    finally:
        db.close()
