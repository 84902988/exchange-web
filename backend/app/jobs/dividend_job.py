from __future__ import annotations

# IMPORTANT:
# Dividend job currently supports SINGLE INSTANCE ONLY.
# Do NOT run multiple backend instances with dividend job enabled,
# otherwise it may cause duplicate distribution.
# Future improvement: DB lock or Redis distributed lock.

import logging
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.dividend import DividendPool, DividendPoolItem, UserDividendRecord
from app.db.models.dividend_job_log import DividendJobLog
from app.db.session import SessionLocal
from app.services.dividend_service import (
    calculate_dividend_pool,
    create_dividend_pool_skeleton,
    distribute_dividend_pool,
    get_dividend_config,
)
from app.services.service_heartbeat import start_heartbeat_thread


DIVIDEND_JOB_INTERVAL_SECONDS = 60
DIVIDEND_HEARTBEAT_SERVICE_NAME = "dividend_job"
DIVIDEND_HEARTBEAT_INTERVAL_SECONDS = 10
DIVIDEND_HEARTBEAT_TTL_SECONDS = 30
logger = logging.getLogger(__name__)

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None
_attempted_dates: set[str] = set()
_lock = threading.Lock()
_last_check_at: Optional[datetime] = None
_last_check_result = "NOT_STARTED"
_last_run_time_utc = "00:10"


def _utc_now() -> datetime:
    return datetime.utcnow()


def _log(message: str) -> None:
    logger.info("[dividend_job] %s", message)


def _iso_utc(value: Optional[datetime]) -> str:
    if value is None:
        return ""
    return value.replace(microsecond=0).isoformat() + "Z"


def _update_heartbeat_state(
    *,
    run_time_utc: Optional[str] = None,
    last_check_at: Optional[datetime] = None,
    last_check_result: Optional[str] = None,
) -> None:
    global _last_check_at, _last_check_result, _last_run_time_utc
    with _lock:
        if run_time_utc:
            _last_run_time_utc = str(run_time_utc).strip()
        if last_check_at is not None:
            _last_check_at = last_check_at
        if last_check_result:
            _last_check_result = str(last_check_result).strip()[:80]


def _dividend_heartbeat_payload() -> dict[str, Any]:
    with _lock:
        last_check_at = _last_check_at
        last_check_result = _last_check_result
        run_time_utc = _last_run_time_utc
    return {
        "run_time_utc": run_time_utc,
        "last_check_at": _iso_utc(last_check_at),
        "last_check_result": last_check_result,
    }


def _run_time_matches(now_utc: datetime, run_time_utc: str) -> bool:
    return now_utc.strftime("%H:%M") == str(run_time_utc or "").strip()


def _target_dividend_date(now_utc: datetime):
    return (now_utc.date() - timedelta(days=1))


def _mark_attempted_once(dividend_date) -> bool:
    key = dividend_date.isoformat()
    with _lock:
        if key in _attempted_dates:
            return False
        _attempted_dates.add(key)
        return True


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


def process_dividend_job_once(now_utc: Optional[datetime] = None, trigger_type: str = "AUTO") -> str:
    now = now_utc or _utc_now()
    db = SessionLocal()
    dividend_date = None
    pool_id = None
    step = "CHECK_TIME"
    try:
        config = get_dividend_config(db)
        run_time_utc = str(config.get("run_time_utc") or "00:10").strip()
        _update_heartbeat_state(run_time_utc=run_time_utc, last_check_at=now)
        if not _run_time_matches(now, run_time_utc):
            _update_heartbeat_state(last_check_result="SKIPPED_TIME")
            return "SKIPPED_TIME"

        dividend_date = _target_dividend_date(now)
        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status="DUE",
            step="CHECK_TIME",
            message=f"dividend job reached configured run_time_utc={run_time_utc}",
        )
        if not _mark_attempted_once(dividend_date):
            _write_job_log(
                run_time=now,
                dividend_date=dividend_date,
                trigger_type=trigger_type,
                status="SKIPPED_IN_PROCESS",
                step="SKIP",
                message="当前进程内该分红日期已执行过，跳过",
            )
            _update_heartbeat_state(last_check_result="SKIPPED_IN_PROCESS")
            return "SKIPPED_IN_PROCESS"

        result, step, pool_id, message = _run_dividend_pool_state_machine(
            db,
            dividend_date=dividend_date,
            create_source="AUTO",
        )

        db.commit()
        _log(f"success dividend_date={dividend_date}, result={result}")
        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status=result,
            step=step,
            pool_id=pool_id,
            message=message,
        )
        _update_heartbeat_state(last_check_result=result)
        return result
    except Exception as exc:
        db.rollback()
        _log(f"failed error={repr(exc)}")
        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status="FAILED",
            step=step,
            pool_id=pool_id,
            message="分红任务执行失败",
            error_message=repr(exc),
        )
        _update_heartbeat_state(last_check_result="FAILED")
        return "FAILED"
    finally:
        db.close()


def process_dividend_job_for_date(dividend_date, trigger_type: str = "MANUAL_TRIGGER") -> dict[str, Any]:
    now = _utc_now()
    db = SessionLocal()
    pool_id = None
    step = "CHECK_DATE"
    try:
        if dividend_date is None:
            raise ValueError("dividend_date is required")
        if dividend_date >= now.date():
            raise ValueError("dividend_date must be earlier than current UTC date")

        _write_job_log(
            run_time=now,
            dividend_date=dividend_date,
            trigger_type=trigger_type,
            status="DUE",
            step=step,
            message="manual trigger reached dividend auto state machine",
        )

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
            message=message,
        )
        return {
            "ok": result != "FAILED",
            "status": result,
            "step": step,
            "pool_id": pool_id,
            "message": message,
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
            message="manual dividend auto rerun failed",
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


def start_dividend_job() -> None:
    global _thread, _stop_event

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()

    def _worker() -> None:
        _log(f"Dividend job started (single-instance mode), interval={DIVIDEND_JOB_INTERVAL_SECONDS}s")
        start_heartbeat_thread(
            DIVIDEND_HEARTBEAT_SERVICE_NAME,
            interval_sec=DIVIDEND_HEARTBEAT_INTERVAL_SECONDS,
            ttl_sec=DIVIDEND_HEARTBEAT_TTL_SECONDS,
            stop_event=stop_event,
            extra_payload_factory=_dividend_heartbeat_payload,
        )
        _write_job_log(
            run_time=_utc_now(),
            trigger_type="AUTO",
            status="THREAD_STARTED",
            step="START",
            message="Dividend job thread started",
        )
        while not stop_event.is_set():
            try:
                process_dividend_job_once()
            except Exception as exc:
                now = _utc_now()
                _log(f"loop error={repr(exc)}")
                _write_job_log(
                    run_time=now,
                    trigger_type="AUTO",
                    status="THREAD_LOOP_FAILED",
                    step="LOOP",
                    message="Dividend job loop failed",
                    error_message=repr(exc),
                )
                _update_heartbeat_state(last_check_at=now, last_check_result="THREAD_LOOP_FAILED")
            stop_event.wait(DIVIDEND_JOB_INTERVAL_SECONDS)
        _log("stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="dividend-job", daemon=True)
    _thread.start()


def stop_dividend_job() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None
