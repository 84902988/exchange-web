from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, Optional

from sqlalchemy import and_, event, or_
from sqlalchemy.orm import Session

from app.db.models.collection import (
    CollectionBatch,
    CollectionBatchStatus,
    CollectionBatchTriggerType,
    CollectionTask,
    CollectionTaskStatus,
    GasTask,
    GasTaskStatus,
)
from app.services.collection_center_events import publish_collection_center_event


COLLECTION_TASK_EVENT_QUEUE_KEY = "collection_task_status_events"


def _now() -> datetime:
    return datetime.utcnow()


def _queue_collection_status_event(db: Session, event_type: str, payload: Dict[str, Any]) -> None:
    events = db.info.setdefault(COLLECTION_TASK_EVENT_QUEUE_KEY, [])
    events.append({"event_type": event_type, "payload": payload})


@event.listens_for(Session, "after_commit")
def _publish_collection_status_events_after_commit(session: Session) -> None:
    events = list(session.info.pop(COLLECTION_TASK_EVENT_QUEUE_KEY, []) or [])
    for event_item in events:
        publish_collection_center_event(str(event_item.get("event_type") or ""), dict(event_item.get("payload") or {}))


@event.listens_for(Session, "after_rollback")
def _discard_collection_status_events_after_rollback(session: Session) -> None:
    session.info.pop(COLLECTION_TASK_EVENT_QUEUE_KEY, None)


def _queue_collection_task_changed(db: Session, task: CollectionTask) -> None:
    _queue_collection_status_event(
        db,
        "collection_task_changed",
        {
            "batch_id": int(task.batch_id) if task.batch_id is not None else None,
            "collection_task_id": int(task.id),
            "task_id": int(task.id),
            "task_no": task.task_no,
            "status": task.status,
            "chain_key": task.chain_key,
            "coin_symbol": task.coin_symbol,
            "gas_task_id": int(task.gas_task_id) if task.gas_task_id is not None else None,
            "tx_hash": task.tx_hash or "",
            "failure_reason": task.last_error or task.reason or "",
            "updated_at": task.updated_at,
        },
    )


def _queue_gas_task_changed(db: Session, task: GasTask) -> None:
    batch_id = None
    if task.collection_task_id:
        collection_task = db.query(CollectionTask).filter(CollectionTask.id == int(task.collection_task_id)).first()
        if collection_task:
            batch_id = int(collection_task.batch_id) if collection_task.batch_id is not None else None
    _queue_collection_status_event(
        db,
        "gas_task_changed",
        {
            "batch_id": batch_id,
            "collection_task_id": int(task.collection_task_id) if task.collection_task_id is not None else None,
            "gas_task_id": int(task.id),
            "task_id": int(task.id),
            "task_no": task.task_no,
            "status": task.status,
            "chain_key": task.chain_key,
            "coin_symbol": task.gas_coin_symbol,
            "gas_topup_amount": str(task.topup_amount) if task.topup_amount is not None else "",
            "gas_tx_hash": task.tx_hash or "",
            "failure_reason": task.last_error or "",
            "updated_at": task.updated_at,
        },
    )


def _new_no(prefix: str) -> str:
    return f"{prefix}{_now().strftime('%Y%m%d%H%M%S%f')}{secrets.token_hex(3).upper()}"


def _normalize_chain_key(chain_key: str) -> str:
    value = (chain_key or "").strip().lower()
    if not value:
        raise ValueError("chain_key is required")
    return value


def _normalize_symbol(symbol: str) -> str:
    value = (symbol or "").strip().upper()
    if not value:
        raise ValueError("coin symbol is required")
    return value


def _normalize_address(address: str, field_name: str) -> str:
    value = (address or "").strip().lower()
    if not value:
        raise ValueError(f"{field_name} is required")
    return value


def _to_decimal(value: Decimal) -> Decimal:
    amount = Decimal(str(value))
    if amount < 0:
        raise ValueError("amount must be >= 0")
    return amount


def _to_positive_decimal(value: Decimal, field_name: str) -> Decimal:
    amount = _to_decimal(value)
    if amount <= 0:
        raise ValueError(f"{field_name} must be > 0")
    return amount


ACTIVE_COLLECTION_STATUSES = {
    CollectionTaskStatus.PENDING.value,
    CollectionTaskStatus.QUEUED.value,
    CollectionTaskStatus.GAS_REQUIRED.value,
    CollectionTaskStatus.GAS_QUEUED.value,
    CollectionTaskStatus.READY.value,
    CollectionTaskStatus.SENDING.value,
    CollectionTaskStatus.SENT.value,
}

ACTIVE_GAS_STATUSES = {
    GasTaskStatus.PENDING.value,
    GasTaskStatus.QUEUED.value,
    GasTaskStatus.SENDING.value,
    GasTaskStatus.SENT.value,
}

REAL_COLLECTION_SUCCESS_STATUSES = {
    CollectionTaskStatus.CONFIRMED.value,
    "SUCCESS",
    "COMPLETED",
}

COLLECTION_TASK_FAILED_STATUSES = {
    CollectionTaskStatus.FAILED.value,
    "ERROR",
    "TIMEOUT",
}

COLLECTION_TASK_PENDING_STATUSES = {
    CollectionTaskStatus.PENDING.value,
    CollectionTaskStatus.QUEUED.value,
    CollectionTaskStatus.GAS_REQUIRED.value,
    CollectionTaskStatus.GAS_QUEUED.value,
    CollectionTaskStatus.READY.value,
}

COLLECTION_TASK_PROCESSING_STATUSES = {
    "RUNNING",
    "PROCESSING",
    CollectionTaskStatus.SENDING.value,
}

COLLECTION_TASK_SENT_STATUSES = {
    CollectionTaskStatus.SENT.value,
    "GAS_SENT",
    "CONFIRMING",
}


def _retryable_failed_clause(model):
    return and_(
        model.status == "FAILED",
        model.next_retry_at.isnot(None),
        model.retry_count < model.max_retry,
    )


def find_active_collection_task_duplicate(
    db: Session,
    *,
    user_id: int,
    chain_key: str,
    coin_symbol: str,
    from_address: str,
) -> Optional[CollectionTask]:
    ck = _normalize_chain_key(chain_key)
    symbol = _normalize_symbol(coin_symbol)
    from_addr = _normalize_address(from_address, "from_address")
    return (
        db.query(CollectionTask)
        .filter(CollectionTask.user_id == int(user_id))
        .filter(CollectionTask.chain_key == ck)
        .filter(CollectionTask.coin_symbol == symbol)
        .filter(CollectionTask.from_address == from_addr)
        .filter(
            or_(
                CollectionTask.status.in_(ACTIVE_COLLECTION_STATUSES),
                _retryable_failed_clause(CollectionTask),
            )
        )
        .order_by(CollectionTask.id.desc())
        .first()
    )


def find_active_gas_task_duplicate(
    db: Session,
    *,
    chain_key: str,
    to_address: str,
) -> Optional[GasTask]:
    ck = _normalize_chain_key(chain_key)
    to_addr = _normalize_address(to_address, "to_address")
    return (
        db.query(GasTask)
        .filter(GasTask.chain_key == ck)
        .filter(GasTask.to_address == to_addr)
        .filter(or_(GasTask.status.in_(ACTIVE_GAS_STATUSES), _retryable_failed_clause(GasTask)))
        .order_by(GasTask.id.desc())
        .first()
    )


def _collection_task_idempotency_key(
    *,
    user_id: int,
    chain_key: str,
    coin_symbol: str,
    from_address: str,
    to_address: str,
    amount: Decimal,
) -> str:
    raw = (
        f"collect:{int(user_id)}:{chain_key}:{coin_symbol}:"
        f"{from_address}:{to_address}:{format(amount, 'f')}"
    )
    return f"collect:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def _gas_task_idempotency_key(
    *,
    collection_task_id: Optional[int],
    user_id: int,
    chain_key: str,
    gas_coin_symbol: str,
    from_address: str,
    to_address: str,
    topup_amount: Decimal,
) -> str:
    task_part = str(collection_task_id) if collection_task_id is not None else "none"
    raw = (
        f"gas:{int(user_id)}:{chain_key}:{task_part}:{gas_coin_symbol}:"
        f"{from_address}:{to_address}:{format(topup_amount, 'f')}"
    )
    return f"gas:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def _get_collection_batch(db: Session, batch_id: Optional[int]) -> Optional[CollectionBatch]:
    if batch_id is None:
        return None
    return db.query(CollectionBatch).filter(CollectionBatch.id == batch_id).first()


def _recompute_batch_status(batch: CollectionBatch) -> None:
    total = int(batch.total_tasks or 0)
    done = int(batch.success_tasks or 0) + int(batch.failed_tasks or 0) + int(batch.skipped_tasks or 0)
    if total <= 0:
        return
    if done < total:
        if batch.status == CollectionBatchStatus.PENDING.value:
            batch.status = CollectionBatchStatus.RUNNING.value
        return
    if int(batch.success_tasks or 0) == total:
        batch.status = CollectionBatchStatus.SUCCESS.value
    elif int(batch.success_tasks or 0) == 0 and int(batch.failed_tasks or 0) > 0:
        batch.status = CollectionBatchStatus.FAILED.value
    else:
        batch.status = CollectionBatchStatus.PARTIAL.value
    batch.finished_at = batch.finished_at or _now()


def _touch_batch_on_start(batch: Optional[CollectionBatch]) -> None:
    if not batch:
        return
    if batch.status == CollectionBatchStatus.PENDING.value:
        batch.status = CollectionBatchStatus.RUNNING.value
        batch.started_at = batch.started_at or _now()
    batch.updated_at = _now()


def _is_real_collection_tx_hash(value: Optional[str]) -> bool:
    tx_hash = str(value or "").strip()
    return bool(
        tx_hash.lower().startswith("0x")
        and not tx_hash.upper().startswith("DRYRUN_")
        and not tx_hash.upper().startswith("DRYGAS_")
    )


def _collection_batch_amount_totals(tasks: list[CollectionTask]) -> tuple[Optional[str], Decimal, Decimal]:
    total_by_symbol: dict[str, Decimal] = {}
    success_by_symbol: dict[str, Decimal] = {}
    for task in tasks:
        symbol = _normalize_symbol(str(task.coin_symbol or ""))
        amount = Decimal(str(task.amount or 0))
        total_by_symbol[symbol] = total_by_symbol.get(symbol, Decimal("0")) + amount
        status = str(task.status or "").upper()
        if status in REAL_COLLECTION_SUCCESS_STATUSES and _is_real_collection_tx_hash(task.tx_hash):
            success_by_symbol[symbol] = success_by_symbol.get(symbol, Decimal("0")) + amount

    symbols = {symbol for symbol, amount in total_by_symbol.items() if amount > 0}
    if len(symbols) == 1:
        symbol = next(iter(symbols))
        return symbol, total_by_symbol.get(symbol, Decimal("0")), success_by_symbol.get(symbol, Decimal("0"))
    return None, Decimal("0"), Decimal("0")


def refresh_collection_batch_aggregate(db: Session, batch_id: Optional[int]) -> Dict[str, Any]:
    batch = _get_collection_batch(db, batch_id)
    if not batch:
        return {
            "ok": False,
            "batch_id": batch_id,
            "reason": "BATCH_NOT_FOUND",
        }

    tasks = (
        db.query(CollectionTask)
        .filter(CollectionTask.batch_id == int(batch.id))
        .order_by(CollectionTask.id.asc())
        .all()
    )
    total_tasks = len(tasks)
    success_tasks = 0
    failed_tasks = 0
    skipped_tasks = 0
    pending_tasks = 0
    processing_tasks = 0
    sent_tasks = 0
    dry_run_tasks = 0
    terminal_tasks = 0

    for task in tasks:
        status = str(task.status or "").upper()
        tx_hash = str(task.tx_hash or "").strip()
        is_dry_run = tx_hash.upper().startswith("DRYRUN_") or tx_hash.upper().startswith("DRYGAS_")
        if is_dry_run:
            dry_run_tasks += 1

        if status in REAL_COLLECTION_SUCCESS_STATUSES and _is_real_collection_tx_hash(tx_hash):
            success_tasks += 1
            terminal_tasks += 1
        elif status in COLLECTION_TASK_FAILED_STATUSES:
            failed_tasks += 1
            terminal_tasks += 1
        elif status in {CollectionTaskStatus.SKIPPED.value, CollectionTaskStatus.CANCELED.value, "CANCELLED"}:
            skipped_tasks += 1
            terminal_tasks += 1
        elif status in COLLECTION_TASK_SENT_STATUSES:
            sent_tasks += 1
        elif status in COLLECTION_TASK_PROCESSING_STATUSES:
            processing_tasks += 1
        elif status in COLLECTION_TASK_PENDING_STATUSES or is_dry_run:
            pending_tasks += 1
        else:
            processing_tasks += 1

    single_symbol, total_amount, success_amount = _collection_batch_amount_totals(tasks)

    now = _now()
    batch.total_tasks = total_tasks
    batch.success_tasks = success_tasks
    batch.failed_tasks = failed_tasks
    batch.skipped_tasks = skipped_tasks
    batch.coin_symbol = single_symbol
    batch.total_amount = total_amount
    batch.success_amount = success_amount
    if total_tasks <= 0:
        batch.status = CollectionBatchStatus.PENDING.value
        batch.finished_at = None
    elif success_tasks == total_tasks:
        batch.status = "COMPLETED"
        batch.finished_at = batch.finished_at or now
    elif pending_tasks == total_tasks:
        batch.status = CollectionBatchStatus.PENDING.value
        batch.finished_at = None
    elif pending_tasks or processing_tasks or sent_tasks or dry_run_tasks:
        batch.status = "PROCESSING"
        batch.started_at = batch.started_at or now
        batch.finished_at = None
    elif failed_tasks:
        batch.status = CollectionBatchStatus.FAILED.value if failed_tasks == total_tasks else CollectionBatchStatus.PARTIAL.value
        batch.finished_at = batch.finished_at or now
    else:
        batch.status = CollectionBatchStatus.PARTIAL.value
        batch.finished_at = batch.finished_at or now
    batch.updated_at = now
    db.flush()
    return {
        "ok": True,
        "batch_id": int(batch.id),
        "status": batch.status,
        "total_tasks": total_tasks,
        "success_tasks": success_tasks,
        "sent_tasks": sent_tasks,
        "failed_tasks": failed_tasks,
        "pending_tasks": pending_tasks,
        "processing_tasks": processing_tasks,
        "skipped_tasks": skipped_tasks,
        "dry_run_tasks": dry_run_tasks,
        "coin_symbol": single_symbol,
        "total_amount": str(total_amount),
        "success_amount": str(success_amount),
    }


def _update_batch_for_task_created(db: Session, task: CollectionTask) -> None:
    refresh_collection_batch_aggregate(db, task.batch_id)


def _update_batch_for_task_confirmed(db: Session, task: CollectionTask) -> None:
    refresh_collection_batch_aggregate(db, task.batch_id)


def _update_batch_for_task_failed(db: Session, task: CollectionTask) -> None:
    refresh_collection_batch_aggregate(db, task.batch_id)


def _update_batch_for_task_skipped(db: Session, task: CollectionTask) -> None:
    refresh_collection_batch_aggregate(db, task.batch_id)


def _get_collection_task(db: Session, task_id: int) -> CollectionTask:
    task = db.query(CollectionTask).filter(CollectionTask.id == task_id).first()
    if not task:
        raise ValueError(f"collection task not found: {task_id}")
    return task


def _get_gas_task(db: Session, task_id: int) -> GasTask:
    task = db.query(GasTask).filter(GasTask.id == task_id).first()
    if not task:
        raise ValueError(f"gas task not found: {task_id}")
    return task


def create_collection_batch(
    db: Session,
    *,
    trigger_type: str,
    target_address: str,
    chain_key: Optional[str] = None,
    coin_symbol: Optional[str] = None,
    created_by: Optional[int] = None,
) -> CollectionBatch:
    trigger = (trigger_type or "").strip().upper()
    if trigger not in {item.value for item in CollectionBatchTriggerType}:
        raise ValueError(f"unsupported collection trigger_type: {trigger_type}")

    batch = CollectionBatch(
        batch_no=_new_no("CB"),
        trigger_type=trigger,
        target_address=_normalize_address(target_address, "target_address"),
        chain_key=(chain_key or "").strip().lower() or None,
        coin_symbol=(coin_symbol or "").strip().upper() or None,
        status=CollectionBatchStatus.PENDING.value,
        total_tasks=0,
        success_tasks=0,
        failed_tasks=0,
        skipped_tasks=0,
        total_amount=Decimal("0"),
        success_amount=Decimal("0"),
        created_by=created_by,
    )
    db.add(batch)
    db.flush()
    return batch


def create_collection_task(
    db: Session,
    *,
    batch_id: Optional[int],
    user_id: int,
    chain_key: str,
    coin_symbol: str,
    asset_chain_id: Optional[int],
    from_address: str,
    to_address: str,
    amount: Decimal,
    reason: Optional[str] = None,
) -> CollectionTask:
    ck = _normalize_chain_key(chain_key)
    symbol = _normalize_symbol(coin_symbol)
    from_addr = _normalize_address(from_address, "from_address")
    to_addr = _normalize_address(to_address, "to_address")
    task_amount = _to_decimal(amount)
    idempotency_key = _collection_task_idempotency_key(
        user_id=user_id,
        chain_key=ck,
        coin_symbol=symbol,
        from_address=from_addr,
        to_address=to_addr,
        amount=task_amount,
    )

    existing = db.query(CollectionTask).filter(CollectionTask.idempotency_key == idempotency_key).first()
    if existing:
        return existing

    active_duplicate = find_active_collection_task_duplicate(
        db,
        user_id=user_id,
        chain_key=ck,
        coin_symbol=symbol,
        from_address=from_addr,
    )
    if active_duplicate:
        return active_duplicate

    task = CollectionTask(
        task_no=_new_no("CT"),
        batch_id=batch_id,
        user_id=int(user_id),
        chain_key=ck,
        coin_symbol=symbol,
        asset_chain_id=asset_chain_id,
        from_address=from_addr,
        to_address=to_addr,
        amount=task_amount,
        status=CollectionTaskStatus.PENDING.value,
        reason=(reason or "").strip() or None,
        idempotency_key=idempotency_key,
        retry_count=0,
        max_retry=3,
    )
    db.add(task)
    db.flush()
    _update_batch_for_task_created(db, task)
    db.flush()
    return task


def create_gas_task(
    db: Session,
    *,
    collection_task_id: Optional[int],
    user_id: int,
    chain_key: str,
    gas_coin_symbol: str,
    from_address: str,
    to_address: str,
    topup_amount: Decimal,
    target_balance: Optional[Decimal] = None,
) -> GasTask:
    ck = _normalize_chain_key(chain_key)
    gas_symbol = _normalize_symbol(gas_coin_symbol)
    from_addr = _normalize_address(from_address, "from_address")
    to_addr = _normalize_address(to_address, "to_address")
    topup = _to_decimal(topup_amount)
    topup = _to_positive_decimal(topup, "topup_amount")
    target = _to_decimal(target_balance) if target_balance is not None else None
    idempotency_key = _gas_task_idempotency_key(
        collection_task_id=collection_task_id,
        user_id=user_id,
        chain_key=ck,
        gas_coin_symbol=gas_symbol,
        from_address=from_addr,
        to_address=to_addr,
        topup_amount=topup,
    )

    existing = db.query(GasTask).filter(GasTask.idempotency_key == idempotency_key).first()
    if existing:
        return existing

    active_duplicate = find_active_gas_task_duplicate(
        db,
        chain_key=ck,
        to_address=to_addr,
    )
    if active_duplicate:
        return active_duplicate

    task = GasTask(
        task_no=_new_no("GT"),
        collection_task_id=collection_task_id,
        user_id=int(user_id),
        chain_key=ck,
        gas_coin_symbol=gas_symbol,
        from_address=from_addr,
        to_address=to_addr,
        target_balance=target,
        topup_amount=topup,
        status=GasTaskStatus.PENDING.value,
        idempotency_key=idempotency_key,
        retry_count=0,
        max_retry=3,
    )
    db.add(task)
    db.flush()
    return task


def mark_collection_task_queued(db: Session, task_id: int) -> CollectionTask:
    task = _get_collection_task(db, task_id)
    if task.status not in {
        CollectionTaskStatus.PENDING.value,
        CollectionTaskStatus.READY.value,
        CollectionTaskStatus.FAILED.value,
    }:
        raise ValueError(f"cannot queue collection task from status {task.status}")
    task.status = CollectionTaskStatus.QUEUED.value
    task.updated_at = _now()
    _touch_batch_on_start(_get_collection_batch(db, task.batch_id))
    refresh_collection_batch_aggregate(db, task.batch_id)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def mark_collection_task_sending(db: Session, task_id: int) -> CollectionTask:
    task = _get_collection_task(db, task_id)
    if task.status not in {CollectionTaskStatus.QUEUED.value, CollectionTaskStatus.READY.value}:
        raise ValueError(f"cannot mark collection task sending from status {task.status}")
    task.status = CollectionTaskStatus.SENDING.value
    task.locked_at = task.locked_at or _now()
    task.updated_at = _now()
    _touch_batch_on_start(_get_collection_batch(db, task.batch_id))
    refresh_collection_batch_aggregate(db, task.batch_id)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def mark_collection_task_sent(db: Session, task_id: int, tx_hash: str) -> CollectionTask:
    tx_raw = (tx_hash or "").strip()
    tx = tx_raw if tx_raw.startswith("DRYRUN_") else tx_raw.lower()
    if not tx:
        raise ValueError("tx_hash is required when marking collection task SENT")
    task = _get_collection_task(db, task_id)
    if task.status != CollectionTaskStatus.SENDING.value:
        raise ValueError(f"cannot mark collection task sent from status {task.status}")
    task.status = CollectionTaskStatus.SENT.value
    task.tx_hash = tx
    task.sent_at = task.sent_at or _now()
    task.updated_at = _now()
    refresh_collection_batch_aggregate(db, task.batch_id)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def mark_collection_task_confirmed(
    db: Session,
    task_id: int,
    block_number: Optional[int] = None,
) -> CollectionTask:
    task = _get_collection_task(db, task_id)
    if task.status not in {CollectionTaskStatus.SENT.value, CollectionTaskStatus.SENDING.value}:
        raise ValueError(f"cannot confirm collection task from status {task.status}")
    task.status = CollectionTaskStatus.CONFIRMED.value
    task.block_number = block_number
    task.confirmed_at = task.confirmed_at or _now()
    task.updated_at = _now()
    _update_batch_for_task_confirmed(db, task)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def mark_collection_task_failed(
    db: Session,
    task_id: int,
    error_message: str,
    retryable: bool = True,
) -> CollectionTask:
    task = _get_collection_task(db, task_id)
    if task.status in {
        CollectionTaskStatus.CONFIRMED.value,
        CollectionTaskStatus.SKIPPED.value,
        CollectionTaskStatus.CANCELED.value,
    }:
        raise ValueError(f"cannot fail collection task from status {task.status}")
    task.retry_count = int(task.retry_count or 0) + 1
    task.last_error = (error_message or "").strip() or "collection task failed"
    task.status = CollectionTaskStatus.FAILED.value
    task.next_retry_at = _now() + timedelta(minutes=2) if retryable and task.retry_count < int(task.max_retry or 0) else None
    task.updated_at = _now()
    _update_batch_for_task_failed(db, task)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def mark_collection_task_wait_gas(
    db: Session,
    task_id: int,
    *,
    gas_task_id: int,
    reason: str = "WAIT_GAS",
) -> CollectionTask:
    task = _get_collection_task(db, task_id)
    if task.status in {
        CollectionTaskStatus.CONFIRMED.value,
        CollectionTaskStatus.SENT.value,
        CollectionTaskStatus.CANCELED.value,
    }:
        raise ValueError(f"cannot mark collection task wait gas from status {task.status}")
    task.status = CollectionTaskStatus.GAS_REQUIRED.value
    task.gas_task_id = int(gas_task_id)
    task.reason = (reason or "WAIT_GAS").strip()
    task.last_error = None
    task.next_retry_at = None
    task.locked_at = None
    task.updated_at = _now()
    _touch_batch_on_start(_get_collection_batch(db, task.batch_id))
    refresh_collection_batch_aggregate(db, task.batch_id)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def record_collection_task_failure_note(db: Session, task_id: int, message: str) -> CollectionTask:
    task = _get_collection_task(db, task_id)
    status_value = str(task.status or "").upper()
    if task.tx_hash or status_value in {
        CollectionTaskStatus.SENT.value,
        CollectionTaskStatus.CONFIRMED.value,
        CollectionTaskStatus.CANCELED.value,
    }:
        return task
    task.status = CollectionTaskStatus.FAILED.value
    task.last_error = (message or "").strip()[:1000] or "collection task failed"
    task.next_retry_at = None
    task.locked_at = None
    task.updated_at = _now()
    refresh_collection_batch_aggregate(db, task.batch_id)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def mark_collection_task_skipped(db: Session, task_id: int, reason: str) -> CollectionTask:
    task = _get_collection_task(db, task_id)
    if task.status in {
        CollectionTaskStatus.CONFIRMED.value,
        CollectionTaskStatus.FAILED.value,
        CollectionTaskStatus.CANCELED.value,
    }:
        raise ValueError(f"cannot skip collection task from status {task.status}")
    task.status = CollectionTaskStatus.SKIPPED.value
    task.reason = (reason or "").strip() or task.reason
    task.updated_at = _now()
    _update_batch_for_task_skipped(db, task)
    db.flush()
    _queue_collection_task_changed(db, task)
    return task


def mark_gas_task_queued(db: Session, task_id: int) -> GasTask:
    task = _get_gas_task(db, task_id)
    if task.status not in {GasTaskStatus.PENDING.value, GasTaskStatus.FAILED.value}:
        raise ValueError(f"cannot queue gas task from status {task.status}")
    task.status = GasTaskStatus.QUEUED.value
    task.updated_at = _now()
    db.flush()
    _queue_gas_task_changed(db, task)
    return task


def mark_gas_task_sending(db: Session, task_id: int) -> GasTask:
    task = _get_gas_task(db, task_id)
    if task.status != GasTaskStatus.QUEUED.value:
        raise ValueError(f"cannot mark gas task sending from status {task.status}")
    task.status = GasTaskStatus.SENDING.value
    task.locked_at = task.locked_at or _now()
    task.updated_at = _now()
    db.flush()
    _queue_gas_task_changed(db, task)
    return task


def mark_gas_task_sent(db: Session, task_id: int, tx_hash: str) -> GasTask:
    tx_raw = (tx_hash or "").strip()
    tx = tx_raw if tx_raw.startswith("DRYGAS_") else tx_raw.lower()
    if not tx:
        raise ValueError("tx_hash is required when marking gas task SENT")
    task = _get_gas_task(db, task_id)
    if task.status != GasTaskStatus.SENDING.value:
        raise ValueError(f"cannot mark gas task sent from status {task.status}")
    task.status = GasTaskStatus.SENT.value
    task.tx_hash = tx
    task.sent_at = task.sent_at or _now()
    task.updated_at = _now()
    db.flush()
    _queue_gas_task_changed(db, task)
    return task


def mark_gas_task_confirmed(db: Session, task_id: int, block_number: Optional[int] = None) -> GasTask:
    task = _get_gas_task(db, task_id)
    if task.status not in {GasTaskStatus.SENT.value, GasTaskStatus.SENDING.value}:
        raise ValueError(f"cannot confirm gas task from status {task.status}")
    task.status = GasTaskStatus.CONFIRMED.value
    task.block_number = block_number
    task.confirmed_at = task.confirmed_at or _now()
    task.updated_at = _now()
    db.flush()
    _queue_gas_task_changed(db, task)
    return task


def mark_gas_task_failed(
    db: Session,
    task_id: int,
    error_message: str,
    retryable: bool = True,
) -> GasTask:
    task = _get_gas_task(db, task_id)
    if task.status in {GasTaskStatus.CONFIRMED.value, GasTaskStatus.SKIPPED.value, GasTaskStatus.CANCELED.value}:
        raise ValueError(f"cannot fail gas task from status {task.status}")
    task.retry_count = int(task.retry_count or 0) + 1
    task.last_error = (error_message or "").strip() or "gas task failed"
    task.status = GasTaskStatus.FAILED.value
    task.next_retry_at = _now() + timedelta(minutes=2) if retryable and task.retry_count < int(task.max_retry or 0) else None
    task.updated_at = _now()
    db.flush()
    _queue_gas_task_changed(db, task)
    return task


def mark_gas_task_skipped(db: Session, task_id: int, reason: str) -> GasTask:
    task = _get_gas_task(db, task_id)
    if task.status in {GasTaskStatus.CONFIRMED.value, GasTaskStatus.FAILED.value, GasTaskStatus.CANCELED.value}:
        raise ValueError(f"cannot skip gas task from status {task.status}")
    task.status = GasTaskStatus.SKIPPED.value
    task.last_error = (reason or "").strip() or task.last_error
    task.updated_at = _now()
    db.flush()
    _queue_gas_task_changed(db, task)
    return task


def list_pending_collection_tasks(db: Session, limit: int = 100) -> list[CollectionTask]:
    return (
        db.query(CollectionTask)
        .filter(CollectionTask.status == CollectionTaskStatus.PENDING.value)
        .order_by(CollectionTask.id.asc())
        .limit(limit)
        .all()
    )


def list_retryable_collection_tasks(
    db: Session,
    now: Optional[datetime] = None,
    limit: int = 100,
) -> list[CollectionTask]:
    current = now or _now()
    return (
        db.query(CollectionTask)
        .filter(CollectionTask.status == CollectionTaskStatus.FAILED.value)
        .filter(CollectionTask.next_retry_at.isnot(None))
        .filter(CollectionTask.next_retry_at <= current)
        .filter(CollectionTask.retry_count < CollectionTask.max_retry)
        .order_by(CollectionTask.next_retry_at.asc(), CollectionTask.id.asc())
        .limit(limit)
        .all()
    )


def list_pending_gas_tasks(db: Session, limit: int = 100) -> list[GasTask]:
    return (
        db.query(GasTask)
        .filter(GasTask.status == GasTaskStatus.PENDING.value)
        .order_by(GasTask.id.asc())
        .limit(limit)
        .all()
    )


def list_retryable_gas_tasks(
    db: Session,
    now: Optional[datetime] = None,
    limit: int = 100,
) -> list[GasTask]:
    current = now or _now()
    return (
        db.query(GasTask)
        .filter(GasTask.status == GasTaskStatus.FAILED.value)
        .filter(GasTask.next_retry_at.isnot(None))
        .filter(GasTask.next_retry_at <= current)
        .filter(GasTask.retry_count < GasTask.max_retry)
        .order_by(GasTask.next_retry_at.asc(), GasTask.id.asc())
        .limit(limit)
        .all()
    )
