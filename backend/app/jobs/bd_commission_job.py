from __future__ import annotations

# IMPORTANT:
# BD commission auto payout only pays existing PENDING records.
# It does not calculate commissions, change fee deduction, or touch dividend pools.

import logging
import threading
from datetime import datetime
from decimal import Decimal
from typing import Optional

from app.db.models.bd_commission_job_log import BdCommissionJobLog
from app.db.models.bd_commission_record import BdCommissionRecord
from app.db.session import SessionLocal
from app.services.bd_commission_service import InsufficientPlatformBalanceError, pay_bd_commission_record


BD_COMMISSION_JOB_INTERVAL_SECONDS = 60
BD_COMMISSION_JOB_BATCH_LIMIT = 100
logger = logging.getLogger(__name__)

_thread: Optional[threading.Thread] = None
_stop_event: Optional[threading.Event] = None
_run_lock = threading.Lock()


def _utc_now() -> datetime:
    return datetime.utcnow()


def _log(message: str) -> None:
    logger.info("[bd_commission_job] %s", message)


def _write_job_log(
    *,
    run_time: datetime,
    status: str,
    step: str,
    processed_count: int = 0,
    success_count: int = 0,
    failed_count: int = 0,
    message: str = "",
    error_message: Optional[str] = None,
) -> None:
    db = SessionLocal()
    try:
        db.add(
            BdCommissionJobLog(
                run_time=run_time,
                status=status,
                step=step,
                processed_count=int(processed_count or 0),
                success_count=int(success_count or 0),
                failed_count=int(failed_count or 0),
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


def _format_record_error(record_id: int, exc: Exception) -> str:
    return f"record_id={int(record_id)} error={type(exc).__name__}: {exc}"


def _commission_asset_symbol(record: BdCommissionRecord) -> str:
    return str(record.commission_asset_symbol or "RCB").upper().strip() or "RCB"


def _add_paid_total(result: dict, record: BdCommissionRecord) -> None:
    symbol = _commission_asset_symbol(record)
    amount = str(record.commission_amount or 0)
    totals = result.setdefault("paid_totals", {})

    totals[symbol] = str(Decimal(str(totals.get(symbol, "0"))) + Decimal(amount))


def _format_paid_totals(totals: dict) -> str:
    if not totals:
        return "RCB=0, USDT=0"
    return ", ".join(f"{symbol}={totals.get(symbol, '0')}" for symbol in sorted({"RCB", "USDT", *totals.keys()}))


def _mark_record_failed(db, record_id: int) -> None:
    record = (
        db.query(BdCommissionRecord)
        .filter(
            BdCommissionRecord.id == int(record_id),
            BdCommissionRecord.status == "PENDING",
        )
        .with_for_update()
        .first()
    )
    if record is None:
        return

    record.status = "FAILED"
    record.updated_at = _utc_now()
    db.add(record)
    db.flush()


def _pay_pending_records_for_job(db, limit: int) -> dict:
    record_ids = [
        int(record_id)
        for (record_id,) in (
            db.query(BdCommissionRecord.id)
            .filter(BdCommissionRecord.status == "PENDING")
            .order_by(BdCommissionRecord.id.asc())
            .limit(limit)
            .all()
        )
    ]

    result = {
        "paid_count": 0,
        "skipped_count": 0,
        "failed_count": 0,
        "failed_ids": [],
        "errors": [],
        "paid_totals": {},
    }

    for record_id in record_ids:
        try:
            with db.begin_nested():
                record = pay_bd_commission_record(db, record_id)
                if record.status == "PAID":
                    result["paid_count"] += 1
                    _add_paid_total(result, record)
                else:
                    result["skipped_count"] += 1
        except Exception as exc:
            result["failed_count"] += 1
            result["failed_ids"].append(record_id)
            result["errors"].append(_format_record_error(record_id, exc))
            if not isinstance(exc, InsufficientPlatformBalanceError):
                try:
                    with db.begin_nested():
                        _mark_record_failed(db, record_id)
                except Exception as mark_exc:
                    result["errors"].append(
                        f"record_id={int(record_id)} mark_failed_error={type(mark_exc).__name__}: {mark_exc}"
                    )

    return result


def process_bd_commission_job_once(limit: int = BD_COMMISSION_JOB_BATCH_LIMIT) -> str:
    if not _run_lock.acquire(blocking=False):
        return "SKIPPED_IN_PROCESS"

    now = _utc_now()
    db = SessionLocal()
    step = "CHECK_PENDING"
    try:
        batch_limit = min(max(int(limit or BD_COMMISSION_JOB_BATCH_LIMIT), 1), BD_COMMISSION_JOB_BATCH_LIMIT)
        pending_count = int(
            db.query(BdCommissionRecord.id)
            .filter(BdCommissionRecord.status == "PENDING")
            .count()
            or 0
        )
        if pending_count <= 0:
            return "NO_PENDING"

        step = "PAYOUT_PENDING"
        result = _pay_pending_records_for_job(db, limit=batch_limit)
        db.commit()

        paid_count = int(result.get("paid_count") or 0)
        skipped_count = int(result.get("skipped_count") or 0)
        failed_count = int(result.get("failed_count") or 0)
        processed_count = paid_count + skipped_count + failed_count
        errors = result.get("errors") or []

        if failed_count > 0 and paid_count > 0:
            status = "PARTIAL_FAILED"
        elif failed_count > 0:
            status = "FAILED"
        else:
            status = "SUCCESS"

        message = (
            f"BD commission auto payout finished: paid={paid_count}, "
            f"skipped={skipped_count}, failed={failed_count}, "
            f"totals=({_format_paid_totals(result.get('paid_totals') or {})}), limit={batch_limit}"
        )
        error_message = "\n".join(str(item) for item in errors) if errors else None
        _write_job_log(
            run_time=now,
            status=status,
            step=step,
            processed_count=processed_count,
            success_count=paid_count,
            failed_count=failed_count,
            message=message,
            error_message=error_message,
        )
        _log(message)
        return status
    except Exception as exc:
        db.rollback()
        _write_job_log(
            run_time=now,
            status="FAILED",
            step=step,
            message="BD commission auto payout job failed",
            error_message=repr(exc),
        )
        _log(f"failed step={step}, error={repr(exc)}")
        return "FAILED"
    finally:
        db.close()
        _run_lock.release()


def start_bd_commission_job() -> None:
    global _thread, _stop_event

    if _thread and _thread.is_alive():
        return

    stop_event = threading.Event()

    def _worker() -> None:
        _log(
            "BD commission job started, "
            f"interval={BD_COMMISSION_JOB_INTERVAL_SECONDS}s, limit={BD_COMMISSION_JOB_BATCH_LIMIT}"
        )
        while not stop_event.is_set():
            process_bd_commission_job_once(limit=BD_COMMISSION_JOB_BATCH_LIMIT)
            stop_event.wait(BD_COMMISSION_JOB_INTERVAL_SECONDS)
        _log("stopped")

    _stop_event = stop_event
    _thread = threading.Thread(target=_worker, name="bd-commission-job", daemon=True)
    _thread.start()


def stop_bd_commission_job() -> None:
    global _thread, _stop_event

    if _stop_event is not None:
        _stop_event.set()

    if _thread and _thread.is_alive():
        _thread.join(timeout=2)

    _thread = None
    _stop_event = None
