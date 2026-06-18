from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterable

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.rq import QUEUE_MAINTENANCE, get_queue, get_redis_connection
from app.db.models.db_lifecycle_cleanup_log import DbLifecycleCleanupLog
from app.db.session import SessionLocal


logger = logging.getLogger(__name__)

JOB_NAME = "db_lifecycle_cleanup"
MAX_BATCH_SIZE = 1000
DEFAULT_FAILED_RETENTION_DAYS = 180
CLEANUP_EXECUTE_CONFIRM_TEXT = "DELETE_NON_CORE_TEMP_DATA"
OPERATION_MODE_DRY_RUN = "DRY_RUN"
OPERATION_MODE_EXECUTE = "EXECUTE"
RISK_LEVEL_SAFE_DRY_RUN = "SAFE_DRY_RUN"
RISK_LEVEL_REAL_DELETE = "REAL_DELETE"
JOB_SUCCESS_STATUSES = ("SUCCESS",)
JOB_FAILED_STATUSES = ("FAILED",)
STOCK_RELEASE_SUCCESS_STATUSES = ("SUCCESS", "NOOP")
STOCK_RELEASE_FAILED_STATUSES = ("FAILED",)
PROTECTED_CORE_REASON = "PROTECTED_CORE_TABLE"
CORE_FINANCIAL_TABLES: dict[str, dict[str, str]] = {
    "balance_logs": {"type": "资金流水", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "orders": {"type": "现货订单", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "trades": {"type": "现货成交", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "contract_orders": {"type": "合约订单", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "contract_trades": {"type": "合约成交", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "contract_margin_logs": {"type": "保证金流水", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "deposits": {"type": "充值", "hot_retention": "24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "withdraw_logs": {"type": "提现", "hot_retention": "24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "user_balances": {"type": "用户余额", "hot_retention": "长期在线", "next_step": "仅快照归档"},
    "platform_adjust_logs": {"type": "平台调账", "hot_retention": "24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "bd_commission_records": {"type": "BD 发放记录", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "user_invite_commission_records": {"type": "邀请发放记录", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "user_dividend_records": {"type": "分红发放记录", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "dividend_pools": {"type": "分红池", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
    "dividend_pool_items": {"type": "分红明细", "hot_retention": "12～24 个月", "next_step": "月度归档 / 冷数据迁移"},
}
PROTECTED_TABLES = frozenset(CORE_FINANCIAL_TABLES) | frozenset({"withdraws", "invite_commission_records", "dividend_records"})
PROTECTED_CORE_TABLES = PROTECTED_TABLES


@dataclass(frozen=True)
class CleanupSpec:
    table_name: str
    where_sql: str
    params: dict[str, Any]
    retention_days: int


def core_financial_table_rows() -> list[dict[str, str]]:
    return [
        {
            "table_name": table_name,
            "type": meta["type"],
            "policy": "禁止清理，只允许归档",
            "hot_retention": meta["hot_retention"],
            "next_step": meta["next_step"],
        }
        for table_name, meta in CORE_FINANCIAL_TABLES.items()
    ]


def _status_placeholders(prefix: str, values: Iterable[str], params: dict[str, Any]) -> str:
    keys: list[str] = []
    for index, value in enumerate(values):
        key = f"{prefix}_{index}"
        params[key] = value
        keys.append(f":{key}")
    return ", ".join(keys)


def _retention_days() -> int:
    try:
        return max(1, int(settings.DB_LIFECYCLE_CLEANUP_RETENTION_DAYS or 90))
    except (TypeError, ValueError):
        return 90


def _enqueue_interval_seconds() -> int:
    try:
        value = int(settings.DB_LIFECYCLE_CLEANUP_ENQUEUE_INTERVAL_SECONDS or 24 * 60 * 60)
    except (TypeError, ValueError):
        value = 24 * 60 * 60
    return max(3600, value)


def _configured_execute_confirm() -> str:
    return str(settings.DB_LIFECYCLE_CLEANUP_EXECUTE_CONFIRM or "").strip()


def can_execute_cleanup(confirm_text: str | None = None) -> bool:
    return (
        bool(settings.DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE)
        and not bool(settings.DB_LIFECYCLE_CLEANUP_DRY_RUN)
        and str(confirm_text or "").strip() == CLEANUP_EXECUTE_CONFIRM_TEXT
        and _configured_execute_confirm() == CLEANUP_EXECUTE_CONFIRM_TEXT
    )


def _window_id(now_ts: int | None = None, interval_seconds: int | None = None) -> int:
    interval = interval_seconds or _enqueue_interval_seconds()
    return int((now_ts if now_ts is not None else time.time()) // interval)


def _cleanup_specs(now: datetime, retention_days: int | None = None) -> list[CleanupSpec]:
    operational_retention_days = max(1, int(retention_days or _retention_days()))
    failed_retention_days = max(DEFAULT_FAILED_RETENTION_DAYS, operational_retention_days * 2)
    success_cutoff = now - timedelta(days=operational_retention_days)
    failed_cutoff = now - timedelta(days=failed_retention_days)
    otp_cutoff = now - timedelta(days=30)
    session_created_cutoff = now - timedelta(days=operational_retention_days)
    session_expired_cutoff = now - timedelta(days=30)
    geo_cutoff = now - timedelta(days=operational_retention_days)

    dividend_params: dict[str, Any] = {"success_cutoff": success_cutoff, "failed_cutoff": failed_cutoff}
    bd_params: dict[str, Any] = {"success_cutoff": success_cutoff, "failed_cutoff": failed_cutoff}
    stock_params: dict[str, Any] = {"success_cutoff": success_cutoff, "failed_cutoff": failed_cutoff}
    dividend_success = _status_placeholders("dividend_success", JOB_SUCCESS_STATUSES, dividend_params)
    dividend_failed = _status_placeholders("dividend_failed", JOB_FAILED_STATUSES, dividend_params)
    bd_success = _status_placeholders("bd_success", JOB_SUCCESS_STATUSES, bd_params)
    bd_failed = _status_placeholders("bd_failed", JOB_FAILED_STATUSES, bd_params)
    stock_success = _status_placeholders("stock_success", STOCK_RELEASE_SUCCESS_STATUSES, stock_params)
    stock_failed = _status_placeholders("stock_failed", STOCK_RELEASE_FAILED_STATUSES, stock_params)

    return [
        CleanupSpec(
            table_name="user_otps",
            where_sql="created_at < :cutoff",
            params={"cutoff": otp_cutoff},
            retention_days=30,
        ),
        CleanupSpec(
            table_name="user_sessions",
            where_sql="created_at < :created_cutoff OR expires_at < :expired_cutoff",
            params={"created_cutoff": session_created_cutoff, "expired_cutoff": session_expired_cutoff},
            retention_days=operational_retention_days,
        ),
        CleanupSpec(
            table_name="geo_access_logs",
            where_sql="last_seen_at < :cutoff",
            params={"cutoff": geo_cutoff},
            retention_days=operational_retention_days,
        ),
        CleanupSpec(
            table_name="dividend_job_logs",
            where_sql=(
                f"(status IN ({dividend_success}) AND created_at < :success_cutoff) "
                f"OR (status IN ({dividend_failed}) AND created_at < :failed_cutoff)"
            ),
            params=dividend_params,
            retention_days=operational_retention_days,
        ),
        CleanupSpec(
            table_name="bd_commission_job_logs",
            where_sql=(
                f"(status IN ({bd_success}) AND created_at < :success_cutoff) "
                f"OR (status IN ({bd_failed}) AND created_at < :failed_cutoff)"
            ),
            params=bd_params,
            retention_days=operational_retention_days,
        ),
        CleanupSpec(
            table_name="stock_token_release_logs",
            where_sql=(
                f"(status IN ({stock_success}) AND created_at < :success_cutoff) "
                f"OR (status IN ({stock_failed}) AND created_at < :failed_cutoff)"
            ),
            params=stock_params,
            retention_days=operational_retention_days,
        ),
    ]


def _safe_table_name(table_name: str) -> str:
    if not table_name.replace("_", "").isalnum():
        raise ValueError(f"unsafe table name: {table_name}")
    if table_name in PROTECTED_TABLES:
        raise ValueError(f"protected core table cannot be cleaned: {table_name}")
    return table_name


def _is_protected_table(table_name: str) -> bool:
    return str(table_name or "").strip() in PROTECTED_TABLES


def _count_matches(db: Session, spec: CleanupSpec) -> int:
    table_name = _safe_table_name(spec.table_name)
    return int(
        db.execute(
            text(f"SELECT COUNT(*) FROM {table_name} WHERE {spec.where_sql}"),
            spec.params,
        ).scalar()
        or 0
    )


def _delete_batch(db: Session, spec: CleanupSpec, batch_size: int) -> int:
    if " where " in spec.where_sql.lower():
        raise ValueError("where_sql must be a predicate, not a full WHERE clause")
    table_name = _safe_table_name(spec.table_name)
    result = db.execute(
        text(
            f"""
            DELETE FROM {table_name}
            WHERE {spec.where_sql}
            ORDER BY id
            LIMIT :batch_size
            """
        ),
        {**spec.params, "batch_size": batch_size},
    )
    return int(result.rowcount or 0)


def _record_cleanup_log(
    db: Session,
    *,
    dry_run: bool,
    spec: CleanupSpec,
    matched_count: int,
    deleted_count: int,
    status: str,
    error_message: str,
    started_at: datetime,
    finished_at: datetime,
    skipped: bool = False,
    reason: str = "",
    operation_mode: str = OPERATION_MODE_DRY_RUN,
    risk_level: str = RISK_LEVEL_SAFE_DRY_RUN,
) -> None:
    db.add(
        DbLifecycleCleanupLog(
            job_name=JOB_NAME,
            dry_run=bool(dry_run),
            table_name=spec.table_name,
            matched_count=int(matched_count or 0),
            deleted_count=int(deleted_count or 0),
            retention_days=int(spec.retention_days or 0),
            status=str(status or "SUCCESS")[:32],
            skipped=bool(skipped),
            reason=(reason or None),
            operation_mode=str(operation_mode or OPERATION_MODE_DRY_RUN)[:32],
            risk_level=str(risk_level or RISK_LEVEL_SAFE_DRY_RUN)[:32],
            error_message=(error_message or None),
            started_at=started_at,
            finished_at=finished_at,
            created_at=datetime.utcnow(),
        )
    )
    db.commit()


def run_db_lifecycle_cleanup(
    db: Session,
    *,
    dry_run: bool = True,
    allow_execute: bool = False,
    confirm_text: str | None = None,
    batch_size: int = MAX_BATCH_SIZE,
    now: datetime | None = None,
    retention_days: int | None = None,
    record_results: bool = True,
    extra_specs: Iterable[CleanupSpec] | None = None,
) -> dict[str, Any]:
    execute_allowed = bool(allow_execute) and can_execute_cleanup(confirm_text)
    effective_dry_run = bool(dry_run) or not execute_allowed
    operation_mode = OPERATION_MODE_DRY_RUN if effective_dry_run else OPERATION_MODE_EXECUTE
    risk_level = RISK_LEVEL_SAFE_DRY_RUN if effective_dry_run else RISK_LEVEL_REAL_DELETE
    safe_batch_size = min(max(int(batch_size or MAX_BATCH_SIZE), 1), MAX_BATCH_SIZE)
    now_value = now or datetime.utcnow()
    specs = [*_cleanup_specs(now_value, retention_days=retention_days), *(extra_specs or [])]
    results: list[dict[str, Any]] = []
    for spec in specs:
        started_at = datetime.utcnow()
        matched_count = 0
        deleted_count = 0
        error = ""
        reason = ""
        skipped = False
        status = "DRY_RUN" if effective_dry_run else "SUCCESS"
        if _is_protected_table(spec.table_name):
            skipped = True
            reason = PROTECTED_CORE_REASON
            status = "SKIPPED"
            error = "protected core table cannot be cleaned"
            logger.warning("db lifecycle cleanup skipped protected table=%s", spec.table_name)
        else:
            try:
                matched_count = _count_matches(db, spec)
                if not effective_dry_run:
                    while True:
                        deleted = _delete_batch(db, spec, safe_batch_size)
                        deleted_count += deleted
                        db.commit()
                        if deleted < safe_batch_size:
                            break
            except Exception as exc:
                db.rollback()
                error = str(exc)
                status = "FAILED"
                logger.exception("db lifecycle cleanup failed table=%s", spec.table_name)
        finished_at = datetime.utcnow()
        if record_results:
            try:
                _record_cleanup_log(
                    db,
                    dry_run=effective_dry_run,
                    spec=spec,
                    matched_count=matched_count,
                    deleted_count=0 if effective_dry_run else deleted_count,
                    status=status,
                    skipped=skipped,
                    reason=reason,
                    operation_mode=operation_mode,
                    risk_level=risk_level,
                    error_message=error,
                    started_at=started_at,
                    finished_at=finished_at,
                )
            except Exception:
                db.rollback()
                logger.exception("db lifecycle cleanup result logging failed table=%s", spec.table_name)
        results.append(
            {
                "table_name": spec.table_name,
                "matched_count": matched_count,
                "deleted_count": 0 if effective_dry_run else deleted_count,
                "retention_days": spec.retention_days,
                "dry_run": bool(effective_dry_run),
                "status": status,
                "skipped": skipped,
                "reason": reason,
                "operation_mode": operation_mode,
                "risk_level": risk_level,
                "error": error,
            }
        )
    return {"dry_run": bool(effective_dry_run), "batch_size": safe_batch_size, "items": results}


def run_db_lifecycle_cleanup_once(
    *,
    dry_run: bool = True,
    batch_size: int = MAX_BATCH_SIZE,
    confirm_text: str | None = None,
) -> dict[str, Any]:
    db = SessionLocal()
    try:
        return run_db_lifecycle_cleanup(
            db,
            dry_run=dry_run,
            allow_execute=not dry_run,
            confirm_text=confirm_text,
            batch_size=batch_size,
            retention_days=_retention_days(),
            record_results=True,
        )
    finally:
        db.close()


def run_db_lifecycle_cleanup_job(
    *,
    dry_run: bool | None = None,
    batch_size: int = MAX_BATCH_SIZE,
    confirm_text: str | None = None,
) -> dict[str, Any]:
    configured_dry_run = bool(settings.DB_LIFECYCLE_CLEANUP_DRY_RUN) or not bool(settings.DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE)
    requested_dry_run = True if dry_run is None else bool(dry_run)
    effective_dry_run = configured_dry_run or requested_dry_run
    return run_db_lifecycle_cleanup_once(
        dry_run=effective_dry_run,
        batch_size=batch_size,
        confirm_text=confirm_text,
    )


def enqueue_db_lifecycle_cleanup_job(*, force: bool = False) -> dict[str, Any]:
    interval = _enqueue_interval_seconds()
    window = _window_id(interval_seconds=interval)
    job_id = f"{JOB_NAME}_{window}"
    if not settings.DB_LIFECYCLE_CLEANUP_ENABLED:
        return {
            "ok": True,
            "enqueued": False,
            "queue": QUEUE_MAINTENANCE,
            "job_id": job_id,
            "window": window,
            "reason": "DISABLED",
        }

    scheduler_confirm = _configured_execute_confirm()
    scheduler_dry_run = not can_execute_cleanup(scheduler_confirm)
    lock_key = f"{JOB_NAME}:enqueue:{window}"
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
                "reason": "DUPLICATE_WINDOW",
            }

    queue = get_queue(QUEUE_MAINTENANCE)
    try:
        job = queue.enqueue_call(
            func=run_db_lifecycle_cleanup_job,
            kwargs={"dry_run": scheduler_dry_run, "confirm_text": scheduler_confirm},
            timeout=1800,
            result_ttl=7 * 24 * 3600,
            failure_ttl=7 * 24 * 3600,
            job_id=job_id,
            description=f"{JOB_NAME} window={window} dry_run={scheduler_dry_run}",
        )
    except Exception:
        if not force:
            redis.delete(lock_key)
        raise

    return {
        "ok": True,
        "enqueued": True,
        "queue": QUEUE_MAINTENANCE,
        "job_id": str(job.id),
        "window": window,
        "dry_run": scheduler_dry_run,
    }


def process_db_lifecycle_cleanup_scheduler_once() -> dict[str, Any]:
    return enqueue_db_lifecycle_cleanup_job()
