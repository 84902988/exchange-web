import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.jobs.withdraw_jobs import SENDABLE_WITHDRAW_STATUSES, enqueue_withdraw_send

router = APIRouter(prefix="/asset", tags=["asset"])
logger = logging.getLogger(__name__)


def _send_error(code: str, message: str, trace_id: Optional[str] = None, status: str = "FROZEN"):
    return {
        "ok": False,
        "status": status,
        "code": code,
        "error": message,
        "message": message,
        "trace_id": trace_id,
    }


@router.post("/withdraw/send")
def withdraw_send_tx(
    request: Request,
    withdraw_id: int,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    owner = db.execute(
        text(
            """
            SELECT id, status, tx_hash, chain_key
            FROM withdraw_logs
            WHERE id=:withdraw_id AND user_id=:user_id
            LIMIT 1
            """
        ),
        {"withdraw_id": int(withdraw_id), "user_id": int(user_id)},
    ).mappings().first()
    if not owner:
        return _send_error("NOT_FOUND", "提现单不存在或不属于当前用户。", trace_id, status="")

    status = str(owner.get("status") or "").strip().upper()
    if owner.get("tx_hash"):
        return _send_error("TX_HASH_EXISTS", "tx_hash 已存在，不允许重复提交。", trace_id, status=status)
    if status not in SENDABLE_WITHDRAW_STATUSES:
        return _send_error("BAD_STATE", f"当前状态 {status or 'UNKNOWN'} 不允许继续提交。", trace_id, status=status)

    try:
        enqueue_result = enqueue_withdraw_send(int(withdraw_id))
    except Exception as exc:
        logger.exception(
            "[withdraw-send] enqueue failed trace_id=%s withdraw_id=%s user_id=%s",
            trace_id,
            withdraw_id,
            user_id,
        )
        return _send_error("WITHDRAW_SEND_ENQUEUE_FAILED", "链上发送任务提交失败，请稍后在提现记录中继续提交", trace_id, status=status)

    return {
        "ok": True,
        "status": "PROCESSING",
        "withdraw_id": int(withdraw_id),
        "data": {
            "ok": True,
            "status": "PROCESSING",
            "withdraw_id": int(withdraw_id),
            "queued": True,
            **enqueue_result,
        },
        "trace_id": trace_id,
    }
