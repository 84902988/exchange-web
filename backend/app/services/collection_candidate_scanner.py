from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
import logging
import time
from typing import Any, Iterable, Mapping, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.rq import get_redis_connection
from app.db.models.collection import CollectionBatch
from app.services.collection_balance_checker import get_collection_onchain_balances, get_rpc_urls_for_chain
from app.services.collection_center_events import publish_collection_center_event
from app.services.collection_chain_helper import CollectionEvaluationResult, evaluate_collection_candidate
from app.services.collection_candidate_registry import mark_collection_candidate_scanned
from app.services.collection_service import (
    create_collection_batch,
    create_collection_task_with_result,
    create_gas_task,
    find_active_collection_task_duplicate,
    find_active_gas_task_duplicate,
    find_collection_task_by_idempotency,
)


logger = logging.getLogger(__name__)

CONFIG_ONLY_DRY_RUN_CHAIN_KEYS = {"avaxc", "ethereum", "optimism", "solana"}
BSC_SCAN_MAX_ADDRESSES = 20
ADDRESS_BALANCE_SCAN_TIMEOUT_SECONDS = 8.0
BSC_ADDRESS_BALANCE_SCAN_TIMEOUT_SECONDS = 8.0
TOOL_SCAN_PROGRESS_TTL_SECONDS = 24 * 60 * 60
TOOL_SCAN_TERMINAL_STATUSES = {"completed", "failed", "timeout", "skipped"}
VERIFY_RUNNING_TTL_SECONDS = 10 * 60
VERIFY_COMPLETED_TTL_SECONDS = 5 * 60
VERIFY_FAILED_TTL_SECONDS = 10 * 60
_UNSET = object()


@dataclass(frozen=True)
class CollectionCandidate:
    user_id: int
    chain_key: str
    coin_symbol: str
    asset_chain_id: Optional[int]
    from_address: str
    to_address: str
    token_balance: Decimal
    native_balance: Decimal
    balance_source: str
    balance_checked_at: Optional[datetime]
    balance_error: str
    evaluation: CollectionEvaluationResult
    should_create_task: bool
    reason: str


@dataclass(frozen=True)
class ScanResult:
    total_addresses: int
    evaluated_count: int
    collectible_count: int
    gas_required_count: int
    skipped_count: int
    created_task_count: int
    created_gas_task_count: int
    candidates: list[CollectionCandidate]
    skipped_duplicate_count: int = 0
    skipped_gas_required_count: int = 0
    gas_task_skipped_duplicate_count: int = 0
    gas_task_skipped_config_missing_count: int = 0
    created_task_ids: list[int] = field(default_factory=list)
    created_gas_task_ids: list[int] = field(default_factory=list)
    batch_id: Optional[int] = None
    batch_no: Optional[str] = None
    warnings: list[str] = field(default_factory=list)
    error_message: Optional[str] = None


def _get_columns(db: Session, table_name: str) -> set[str]:
    rows = db.execute(
        text(
            """
            SELECT COLUMN_NAME
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = :table_name
            """
        ),
        {"table_name": table_name},
    ).mappings().all()
    return {str(row["COLUMN_NAME"]) for row in rows}


def _has_table(db: Session, table_name: str) -> bool:
    return bool(_get_columns(db, table_name))


def _address_active_filter(columns: set[str]) -> str:
    if "is_active" in columns:
        return " AND COALESCE(uca.is_active, 0) = 1"
    if "enabled" in columns:
        return " AND COALESCE(uca.enabled, 0) = 1"
    return ""


def _load_candidate_rows(
    db: Session,
    *,
    chain_key: Optional[str],
    coin_symbol: Optional[str],
    user_id: Optional[int] = None,
    address: str = "",
    limit: int,
    include_config_only_chains: bool = False,
    exclude_existing_candidates: bool = False,
) -> list[Mapping[str, Any]]:
    columns = _get_columns(db, "user_chain_addresses")
    asset_chain_columns = _get_columns(db, "asset_chains")
    chain_columns = _get_columns(db, "chains")
    collection_min_amount_sql = (
        "ac.collection_min_amount AS collection_min_amount"
        if "collection_min_amount" in asset_chain_columns
        else "NULL AS collection_min_amount"
    )
    if not {"user_id", "address"}.issubset(columns):
        raise RuntimeError("user_chain_addresses must contain user_id and address columns")

    has_chain_key = "chain_key" in columns
    has_chain_id = "chain_id" in columns
    if not has_chain_key and not has_chain_id:
        raise RuntimeError("user_chain_addresses must contain chain_key or chain_id")

    chain_key_expr = "uca.chain_key" if has_chain_key else "NULL"
    join_chain_sql = "LEFT JOIN chains c ON c.id = uca.chain_id" if has_chain_id else "LEFT JOIN chains c ON c.chain_key = uca.chain_key"
    resolved_chain_key_expr = "COALESCE(NULLIF(LOWER(TRIM({chain_key_expr})), ''), LOWER(TRIM(c.chain_key)))".format(
        chain_key_expr=chain_key_expr
    )

    filters = [
        "uca.user_id IS NOT NULL",
        "uca.address IS NOT NULL",
        "TRIM(uca.address) <> ''",
        "c.enabled = 1",
        "a.enabled = 1",
        "ac.enabled = 1",
    ]
    if "collection_enabled" in chain_columns:
        filters.append("COALESCE(c.collection_enabled, 0) = 1")
    if not include_config_only_chains:
        filters.append("ac.deposit_enabled = 1")
    params: dict[str, Any] = {"limit": int(limit)}
    if chain_key:
        filters.append("LOWER(c.chain_key) = :chain_key")
        params["chain_key"] = chain_key.strip().lower()
    if coin_symbol:
        filters.append("UPPER(a.symbol) = :coin_symbol")
        params["coin_symbol"] = coin_symbol.strip().upper()
    if user_id is not None:
        filters.append("uca.user_id = :user_id")
        params["user_id"] = int(user_id)
    address_text = str(address or "").strip().lower()
    if address_text:
        filters.append("LOWER(uca.address) LIKE :address")
        params["address"] = f"%{address_text}%"

    candidate_join_sql = ""
    candidate_filter_sql = ""
    if exclude_existing_candidates and _has_table(db, "collection_candidates"):
        candidate_join_sql = """
        LEFT JOIN collection_candidates cc
          ON LOWER(cc.chain_key) = LOWER(c.chain_key)
         AND LOWER(cc.token_contract) = LOWER(ac.contract_address)
         AND LOWER(cc.address) = LOWER(uca.address)
         AND cc.status <> 'DISABLED'
        """
        candidate_filter_sql = "AND cc.id IS NULL"

    sql = f"""
        SELECT
          uca.user_id AS user_id,
          LOWER(uca.address) AS from_address,
          {resolved_chain_key_expr} AS chain_key,
          a.symbol AS coin_symbol,
          ac.id AS asset_chain_id,
          ac.contract_address AS token_contract_address,
          ac.decimals AS token_decimals,
          {collection_min_amount_sql},
          c.collection_address AS chain_collection_address,
          c.hot_wallet_address AS chain_hot_wallet_address,
          c.native_symbol AS chain_native_symbol
        FROM user_chain_addresses uca
        {join_chain_sql}
        JOIN asset_chains ac ON ac.chain_id = c.id
        JOIN assets a ON a.id = ac.asset_id
        {candidate_join_sql}
        WHERE {" AND ".join(filters)}
          {_address_active_filter(columns)}
          {candidate_filter_sql}
        ORDER BY uca.id ASC, ac.id ASC
        LIMIT :limit
    """
    return db.execute(text(sql), params).mappings().all()


def _load_event_candidate_rows(
    db: Session,
    *,
    chain_key: Optional[str],
    coin_symbol: Optional[str],
    user_id: Optional[int] = None,
    address: str = "",
    limit: int,
) -> list[Mapping[str, Any]]:
    if not _has_table(db, "collection_candidates"):
        return []
    asset_chain_columns = _get_columns(db, "asset_chains")
    chain_columns = _get_columns(db, "chains")
    collection_min_amount_sql = (
        "ac.collection_min_amount AS collection_min_amount"
        if "collection_min_amount" in asset_chain_columns
        else "NULL AS collection_min_amount"
    )
    filters = [
        "cc.status IN ('PENDING', 'ACTIVE', 'PENDING_VERIFY')",
        "cc.address IS NOT NULL",
        "TRIM(cc.address) <> ''",
        "cc.token_contract IS NOT NULL",
        "TRIM(cc.token_contract) <> ''",
        "c.enabled = 1",
        "a.enabled = 1",
        "ac.enabled = 1",
    ]
    if "collection_enabled" in chain_columns:
        filters.append("COALESCE(c.collection_enabled, 0) = 1")
    params: dict[str, Any] = {"limit": int(limit)}
    if chain_key:
        filters.append("LOWER(cc.chain_key) = :chain_key")
        params["chain_key"] = chain_key.strip().lower()
    if coin_symbol:
        filters.append("UPPER(cc.asset_symbol) = :coin_symbol")
        params["coin_symbol"] = coin_symbol.strip().upper()
    if user_id is not None:
        filters.append("cc.user_id = :user_id")
        params["user_id"] = int(user_id)
    address_text = str(address or "").strip().lower()
    if address_text:
        filters.append("LOWER(cc.address) LIKE :address")
        params["address"] = f"%{address_text}%"

    sql = f"""
        SELECT
          cc.id AS candidate_id,
          cc.user_id AS user_id,
          LOWER(cc.address) AS from_address,
          LOWER(cc.chain_key) AS chain_key,
          UPPER(cc.asset_symbol) AS coin_symbol,
          COALESCE(cc.asset_chain_id, ac.id) AS asset_chain_id,
          COALESCE(NULLIF(cc.token_contract, ''), ac.contract_address) AS token_contract_address,
          ac.decimals AS token_decimals,
          {collection_min_amount_sql},
          c.collection_address AS chain_collection_address,
          c.hot_wallet_address AS chain_hot_wallet_address,
          c.native_symbol AS chain_native_symbol
        FROM collection_candidates cc
        JOIN chains c ON LOWER(c.chain_key) = LOWER(cc.chain_key)
        JOIN assets a ON UPPER(a.symbol) = UPPER(cc.asset_symbol)
        JOIN asset_chains ac ON ac.chain_id = c.id
          AND ac.asset_id = a.id
          AND LOWER(ac.contract_address) = LOWER(cc.token_contract)
        WHERE {" AND ".join(filters)}
        ORDER BY cc.latest_deposit_at DESC, cc.updated_at DESC, cc.id DESC
        LIMIT :limit
    """
    return db.execute(text(sql), params).mappings().all()


def _to_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    text_value = str(value).strip()
    if not text_value or text_value in {"-", "None", "none", "null", "NULL"}:
        return Decimal("0")
    try:
        return Decimal(text_value)
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def _get_batch(db: Session, batch_id: Optional[int]) -> Optional[CollectionBatch]:
    if batch_id is None:
        return None
    return db.query(CollectionBatch).filter(CollectionBatch.id == batch_id).first()


def _normalize_optional_address(value: Any) -> str:
    return str(value or "").strip().lower()


def _record_warning(warnings: list[str], message: str) -> None:
    if message in warnings:
        return
    warnings.append(message)
    logger.warning(message)


def _tool_scan_progress_key(scan_batch_id: str) -> str:
    return f"collection:tool_scan:{str(scan_batch_id or '').strip()}"


def candidate_verify_status_key(candidate_id: Any) -> str:
    return f"collection:candidate_verify:{int(candidate_id or 0)}"


def write_candidate_verify_status(
    candidate_id: Any,
    *,
    status: str,
    chain_key: str = "",
    coin_symbol: str = "",
    address: str = "",
    scan_batch_id: str = "",
    balance_amount: Any = None,
    error: str = "",
) -> None:
    try:
        normalized_id = int(candidate_id or 0)
    except Exception:
        normalized_id = 0
    if normalized_id <= 0:
        logger.warning("collection candidate verify status write skipped: candidate_id missing")
        return
    now_iso = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    status_value = str(status or "").strip().lower() or "running"
    payload = {
        "candidate_id": normalized_id,
        "status": status_value,
        "chain_key": str(chain_key or "").strip().lower(),
        "coin_symbol": str(coin_symbol or "").strip().upper(),
        "address": str(address or "").strip().lower(),
        "scan_batch_id": str(scan_batch_id or "").strip(),
        "updated_at": now_iso,
    }
    ttl_seconds = VERIFY_RUNNING_TTL_SECONDS
    if status_value == "running":
        payload["started_at"] = now_iso
    elif status_value == "completed":
        payload["completed_at"] = now_iso
        payload["balance_amount"] = _progress_json_safe(balance_amount)
        ttl_seconds = VERIFY_COMPLETED_TTL_SECONDS
    elif status_value == "failed":
        payload["failed_at"] = now_iso
        payload["error"] = str(error or "VERIFY_FAILED")[:180]
        ttl_seconds = VERIFY_FAILED_TTL_SECONDS
    try:
        get_redis_connection().set(
            candidate_verify_status_key(normalized_id),
            json.dumps(_progress_json_safe(payload), ensure_ascii=False, sort_keys=True),
            ex=ttl_seconds,
        )
    except Exception as exc:
        logger.warning("collection candidate verify status write failed candidate_id=%s error=%s", normalized_id, exc)


def load_candidate_verify_statuses(candidate_ids: Iterable[Any]) -> dict[int, dict[str, Any]]:
    ids: list[int] = []
    for candidate_id in candidate_ids:
        try:
            normalized_id = int(candidate_id or 0)
        except Exception:
            normalized_id = 0
        if normalized_id > 0 and normalized_id not in ids:
            ids.append(normalized_id)
    if not ids:
        return {}
    try:
        redis = get_redis_connection()
        values = redis.mget([candidate_verify_status_key(candidate_id) for candidate_id in ids])
    except Exception as exc:
        logger.debug("collection candidate verify statuses read failed error=%s", exc)
        return {}
    result: dict[int, dict[str, Any]] = {}
    for candidate_id, raw in zip(ids, values):
        try:
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            payload = json.loads(str(raw or "{}"))
            if isinstance(payload, dict):
                result[candidate_id] = payload
        except Exception:
            continue
    return result


def _progress_json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, dict):
        return {str(key): _progress_json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_progress_json_safe(item) for item in value]
    return value


def _write_tool_scan_progress(scan_batch_id: str, payload: dict[str, Any]) -> None:
    if not str(scan_batch_id or "").strip():
        logger.warning("collection tool scan progress write skipped: scan_batch_id missing")
        return
    try:
        get_redis_connection().set(
            _tool_scan_progress_key(scan_batch_id),
            json.dumps(_progress_json_safe(payload), ensure_ascii=False, sort_keys=True),
            ex=TOOL_SCAN_PROGRESS_TTL_SECONDS,
        )
    except Exception as exc:
        logger.warning("collection tool scan progress write failed batch=%s error=%s", scan_batch_id, exc)


def _load_tool_scan_progress(scan_batch_id: str) -> dict[str, Any]:
    batch_id = str(scan_batch_id or "").strip()
    if not batch_id:
        return {}
    try:
        raw = get_redis_connection().get(_tool_scan_progress_key(batch_id))
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        payload = json.loads(str(raw or "{}"))
        return payload if isinstance(payload, dict) else {}
    except Exception as exc:
        logger.debug("collection tool scan progress read failed batch=%s error=%s", batch_id, exc)
        return {}


def _tool_scan_initial_rows(rows: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "user_id": int(row.get("user_id") or 0),
            "address": str(row.get("from_address") or "").strip().lower(),
            "asset_symbol": str(row.get("coin_symbol") or "").strip().upper(),
            "status": "pending",
            "balance_amount": None,
            "error": None,
            "candidate_exists": False,
        }
        for row in rows
    ]


def prepare_collection_tool_scan_progress(
    db: Session,
    *,
    scan_batch_id: str,
    chain_key: str,
    coin_symbol: str,
    user_id: Optional[int] = None,
    address: str = "",
    limit: int = 100,
) -> dict[str, Any]:
    requested_chain_key = str(chain_key or "").strip().lower()
    requested_coin_symbol = str(coin_symbol or "").strip().upper()
    effective_limit = min(int(limit), BSC_SCAN_MAX_ADDRESSES) if requested_chain_key == "bsc" else int(limit)
    rows = _load_candidate_rows(
        db,
        chain_key=requested_chain_key,
        coin_symbol=requested_coin_symbol,
        user_id=user_id,
        address=address,
        limit=effective_limit,
        include_config_only_chains=False,
        exclude_existing_candidates=True,
    )
    now_iso = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    progress_rows = _tool_scan_initial_rows(list(rows))
    status = "completed" if not progress_rows else "queued"
    payload = {
        "status": status,
        "chain_key": requested_chain_key,
        "coin_symbol": requested_coin_symbol,
        "filters": {
            "chain_key": requested_chain_key,
            "coin_symbol": requested_coin_symbol,
            "user_id": str(user_id or ""),
            "address": str(address or "").strip().lower(),
        },
        "total": len(progress_rows),
        "scanned": 0,
        "current_address": "",
        "success_count": 0,
        "positive_count": 0,
        "zero_count": 0,
        "failed_count": 0,
        "started_at": now_iso,
        "updated_at": now_iso,
        "rows": progress_rows,
        "message": "当前筛选范围内暂无未入候选地址" if not progress_rows else "",
    }
    if not progress_rows:
        payload["finished_at"] = now_iso
        payload["completed_at"] = now_iso
    _write_tool_scan_progress(scan_batch_id, payload)
    return payload


def finalize_tool_scan_snapshot(snapshot: dict[str, Any], *, scan_batch_id: str = "") -> dict[str, Any]:
    rows = [row for row in (snapshot.get("rows") or []) if isinstance(row, dict)]
    for row in rows:
        status = str(row.get("status") or "").strip().lower()
        if status in {"", "pending", "running", "scanning"}:
            logger.debug(
                "collection tool scan stale row finalized scan_batch_id=%s address=%s old_status=%s",
                scan_batch_id or str(snapshot.get("scan_batch_id") or ""),
                str(row.get("address") or ""),
                status or "-",
            )
            if row.get("balance_amount") not in {None, "", "-"}:
                row["status"] = "completed"
                row["error"] = None
            else:
                row["status"] = "failed"
                row["error"] = row.get("error") or "SCAN_ROW_NOT_FINALIZED"
    completed = [
        row
        for row in rows
        if str(row.get("status") or "").strip().lower() == "completed"
    ]
    failed = [
        row
        for row in rows
        if str(row.get("status") or "").strip().lower() in {"failed", "timeout"}
    ]
    terminal = [
        row
        for row in rows
        if str(row.get("status") or "").strip().lower() in TOOL_SCAN_TERMINAL_STATUSES
    ]
    snapshot["rows"] = rows
    snapshot["total"] = len(rows)
    snapshot["scanned"] = len(terminal)
    snapshot["success_count"] = len(completed)
    snapshot["failed_count"] = len(failed)
    snapshot["skipped_count"] = sum(
        1
        for row in rows
        if str(row.get("status") or "").strip().lower() == "skipped"
    )
    snapshot["positive_count"] = sum(1 for row in completed if _to_decimal(row.get("balance_amount")) > 0)
    snapshot["zero_count"] = sum(1 for row in completed if _to_decimal(row.get("balance_amount")) <= 0)
    if snapshot["total"] == snapshot["scanned"] and all(
        str(row.get("status") or "").strip().lower() in TOOL_SCAN_TERMINAL_STATUSES for row in rows
    ):
        snapshot["status"] = "completed"
    return snapshot


def _refresh_tool_scan_counts(tool_progress: dict[str, Any]) -> None:
    rows = [row for row in (tool_progress.get("rows") or []) if isinstance(row, dict)]
    completed = [row for row in rows if str(row.get("status") or "").strip().lower() == "completed"]
    failed = [row for row in rows if str(row.get("status") or "").strip().lower() in {"failed", "timeout"}]
    terminal = [row for row in rows if str(row.get("status") or "").strip().lower() in TOOL_SCAN_TERMINAL_STATUSES]
    tool_progress["total"] = len(rows)
    tool_progress["scanned"] = len(terminal)
    tool_progress["success_count"] = len(completed)
    tool_progress["failed_count"] = len(failed)
    tool_progress["skipped_count"] = sum(1 for row in rows if str(row.get("status") or "").strip().lower() == "skipped")
    tool_progress["positive_count"] = sum(1 for row in completed if _to_decimal(row.get("balance_amount")) > 0)
    tool_progress["zero_count"] = sum(1 for row in completed if _to_decimal(row.get("balance_amount")) <= 0)


def _tool_scan_all_rows_terminal(tool_progress: dict[str, Any]) -> bool:
    rows = [row for row in (tool_progress.get("rows") or []) if isinstance(row, dict)]
    return all(str(row.get("status") or "").strip().lower() in TOOL_SCAN_TERMINAL_STATUSES for row in rows)


def _mark_tool_scan_row_terminal(
    tool_progress: Optional[dict[str, Any]],
    index: int,
    scan_batch_id: str,
    *,
    status: str,
    error: str = "",
    balance_amount: Any = _UNSET,
) -> None:
    if tool_progress is None or index >= len(tool_progress.get("rows") or []):
        return
    row = tool_progress["rows"][index]
    if not isinstance(row, dict):
        return
    row["status"] = status
    row["error"] = error
    if balance_amount is not _UNSET:
        row["balance_amount"] = balance_amount
    _refresh_tool_scan_counts(tool_progress)
    tool_progress["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    _write_tool_scan_progress(scan_batch_id, tool_progress)


def _finalize_tool_scan_rows(
    tool_progress: dict[str, Any],
    reason: str = "SCAN_ROW_NOT_FINALIZED",
    *,
    scan_batch_id: str = "",
) -> None:
    finalize_tool_scan_snapshot(tool_progress, scan_batch_id=scan_batch_id)
    for row in tool_progress.get("rows") or []:
        if isinstance(row, dict) and row.get("error") is None:
            row["error"] = ""


def _finalize_single_tool_scan_row(
    tool_progress: Optional[dict[str, Any]],
    index: int,
    scan_batch_id: str,
    *,
    reason: str = "SCAN_ROW_NOT_FINALIZED",
) -> None:
    if tool_progress is None or index >= len(tool_progress.get("rows") or []):
        return
    row = tool_progress["rows"][index]
    if not isinstance(row, dict):
        return
    status = str(row.get("status") or "").strip().lower()
    if status in {"", "pending", "running", "scanning"}:
        logger.debug(
            "collection tool scan stale row finalized scan_batch_id=%s address=%s old_status=%s",
            scan_batch_id,
            str(row.get("address") or ""),
            status or "-",
        )
        if row.get("balance_amount") not in {None, ""}:
            row["status"] = "completed"
            row["error"] = ""
        else:
            row["status"] = "failed"
            row["error"] = row.get("error") or reason
            row["balance_amount"] = ""
        _refresh_tool_scan_counts(tool_progress)
        tool_progress["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        _write_tool_scan_progress(scan_batch_id, tool_progress)


def _scan_deadline_reached(deadline_monotonic: Optional[float]) -> bool:
    return deadline_monotonic is not None and time.monotonic() >= float(deadline_monotonic)


def _address_balance_timeout_seconds(chain_key: str) -> float:
    return BSC_ADDRESS_BALANCE_SCAN_TIMEOUT_SECONDS if str(chain_key or "").strip().lower() == "bsc" else ADDRESS_BALANCE_SCAN_TIMEOUT_SECONDS


def _address_balance_deadline(chain_key: str, deadline_monotonic: Optional[float]) -> float:
    address_deadline = time.monotonic() + _address_balance_timeout_seconds(chain_key)
    if deadline_monotonic is None:
        return address_deadline
    return min(address_deadline, float(deadline_monotonic))


def _read_collection_balances_with_timeout(
    *,
    db: Session,
    chain_key: str,
    address: str,
    token_contract_address: str,
    token_decimals: int,
    deadline_monotonic: Optional[float],
) -> Any:
    address_deadline = _address_balance_deadline(chain_key, deadline_monotonic)
    timeout_seconds = max(0.1, address_deadline - time.monotonic())
    rpc_urls = get_rpc_urls_for_chain(chain_key, db=db)
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="collection-row-balance")
    future = executor.submit(
        get_collection_onchain_balances,
        chain_key=chain_key,
        address=address,
        token_contract_address=token_contract_address,
        token_decimals=token_decimals,
        db=None,
        deadline_monotonic=address_deadline,
        rpc_urls=rpc_urls,
    )
    try:
        return future.result(timeout=timeout_seconds)
    except FutureTimeoutError as exc:
        future.cancel()
        raise TimeoutError("BALANCE_READ_TIMEOUT") from exc
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _gas_config_skip_reason(
    db: Session,
    *,
    chain_key: str,
    hot_wallet_address: str,
    gas_coin_symbol: str,
    topup_amount: Decimal,
) -> str:
    if not hot_wallet_address:
        return "HOT_WALLET_ADDRESS_MISSING"
    if not gas_coin_symbol:
        return "NATIVE_SYMBOL_MISSING"
    if topup_amount <= 0:
        return "GAS_TOPUP_AMOUNT_NOT_POSITIVE"
    try:
        get_rpc_urls_for_chain(chain_key, db=db)
    except Exception as exc:
        return f"RPC_NOT_CONFIGURED:{str(exc)[:160]}"
    return ""


def scan_collection_candidates(
    db: Session,
    *,
    chain_key: Optional[str] = None,
    coin_symbol: Optional[str] = "USDT",
    target_address: str = "",
    dry_run: bool = True,
    create_tasks: bool = False,
    batch_id: Optional[int] = None,
    limit: int = 100,
    mock_token_balance: Optional[Decimal] = None,
    mock_native_balance: Optional[Decimal] = None,
    user_id: Optional[int] = None,
    address: str = "",
    include_config_only_chains: bool = False,
    min_collect_amount: Optional[Decimal] = None,
    created_by: Optional[int] = None,
    create_gas_tasks: bool = True,
    deadline_monotonic: Optional[float] = None,
    candidate_source: str = "events",
    scan_batch_id: str = "",
) -> ScanResult:
    """
    Scan collection candidates from configured deposit addresses.

    Candidate addresses and token configs come from the database, but
    collectible token/native balances are read from chain. Never use
    user_balances as the source of collectible balance.
    """
    fallback_collection_address = _normalize_optional_address(target_address)
    if dry_run and create_tasks:
        raise ValueError("create_tasks cannot be true when dry_run is true")
    if include_config_only_chains:
        if create_tasks:
            raise ValueError("include_config_only_chains is only allowed for dry-run scanning")
        if not dry_run:
            raise ValueError("include_config_only_chains requires dry_run=true")
        if not chain_key:
            raise ValueError("include_config_only_chains requires an explicit chain_key")

    requested_chain_key = str(chain_key or "").strip().lower()
    source_mode = str(candidate_source or "events").strip().lower()
    if source_mode not in {"events", "address_book", "address_book_missing_candidates"}:
        source_mode = "events"
    requested_coin_symbol = str(coin_symbol or "USDT").strip().upper()
    if source_mode == "address_book_missing_candidates" and not requested_coin_symbol:
        raise ValueError("请选择币种")
    if requested_coin_symbol in {"*", "ALL", "__ALL__"}:
        raise ValueError("全币种补漏扫描暂未开放，请选择具体币种")
    scan_started = time.monotonic()
    effective_limit = int(limit)
    if requested_chain_key == "bsc":
        effective_limit = min(effective_limit, BSC_SCAN_MAX_ADDRESSES)
    if source_mode in {"address_book", "address_book_missing_candidates"}:
        rows = _load_candidate_rows(
            db,
            chain_key=requested_chain_key,
            coin_symbol=requested_coin_symbol,
            user_id=user_id,
            address=address,
            limit=effective_limit,
            include_config_only_chains=include_config_only_chains,
            exclude_existing_candidates=source_mode == "address_book_missing_candidates",
        )
    else:
        rows = _load_event_candidate_rows(
            db,
            chain_key=requested_chain_key,
            coin_symbol=requested_coin_symbol,
            user_id=user_id,
            address=address,
            limit=effective_limit,
        )
    tool_progress: Optional[dict[str, Any]] = None
    if source_mode == "address_book_missing_candidates" and scan_batch_id:
        existing_progress = _load_tool_scan_progress(scan_batch_id)
        existing_progress_rows = existing_progress.get("rows") if isinstance(existing_progress, dict) else []
        if isinstance(existing_progress_rows, list) and existing_progress_rows:
            row_map = {
                (
                    int(row.get("user_id") or 0),
                    str(row.get("from_address") or "").strip().lower(),
                    str(row.get("coin_symbol") or "").strip().upper(),
                ): row
                for row in rows
            }
            ordered_rows = []
            for progress_row in existing_progress_rows:
                if not isinstance(progress_row, dict):
                    continue
                key = (
                    int(progress_row.get("user_id") or 0),
                    str(progress_row.get("address") or "").strip().lower(),
                    str(progress_row.get("asset_symbol") or progress_row.get("coin_symbol") or "").strip().upper(),
                )
                if key in row_map:
                    ordered_rows.append(row_map[key])
            rows = ordered_rows
        now_iso = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        tool_progress = dict(existing_progress) if isinstance(existing_progress, dict) and existing_progress else {
            "status": "running",
            "chain_key": requested_chain_key,
            "coin_symbol": requested_coin_symbol,
            "filters": {
                "chain_key": requested_chain_key,
                "coin_symbol": requested_coin_symbol,
                "user_id": str(user_id or ""),
                "address": str(address or "").strip().lower(),
            },
            "total": len(rows),
            "scanned": 0,
            "current_address": "",
            "success_count": 0,
            "positive_count": 0,
            "zero_count": 0,
            "failed_count": 0,
            "started_at": now_iso,
            "updated_at": now_iso,
            "rows": [
                {
                    "user_id": int(row.get("user_id") or 0),
                    "address": str(row.get("from_address") or "").strip().lower(),
                    "asset_symbol": str(row.get("coin_symbol") or "").strip().upper(),
                    "status": "pending",
                    "balance_amount": "",
                    "error": "",
                    "candidate_exists": False,
                }
                for row in rows
            ],
        }
        tool_progress["status"] = "running"
        tool_progress["chain_key"] = requested_chain_key
        tool_progress["coin_symbol"] = requested_coin_symbol
        tool_progress["updated_at"] = now_iso
        tool_progress["started_at"] = tool_progress.get("started_at") or now_iso
        tool_progress.setdefault("filters", {
            "chain_key": requested_chain_key,
            "coin_symbol": requested_coin_symbol,
            "user_id": str(user_id or ""),
            "address": str(address or "").strip().lower(),
        })
        if not isinstance(tool_progress.get("rows"), list):
            tool_progress["rows"] = _tool_scan_initial_rows(list(rows))
        _refresh_tool_scan_counts(tool_progress)
        _write_tool_scan_progress(scan_batch_id, tool_progress)
    if requested_chain_key == "bsc":
        logger.info(
            "BSC_SCAN_START chain=bsc candidate_total=%s address_limit=%s token_count=1 symbols=%s",
            len(rows),
            effective_limit,
            requested_coin_symbol,
        )
    total_addresses = 0
    candidates: list[CollectionCandidate] = []
    evaluated_count = 0
    collectible_count = 0
    gas_required_count = 0
    skipped_count = 0
    created_task_count = 0
    created_gas_task_count = 0
    skipped_duplicate_count = 0
    skipped_gas_required_count = 0
    gas_task_skipped_duplicate_count = 0
    gas_task_skipped_config_missing_count = 0
    created_task_ids: list[int] = []
    created_gas_task_ids: list[int] = []
    warnings: list[str] = []
    if requested_chain_key == "bsc" and len(rows) >= effective_limit:
        _record_warning(warnings, f"BSC_SCAN_LIMIT_APPLIED: scanned first {effective_limit} candidates")

    batch: Optional[CollectionBatch] = None
    pre_task_ids: set[int] = set()
    pre_gas_task_ids: set[int] = set()
    if create_tasks:
        pre_task_ids = {int(row[0]) for row in db.execute(text("SELECT id FROM collection_tasks")).all()}
        pre_gas_task_ids = {int(row[0]) for row in db.execute(text("SELECT id FROM gas_tasks")).all()}
        batch = _get_batch(db, batch_id)
        if batch_id is not None and not batch:
            raise ValueError(f"collection batch not found: {batch_id}")

    for index, row in enumerate(rows):
        if _scan_deadline_reached(deadline_monotonic):
            _record_warning(
                warnings,
                f"COLLECTION_SCAN_JOB_TIMEOUT: stop before next candidate chain_key={requested_chain_key or '-'}",
            )
            break
        row_chain_key = str(row["chain_key"] or "").strip().lower()
        row_coin_symbol = str(row["coin_symbol"] or "").strip().upper()
        row_candidate_id = row.get("candidate_id")
        try:
            if tool_progress is not None:
                logger.debug(
                    "BEFORE_SCAN scan_batch_id=%s row_index=%s total=%s user_id=%s address=%s chain_key=%s coin_symbol=%s",
                    scan_batch_id,
                    index + 1,
                    len(rows),
                    row.get("user_id"),
                    str(row.get("from_address") or ""),
                    row_chain_key,
                    row_coin_symbol,
                )
            if requested_chain_key and row_chain_key != requested_chain_key:
                skipped_count += 1
                _mark_tool_scan_row_terminal(
                    tool_progress,
                    index,
                    scan_batch_id,
                    status="skipped",
                    error="CHAIN_FILTER_SKIPPED",
                )
                _record_warning(
                    warnings,
                    f"已过滤非当前网络候选: selected={requested_chain_key}, candidate={row_chain_key or '-'}",
                )
                continue
            if requested_coin_symbol and row_coin_symbol != requested_coin_symbol:
                skipped_count += 1
                _mark_tool_scan_row_terminal(
                    tool_progress,
                    index,
                    scan_batch_id,
                    status="skipped",
                    error="COIN_FILTER_SKIPPED",
                )
                _record_warning(
                    warnings,
                    f"已过滤非当前币种候选: selected={requested_coin_symbol}, candidate={row_coin_symbol or '-'}",
                )
                continue

            total_addresses += 1
            chain_collection_address = _normalize_optional_address(row.get("chain_collection_address"))
            chain_hot_wallet_address = _normalize_optional_address(row.get("chain_hot_wallet_address"))
            if row_chain_key in CONFIG_ONLY_DRY_RUN_CHAIN_KEYS and not chain_collection_address:
                skipped_count += 1
                _mark_tool_scan_row_terminal(
                    tool_progress,
                    index,
                    scan_batch_id,
                    status="skipped",
                    error="COLLECTION_ADDRESS_NOT_CONFIGURED",
                )
                _record_warning(warnings, f"{row_chain_key} collection_address not configured")
                continue
            if row_chain_key in CONFIG_ONLY_DRY_RUN_CHAIN_KEYS and not chain_hot_wallet_address:
                _record_warning(warnings, f"{row_chain_key} hot_wallet_address not configured")
                if create_tasks:
                    skipped_count += 1
                    continue
            to_address = chain_collection_address or fallback_collection_address
            if not chain_collection_address:
                _record_warning(
                    warnings,
                    f"当前链未配置归集钱包地址: chain_key={row_chain_key}",
                )
            if not to_address:
                skipped_count += 1
                _mark_tool_scan_row_terminal(
                    tool_progress,
                    index,
                    scan_batch_id,
                    status="skipped",
                    error="COLLECTION_ADDRESS_NOT_CONFIGURED",
                )
                _record_warning(
                    warnings,
                    f"当前链未配置归集钱包地址且无 fallback，跳过候选地址: chain_key={row_chain_key}",
                )
                continue
            if create_tasks and not chain_collection_address:
                skipped_count += 1
                _mark_tool_scan_row_terminal(
                    tool_progress,
                    index,
                    scan_batch_id,
                    status="skipped",
                    error="COLLECTION_ADDRESS_NOT_CONFIGURED",
                )
                _record_warning(
                    warnings,
                    f"当前链未配置归集钱包地址，已跳过真实归集任务创建: chain_key={row_chain_key}",
                )
                continue

            if tool_progress is not None and index < len(tool_progress["rows"]):
                tool_progress["status"] = "running"
                tool_progress["current_address"] = str(row.get("from_address") or "").strip().lower()
                tool_progress["rows"][index]["status"] = "scanning"
                tool_progress["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
                _write_tool_scan_progress(scan_batch_id, tool_progress)
            if tool_progress is not None:
                logger.debug(
                    "BEFORE_BALANCE_READ scan_batch_id=%s row_index=%s total=%s address=%s chain_key=%s coin_symbol=%s",
                    scan_batch_id,
                    index + 1,
                    len(rows),
                    str(row.get("from_address") or ""),
                    row_chain_key,
                    row_coin_symbol,
                )
            balance_source = "链上扫描"
            balance_checked_at: Optional[datetime] = None
            balance_error = ""
            if mock_token_balance is not None or mock_native_balance is not None:
                token_balance = _to_decimal(mock_token_balance if mock_token_balance is not None else Decimal("0"))
                native_balance = _to_decimal(mock_native_balance if mock_native_balance is not None else Decimal("0"))
                balance_source = "mock"
            elif not str(row.get("token_contract_address") or "").strip():
                token_balance = Decimal("0")
                native_balance = Decimal("0")
                balance_error = "TOKEN_CONTRACT_ADDRESS_MISSING"
                _record_warning(
                    warnings,
                    f"链上余额扫描失败：token 合约地址缺失 chain_key={row_chain_key}, coin={row_coin_symbol}, address={row.get('from_address')}",
                )
            else:
                try:
                    balances = _read_collection_balances_with_timeout(
                        db=db,
                        chain_key=row_chain_key,
                        address=str(row["from_address"]),
                        token_contract_address=str(row.get("token_contract_address") or ""),
                        token_decimals=int(row.get("token_decimals") or 18),
                        deadline_monotonic=deadline_monotonic,
                    )
                    token_balance = balances.token_balance
                    native_balance = balances.native_balance
                    balance_checked_at = balances.checked_at
                    if not balances.ok:
                        balance_error = balances.error_message or "ONCHAIN_BALANCE_CHECK_FAILED"
                        if "RPC_CALL_TIMEOUT" in balance_error or "deadline reached" in balance_error:
                            balance_error = "BALANCE_READ_TIMEOUT"
                except TimeoutError:
                    token_balance = Decimal("0")
                    native_balance = Decimal("0")
                    balance_error = "BALANCE_READ_TIMEOUT"
                    _mark_tool_scan_row_terminal(
                        tool_progress,
                        index,
                        scan_batch_id,
                        status="failed",
                        error=balance_error,
                        balance_amount=None,
                    )
                except Exception as exc:
                    token_balance = Decimal("0")
                    native_balance = Decimal("0")
                    balance_error = f"ONCHAIN_BALANCE_CHECK_EXCEPTION:{str(exc)[:140]}"
                if balance_error:
                    _record_warning(
                        warnings,
                        (
                            "链上余额扫描失败："
                            f"chain_key={row_chain_key}, coin={row_coin_symbol}, address={row.get('from_address')}, "
                            f"error={balance_error[:160]}"
                        ),
                    )
            if tool_progress is not None:
                logger.debug(
                    "AFTER_BALANCE_READ scan_batch_id=%s row_index=%s total=%s address=%s chain_key=%s coin_symbol=%s balance=%s error=%s",
                    scan_batch_id,
                    index + 1,
                    len(rows),
                    str(row.get("from_address") or ""),
                    row_chain_key,
                    row_coin_symbol,
                    token_balance,
                    balance_error[:180],
                )
            try:
                configured_min_amount = row.get("collection_min_amount")
                effective_min_collect_amount = (
                    min_collect_amount
                    if min_collect_amount is not None
                    else (_to_decimal(configured_min_amount) if configured_min_amount is not None else None)
                )
                evaluation = evaluate_collection_candidate(
                    chain_key=str(row["chain_key"]),
                    coin_symbol=str(row["coin_symbol"]),
                    from_address=str(row["from_address"]),
                    to_address=to_address,
                    token_balance=token_balance,
                    native_balance=native_balance,
                    token_contract_address=row.get("token_contract_address"),
                    min_collect_amount=effective_min_collect_amount,
                    db=db,
                )
            except Exception as exc:
                skipped_count += 1
                if (
                    source_mode == "events"
                    and str(scan_batch_id or "").startswith("collection_candidate_verify_")
                    and row_candidate_id
                ):
                    error_text = str(exc)[:180]
                    write_candidate_verify_status(
                        row_candidate_id,
                        status="failed",
                        chain_key=row_chain_key,
                        coin_symbol=row_coin_symbol,
                        address=str(row.get("from_address") or ""),
                        scan_batch_id=scan_batch_id,
                        error=error_text,
                    )
                    publish_collection_center_event(
                        "candidate_verify_failed",
                        {
                            "candidate_id": row_candidate_id,
                            "chain_key": row_chain_key,
                            "asset_symbol": row_coin_symbol,
                            "coin_symbol": row_coin_symbol,
                            "address": str(row.get("from_address") or ""),
                            "user_id": row.get("user_id"),
                            "status": "failed",
                            "error": error_text,
                            "message": "复核失败",
                        },
                    )
                if tool_progress is not None and index < len(tool_progress["rows"]):
                    tool_progress["rows"][index]["status"] = "failed"
                    tool_progress["rows"][index]["error"] = str(exc)[:180]
                    _refresh_tool_scan_counts(tool_progress)
                    tool_progress["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
                    _write_tool_scan_progress(scan_batch_id, tool_progress)
                continue

            evaluated_count += 1
            if evaluation.should_collect:
                collectible_count += 1
            if evaluation.gas_required:
                gas_required_count += 1

            active_duplicate = find_active_collection_task_duplicate(
                db,
                user_id=int(row["user_id"]),
                chain_key=row_chain_key,
                coin_symbol=row_coin_symbol,
                from_address=str(row["from_address"]),
            )
            duplicate_reason = f"ACTIVE_COLLECTION_TASK_EXISTS:{active_duplicate.id}" if active_duplicate else ""
            should_create_task = bool(evaluation.should_collect and not active_duplicate)

            candidate = CollectionCandidate(
                user_id=int(row["user_id"]),
                chain_key=str(row["chain_key"]),
                coin_symbol=row_coin_symbol,
                asset_chain_id=int(row["asset_chain_id"]) if row.get("asset_chain_id") is not None else None,
                from_address=str(row["from_address"]),
                to_address=to_address,
                token_balance=token_balance,
                native_balance=native_balance,
                balance_source=balance_source,
                balance_checked_at=balance_checked_at,
                balance_error=balance_error,
                evaluation=evaluation,
                should_create_task=should_create_task,
                reason=duplicate_reason or (f"ONCHAIN_BALANCE_CHECK_FAILED:{balance_error}" if balance_error else evaluation.reason),
            )
            candidates.append(candidate)
            if (
                source_mode == "events"
                and str(scan_batch_id or "").startswith("collection_candidate_verify_")
                and row_candidate_id
            ):
                if balance_error:
                    write_candidate_verify_status(
                        row_candidate_id,
                        status="failed",
                        chain_key=row_chain_key,
                        coin_symbol=row_coin_symbol,
                        address=str(row.get("from_address") or ""),
                        scan_batch_id=scan_batch_id,
                        error=balance_error,
                    )
                    publish_collection_center_event(
                        "candidate_verify_failed",
                        {
                            "candidate_id": row_candidate_id,
                            "chain_key": row_chain_key,
                            "asset_symbol": row_coin_symbol,
                            "coin_symbol": row_coin_symbol,
                            "address": str(row.get("from_address") or ""),
                            "user_id": row.get("user_id"),
                            "status": "failed",
                            "error": balance_error,
                            "message": "复核失败",
                        },
                    )
                else:
                    try:
                        scanned_at = balance_checked_at or datetime.utcnow()
                        mark_collection_candidate_scanned(
                            db,
                            chain_key=row_chain_key,
                            asset_symbol=row_coin_symbol,
                            token_contract=str(row.get("token_contract_address") or ""),
                            address=str(row.get("from_address") or ""),
                            balance_amount=token_balance,
                            scanned_at=scanned_at,
                        )
                        write_candidate_verify_status(
                            row_candidate_id,
                            status="completed",
                            chain_key=row_chain_key,
                            coin_symbol=row_coin_symbol,
                            address=str(row.get("from_address") or ""),
                            scan_batch_id=scan_batch_id,
                            balance_amount=token_balance,
                        )
                        scanned_at_display = scanned_at.strftime("%Y-%m-%d %H:%M:%S")
                        balance_display = f"{format(token_balance, 'f')} {row_coin_symbol}"
                        publish_collection_center_event(
                            "candidate_verify_completed",
                            {
                                "candidate_id": row_candidate_id,
                                "chain_key": row_chain_key,
                                "asset_symbol": row_coin_symbol,
                                "coin_symbol": row_coin_symbol,
                                "address": str(row.get("from_address") or ""),
                                "user_id": row.get("user_id"),
                                "status": "completed",
                                "last_balance_amount": str(token_balance),
                                "last_balance_amount_display": balance_display,
                                "last_scan_at": scanned_at.isoformat(timespec="seconds"),
                                "last_scan_at_display": scanned_at_display,
                                "message": "已复核",
                            },
                        )
                    except Exception:
                        logger.warning(
                            "collection candidate scan write-back failed chain=%s coin=%s address=%s",
                            row_chain_key,
                            row_coin_symbol,
                            str(row.get("from_address") or ""),
                            exc_info=True,
                        )
                        write_candidate_verify_status(
                            row_candidate_id,
                            status="failed",
                            chain_key=row_chain_key,
                            coin_symbol=row_coin_symbol,
                            address=str(row.get("from_address") or ""),
                            scan_batch_id=scan_batch_id,
                            error="CANDIDATE_WRITE_BACK_FAILED",
                        )
                        publish_collection_center_event(
                            "candidate_verify_failed",
                            {
                                "candidate_id": row_candidate_id,
                                "chain_key": row_chain_key,
                                "asset_symbol": row_coin_symbol,
                                "coin_symbol": row_coin_symbol,
                                "address": str(row.get("from_address") or ""),
                                "user_id": row.get("user_id"),
                                "status": "failed",
                                "error": "CANDIDATE_WRITE_BACK_FAILED",
                                "message": "复核失败",
                            },
                        )
            if tool_progress is not None and index < len(tool_progress["rows"]):
                tool_progress["current_address"] = str(row.get("from_address") or "").strip().lower()
                tool_progress["rows"][index]["balance_amount"] = None if balance_error else token_balance
                if balance_error:
                    tool_progress["rows"][index]["status"] = "failed"
                    tool_progress["rows"][index]["error"] = balance_error[:180]
                else:
                    tool_progress["rows"][index]["status"] = "completed"
                    tool_progress["rows"][index]["error"] = ""
                _refresh_tool_scan_counts(tool_progress)
                tool_progress["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
                _write_tool_scan_progress(scan_batch_id, tool_progress)
            if row_chain_key == "avaxc" and evaluated_count <= 50:
                if balance_error:
                    final_status = "balance_read_failed"
                elif evaluation.gas_required:
                    final_status = "gas_required"
                elif evaluation.should_collect:
                    final_status = "collectible"
                else:
                    final_status = evaluation.reason
                logger.info(
                    "collection scan gas decision chain=%s address=%s coin=%s token_balance=%s collectable_amount=%s native_balance=%s required_gas=%s gas_required=%s final_status=%s",
                    row_chain_key,
                    str(row.get("from_address") or ""),
                    row_coin_symbol,
                    token_balance,
                    evaluation.collect_amount,
                    native_balance,
                    evaluation.estimated_gas_native,
                    evaluation.gas_required,
                    final_status,
                )

            if active_duplicate:
                skipped_duplicate_count += 1
                skipped_count += 1
                continue

            if not create_tasks or not should_create_task:
                continue

            gas_task_to_link = None
            if evaluation.gas_required:
                if not create_gas_tasks:
                    skipped_gas_required_count += 1
                    skipped_count += 1
                    _record_warning(
                        warnings,
                        (
                            "skip gas-required candidate because gas task creation is disabled: "
                            f"chain_key={candidate.chain_key}, user_id={candidate.user_id}, address={candidate.from_address}"
                        ),
                    )
                    continue
                gas_coin_symbol = str(evaluation.gas_coin_symbol or row.get("chain_native_symbol") or "").strip().upper()
                gas_duplicate = find_active_gas_task_duplicate(
                    db,
                    chain_key=candidate.chain_key,
                    to_address=candidate.from_address,
                )
                if gas_duplicate:
                    gas_task_to_link = gas_duplicate
                    gas_task_skipped_duplicate_count += 1
                else:
                    gas_skip_reason = _gas_config_skip_reason(
                        db,
                        chain_key=candidate.chain_key,
                        hot_wallet_address=chain_hot_wallet_address,
                        gas_coin_symbol=gas_coin_symbol,
                        topup_amount=evaluation.gas_topup_amount,
                    )
                    if gas_skip_reason:
                        skipped_gas_required_count += 1
                        gas_task_skipped_config_missing_count += 1
                        skipped_count += 1
                        _record_warning(
                            warnings,
                            (
                                "skip gas-required candidate because gas task config is incomplete: "
                                f"chain_key={candidate.chain_key}, user_id={candidate.user_id}, "
                                f"address={candidate.from_address}, reason={gas_skip_reason}"
                            ),
                        )
                        continue

            existing_task = find_collection_task_by_idempotency(
                db,
                user_id=candidate.user_id,
                chain_key=candidate.chain_key,
                coin_symbol=candidate.coin_symbol,
                from_address=candidate.from_address,
                to_address=candidate.to_address,
                amount=evaluation.collect_amount,
            )
            if existing_task:
                skipped_duplicate_count += 1
                skipped_count += 1
                _record_warning(
                    warnings,
                    (
                        "skip candidate because an idempotent collection task already exists: "
                        f"chain_key={candidate.chain_key}, coin={candidate.coin_symbol}, "
                        f"user_id={candidate.user_id}, address={candidate.from_address}, task_id={existing_task.id}"
                    ),
                )
                continue

            if not batch:
                batch = create_collection_batch(
                    db,
                    trigger_type="MANUAL",
                    target_address=chain_collection_address,
                    chain_key=row_chain_key or chain_key,
                    coin_symbol=candidate.coin_symbol,
                    created_by=created_by,
                )

            create_result = create_collection_task_with_result(
                db,
                batch_id=batch.id if batch else batch_id,
                user_id=candidate.user_id,
                chain_key=candidate.chain_key,
                coin_symbol=candidate.coin_symbol,
                asset_chain_id=candidate.asset_chain_id,
                from_address=candidate.from_address,
                to_address=candidate.to_address,
                amount=evaluation.collect_amount,
                reason=evaluation.reason,
            )
            task = create_result.task
            if create_result.created_new and int(task.id) not in pre_task_ids:
                created_task_count += 1
                pre_task_ids.add(int(task.id))
                created_task_ids.append(int(task.id))
            elif not create_result.created_new:
                skipped_duplicate_count += 1
                skipped_count += 1
                _record_warning(
                    warnings,
                    (
                        "skip candidate because create_collection_task returned an existing task: "
                        f"chain_key={candidate.chain_key}, coin={candidate.coin_symbol}, "
                        f"user_id={candidate.user_id}, address={candidate.from_address}, task_id={task.id}"
                    ),
                )
                continue

            if gas_task_to_link is not None:
                task.gas_task_id = gas_task_to_link.id

            if (
                create_gas_tasks
                and evaluation.gas_required
                and gas_task_to_link is None
                and evaluation.gas_coin_symbol
                and evaluation.gas_topup_amount > 0
            ):
                if not chain_hot_wallet_address:
                    skipped_count += 1
                    _record_warning(
                        warnings,
                        f"当前链未配置平台热钱包地址，无法创建补 Gas 任务: chain_key={candidate.chain_key}",
                    )
                    continue
                gas_task = create_gas_task(
                    db,
                    collection_task_id=task.id,
                    user_id=candidate.user_id,
                    chain_key=candidate.chain_key,
                    gas_coin_symbol=evaluation.gas_coin_symbol,
                    from_address=chain_hot_wallet_address,
                    to_address=candidate.from_address,
                    topup_amount=evaluation.gas_topup_amount,
                    target_balance=evaluation.gas_target_balance,
                    gas_topup_mode=evaluation.gas_topup_mode,
                    estimate_source=evaluation.estimate_source,
                )
                task.gas_task_id = gas_task.id
                if int(gas_task.id) not in pre_gas_task_ids:
                    created_gas_task_count += 1
                    pre_gas_task_ids.add(int(gas_task.id))
                    created_gas_task_ids.append(int(gas_task.id))

        finally:
            _finalize_single_tool_scan_row(tool_progress, index, scan_batch_id)
            if tool_progress is not None:
                progress_rows = tool_progress.get("rows") or []
                progress_row = progress_rows[index] if index < len(progress_rows) and isinstance(progress_rows[index], dict) else {}
                logger.debug(
                    "ROW_FINALIZED scan_batch_id=%s row_index=%s total=%s address=%s status=%s balance=%s error=%s",
                    scan_batch_id,
                    index + 1,
                    len(rows),
                    str(row.get("from_address") or ""),
                    str(progress_row.get("status") or ""),
                    str(progress_row.get("balance_amount") or ""),
                    str(progress_row.get("error") or "")[:180],
                )
    if requested_chain_key == "bsc":
        logger.info(
            "collection scan chain summary chain=%s loaded_candidates=%s scanned_addresses=%s evaluated=%s collectible=%s gas_needed=%s balance_errors=%s elapsed_ms=%s",
            requested_chain_key,
            len(rows),
            total_addresses,
            evaluated_count,
            collectible_count,
            gas_required_count,
            sum(1 for item in candidates if item.balance_error),
            int((time.monotonic() - scan_started) * 1000),
        )

    if batch and created_task_count <= 0:
        batch.status = "CANCELED"
        batch.error_message = batch.error_message or "EMPTY_BATCH_NO_NEW_TASKS"
        batch.finished_at = batch.finished_at or datetime.utcnow()
        batch.updated_at = datetime.utcnow()
        db.flush()

    if tool_progress is not None:
        _finalize_tool_scan_rows(tool_progress, scan_batch_id=scan_batch_id)
        tool_progress["current_address"] = ""
        if int(tool_progress.get("total") or 0) == 0:
            tool_progress["message"] = "当前筛选范围内暂无未入候选地址"
        tool_progress["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        if _tool_scan_all_rows_terminal(tool_progress):
            tool_progress["status"] = "completed"
            tool_progress["finished_at"] = tool_progress["updated_at"]
            tool_progress["completed_at"] = tool_progress["updated_at"]
        else:
            tool_progress["status"] = "failed"
            tool_progress["error"] = "SCAN_ROWS_NOT_FINALIZED"
            tool_progress["finished_at"] = tool_progress["updated_at"]
        _write_tool_scan_progress(scan_batch_id, tool_progress)

    return ScanResult(
        total_addresses=total_addresses,
        evaluated_count=evaluated_count,
        collectible_count=collectible_count,
        gas_required_count=gas_required_count,
        skipped_count=skipped_count,
        created_task_count=created_task_count,
        created_gas_task_count=created_gas_task_count,
        candidates=candidates,
        skipped_duplicate_count=skipped_duplicate_count,
        skipped_gas_required_count=skipped_gas_required_count,
        gas_task_skipped_duplicate_count=gas_task_skipped_duplicate_count,
        gas_task_skipped_config_missing_count=gas_task_skipped_config_missing_count,
        created_task_ids=created_task_ids,
        created_gas_task_ids=created_gas_task_ids,
        batch_id=batch.id if batch else batch_id,
        batch_no=batch.batch_no if batch else None,
        warnings=warnings,
        error_message="; ".join(warnings) if warnings else None,
    )


def admin_preview_collection_candidates(
    db: Session,
    *,
    chain_key: Optional[str] = None,
    asset_symbol: Optional[str] = None,
    min_amount: Optional[Decimal] = None,
    user_id: Optional[int] = None,
    address: str = "",
    limit: int = 200,
    include_config_only_chains: bool = False,
    deadline_monotonic: Optional[float] = None,
    candidate_source: str = "events",
    scan_batch_id: str = "",
) -> ScanResult:
    return scan_collection_candidates(
        db,
        chain_key=chain_key,
        coin_symbol=asset_symbol,
        user_id=user_id,
        address=address,
        dry_run=True,
        create_tasks=False,
        limit=limit,
        min_collect_amount=min_amount,
        include_config_only_chains=include_config_only_chains,
        deadline_monotonic=deadline_monotonic,
        candidate_source=candidate_source,
        scan_batch_id=scan_batch_id,
    )


def admin_create_collection_tasks(
    db: Session,
    *,
    chain_key: Optional[str] = None,
    asset_symbol: Optional[str] = None,
    min_amount: Optional[Decimal] = None,
    operator_id: Optional[int] = None,
    user_id: Optional[int] = None,
    address: str = "",
    limit: int = 200,
    deadline_monotonic: Optional[float] = None,
    candidate_source: str = "events",
) -> ScanResult:
    return scan_collection_candidates(
        db,
        chain_key=chain_key,
        coin_symbol=asset_symbol,
        user_id=user_id,
        address=address,
        dry_run=False,
        create_tasks=True,
        limit=limit,
        min_collect_amount=min_amount,
        created_by=operator_id,
        create_gas_tasks=True,
        deadline_monotonic=deadline_monotonic,
        candidate_source=candidate_source,
    )
