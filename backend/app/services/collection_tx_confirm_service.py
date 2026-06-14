from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.core.chain_config import get_runtime_chain_config
from app.db.models.collection import CollectionTask, CollectionTaskStatus, GasTask, GasTaskStatus
from app.services.collection_balance_checker import CollectionBalanceCheckerError, get_web3_for_chain
from app.services.collection_service import (
    mark_collection_task_confirming,
    mark_collection_task_confirmed,
    mark_collection_task_failed,
    queue_collection_task_changed,
    mark_gas_task_confirmed,
    mark_gas_task_confirming,
    mark_gas_task_failed,
    refresh_collection_batch_aggregate,
)
from app.services.solana_client import get_solana_transaction_status_with_rpc_fallback


@dataclass(frozen=True)
class TxConfirmResult:
    task_type: str
    task_id: int
    tx_hash: str
    status: str
    block_number: Optional[int]
    error_message: Optional[str]


def _get_collection_task(db: Session, task_id: int) -> Optional[CollectionTask]:
    return db.query(CollectionTask).filter(CollectionTask.id == int(task_id)).first()


def _get_gas_task(db: Session, task_id: int) -> Optional[GasTask]:
    return db.query(GasTask).filter(GasTask.id == int(task_id)).first()


def _receipt_status_and_block(*, db: Session, chain_key: str, tx_hash: str) -> tuple[Optional[int], Optional[int], Optional[str]]:
    if (chain_key or "").strip().lower() == "solana":
        try:
            cfg = get_runtime_chain_config(db, chain_key)
            receipt = get_solana_transaction_status_with_rpc_fallback(list(cfg.rpc_urls), tx_hash)
        except Exception as exc:
            return None, None, str(exc)
        if receipt is None:
            return None, None, None
        return receipt.status, receipt.slot, None

    try:
        w3 = get_web3_for_chain(chain_key, db=db)
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except CollectionBalanceCheckerError as exc:
        return None, None, str(exc)
    except Exception as exc:
        message = str(exc)
        if "not found" in message.lower() or "transactionnotfound" in type(exc).__name__.lower():
            return None, None, None
        return None, None, message

    if receipt is None:
        return None, None, None

    status = int(getattr(receipt, "status", receipt.get("status", 0)))
    block_number = getattr(receipt, "blockNumber", receipt.get("blockNumber", None))
    return status, int(block_number) if block_number is not None else None, None


def confirm_collection_task_tx(db: Session, task_id: int) -> TxConfirmResult:
    task = _get_collection_task(db, task_id)
    if not task:
        return TxConfirmResult("collection", int(task_id), "", "SKIPPED", None, "TASK_NOT_FOUND")

    tx_hash = (task.tx_hash or "").strip()
    task_status = str(task.status or "").upper()
    confirmable_statuses = {
        CollectionTaskStatus.SENT.value,
        CollectionTaskStatus.SENDING.value,
        CollectionTaskStatus.QUEUED.value,
        CollectionTaskStatus.GAS_REQUIRED.value,
        "CONFIRMING",
        "COLLECTION_SENT",
        "COLLECTION_CONFIRMING",
        "PROCESSING",
    }
    if task_status in {CollectionTaskStatus.CONFIRMED.value, "SUCCESS", "COMPLETED"}:
        if tx_hash.lower().startswith("0x") and not tx_hash.upper().startswith(("DRYRUN_", "DRYGAS_")) and task.last_error:
            task.last_error = None
            db.flush()
            queue_collection_task_changed(db, task)
        refresh_collection_batch_aggregate(db, task.batch_id)
        return TxConfirmResult("collection", int(task.id), tx_hash, "CONFIRMED", task.block_number, None)
    if task_status not in confirmable_statuses:
        return TxConfirmResult("collection", int(task.id), tx_hash, "SKIPPED", None, f"STATUS_{task.status}")
    if not tx_hash:
        task.last_error = "TX_HASH_EMPTY"
        db.flush()
        return TxConfirmResult("collection", int(task.id), "", "SKIPPED", None, "TX_HASH_EMPTY")

    if tx_hash.startswith("DRYRUN_"):
        mark_collection_task_confirmed(db, int(task.id), block_number=None)
        return TxConfirmResult("collection", int(task.id), tx_hash, "CONFIRMED", None, None)

    receipt_status, block_number, error = _receipt_status_and_block(db=db, chain_key=task.chain_key, tx_hash=tx_hash)
    if error:
        task.last_error = error[:1000]
        db.flush()
        return TxConfirmResult("collection", int(task.id), tx_hash, "PENDING", None, error)
    if receipt_status is None:
        if task_status in {
            CollectionTaskStatus.SENT.value,
            "COLLECTION_SENT",
            "COLLECTION_CONFIRMING",
            "CONFIRMING",
        }:
            mark_collection_task_confirming(db, int(task.id))
        return TxConfirmResult("collection", int(task.id), tx_hash, "PENDING", None, None)
    if receipt_status == 1:
        mark_collection_task_confirmed(db, int(task.id), block_number=block_number)
        return TxConfirmResult("collection", int(task.id), tx_hash, "CONFIRMED", block_number, None)

    error_message = f"TX_FAILED status={receipt_status}"
    mark_collection_task_failed(db, int(task.id), error_message, retryable=False)
    return TxConfirmResult("collection", int(task.id), tx_hash, "FAILED", block_number, error_message)


def confirm_gas_task_tx(db: Session, task_id: int) -> TxConfirmResult:
    task = _get_gas_task(db, task_id)
    if not task:
        return TxConfirmResult("gas", int(task_id), "", "SKIPPED", None, "TASK_NOT_FOUND")

    tx_hash = (task.tx_hash or "").strip()
    if task.status not in {GasTaskStatus.SENT.value, GasTaskStatus.CONFIRMING.value}:
        return TxConfirmResult("gas", int(task.id), tx_hash, "SKIPPED", None, f"STATUS_{task.status}")
    if not tx_hash:
        task.last_error = "TX_HASH_EMPTY"
        db.flush()
        return TxConfirmResult("gas", int(task.id), "", "SKIPPED", None, "TX_HASH_EMPTY")

    if tx_hash.startswith("DRYGAS_"):
        mark_gas_task_confirmed(db, int(task.id), block_number=None)
        return TxConfirmResult("gas", int(task.id), tx_hash, "CONFIRMED", None, None)

    receipt_status, block_number, error = _receipt_status_and_block(db=db, chain_key=task.chain_key, tx_hash=tx_hash)
    if error:
        task.last_error = error[:1000]
        db.flush()
        return TxConfirmResult("gas", int(task.id), tx_hash, "PENDING", None, error)
    if receipt_status is None:
        mark_gas_task_confirming(db, int(task.id))
        return TxConfirmResult("gas", int(task.id), tx_hash, "PENDING", None, None)
    if receipt_status == 1:
        mark_gas_task_confirmed(db, int(task.id), block_number=block_number)
        return TxConfirmResult("gas", int(task.id), tx_hash, "CONFIRMED", block_number, None)

    error_message = f"TX_FAILED status={receipt_status}"
    mark_gas_task_failed(db, int(task.id), error_message, retryable=False)
    return TxConfirmResult("gas", int(task.id), tx_hash, "FAILED", block_number, error_message)


def scan_sent_collection_tasks_for_confirm(db: Session, limit: int = 100) -> list[TxConfirmResult]:
    rows = (
        db.query(CollectionTask)
        .filter(CollectionTask.status.in_([
            CollectionTaskStatus.SENT.value,
            "CONFIRMING",
            "COLLECTION_SENT",
            "COLLECTION_CONFIRMING",
        ]))
        .filter(CollectionTask.tx_hash.isnot(None))
        .filter(CollectionTask.tx_hash != "")
        .order_by(CollectionTask.sent_at.asc(), CollectionTask.id.asc())
        .limit(limit)
        .all()
    )
    return [confirm_collection_task_tx(db, int(item.id)) for item in rows]


def scan_sent_gas_tasks_for_confirm(db: Session, limit: int = 100) -> list[TxConfirmResult]:
    rows = (
        db.query(GasTask)
        .filter(GasTask.status.in_([GasTaskStatus.SENT.value, GasTaskStatus.CONFIRMING.value]))
        .filter(GasTask.tx_hash.isnot(None))
        .filter(GasTask.tx_hash != "")
        .order_by(GasTask.sent_at.asc(), GasTask.id.asc())
        .limit(limit)
        .all()
    )
    return [confirm_gas_task_tx(db, int(item.id)) for item in rows]
