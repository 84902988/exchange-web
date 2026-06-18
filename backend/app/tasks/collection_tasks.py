from __future__ import annotations

import logging
import json
import time
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict

from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.core.rq import QUEUE_COLLECTION, QUEUE_GAS, QUEUE_TX_CONFIRM, enqueue_job, get_queue, get_redis_connection
from app.db.models.collection import CollectionBatch, CollectionBatchStatus, CollectionTask, CollectionTaskStatus, GasTask, GasTaskStatus
from app.db.session import SessionLocal
from app.services.collection_balance_checker import CollectionBalanceCheckerError, confirm_collection_candidate_onchain, get_native_balance
from app.services.collection_center_events import publish_collection_center_event
from app.services.collection_candidate_scanner import finalize_tool_scan_snapshot, write_candidate_verify_status
from app.services.collection_chain_helper import get_native_gas_coin_symbol
from app.services.collection_scan_cache import (
    SCAN_LOCK_TTL_SECONDS,
    SCAN_SNAPSHOT_TTL_SECONDS,
    get_scan_status,
    normalize_scan_chain_key,
    save_scan_snapshot,
    safe_scan_job_id_part,
    scan_lock_key,
    scan_status_running,
    set_scan_status,
)
from app.services.collection_send_helper import (
    is_collection_real_send_enabled,
    send_erc20_collect_transfer,
    send_native_gas_topup,
)
from app.services.collection_service import (
    create_gas_task,
    mark_collection_task_confirmed,
    mark_collection_task_failed,
    mark_collection_task_queued,
    mark_collection_task_sending,
    mark_collection_task_sent,
    mark_collection_task_skipped,
    mark_collection_task_wait_gas,
    mark_gas_task_confirmed,
    mark_gas_task_failed,
    mark_gas_task_queued,
    mark_gas_task_sending,
    mark_gas_task_sent,
    mark_gas_task_skipped,
    record_collection_task_failure_note,
)
from app.services.collection_tx_confirm_service import confirm_collection_task_tx, confirm_gas_task_tx
from app.services.evm_wallet import derive_evm_private_key_by_chain
from app.services.hot_wallet_key_service import (
    get_chain_hot_wallet_private_key,
    validate_hot_wallet_private_key_matches_address,
)


DRY_RUN_PRIVATE_KEY_PLACEHOLDER = "0x" + "11" * 32
COLLECTION_CENTER_SCAN_JOB_TIMEOUT_SECONDS = 10 * 60
logger = logging.getLogger(__name__)
TX_CONFIRM_RETRY_MAX_ATTEMPTS = 12


def _collection_candidate_amount_label(value: Any, symbol: str) -> str:
    try:
        amount = Decimal(str(value if value is not None else "0"))
    except Exception:
        amount = Decimal("0")
    text_value = format(amount, "f")
    if "." in text_value:
        text_value = text_value.rstrip("0").rstrip(".")
    if "." not in text_value:
        text_value = f"{text_value}.00"
    else:
        whole, frac = text_value.split(".", 1)
        if len(frac) < 2:
            text_value = f"{whole}.{frac.ljust(2, '0')}"
    return f"{text_value} {str(symbol or '').strip().upper()}"


def _collection_candidate_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value if value is not None else "0"))
    except Exception:
        return Decimal("0")


def _publish_candidate_verify_completed_from_db(
    db: Session,
    *,
    candidate_id: Any,
    fallback_chain_key: str,
    fallback_coin_symbol: str,
    fallback_address: str,
    fallback_user_id: Any,
    job_id: str,
) -> None:
    try:
        normalized_id = int(candidate_id or 0)
    except Exception:
        normalized_id = 0
    if normalized_id <= 0:
        return
    row = db.execute(
        text(
            """
            SELECT id, user_id, LOWER(chain_key) AS chain_key, UPPER(asset_symbol) AS asset_symbol,
                   LOWER(address) AS address, last_balance_amount, last_scan_at
            FROM collection_candidates
            WHERE id = :candidate_id
            LIMIT 1
            """
        ),
        {"candidate_id": normalized_id},
    ).mappings().first()
    if not row:
        return
    symbol = str(row.get("asset_symbol") or fallback_coin_symbol or "").strip().upper()
    last_scan_at = row.get("last_scan_at")
    last_scan_at_display = last_scan_at.strftime("%Y-%m-%d %H:%M:%S") if hasattr(last_scan_at, "strftime") else str(last_scan_at or "")
    balance_amount = row.get("last_balance_amount")
    status_label = "可归集" if _collection_candidate_decimal(balance_amount) > 0 else "余额不足"
    publish_collection_center_event(
        "candidate_verify_completed",
        {
            "candidate_id": normalized_id,
            "chain_key": str(row.get("chain_key") or fallback_chain_key or "").strip().lower(),
            "asset_symbol": symbol,
            "coin_symbol": symbol,
            "address": str(row.get("address") or fallback_address or "").strip().lower(),
            "user_id": row.get("user_id") or fallback_user_id,
            "status": "completed",
            "balance_amount": str(balance_amount if balance_amount is not None else "0"),
            "last_balance_amount": str(balance_amount if balance_amount is not None else "0"),
            "balance_label": _collection_candidate_amount_label(balance_amount, symbol),
            "last_balance_amount_display": _collection_candidate_amount_label(balance_amount, symbol),
            "verified_at": str(last_scan_at or ""),
            "last_scan_at": str(last_scan_at or ""),
            "last_scan_at_display": last_scan_at_display,
            "status_label": status_label,
            "verify_status_text": "已复核",
            "verify_button_label": "复核",
            "message": "已复核",
        },
    )
    logger.info(
        "candidate verify fallback publish completed candidate_id=%s chain=%s coin=%s job_id=%s",
        normalized_id,
        str(row.get("chain_key") or fallback_chain_key or "").strip().lower(),
        symbol,
        job_id,
    )


def _write_tool_scan_status_snapshot(
    scan_batch_id: str,
    *,
    chain_key: str,
    coin_symbol: str,
    filters: Dict[str, Any],
    status: str,
    error: str,
    total: int | None = None,
    scanned: int | None = None,
    success_count: int | None = None,
    positive_count: int | None = None,
    zero_count: int | None = None,
    failed_count: int | None = None,
    rows: list[Dict[str, Any]] | None = None,
    message: str | None = None,
) -> None:
    batch_id = str(scan_batch_id or "").strip()
    if not batch_id or str(filters.get("candidate_source") or "").strip() != "address_book_missing_candidates":
        return
    key = f"collection:tool_scan:{batch_id}"
    now_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    try:
        redis = get_redis_connection()
        raw = redis.get(key)
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        payload = json.loads(str(raw or "{}"))
        if not isinstance(payload, dict):
            payload = {}
        payload.update(
            {
                "status": status,
                "chain_key": chain_key,
                "coin_symbol": coin_symbol,
                "scan_batch_id": batch_id,
                "error": error,
                "message": message if message is not None else error,
                "updated_at": now_at,
            }
        )
        if status in {"completed", "failed", "timeout"}:
            payload["finished_at"] = now_at
        if status == "completed":
            payload["completed_at"] = now_at
        payload.setdefault(
            "filters",
            {
                "chain_key": chain_key,
                "coin_symbol": coin_symbol,
                "user_id": str(filters.get("user_id") or ""),
                "address": str(filters.get("address") or "").strip().lower(),
            },
        )
        if rows is not None:
            payload["rows"] = rows
        if total is not None:
            payload["total"] = int(total)
        if scanned is not None:
            payload["scanned"] = int(scanned)
        if success_count is not None:
            payload["success_count"] = int(success_count)
        if positive_count is not None:
            payload["positive_count"] = int(positive_count)
        if zero_count is not None:
            payload["zero_count"] = int(zero_count)
        if failed_count is not None:
            payload["failed_count"] = int(failed_count)
        payload.setdefault("total", 0)
        payload.setdefault("scanned", 0)
        payload.setdefault("current_address", "")
        payload.setdefault("success_count", 0)
        payload.setdefault("positive_count", 0)
        payload.setdefault("zero_count", 0)
        payload.setdefault("failed_count", 0)
        payload.setdefault("rows", [])
        if status == "completed":
            payload = finalize_tool_scan_snapshot(payload, scan_batch_id=batch_id)
            payload["current_address"] = ""
            if int(payload.get("total") or 0) == 0 and not payload.get("message"):
                payload["message"] = "当前筛选范围内暂无未入候选地址"
        redis.set(key, json.dumps(payload, ensure_ascii=False, default=str, sort_keys=True), ex=24 * 60 * 60)
    except Exception:
        logger.debug("collection tool scan status snapshot write failed batch=%s", batch_id, exc_info=True)


def _load_tool_scan_status_snapshot(scan_batch_id: str, filters: Dict[str, Any]) -> Dict[str, Any]:
    batch_id = str(scan_batch_id or "").strip()
    if not batch_id or str(filters.get("candidate_source") or "").strip() != "address_book_missing_candidates":
        return {}
    try:
        raw = get_redis_connection().get(f"collection:tool_scan:{batch_id}")
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        payload = json.loads(str(raw or "{}"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        logger.debug("collection tool scan status snapshot read failed batch=%s", batch_id, exc_info=True)
        return {}


def _tool_scan_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except Exception:
        return Decimal("0")


def _tool_scan_rows_from_result(result: Dict[str, Any]) -> list[Dict[str, Any]]:
    source_rows = result.get("address_items") or result.get("items") or []
    rows: list[Dict[str, Any]] = []
    for item in source_rows:
        if not isinstance(item, dict):
            continue
        address = str(item.get("address") or item.get("from_address") or "").strip().lower()
        if not address:
            continue
        balance = (
            item.get("balance_amount")
            or item.get("token_balance_raw")
            or item.get("token_balance")
            or item.get("collectable_amount_raw")
            or item.get("collectable_amount")
            or "0"
        )
        error = str(item.get("balance_error") or item.get("error") or "").strip()
        rows.append(
            {
                "user_id": int(item.get("user_id") or 0),
                "address": address,
                "asset_symbol": str(item.get("coin_symbol") or item.get("asset_symbol") or "").strip().upper(),
                "status": "failed" if error else "completed",
                "balance_amount": str(balance or "0"),
                "error": error,
                "candidate_exists": bool(item.get("candidate_exists")),
            }
        )
    return rows


def _tool_scan_counts_from_rows(rows: list[Dict[str, Any]]) -> Dict[str, int]:
    failed = sum(1 for row in rows if str(row.get("status") or "").lower() in {"failed", "timeout"} or row.get("error"))
    success = max(0, len(rows) - failed)
    positive = sum(
        1
        for row in rows
        if not row.get("error") and _tool_scan_decimal(row.get("balance_amount")) > 0
    )
    zero = sum(
        1
        for row in rows
        if not row.get("error") and _tool_scan_decimal(row.get("balance_amount")) <= 0
    )
    return {
        "total": len(rows),
        "scanned": len(rows),
        "success_count": success,
        "positive_count": positive,
        "zero_count": zero,
        "failed_count": failed,
    }


def _finalize_tool_scan_rows(rows: list[Dict[str, Any]], scan_batch_id: str = "") -> list[Dict[str, Any]]:
    snapshot = finalize_tool_scan_snapshot(
        {"scan_batch_id": scan_batch_id, "rows": [dict(row) for row in rows if isinstance(row, dict)]},
        scan_batch_id=scan_batch_id,
    )
    return [row for row in (snapshot.get("rows") or []) if isinstance(row, dict)]


def _get_collection_task(db: Session, task_id: int) -> CollectionTask | None:
    return db.query(CollectionTask).filter(CollectionTask.id == int(task_id)).first()


def _get_gas_task(db: Session, task_id: int) -> GasTask | None:
    return db.query(GasTask).filter(GasTask.id == int(task_id)).first()


def _load_asset_chain_meta(db: Session, task: CollectionTask, *, real_send_enabled: bool) -> dict[str, object]:
    from sqlalchemy import text

    row = db.execute(
        text(
            """
            SELECT ac.contract_address, ac.decimals
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE a.symbol = :symbol
              AND c.chain_key = :chain_key
              AND ac.enabled = 1
            LIMIT 1
            """
        ),
        {"symbol": task.coin_symbol, "chain_key": task.chain_key},
    ).mappings().first()
    if not row:
        raise ValueError(f"asset_chain not found: {task.coin_symbol} {task.chain_key}")
    contract = (row.get("contract_address") or "").strip()
    if not contract and real_send_enabled:
        raise ValueError(f"token contract not configured: {task.coin_symbol} {task.chain_key}")
    return {
        "contract_address": contract or "0x0000000000000000000000000000000000000000",
        "decimals": int(row.get("decimals") or 18),
    }


def _load_collection_min_amount(db: Session, task: CollectionTask) -> Decimal | None:
    row = db.execute(
        text(
            """
            SELECT ac.collection_min_amount
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE (
                    :asset_chain_id IS NOT NULL
                    AND ac.id = :asset_chain_id
                  )
               OR (
                    a.symbol = :symbol
                    AND c.chain_key = :chain_key
                    AND ac.enabled = 1
                  )
            ORDER BY CASE WHEN ac.id = :asset_chain_id THEN 0 ELSE 1 END
            LIMIT 1
            """
        ),
        {
            "asset_chain_id": task.asset_chain_id,
            "symbol": task.coin_symbol,
            "chain_key": task.chain_key,
        },
    ).mappings().first()
    if not row or row.get("collection_min_amount") is None:
        return None
    return Decimal(str(row.get("collection_min_amount")))


def _linked_gas_task_confirmed(db: Session, task: CollectionTask) -> bool:
    if not task.gas_task_id:
        return False
    gas_task = _get_gas_task(db, int(task.gas_task_id))
    return bool(gas_task and gas_task.status == GasTaskStatus.CONFIRMED.value)


def _load_chain_hot_wallet_address(db: Session, chain_key: str) -> str:
    row = db.execute(
        text("SELECT hot_wallet_address FROM chains WHERE LOWER(chain_key)=:chain_key LIMIT 1"),
        {"chain_key": str(chain_key or "").strip().lower()},
    ).mappings().first()
    return str((row or {}).get("hot_wallet_address") or "").strip().lower()


def _create_wait_gas_task_for_collection(
    db: Session,
    task: CollectionTask,
    evaluation: Any,
) -> GasTask:
    gas_symbol = str(getattr(evaluation, "gas_coin_symbol", "") or get_native_gas_coin_symbol(task.chain_key)).strip().upper()
    topup_amount = Decimal(str(getattr(evaluation, "gas_topup_amount", "0") or "0"))
    if topup_amount <= 0:
        raise ValueError(f"GAS_TOPUP_NOT_POSITIVE:{topup_amount}")
    hot_wallet_address = _load_chain_hot_wallet_address(db, task.chain_key)
    if not hot_wallet_address:
        raise ValueError("GAS_HOT_WALLET_ADDRESS_NOT_CONFIGURED")
    target_balance = Decimal(str(getattr(evaluation, "gas_target_balance", topup_amount) or topup_amount))
    gas_task = create_gas_task(
        db,
        collection_task_id=int(task.id),
        user_id=int(task.user_id),
        chain_key=str(task.chain_key),
        gas_coin_symbol=gas_symbol,
        from_address=hot_wallet_address,
        to_address=str(task.from_address),
        topup_amount=topup_amount,
        target_balance=target_balance,
        gas_topup_mode=str(getattr(evaluation, "gas_topup_mode", "") or ""),
        estimate_source=str(getattr(evaluation, "estimate_source", "") or ""),
    )
    if not gas_task.collection_task_id:
        gas_task.collection_task_id = int(task.id)
    wait_reason = f"WAIT_GAS:{gas_symbol}:{format(topup_amount, 'f')}"
    mark_collection_task_wait_gas(db, int(task.id), gas_task_id=int(gas_task.id), reason=wait_reason)
    return gas_task


def _collection_private_key_for_task(task: CollectionTask, *, real_send_enabled: bool) -> str:
    if not real_send_enabled:
        return DRY_RUN_PRIVATE_KEY_PLACEHOLDER
    return derive_evm_private_key_by_chain(int(task.user_id), str(task.chain_key))


def _gas_private_key_for_task(db: Session, task: GasTask, *, real_send_enabled: bool) -> str:
    if not real_send_enabled:
        return DRY_RUN_PRIVATE_KEY_PLACEHOLDER
    private_key = get_chain_hot_wallet_private_key(db, str(task.chain_key))
    if not private_key:
        raise ValueError("gas hot wallet private key not configured")
    row = db.execute(
        text("SELECT hot_wallet_address FROM chains WHERE LOWER(chain_key)=:chain_key LIMIT 1"),
        {"chain_key": str(task.chain_key or "").strip().lower()},
    ).mappings().first()
    validate_hot_wallet_private_key_matches_address(
        private_key,
        str((row or {}).get("hot_wallet_address") or task.from_address or ""),
    )
    return private_key


def enqueue_collection_task(task_id: int, *, allow_real_send: bool = False) -> str:
    job_id = f"collection_task_{int(task_id)}"
    job = _enqueue_unique_task_job(
        QUEUE_COLLECTION,
        process_collection_task,
        int(task_id),
        job_id,
        allow_real_send=allow_real_send,
    )
    return str(job.id)


def enqueue_gas_task(task_id: int, *, allow_real_send: bool = False) -> str:
    job_id = f"gas_task_{int(task_id)}"
    job = _enqueue_unique_task_job(QUEUE_GAS, process_gas_task, int(task_id), job_id, allow_real_send=allow_real_send)
    return str(job.id)


def _rq_job_status_text(job: object) -> str:
    try:
        return str(job.get_status(refresh=True)).lower()
    except Exception:
        return ""


def _rq_job_is_active_status(status: str) -> bool:
    text_value = str(status or "").lower()
    return any(token in text_value for token in ("queued", "started", "deferred", "scheduled"))


def _rq_task_job_is_active(queue_name: str, job_id: str) -> bool:
    try:
        queue = get_queue(queue_name)
        job = queue.fetch_job(job_id)
        return bool(job and _rq_job_is_active_status(_rq_job_status_text(job)))
    except Exception:
        logger.warning("rq task job active check failed queue=%s job_id=%s", queue_name, job_id, exc_info=True)
        return False


def is_collection_task_job_active(task_id: int) -> bool:
    return _rq_task_job_is_active(QUEUE_COLLECTION, f"collection_task_{int(task_id)}")


def is_gas_task_job_active(task_id: int) -> bool:
    return _rq_task_job_is_active(QUEUE_GAS, f"gas_task_{int(task_id)}")


def _enqueue_unique_task_job(queue_name: str, func: object, task_id: int, job_id: str, **kwargs: Any):
    queue = get_queue(queue_name)
    existing_job = queue.fetch_job(job_id)
    if existing_job:
        status = _rq_job_status_text(existing_job)
        if _rq_job_is_active_status(status):
            return existing_job
        try:
            existing_job.delete()
        except Exception:
            logger.warning("stale rq task job delete failed queue=%s job_id=%s", queue_name, job_id, exc_info=True)
    return enqueue_job(queue_name, func, int(task_id), job_id=job_id, **kwargs)


def enqueue_tx_confirm_collection_task(task_id: int) -> str:
    job = _enqueue_unique_task_job(
        QUEUE_TX_CONFIRM,
        process_tx_confirm_collection_task,
        int(task_id),
        f"tx_confirm_collection_{int(task_id)}",
    )
    return str(job.id)


def enqueue_tx_confirm_gas_task(task_id: int) -> str:
    job = _enqueue_unique_task_job(
        QUEUE_TX_CONFIRM,
        process_tx_confirm_gas_task,
        int(task_id),
        f"tx_confirm_gas_{int(task_id)}",
    )
    return str(job.id)


def _enqueue_tx_confirm_collection_retry_task(task_id: int, confirm_attempt: int) -> str:
    job = _enqueue_unique_task_job(
        QUEUE_TX_CONFIRM,
        process_tx_confirm_collection_task,
        int(task_id),
        f"tx_confirm_collection_{int(task_id)}_retry_{int(confirm_attempt)}",
        confirm_attempt=int(confirm_attempt),
    )
    return str(job.id)


def _enqueue_tx_confirm_gas_retry_task(task_id: int, confirm_attempt: int) -> str:
    job = _enqueue_unique_task_job(
        QUEUE_TX_CONFIRM,
        process_tx_confirm_gas_task,
        int(task_id),
        f"tx_confirm_gas_{int(task_id)}_retry_{int(confirm_attempt)}",
        confirm_attempt=int(confirm_attempt),
    )
    return str(job.id)


def _scan_filters_for_network(chain_key: str, filters: Dict[str, Any] | None) -> Dict[str, Any]:
    payload = dict(filters or {})
    payload["view"] = payload.get("view") or "addresses"
    payload["chain_key"] = normalize_scan_chain_key(chain_key)
    return payload


def _release_scan_lock(chain_key: str, job_id: str) -> None:
    try:
        redis = get_redis_connection()
        key = scan_lock_key(chain_key)
        current = redis.get(key)
        if isinstance(current, bytes):
            current = current.decode("utf-8")
        if str(current or "") == str(job_id):
            redis.delete(key)
    except Exception as exc:
        logger.warning("collection center scan lock release failed chain=%s job_id=%s error=%s", chain_key, job_id, exc)


def _scan_failed_count(result: Dict[str, Any]) -> int:
    items = result.get("items") or result.get("asset_items") or []
    count = 0
    for item in items:
        if isinstance(item, dict) and item.get("balance_error"):
            count += 1
    return count


def _short_scan_error(value: Any) -> str:
    text_value = str(value or "").strip()
    return text_value[:180] if text_value else ""


def enqueue_collection_center_scan(
    chain_key: str,
    filters: Dict[str, Any] | None = None,
    *,
    scan_batch_id: str = "",
    job_id_prefix: str = "collection_center_scan",
    job_id_coin_symbol: str = "",
) -> Dict[str, Any]:
    chain = normalize_scan_chain_key(chain_key)
    if not chain:
        return {"enqueued": False, "chain_key": "", "error": "CHAIN_KEY_REQUIRED"}

    safe_prefix = "collection_tool_scan" if str(job_id_prefix or "").strip() == "collection_tool_scan" else "collection_center_scan"
    scan_filters = _scan_filters_for_network(chain, filters)
    batch_id = str(scan_batch_id or scan_filters.get("scan_batch_id") or "").strip()
    safe_chain = safe_scan_job_id_part(chain)
    safe_symbol = safe_scan_job_id_part(str(job_id_coin_symbol or "").strip().lower())
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    if safe_prefix == "collection_tool_scan" and batch_id:
        job_id = batch_id
    elif safe_prefix == "collection_tool_scan" and safe_symbol:
        job_id = f"{safe_prefix}_{safe_chain}_{safe_symbol}_{timestamp}"
    else:
        job_id = f"{safe_prefix}_{safe_chain}_{timestamp}"
    if not batch_id:
        batch_id = job_id
    redis = get_redis_connection()
    lock_key = scan_lock_key(chain)
    acquired = bool(redis.set(lock_key, job_id, nx=True, ex=SCAN_LOCK_TTL_SECONDS))
    if not acquired:
        status = get_scan_status(chain)
        if status and not scan_status_running(status):
            try:
                redis.delete(lock_key)
                acquired = bool(redis.set(lock_key, job_id, nx=True, ex=SCAN_LOCK_TTL_SECONDS))
            except Exception:
                acquired = False
            if acquired:
                status = {}
        if acquired:
            status = {}
    if not acquired:
        return {
            "enqueued": False,
            "already_running": True,
            "chain_key": chain,
            "job_id": status.get("job_id") or "",
            "status": status.get("status") or "running",
            "scan_batch_id": status.get("scan_batch_id") or "",
        }

    scan_filters["scan_batch_id"] = batch_id
    scan_batch_started_at = str(scan_filters.get("scan_batch_started_at") or datetime.utcnow().isoformat(timespec="seconds") + "Z")
    scan_filters["scan_batch_started_at"] = scan_batch_started_at
    requested_coin_symbol = str(scan_filters.get("coin_symbol") or "").strip().upper()
    _write_tool_scan_status_snapshot(
        batch_id,
        chain_key=chain,
        coin_symbol=requested_coin_symbol,
        filters=scan_filters,
        status="queued",
        error="",
    )
    set_scan_status(
        chain,
        {
            "status": "queued",
            "job_id": job_id,
            "failed_count": 0,
            "scanned_address_count": 0,
            "collectable_address_count": 0,
            "gas_needed_count": 0,
            "balance_error_count": 0,
            "error": None,
            "last_scan_at": "",
            "queued_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "started_at": None,
            "finished_at": None,
            "chain_key": chain,
            "scan_batch_id": batch_id,
            "scan_batch_started_at": scan_batch_started_at,
            "coin_symbol": requested_coin_symbol,
            "scanned_symbols": [requested_coin_symbol] if requested_coin_symbol else [],
        },
    )
    try:
        queue = get_queue(QUEUE_COLLECTION)
        job = queue.enqueue_call(
            func=process_collection_center_scan,
            args=(chain, scan_filters, job_id, COLLECTION_CENTER_SCAN_JOB_TIMEOUT_SECONDS),
            job_id=job_id,
            timeout=COLLECTION_CENTER_SCAN_JOB_TIMEOUT_SECONDS + 30,
            result_ttl=SCAN_SNAPSHOT_TTL_SECONDS,
            failure_ttl=SCAN_SNAPSHOT_TTL_SECONDS,
        )
    except Exception:
        _release_scan_lock(chain, job_id)
        _write_tool_scan_status_snapshot(
            batch_id,
            chain_key=chain,
            coin_symbol=requested_coin_symbol,
            filters=scan_filters,
            status="failed",
            error="ENQUEUE_FAILED",
        )
        set_scan_status(
            chain,
            {
                "status": "failed",
                "job_id": job_id,
                "chain_key": chain,
                "error": "ENQUEUE_FAILED",
                "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            },
        )
        raise
    return {"enqueued": True, "chain_key": chain, "job_id": str(job.id), "status": "queued", "scan_batch_id": batch_id}


def process_collection_center_scan(
    chain_key: str,
    filters: Dict[str, Any] | None = None,
    job_id: str = "",
    job_timeout: int = COLLECTION_CENTER_SCAN_JOB_TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    chain = normalize_scan_chain_key(chain_key)
    scan_filters = _scan_filters_for_network(chain, filters)
    scan_batch_id = str(scan_filters.get("scan_batch_id") or job_id or "").strip()
    scan_batch_started_at = str(scan_filters.get("scan_batch_started_at") or "").strip()
    requested_coin_symbol = str(scan_filters.get("coin_symbol") or "").strip().upper()
    is_tool_scan = str(scan_filters.get("candidate_source") or "").strip() == "address_book_missing_candidates"
    verify_candidate_id = str(scan_filters.get("candidate_id") or "").strip()
    is_candidate_verify_scan = str(scan_batch_id or "").startswith("collection_candidate_verify_")
    if is_tool_scan and scan_batch_id:
        logger.info(
            "collection tool scan redis key=%s job_id=%s chain=%s coin=%s",
            f"collection:tool_scan:{scan_batch_id}",
            job_id,
            chain,
            requested_coin_symbol,
        )
    started_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    job_timeout_seconds = max(1, int(job_timeout or COLLECTION_CENTER_SCAN_JOB_TIMEOUT_SECONDS))
    if chain == "bsc":
        job_timeout_seconds = min(job_timeout_seconds, 120)
    deadline_monotonic = time.monotonic() + job_timeout_seconds
    final_status_written = False
    set_scan_status(
        chain,
        {
            "status": "running",
            "job_id": job_id,
            "failed_count": 0,
            "scanned_address_count": 0,
            "collectable_address_count": 0,
            "gas_needed_count": 0,
            "balance_error_count": 0,
            "error": None,
            "started_at": started_at,
            "finished_at": None,
            "chain_key": chain,
            "scan_batch_id": scan_batch_id,
            "scan_batch_started_at": scan_batch_started_at,
            "coin_symbol": requested_coin_symbol,
            "scanned_symbols": [requested_coin_symbol] if requested_coin_symbol else [],
            "job_timeout_seconds": job_timeout_seconds,
        },
    )
    _write_tool_scan_status_snapshot(
        scan_batch_id,
        chain_key=chain,
        coin_symbol=requested_coin_symbol,
        filters=scan_filters,
        status="running",
        error="",
    )
    db = SessionLocal()
    try:
        from app.services.admin_queries import admin_query_collection_candidates

        result = admin_query_collection_candidates(db, scan_filters, deadline_monotonic=deadline_monotonic)
        if str(scan_batch_id or "").startswith("collection_candidate_verify_"):
            db.commit()
        failed_count = _scan_failed_count(result)
        summary = result.get("summary") or {}
        finished_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        timed_out = time.monotonic() >= deadline_monotonic
        has_error = bool(result.get("error"))
        error_value = "SCAN_TIMEOUT" if timed_out else _short_scan_error(result.get("error"))
        scanned_count = int(summary.get("total_addresses") or 0)
        collectable_count = int(summary.get("collectible_count") or 0)
        gas_needed_count = int(summary.get("gas_required_count") or 0)
        scanned_symbols = summary.get("result_coin_symbols") or ([requested_coin_symbol] if requested_coin_symbol else [])
        all_balance_reads_failed = bool(scanned_count > 0 and failed_count >= scanned_count)
        status_value = "failed" if (timed_out or has_error or all_balance_reads_failed) else "completed"
        if all_balance_reads_failed and not error_value:
            error_value = "ONCHAIN_BALANCE_READ_FAILED"
        if is_candidate_verify_scan and verify_candidate_id and status_value != "completed":
            write_candidate_verify_status(
                verify_candidate_id,
                status="failed",
                chain_key=chain,
                coin_symbol=requested_coin_symbol,
                address=str(scan_filters.get("address") or "").strip().lower(),
                scan_batch_id=scan_batch_id,
                error=error_value or "VERIFY_FAILED",
            )
            publish_collection_center_event(
                "candidate_verify_failed",
                {
                    "candidate_id": verify_candidate_id,
                    "chain_key": chain,
                    "asset_symbol": requested_coin_symbol,
                    "coin_symbol": requested_coin_symbol,
                    "address": str(scan_filters.get("address") or "").strip().lower(),
                    "user_id": str(scan_filters.get("user_id") or "").strip(),
                    "status": "failed",
                    "error": error_value or "VERIFY_FAILED",
                    "message": "复核失败",
                },
            )
            logger.info(
                "candidate verify fallback publish failed candidate_id=%s chain=%s coin=%s job_id=%s",
                verify_candidate_id,
                chain,
                requested_coin_symbol,
                job_id,
            )
        elif is_candidate_verify_scan and verify_candidate_id and status_value == "completed":
            _publish_candidate_verify_completed_from_db(
                db,
                candidate_id=verify_candidate_id,
                fallback_chain_key=chain,
                fallback_coin_symbol=requested_coin_symbol,
                fallback_address=str(scan_filters.get("address") or "").strip().lower(),
                fallback_user_id=str(scan_filters.get("user_id") or "").strip(),
                job_id=job_id,
            )
        last_scan_at = summary.get("recent_scan_at") or finished_at
        save_scan_snapshot(
            chain,
            scan_filters,
            result,
            metadata={
                "started_at": started_at,
                "finished_at": finished_at,
                "status": status_value,
                "scanned_address_count": scanned_count,
                "collectable_address_count": collectable_count,
                "gas_needed_count": gas_needed_count,
                "balance_error_count": failed_count,
                "error": error_value or None,
                "last_scan_at": last_scan_at,
                "scan_batch_id": scan_batch_id,
                "scan_batch_started_at": scan_batch_started_at,
                "coin_symbol": requested_coin_symbol,
                "scanned_symbols": scanned_symbols,
            },
        )
        set_scan_status(
            chain,
            {
                "status": status_value,
                "job_id": job_id,
                "failed_count": failed_count,
                "scanned_address_count": scanned_count,
                "collectable_address_count": collectable_count,
                "gas_needed_count": gas_needed_count,
                "balance_error_count": failed_count,
                "last_scan_at": last_scan_at,
                "balance_source": summary.get("balance_source") or "链上扫描",
                "error": error_value or None,
                "started_at": started_at,
                "finished_at": finished_at,
                "chain_key": chain,
                "scan_batch_id": scan_batch_id,
                "scan_batch_started_at": scan_batch_started_at,
                "coin_symbol": requested_coin_symbol,
                "scanned_symbols": scanned_symbols,
                "job_timeout_seconds": job_timeout_seconds,
            },
        )
        completed_rows = _tool_scan_rows_from_result(result)
        current_tool_snapshot = _load_tool_scan_status_snapshot(scan_batch_id, scan_filters)
        current_tool_rows = current_tool_snapshot.get("rows") if isinstance(current_tool_snapshot, dict) else []
        if is_tool_scan and isinstance(current_tool_rows, list) and current_tool_rows:
            finalized_rows = _finalize_tool_scan_rows([row for row in current_tool_rows if isinstance(row, dict)], scan_batch_id)
            completed_counts = _tool_scan_counts_from_rows(finalized_rows)
            rows_to_write = finalized_rows
        elif completed_rows:
            completed_rows = _finalize_tool_scan_rows(completed_rows, scan_batch_id)
            completed_counts = _tool_scan_counts_from_rows(completed_rows)
            rows_to_write = completed_rows
        elif isinstance(current_tool_rows, list) and current_tool_rows:
            finalized_rows = _finalize_tool_scan_rows([row for row in current_tool_rows if isinstance(row, dict)], scan_batch_id)
            completed_counts = _tool_scan_counts_from_rows(finalized_rows)
            rows_to_write = finalized_rows
        else:
            completed_counts = {
                "total": scanned_count,
                "scanned": scanned_count,
                "success_count": max(0, scanned_count - failed_count),
                "positive_count": collectable_count,
                "zero_count": max(0, scanned_count - failed_count - collectable_count),
                "failed_count": failed_count,
            }
            rows_to_write = [] if completed_counts["total"] == 0 else None
        _write_tool_scan_status_snapshot(
            scan_batch_id,
            chain_key=chain,
            coin_symbol=requested_coin_symbol,
            filters=scan_filters,
            status=status_value,
            error=error_value or "",
            total=completed_counts["total"],
            scanned=completed_counts["scanned"],
            success_count=completed_counts["success_count"],
            positive_count=completed_counts["positive_count"],
            zero_count=completed_counts["zero_count"],
            failed_count=completed_counts["failed_count"],
            rows=rows_to_write,
            message="当前筛选范围内暂无未入候选地址" if completed_counts["total"] == 0 and status_value == "completed" else "",
        )
        final_status_written = True
        return {
            "ok": not timed_out and not has_error,
            "chain_key": chain,
            "status": status_value,
            "failed_count": failed_count,
            "scanned_address_count": scanned_count,
            "collectible_count": collectable_count,
            "gas_required_count": gas_needed_count,
        }
    except Exception as exc:
        finished_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        error_short = _short_scan_error(f"{type(exc).__name__}: {exc}")
        if is_candidate_verify_scan and verify_candidate_id:
            write_candidate_verify_status(
                verify_candidate_id,
                status="failed",
                chain_key=chain,
                coin_symbol=requested_coin_symbol,
                address=str(scan_filters.get("address") or "").strip().lower(),
                scan_batch_id=scan_batch_id,
                error=error_short,
            )
            publish_collection_center_event(
                "candidate_verify_failed",
                {
                    "candidate_id": verify_candidate_id,
                    "chain_key": chain,
                    "asset_symbol": requested_coin_symbol,
                    "coin_symbol": requested_coin_symbol,
                    "address": str(scan_filters.get("address") or "").strip().lower(),
                    "user_id": str(scan_filters.get("user_id") or "").strip(),
                    "status": "failed",
                    "error": error_short,
                    "message": "复核失败",
                },
            )
            logger.info(
                "candidate verify fallback publish failed candidate_id=%s chain=%s coin=%s job_id=%s",
                verify_candidate_id,
                chain,
                requested_coin_symbol,
                job_id,
            )
        set_scan_status(
            chain,
            {
                "status": "failed",
                "job_id": job_id,
                "failed_count": 0,
                "scanned_address_count": 0,
                "collectable_address_count": 0,
                "gas_needed_count": 0,
                "balance_error_count": 0,
                "error": error_short,
                "started_at": started_at,
                "finished_at": finished_at,
                "chain_key": chain,
                "scan_batch_id": scan_batch_id,
                "scan_batch_started_at": scan_batch_started_at,
                "coin_symbol": requested_coin_symbol,
                "scanned_symbols": [requested_coin_symbol] if requested_coin_symbol else [],
                "job_timeout_seconds": job_timeout_seconds,
            },
        )
        current_tool_snapshot = _load_tool_scan_status_snapshot(scan_batch_id, scan_filters)
        current_tool_rows = current_tool_snapshot.get("rows") if isinstance(current_tool_snapshot, dict) else []
        rows_to_write = None
        counts_to_write: Dict[str, int] = {
            "total": 0,
            "scanned": 0,
            "success_count": 0,
            "positive_count": 0,
            "zero_count": 0,
            "failed_count": 0,
        }
        if isinstance(current_tool_rows, list) and current_tool_rows:
            rows_to_write = _finalize_tool_scan_rows([row for row in current_tool_rows if isinstance(row, dict)], scan_batch_id)
            counts_to_write = _tool_scan_counts_from_rows(rows_to_write)
        _write_tool_scan_status_snapshot(
            scan_batch_id,
            chain_key=chain,
            coin_symbol=requested_coin_symbol,
            filters=scan_filters,
            status="failed",
            error=error_short,
            total=counts_to_write["total"],
            scanned=counts_to_write["scanned"],
            success_count=counts_to_write["success_count"],
            positive_count=counts_to_write["positive_count"],
            zero_count=counts_to_write["zero_count"],
            failed_count=counts_to_write["failed_count"],
            rows=rows_to_write,
        )
        final_status_written = True
        raise
    finally:
        if not final_status_written:
            timed_out = time.monotonic() >= deadline_monotonic
            error_short = "SCAN_TIMEOUT" if timed_out else "SCAN_INTERRUPTED"
            if is_candidate_verify_scan and verify_candidate_id:
                write_candidate_verify_status(
                    verify_candidate_id,
                    status="failed",
                    chain_key=chain,
                    coin_symbol=requested_coin_symbol,
                    address=str(scan_filters.get("address") or "").strip().lower(),
                    scan_batch_id=scan_batch_id,
                    error=error_short,
                )
                publish_collection_center_event(
                    "candidate_verify_failed",
                    {
                        "candidate_id": verify_candidate_id,
                        "chain_key": chain,
                        "asset_symbol": requested_coin_symbol,
                        "coin_symbol": requested_coin_symbol,
                        "address": str(scan_filters.get("address") or "").strip().lower(),
                        "user_id": str(scan_filters.get("user_id") or "").strip(),
                        "status": "failed",
                        "error": error_short,
                        "message": "复核失败",
                    },
                )
                logger.info(
                    "candidate verify fallback publish failed candidate_id=%s chain=%s coin=%s job_id=%s",
                    verify_candidate_id,
                    chain,
                    requested_coin_symbol,
                    job_id,
                )
            set_scan_status(
                chain,
                {
                    "status": "failed",
                    "job_id": job_id,
                    "error": error_short,
                    "job_timeout_seconds": job_timeout_seconds,
                    "started_at": started_at,
                    "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "chain_key": chain,
                    "scan_batch_id": scan_batch_id,
                    "scan_batch_started_at": scan_batch_started_at,
                    "coin_symbol": requested_coin_symbol,
                    "scanned_symbols": [requested_coin_symbol] if requested_coin_symbol else [],
                },
            )
            current_tool_snapshot = _load_tool_scan_status_snapshot(scan_batch_id, scan_filters)
            current_tool_rows = current_tool_snapshot.get("rows") if isinstance(current_tool_snapshot, dict) else []
            rows_to_write = None
            counts_to_write: Dict[str, int] = {
                "total": 0,
                "scanned": 0,
                "success_count": 0,
                "positive_count": 0,
                "zero_count": 0,
                "failed_count": 0,
            }
            if isinstance(current_tool_rows, list) and current_tool_rows:
                rows_to_write = _finalize_tool_scan_rows([row for row in current_tool_rows if isinstance(row, dict)], scan_batch_id)
                counts_to_write = _tool_scan_counts_from_rows(rows_to_write)
            _write_tool_scan_status_snapshot(
                scan_batch_id,
                chain_key=chain,
                coin_symbol=requested_coin_symbol,
                filters=scan_filters,
                status="failed",
                error=error_short,
                total=counts_to_write["total"],
                scanned=counts_to_write["scanned"],
                success_count=counts_to_write["success_count"],
                positive_count=counts_to_write["positive_count"],
                zero_count=counts_to_write["zero_count"],
                failed_count=counts_to_write["failed_count"],
                rows=rows_to_write,
            )
        db.close()
        _release_scan_lock(chain, job_id)


def _append_last_error(current: str | None, message: str) -> str:
    current_text = (current or "").strip()
    message_text = (message or "").strip()
    if not current_text:
        return message_text
    if not message_text or message_text in current_text:
        return current_text
    return f"{current_text}; {message_text}"[:1000]


def _is_guard_rejected_error(message: object) -> bool:
    return "GUARD_REJECTED" in str(message or "").upper()


def _publish_collection_task_changed_now(task: CollectionTask) -> None:
    try:
        publish_collection_center_event(
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
    except Exception:
        logger.debug("publish collection task changed failed task_id=%s", getattr(task, "id", None), exc_info=True)


def _mark_collection_task_pending_send_reason(db: Session, task: CollectionTask, message: object) -> None:
    task.status = CollectionTaskStatus.PENDING.value
    task.last_error = str(message or "GUARD_REJECTED")[:1000]
    task.next_retry_at = None
    task.locked_at = None
    task.updated_at = datetime.utcnow()
    db.flush()


def _publish_gas_task_changed_now(db: Session, task: GasTask) -> None:
    try:
        batch_id = None
        if task.collection_task_id:
            collection_task = db.query(CollectionTask).filter(CollectionTask.id == int(task.collection_task_id)).first()
            if collection_task:
                batch_id = int(collection_task.batch_id) if collection_task.batch_id is not None else None
        publish_collection_center_event(
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
                "tx_hash": task.tx_hash or "",
                "failure_reason": task.last_error or "",
                "updated_at": task.updated_at,
            },
        )
    except Exception:
        logger.debug("publish gas task changed failed task_id=%s", getattr(task, "id", None), exc_info=True)


def _mark_gas_task_pending_send_reason(db: Session, task: GasTask, message: object) -> None:
    task.status = GasTaskStatus.PENDING.value
    task.last_error = str(message or "GUARD_REJECTED")[:1000]
    task.next_retry_at = None
    task.locked_at = None
    task.updated_at = datetime.utcnow()
    db.flush()


def _tx_confirm_retry_sleep(confirm_attempt: int) -> None:
    if confirm_attempt <= 0:
        return
    time.sleep(min(5 * int(confirm_attempt), 30))


def process_tx_confirm_collection_task(task_id: int, *, confirm_attempt: int = 0) -> dict[str, object]:
    _tx_confirm_retry_sleep(int(confirm_attempt))
    db = SessionLocal()
    retry_job_id = ""
    try:
        result = confirm_collection_task_tx(db, int(task_id))
        db.commit()
        if result.status == "PENDING" and int(confirm_attempt) < TX_CONFIRM_RETRY_MAX_ATTEMPTS:
            retry_job_id = _enqueue_tx_confirm_collection_retry_task(int(task_id), int(confirm_attempt) + 1)
        return {
            "ok": result.status in {"CONFIRMED", "PENDING", "SKIPPED"},
            "task_type": result.task_type,
            "task_id": result.task_id,
            "tx_hash": result.tx_hash,
            "status": result.status,
            "block_number": result.block_number,
            "error_message": result.error_message,
            "confirm_attempt": int(confirm_attempt),
            "retry_job_id": retry_job_id,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


REAL_GAS_CONFIRMED_STATUSES = {"CONFIRMED", "SUCCESS", "COMPLETED"}
COLLECTION_GAS_WAITING_STATUSES = {
    CollectionTaskStatus.GAS_REQUIRED.value,
    CollectionTaskStatus.GAS_QUEUED.value,
    "WAITING_GAS",
    "WAIT_GAS",
    "GAS_CONFIRMING",
    "WAITING_GAS_CONFIRM",
    "PENDING_GAS",
}
COLLECTION_CONTINUE_ALLOWED_STATUSES = {
    CollectionTaskStatus.PENDING.value,
    CollectionTaskStatus.QUEUED.value,
    CollectionTaskStatus.READY.value,
    *COLLECTION_GAS_WAITING_STATUSES,
}
COLLECTION_CONTINUE_BLOCKED_STATUSES = {
    CollectionTaskStatus.SENDING.value,
    CollectionTaskStatus.SENT.value,
    CollectionTaskStatus.CONFIRMED.value,
    CollectionTaskStatus.CANCELED.value,
    "SUCCESS",
    "COMPLETED",
    "RUNNING",
    "PROCESSING",
}


def _is_dry_run_gas_hash(tx_hash: str) -> bool:
    value = str(tx_hash or "").strip().upper()
    return bool(value.startswith("DRYGAS_") or value.startswith("DRYRUN_"))


def _collection_batch_canceled(db: Session, batch_id: int | None) -> bool:
    if batch_id is None:
        return False
    batch = db.query(CollectionBatch).filter(CollectionBatch.id == int(batch_id)).first()
    return bool(batch and str(batch.status or "").upper() == CollectionBatchStatus.CANCELED.value)


def _find_collection_task_for_gas_task(db: Session, gas_task: GasTask) -> CollectionTask | None:
    linked_matches = (
        db.query(CollectionTask)
        .filter(CollectionTask.gas_task_id == int(gas_task.id))
        .filter(CollectionTask.tx_hash.is_(None))
        .filter(CollectionTask.status.in_([
            CollectionTaskStatus.GAS_REQUIRED.value,
            CollectionTaskStatus.GAS_QUEUED.value,
            CollectionTaskStatus.PENDING.value,
            CollectionTaskStatus.QUEUED.value,
            CollectionTaskStatus.READY.value,
            "WAITING_GAS",
            "WAIT_GAS",
            "GAS_CONFIRMING",
            "WAITING_GAS_CONFIRM",
            "PENDING_GAS",
        ]))
        .order_by(CollectionTask.updated_at.desc(), CollectionTask.id.desc())
        .all()
    )
    if linked_matches:
        return linked_matches[0]
    if gas_task.collection_task_id:
        task = db.query(CollectionTask).filter(CollectionTask.id == int(gas_task.collection_task_id)).first()
        if task:
            return task
    matches = (
        db.query(CollectionTask)
        .filter(CollectionTask.gas_task_id == int(gas_task.id))
        .order_by(CollectionTask.id.asc())
        .limit(2)
        .all()
    )
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        logger.warning(
            "gas confirmed collection continue skipped because gas_task_id is ambiguous gas_task_id=%s collection_task_ids=%s",
            gas_task.id,
            [item.id for item in matches],
        )
    return None


def _find_collection_tasks_for_gas_address(db: Session, gas_task: GasTask) -> list[CollectionTask]:
    chain_key = str(gas_task.chain_key or "").strip().lower()
    to_address = str(gas_task.to_address or "").strip().lower()
    if not chain_key or not to_address:
        return []
    waiting_statuses = [
        CollectionTaskStatus.GAS_REQUIRED.value,
        CollectionTaskStatus.GAS_QUEUED.value,
        CollectionTaskStatus.PENDING.value,
        "WAITING_GAS",
        "WAIT_GAS",
        "GAS_CONFIRMING",
        "WAITING_GAS_CONFIRM",
        "PENDING_GAS",
    ]
    matches = (
        db.query(CollectionTask)
        .filter(CollectionTask.tx_hash.is_(None))
        .filter(CollectionTask.status.in_(waiting_statuses))
        .filter(
            or_(
                CollectionTask.gas_task_id == int(gas_task.id),
                (
                    (func.lower(CollectionTask.chain_key) == chain_key)
                    & (func.lower(CollectionTask.from_address) == to_address)
                ),
            )
        )
        .order_by(CollectionTask.id.asc())
        .all()
    )
    seen: set[int] = set()
    unique_matches: list[CollectionTask] = []
    for item in matches:
        item_id = int(item.id)
        if item_id in seen:
            continue
        seen.add(item_id)
        unique_matches.append(item)
    return unique_matches


def _evaluate_collection_task_onchain(db: Session, task: CollectionTask) -> Any:
    meta = _load_asset_chain_meta(db, task, real_send_enabled=False)
    configured_min_amount = _load_collection_min_amount(db, task)
    evaluation = confirm_collection_candidate_onchain(
        chain_key=task.chain_key,
        coin_symbol=task.coin_symbol,
        from_address=task.from_address,
        to_address=task.to_address,
        token_contract_address=str(meta["contract_address"]),
        token_decimals=int(meta["decimals"]),
        min_collect_amount=configured_min_amount,
        db=db,
    )
    logger.info(
        "collection task onchain re-evaluation task_id=%s chain_key=%s coin_symbol=%s configured_min_amount=%s final_min_collect_amount=%s reason=%s",
        task.id,
        task.chain_key,
        task.coin_symbol,
        configured_min_amount if configured_min_amount is not None else "",
        evaluation.min_collect_amount,
        evaluation.reason,
    )
    return evaluation


def _mark_collection_ready_for_gas_confirmed_continue(db: Session, task: CollectionTask) -> None:
    status_value = str(task.status or "").upper()
    if status_value not in {CollectionTaskStatus.PENDING.value, CollectionTaskStatus.QUEUED.value, CollectionTaskStatus.READY.value}:
        task.status = CollectionTaskStatus.PENDING.value
    task.next_retry_at = None
    task.locked_at = None
    task.updated_at = datetime.utcnow()
    db.flush()


def _record_collection_continue_failure(collection_task_id: int, message: str) -> None:
    db = SessionLocal()
    try:
        record_collection_task_failure_note(db, int(collection_task_id), message)
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("collection retry after gas confirmed failure note failed task_id=%s", collection_task_id, exc_info=True)
    finally:
        db.close()


def enqueue_collection_after_real_gas_confirmed(
    gas_task_id: int,
    *,
    dry_run: bool = False,
    assume_gas_confirmed: bool = False,
) -> dict[str, object]:
    enqueue_task_ids: list[int] = []
    results: list[dict[str, object]] = []
    db = SessionLocal()
    try:
        gas_task = _get_gas_task(db, int(gas_task_id))
        if not gas_task:
            return {"continued": False, "reason": "GAS_TASK_NOT_FOUND"}
        gas_tx_hash = str(gas_task.tx_hash or "").strip()
        gas_status = str(gas_task.status or "").upper()
        gas_real_confirmed = gas_status in REAL_GAS_CONFIRMED_STATUSES
        if not gas_real_confirmed and not assume_gas_confirmed:
            return {"continued": False, "reason": "GAS_TASK_NOT_REAL_CONFIRMED"}
        if not gas_tx_hash or _is_dry_run_gas_hash(gas_tx_hash) or not gas_tx_hash.lower().startswith("0x"):
            return {"continued": False, "reason": "GAS_TX_NOT_REAL"}

        collection_tasks = _find_collection_tasks_for_gas_address(db, gas_task)
        if not collection_tasks:
            logger.info("gas confirmed collection enqueue skipped because same-address waiting collection tasks not found gas_task_id=%s", gas_task_id)
            return {"continued": False, "reason": "COLLECTION_TASK_NOT_FOUND"}

        for collection_task in collection_tasks:
            task_id = int(collection_task.id)
            collection_tx_hash = str(collection_task.tx_hash or "").strip()
            if collection_tx_hash.lower().startswith("0x") and not _is_dry_run_gas_hash(collection_tx_hash):
                logger.info(
                    "collection task enqueue skipped because already has tx_hash after gas confirmed task_id=%s gas_task_id=%s",
                    task_id,
                    gas_task_id,
                )
                results.append({"continued": False, "reason": "COLLECTION_ALREADY_HAS_TX_HASH", "collection_task_id": task_id})
                continue

            status_value = str(collection_task.status or "").upper()
            if status_value in COLLECTION_CONTINUE_BLOCKED_STATUSES:
                logger.info(
                    "collection task enqueue skipped after gas confirmed because status is blocked task_id=%s gas_task_id=%s status=%s",
                    task_id,
                    gas_task_id,
                    status_value,
                )
                results.append({"continued": False, "reason": f"COLLECTION_STATUS_{status_value}", "collection_task_id": task_id})
                continue
            if status_value not in COLLECTION_CONTINUE_ALLOWED_STATUSES:
                logger.info(
                    "collection task enqueue skipped after gas confirmed because status is not retryable task_id=%s gas_task_id=%s status=%s",
                    task_id,
                    gas_task_id,
                    status_value,
                )
                results.append({"continued": False, "reason": f"COLLECTION_STATUS_{status_value}", "collection_task_id": task_id})
                continue

            retry_count = int(collection_task.retry_count or 0)
            max_retry = int(collection_task.max_retry or 0)
            if max_retry > 0 and retry_count >= max_retry:
                logger.info(
                    "collection task enqueue skipped after gas confirmed because retry limit reached task_id=%s gas_task_id=%s retry_count=%s max_retry=%s",
                    task_id,
                    gas_task_id,
                    retry_count,
                    max_retry,
                )
                results.append({"continued": False, "reason": "COLLECTION_RETRY_LIMIT_REACHED", "collection_task_id": task_id})
                continue
            if _collection_batch_canceled(db, collection_task.batch_id):
                logger.info(
                    "collection task enqueue skipped after gas confirmed because batch canceled task_id=%s gas_task_id=%s batch_id=%s",
                    task_id,
                    gas_task_id,
                    collection_task.batch_id,
                )
                results.append({"continued": False, "reason": "COLLECTION_BATCH_CANCELED", "collection_task_id": task_id})
                continue
            if is_collection_task_job_active(task_id):
                logger.info(
                    "collection task enqueue skipped after gas confirmed because active job exists task_id=%s gas_task_id=%s",
                    task_id,
                    gas_task_id,
                )
                results.append({"continued": False, "reason": "COLLECTION_JOB_ACTIVE", "collection_task_id": task_id})
                continue

            try:
                evaluation = _evaluate_collection_task_onchain(db, collection_task)
            except Exception as exc:
                logger.warning(
                    "collection task gas re-evaluation failed after gas confirmed gas_task_id=%s collection_task_id=%s",
                    gas_task_id,
                    task_id,
                    exc_info=True,
                )
                results.append(
                    {
                        "continued": False,
                        "reason": "COLLECTION_GAS_REEVALUATION_FAILED",
                        "collection_task_id": task_id,
                        "error": str(exc)[:180],
                    }
                )
                continue
            if not evaluation.should_collect:
                results.append(
                    {
                        "continued": False,
                        "reason": "COLLECTION_NOT_COLLECTIBLE",
                        "collection_task_id": task_id,
                        "gas_recheck_reason": evaluation.reason,
                    }
                )
                continue
            if evaluation.gas_required:
                results.append(
                    {
                        "continued": False,
                        "reason": "GAS_STILL_REQUIRED",
                        "collection_task_id": task_id,
                        "gas_recheck_reason": evaluation.reason,
                    }
                )
                continue

            if dry_run:
                results.append(
                    {
                        "continued": True,
                        "would_enqueue": True,
                        "collection_task_id": task_id,
                        "from_status": status_value,
                        "gas_recheck_reason": evaluation.reason,
                    }
                )
                continue

            _mark_collection_ready_for_gas_confirmed_continue(db, collection_task)
            if str(collection_task.status or "").upper() != CollectionTaskStatus.QUEUED.value:
                mark_collection_task_queued(db, task_id)
            enqueue_task_ids.append(task_id)
            results.append(
                {
                    "continued": True,
                    "will_enqueue": True,
                    "collection_task_id": task_id,
                    "from_status": status_value,
                    "gas_recheck_reason": evaluation.reason,
                }
            )

        if dry_run:
            continued = any(bool(item.get("continued")) for item in results)
            return {"continued": continued, "dry_run": True, "results": results}
        if not enqueue_task_ids:
            db.commit()
            return {"continued": False, "reason": "NO_COLLECTION_TASK_ENQUEUED", "results": results}
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("collection enqueue after gas confirmed preflight failed gas_task_id=%s", gas_task_id, exc_info=True)
        return {"continued": False, "reason": "COLLECTION_CONTINUE_PREFLIGHT_FAILED", "error": str(exc)[:180]}
    finally:
        db.close()

    job_results: list[dict[str, object]] = []
    for task_id in enqueue_task_ids:
        try:
            job_id = enqueue_collection_task(task_id, allow_real_send=True)
        except Exception as exc:
            message = f"GAS_CONFIRMED_BUT_COLLECTION_ENQUEUE_FAILED:{type(exc).__name__}:{str(exc)[:180]}"
            _record_collection_continue_failure(task_id, message)
            logger.warning(
                "collection enqueue after gas confirmed failed gas_task_id=%s collection_task_id=%s",
                gas_task_id,
                task_id,
                exc_info=True,
            )
            job_results.append(
                {
                    "continued": False,
                    "reason": "COLLECTION_ENQUEUE_EXCEPTION",
                    "collection_task_id": task_id,
                    "error": str(exc)[:180],
                }
            )
            continue
        logger.info("gas confirmed, enqueued collection task gas_task_id=%s collection_task_id=%s job_id=%s", gas_task_id, task_id, job_id)
        job_results.append({"continued": True, "enqueued": True, "collection_task_id": task_id, "job_id": job_id})
    return {
        "continued": any(bool(item.get("continued")) for item in job_results),
        "enqueued_count": sum(1 for item in job_results if item.get("enqueued")),
        "results": results,
        "jobs": job_results,
    }


def _continue_collection_after_real_gas_confirmed(gas_task_id: int, confirm_result: Any) -> dict[str, object]:
    result_status = str(getattr(confirm_result, "status", "") or "").upper()
    result_tx_hash = str(getattr(confirm_result, "tx_hash", "") or "").strip()
    if result_status not in REAL_GAS_CONFIRMED_STATUSES:
        return {"continued": False, "reason": f"GAS_CONFIRM_STATUS_{result_status or 'EMPTY'}"}
    if not result_tx_hash or _is_dry_run_gas_hash(result_tx_hash):
        logger.info(
            "gas confirmed collection continue skipped because tx_hash is not real gas_task_id=%s tx_hash=%s",
            gas_task_id,
            result_tx_hash,
        )
        return {"continued": False, "reason": "GAS_TX_NOT_REAL"}
    return enqueue_collection_after_real_gas_confirmed(int(gas_task_id))


def process_tx_confirm_gas_task(task_id: int, *, confirm_attempt: int = 0) -> dict[str, object]:
    _tx_confirm_retry_sleep(int(confirm_attempt))
    db = SessionLocal()
    retry_job_id = ""
    try:
        result = confirm_gas_task_tx(db, int(task_id))
        db.commit()
        if result.status == "PENDING" and int(confirm_attempt) < TX_CONFIRM_RETRY_MAX_ATTEMPTS:
            retry_job_id = _enqueue_tx_confirm_gas_retry_task(int(task_id), int(confirm_attempt) + 1)
        continue_result = _continue_collection_after_real_gas_confirmed(int(task_id), result)
        return {
            "ok": result.status in {"CONFIRMED", "PENDING", "SKIPPED"},
            "task_type": result.task_type,
            "task_id": result.task_id,
            "tx_hash": result.tx_hash,
            "status": result.status,
            "block_number": result.block_number,
            "error_message": result.error_message,
            "confirm_attempt": int(confirm_attempt),
            "retry_job_id": retry_job_id,
            "collection_continue": continue_result,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def process_collection_task(task_id: int, *, allow_real_send: bool = False) -> dict[str, object]:
    db = SessionLocal()
    try:
        master_switch_enabled = is_collection_real_send_enabled()
        real_send_enabled = bool(allow_real_send and master_switch_enabled)
        task = _get_collection_task(db, task_id)
        if not task:
            return {"ok": False, "reason": "TASK_NOT_FOUND", "task_id": task_id}

        if task.status not in {
            CollectionTaskStatus.PENDING.value,
            CollectionTaskStatus.QUEUED.value,
            CollectionTaskStatus.FAILED.value,
            CollectionTaskStatus.GAS_REQUIRED.value,
            CollectionTaskStatus.GAS_QUEUED.value,
        }:
            return {"ok": True, "skipped": True, "reason": f"STATUS_{task.status}", "task_id": task_id}

        if allow_real_send and not master_switch_enabled:
            message = "GUARD_REJECTED:MASTER_SWITCH_OFF"
            _mark_collection_task_pending_send_reason(db, task, message)
            db.commit()
            _publish_collection_task_changed_now(task)
            return {"ok": False, "status": CollectionTaskStatus.PENDING.value, "task_id": task_id, "error": message}

        if task.status != CollectionTaskStatus.QUEUED.value:
            mark_collection_task_queued(db, task.id)
        mark_collection_task_sending(db, task.id)
        db.flush()

        gas_required = False
        should_collect = True
        dryrun_note = ""
        try:
            meta = _load_asset_chain_meta(db, task, real_send_enabled=real_send_enabled)
            configured_min_amount = _load_collection_min_amount(db, task)
            evaluation = confirm_collection_candidate_onchain(
                chain_key=task.chain_key,
                coin_symbol=task.coin_symbol,
                from_address=task.from_address,
                to_address=task.to_address,
                token_contract_address=str(meta["contract_address"]),
                token_decimals=int(meta["decimals"]),
                min_collect_amount=configured_min_amount,
                db=db,
            )
            logger.info(
                "collection task onchain evaluation task_id=%s chain_key=%s coin_symbol=%s configured_min_amount=%s final_min_collect_amount=%s reason=%s",
                task.id,
                task.chain_key,
                task.coin_symbol,
                configured_min_amount if configured_min_amount is not None else "",
                evaluation.min_collect_amount,
                evaluation.reason,
            )
            should_collect = evaluation.should_collect
            gas_required = evaluation.gas_required
            if gas_required and not real_send_enabled and _linked_gas_task_confirmed(db, task):
                logger.info(
                    "collection task dry-run gas bypass task_id=%s gas_task_id=%s chain_key=%s coin_symbol=%s reason=%s",
                    task.id,
                    task.gas_task_id,
                    task.chain_key,
                    task.coin_symbol,
                    evaluation.reason,
                )
                gas_required = False
        except (CollectionBalanceCheckerError, Exception) as exc:
            dryrun_note = f"DRY_RUN_ONCHAIN_SKIPPED: {str(exc)[:180]}"
            should_collect = Decimal(str(task.amount or 0)) > 0
            gas_required = False

        if not should_collect:
            mark_collection_task_skipped(db, task.id, "DRY_RUN_NOT_COLLECTIBLE")
            db.commit()
            return {"ok": True, "status": CollectionTaskStatus.SKIPPED.value, "task_id": task.id}

        if gas_required:
            try:
                gas_task = _create_wait_gas_task_for_collection(
                    db,
                    task,
                    evaluation,
                )
            except Exception as exc:
                mark_collection_task_failed(
                    db,
                    task.id,
                    f"GAS_TASK_CREATE_FAILED:{type(exc).__name__}:{str(exc)[:180]}",
                    retryable=True,
                )
                db.commit()
                return {
                    "ok": False,
                    "status": CollectionTaskStatus.FAILED.value,
                    "gas_required": True,
                    "task_id": task.id,
                    "error": str(exc)[:180],
                }
            db.commit()
            gas_job_id = None
            if gas_task.status in {GasTaskStatus.PENDING.value, GasTaskStatus.FAILED.value}:
                try:
                    gas_job_id = enqueue_gas_task(int(gas_task.id), allow_real_send=real_send_enabled)
                except Exception as exc:
                    gas_job_id = None
                    logger.exception(
                        "failed to enqueue gas task after collection gas required collection_task_id=%s gas_task_id=%s",
                        task.id,
                        gas_task.id,
                    )
                    db_note = SessionLocal()
                    try:
                        linked_task = _get_collection_task(db_note, int(task.id))
                        linked_task.last_error = _append_last_error(
                            linked_task.last_error,
                            f"GAS_TASK_ENQUEUE_FAILED:{type(exc).__name__}:{str(exc)[:180]}",
                        )
                        db_note.commit()
                    except Exception:
                        db_note.rollback()
                    finally:
                        db_note.close()
            return {
                "ok": True,
                "status": CollectionTaskStatus.GAS_REQUIRED.value,
                "gas_required": True,
                "gas_task_id": int(gas_task.id),
                "gas_job_id": gas_job_id,
                "task_id": task.id,
            }

        meta = _load_asset_chain_meta(db, task, real_send_enabled=real_send_enabled)
        send_result = send_erc20_collect_transfer(
            chain_key=task.chain_key,
            token_contract_address=str(meta["contract_address"]),
            token_decimals=int(meta["decimals"]),
            from_private_key=lambda: _collection_private_key_for_task(task, real_send_enabled=real_send_enabled),
            from_address=task.from_address,
            to_address=task.to_address,
            amount=Decimal(str(task.amount or 0)),
            coin_symbol=task.coin_symbol,
            db=db,
            force_dry_run=not real_send_enabled,
        )
        if not send_result.ok or not send_result.tx_hash:
            if allow_real_send and _is_guard_rejected_error(send_result.error_message):
                _mark_collection_task_pending_send_reason(db, task, send_result.error_message or "GUARD_REJECTED")
                db.commit()
                _publish_collection_task_changed_now(task)
                return {
                    "ok": False,
                    "status": CollectionTaskStatus.PENDING.value,
                    "task_id": task.id,
                    "error": send_result.error_message,
                }
            mark_collection_task_failed(db, task.id, send_result.error_message or "collection send failed", retryable=True)
            db.commit()
            return {"ok": False, "status": CollectionTaskStatus.FAILED.value, "task_id": task.id, "error": send_result.error_message}
        mark_collection_task_sent(db, task.id, send_result.tx_hash)
        tx_confirm_job_id = None
        tx_confirm_enqueue_error = None
        if not send_result.dry_run:
            try:
                tx_confirm_job_id = enqueue_tx_confirm_collection_task(int(task.id))
            except Exception as exc:
                tx_confirm_enqueue_error = f"TX_CONFIRM_ENQUEUE_FAILED:{type(exc).__name__}:{str(exc)[:180]}"
                task.last_error = _append_last_error(task.last_error, tx_confirm_enqueue_error)
                logger.exception("failed to enqueue tx_confirm for collection task %s", task.id)
        task.last_error = _append_last_error(task.last_error, dryrun_note)
        db.commit()
        return {
            "ok": True,
            "status": CollectionTaskStatus.SENT.value,
            "tx_hash": send_result.tx_hash,
            "dry_run": send_result.dry_run,
            "tx_confirm_job_id": tx_confirm_job_id,
            "tx_confirm_enqueue_error": tx_confirm_enqueue_error,
            "task_id": task.id,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def process_gas_task(task_id: int, *, allow_real_send: bool = False) -> dict[str, object]:
    db = SessionLocal()
    try:
        master_switch_enabled = is_collection_real_send_enabled()
        real_send_enabled = bool(allow_real_send and master_switch_enabled)
        task = _get_gas_task(db, task_id)
        if not task:
            return {"ok": False, "reason": "GAS_TASK_NOT_FOUND", "task_id": task_id}
        if task.status not in {GasTaskStatus.PENDING.value, GasTaskStatus.QUEUED.value, GasTaskStatus.FAILED.value}:
            return {"ok": True, "skipped": True, "reason": f"STATUS_{task.status}", "task_id": task_id}

        if allow_real_send and not master_switch_enabled:
            message = "GUARD_REJECTED:MASTER_SWITCH_OFF"
            mark_gas_task_failed(db, task.id, message, retryable=False)
            db.commit()
            _publish_gas_task_changed_now(db, task)
            return {"ok": False, "status": GasTaskStatus.FAILED.value, "task_id": task_id, "error": message}

        if task.status != GasTaskStatus.QUEUED.value:
            mark_gas_task_queued(db, task.id)
        mark_gas_task_sending(db, task.id)

        try:
            get_native_balance(chain_key=task.chain_key, address=task.to_address, db=db)
        except Exception as exc:
            task.last_error = f"DRY_GAS_ONCHAIN_SKIPPED: {str(exc)[:180]}"

        if Decimal(str(task.topup_amount or 0)) <= 0:
            mark_gas_task_skipped(db, task.id, "DRY_GAS_TOPUP_NOT_POSITIVE")
            db.commit()
            return {"ok": True, "status": GasTaskStatus.SKIPPED.value, "task_id": task.id}

        send_result = send_native_gas_topup(
            chain_key=task.chain_key,
            from_private_key=lambda: _gas_private_key_for_task(db, task, real_send_enabled=real_send_enabled),
            from_address=task.from_address,
            to_address=task.to_address,
            amount=Decimal(str(task.topup_amount or 0)),
            db=db,
            force_dry_run=not real_send_enabled,
        )
        if not send_result.ok or not send_result.tx_hash:
            if allow_real_send and _is_guard_rejected_error(send_result.error_message):
                mark_gas_task_failed(db, task.id, send_result.error_message or "GUARD_REJECTED", retryable=False)
                db.commit()
                _publish_gas_task_changed_now(db, task)
                return {
                    "ok": False,
                    "status": GasTaskStatus.FAILED.value,
                    "task_id": task.id,
                    "error": send_result.error_message,
                }
            mark_gas_task_failed(db, task.id, send_result.error_message or "gas send failed", retryable=True)
            db.commit()
            return {"ok": False, "status": GasTaskStatus.FAILED.value, "task_id": task.id, "error": send_result.error_message}
        mark_gas_task_sent(db, task.id, send_result.tx_hash)
        tx_confirm_job_id = None
        tx_confirm_enqueue_error = None
        if not send_result.dry_run:
            try:
                tx_confirm_job_id = enqueue_tx_confirm_gas_task(int(task.id))
            except Exception as exc:
                tx_confirm_enqueue_error = f"TX_CONFIRM_ENQUEUE_FAILED:{type(exc).__name__}:{str(exc)[:180]}"
                task.last_error = _append_last_error(task.last_error, tx_confirm_enqueue_error)
                logger.exception("failed to enqueue tx_confirm for gas task %s", task.id)
        db.commit()
        return {
            "ok": True,
            "status": GasTaskStatus.SENT.value,
            "tx_hash": send_result.tx_hash,
            "dry_run": send_result.dry_run,
            "tx_confirm_job_id": tx_confirm_job_id,
            "tx_confirm_enqueue_error": tx_confirm_enqueue_error,
            "task_id": task.id,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
