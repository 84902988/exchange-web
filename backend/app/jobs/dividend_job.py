from __future__ import annotations

# Dividend batch execution state machine shared by the guarded manual workflow
# and the dedicated single-instance automatic scheduler. Eligibility capture
# remains owned by the independent, no-funds systemd timer.

import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.dividend import DividendPool, DividendPoolItem, UserDividendRecord
from app.db.models.dividend_job_log import DividendJobLog
from app.db.session import SessionLocal
from app.services.dividend_service import (
    build_dividend_recovery_preview,
    calculate_dividend_pool,
    capture_dividend_eligibility_snapshot,
    create_dividend_pool_skeleton,
    distribute_dividend_pool,
    get_dividend_config,
)


logger = logging.getLogger(__name__)
_attempted_auto_dates: set[str] = set()


def _utc_now() -> datetime:
    return datetime.utcnow()


def _log(message: str) -> None:
    logger.info("[dividend_job] %s", message)


def _write_job_log(
    *,
    run_time: datetime,
    dividend_date=None,
    trigger_type: str = "AUTO",
    status: str,
    step: str,
    pool_id: Optional[int] = None,
    message: str = "",
    error_message: Optional[str] = None,
) -> None:
    db = SessionLocal()
    try:
        db.add(
            DividendJobLog(
                dividend_date=dividend_date,
                run_time=run_time,
                trigger_type=trigger_type,
                status=status,
                step=step,
                pool_id=pool_id,
                message=(message or "")[:500],
                error_message=error_message,
                created_at=_utc_now(),
            )
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        _log(f"write job log failed: {repr(exc)}")
    finally:
        db.close()


def _execute_pool_flow(db: Session, pool: DividendPool) -> tuple[str, str]:
    status = str(pool.status or "").upper()
    if status == "PENDING":
        calculate_dividend_pool(db, int(pool.id))
        distribute_dividend_pool(db, int(pool.id))
        return "DISTRIBUTE", "已完成计算并发放"
    elif status == "CALCULATED":
        distribute_dividend_pool(db, int(pool.id))
        return "DISTRIBUTE", "已发放已计算分红"
    elif status == "FAILED":
        return _recover_failed_pool(db, pool)
    elif status == "PAID":
        _log(f"skip dividend_date={pool.dividend_date}, status={status}")
        return "SKIP", "分红池已发放，跳过"
    else:
        raise ValueError(f"unsupported dividend pool status: {status}")


def _recover_failed_pool(db: Session, pool: DividendPool) -> tuple[str, str]:
    item_count = db.query(DividendPoolItem.id).filter(DividendPoolItem.pool_id == pool.id).count()
    pending_record_count = (
        db.query(UserDividendRecord.id)
        .filter(
            UserDividendRecord.pool_id == pool.id,
            UserDividendRecord.status == "PENDING",
        )
        .count()
    )
    paid_record_count = (
        db.query(UserDividendRecord.id)
        .filter(
            UserDividendRecord.pool_id == pool.id,
            UserDividendRecord.status == "PAID",
        )
        .count()
    )

    if paid_record_count > 0:
        _log(
            "skip failed dividend_date={0}, reason=paid_records_exist".format(
                pool.dividend_date,
            )
        )
        return "SKIP", "FAILED 分红池已有 PAID 记录，跳过以避免重复发放"

    if item_count == 0 and pending_record_count == 0:
        pool.status = "PENDING"
        db.add(pool)
        db.flush()
        calculate_dividend_pool(db, int(pool.id))
        distribute_dividend_pool(db, int(pool.id))
        return "RECOVER_FAILED", "FAILED 无明细，已恢复为 PENDING 并完成计算发放"

    if item_count > 0 and pending_record_count > 0:
        pool.status = "CALCULATED"
        db.add(pool)
        db.flush()
        distribute_dividend_pool(db, int(pool.id))
        return "RECOVER_FAILED", "FAILED 已有待发放记录，已恢复为 CALCULATED 并发放"

    _log(
        "skip failed dividend_date={0}, reason=unsafe_state items={1} pending_records={2} paid_records={3}".format(
            pool.dividend_date,
            item_count,
            pending_record_count,
            paid_record_count,
        )
    )
    return "SKIP", "FAILED 状态无法安全恢复，已跳过"


def _run_dividend_pool_state_machine(
    db: Session,
    *,
    dividend_date,
    create_source: str,
) -> tuple[str, str, Optional[int], str]:
    step = "CHECK_POOL"
    pool = (
        db.query(DividendPool)
        .filter(DividendPool.dividend_date == dividend_date)
        .with_for_update()
        .first()
    )

    if pool is None:
        step = "CREATE_POOL"
        pool = create_dividend_pool_skeleton(db, dividend_date, source=create_source)
        pool_id = int(pool.id)
        step, message = _execute_pool_flow(db, pool)
        return "CREATED_CALCULATED_PAID", step, pool_id, message

    pool_id = int(pool.id)
    before_status = str(pool.status or "").upper()
    step, message = _execute_pool_flow(db, pool)
    return f"EXISTING_{before_status}", step, pool_id, message


def process_dividend_job_once(
    now_utc: Optional[datetime] = None,
    trigger_type: str = "AUTO",
) -> str:
    now = now_utc or _utc_now()
    db = SessionLocal()
    dividend_date = now.date() - timedelta(days=1)
    pool_id: Optional[int] = None
    step = "CHECK_TIME"
    try:
        config = get_dividend_config(db)
        run_time_utc = str(config.get("run_time_utc") or "00:10").strip()
        if now.strftime("%H:%M") != run_time_utc:
            return "SKIPPED_TIME"

        date_key = dividend_date.isoformat()
        if date_key in _attempted_auto_dates:
            return "SKIPPED_IN_PROCESS"

        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status="DUE",
            step=step,
            message=f"dedicated dividend scheduler reached run_time_utc={run_time_utc}",
        )
        result, step, pool_id, message = _run_dividend_pool_state_machine(
            db,
            dividend_date=dividend_date,
            create_source="AUTO",
        )
        db.commit()
        _attempted_auto_dates.add(date_key)
        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status=result,
            step=step,
            pool_id=pool_id,
            message=message,
        )
        return result
    except Exception as exc:
        db.rollback()
        _log(f"automatic scheduler failed error={repr(exc)}")
        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status="FAILED",
            step=step,
            pool_id=pool_id,
            message="dedicated dividend scheduler failed",
            error_message=repr(exc),
        )
        return "FAILED"
    finally:
        db.close()


def process_dividend_job_for_date(
    dividend_date,
    trigger_type: str = "MANUAL_TRIGGER",
    *,
    recover_missing_snapshot: bool = False,
    expected_preview_fingerprint: str = "",
    operator_id: Optional[int] = None,
) -> dict[str, Any]:
    now = _utc_now()
    db = SessionLocal()
    pool_id = None
    step = "CHECK_DATE"
    preview: Optional[dict[str, Any]] = None
    operator_message = f"operator_id={int(operator_id)}" if operator_id is not None else "operator_id=unknown"
    try:
        if dividend_date is None:
            raise ValueError("dividend_date is required")
        if dividend_date >= now.date():
            raise ValueError("dividend_date must be earlier than current UTC date")

        if recover_missing_snapshot:
            step = "VERIFY_PREVIEW"
            preview = build_dividend_recovery_preview(db, dividend_date, now_utc=now)
            expected = str(expected_preview_fingerprint or "").strip().lower()
            actual = str(preview.get("fingerprint") or "").strip().lower()
            if not expected or expected != actual:
                raise ValueError("DIVIDEND_RECOVERY_PREVIEW_CHANGED")
            if not bool(preview.get("can_execute")):
                raise ValueError("DIVIDEND_RECOVERY_PLATFORM_BALANCE_INSUFFICIENT")
            if str(preview.get("snapshot_source") or "").upper() == "OPS_RECONSTRUCTED":
                step = "RECOVER_SNAPSHOT"
                capture_dividend_eligibility_snapshot(
                    db,
                    dividend_date,
                    now_utc=now,
                    source="OPS_RECOVERY",
                    created_by=operator_id,
                    allow_outside_window=True,
                )

        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status="DUE",
            step=step,
            message=(
                "operations dividend recovery confirmed; "
                f"{operator_message}; preview={str(expected_preview_fingerprint or '')[:16]}"
                if recover_missing_snapshot
                else "manual trigger reached dividend auto state machine"
            ),
        )

        step = "CHECK_POOL"
        result, step, pool_id, message = _run_dividend_pool_state_machine(
            db,
            dividend_date=dividend_date,
            create_source=trigger_type,
        )
        db.commit()
        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status=result,
            step=step,
            pool_id=pool_id,
            message=(
                f"{message}; {operator_message}; preview={str(expected_preview_fingerprint or '')[:16]}"
                if recover_missing_snapshot
                else message
            ),
        )
        return {
            "ok": result != "FAILED",
            "status": result,
            "step": step,
            "pool_id": pool_id,
            "message": message,
            "preview": preview,
        }
    except Exception as exc:
        db.rollback()
        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status="FAILED",
            step=step,
            pool_id=pool_id,
            message=(
                f"operations dividend recovery failed; {operator_message}"
                if recover_missing_snapshot
                else "manual dividend auto rerun failed"
            ),
            error_message=repr(exc),
        )
        return {
            "ok": False,
            "status": "FAILED",
            "step": step,
            "pool_id": pool_id,
            "message": "manual dividend auto rerun failed",
            "error": repr(exc),
        }
    finally:
        db.close()
