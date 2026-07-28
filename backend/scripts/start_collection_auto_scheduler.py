from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import and_, or_, text


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.collection import CollectionTask, CollectionTaskStatus, GasTask, GasTaskStatus  # noqa: E402
from app.db.models.system_config import SystemConfig  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.admin_queries import admin_query_collection_auto_settings  # noqa: E402
from app.services.collection_candidate_scanner import admin_create_collection_tasks  # noqa: E402
from app.services.collection_service import (  # noqa: E402
    reconcile_terminal_gas_required_collection_tasks,
    refresh_collection_batch_aggregate,
)
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402
from app.tasks.collection_tasks import (  # noqa: E402
    enqueue_collection_after_real_gas_confirmed,
    enqueue_collection_task,
    enqueue_gas_task,
    enqueue_tx_confirm_collection_task,
    enqueue_tx_confirm_gas_task,
    is_collection_task_job_active,
    is_gas_task_job_active,
)


logger = logging.getLogger(__name__)

LAST_RUN_PREFIX = "collection_auto_last_run:"
SCHEDULER_SERVICE_NAME = "collection_auto_scheduler"
DEFAULT_TICK_SECONDS = 30
RETRY_RECONCILE_ENABLED_ENV = "COLLECTION_RETRY_RECONCILE_ENABLED"
RETRY_RECONCILE_NOT_BEFORE_ENV = "COLLECTION_RETRY_RECONCILE_NOT_BEFORE"
RETRY_RECONCILE_LIMIT = 100
TX_CONFIRM_RECONCILE_LIMIT = 100
TX_CONFIRM_SENT_GRACE_SECONDS = 30
TX_CONFIRM_CONFIRMING_GRACE_SECONDS = 15 * 60
CONFIRMED_GAS_CONTINUE_LIMIT = 100
_scheduler_health_lock = threading.Lock()
_scheduler_health: dict[str, Any] = {
    "last_tick_at": None,
    "last_tick_ok": None,
    "last_tick_error": "",
    "consecutive_failures": 0,
}


def _scheduler_tick_timestamp() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _record_scheduler_tick(result: dict[str, Any]) -> None:
    ok = bool(result.get("ok"))
    error = str(result.get("error") or "")[:240]
    if not error and not ok:
        for item in result.get("chains") or []:
            if item.get("error"):
                error = str(item.get("error"))[:240]
                break
            enqueue_errors = item.get("enqueue_errors") or []
            if enqueue_errors:
                error = str(enqueue_errors[0])[:240]
                break
    with _scheduler_health_lock:
        failures = 0 if ok else int(_scheduler_health.get("consecutive_failures") or 0) + 1
        _scheduler_health.update(
            {
                "last_tick_at": _scheduler_tick_timestamp(),
                "last_tick_ok": ok,
                "last_tick_error": error,
                "consecutive_failures": failures,
            }
        )


def get_collection_auto_scheduler_heartbeat_payload() -> dict[str, Any]:
    with _scheduler_health_lock:
        return dict(_scheduler_health)


def _rollback_scheduler_session(db: Any) -> None:
    if db is None:
        return
    try:
        db.rollback()
    except Exception:
        logger.warning("collection auto scheduler rollback failed", exc_info=True)


def _close_scheduler_session(db: Any) -> None:
    if db is None:
        return
    try:
        db.close()
    except Exception:
        # Cleanup failures must not replace the tick health result or stop the
        # forever loop. The next tick creates a fresh SQLAlchemy session.
        logger.warning("collection auto scheduler session close failed", exc_info=True)


def _last_run_key(chain_key: str) -> str:
    return f"{LAST_RUN_PREFIX}{str(chain_key or '').strip().lower()}"


def _parse_datetime(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


def _load_last_run_at(db, chain_key: str) -> Optional[datetime]:
    row = db.query(SystemConfig).filter(SystemConfig.config_key == _last_run_key(chain_key)).first()
    if not row:
        return None
    try:
        payload = json.loads(row.config_value or "{}")
    except Exception:
        payload = {}
    return _parse_datetime(payload.get("started_at") if isinstance(payload, dict) else None)


def _save_last_run(db, chain_key: str, payload: dict[str, Any]) -> None:
    key = _last_run_key(chain_key)
    row = db.query(SystemConfig).filter(SystemConfig.config_key == key).first()
    value = json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":"))
    if row:
        row.config_value = value
        row.description = "Collection auto scheduler last run"
        row.updated_at = datetime.utcnow()
    else:
        db.add(
            SystemConfig(
                config_key=key,
                config_value=value,
                description="Collection auto scheduler last run",
            )
        )


def _decimal_or_none(value: Any) -> Optional[Decimal]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        amount = Decimal(text)
    except Exception:
        return None
    return amount if amount > 0 else None


def _env_enabled(name: str, default: bool = False) -> bool:
    raw = str(os.getenv(name, "1" if default else "0") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _retry_reconcile_not_before() -> Optional[datetime]:
    return _parse_datetime(os.getenv(RETRY_RECONCILE_NOT_BEFORE_ENV, ""))


def _load_due_retry_task_ids(
    db,
    *,
    model,
    chain_key: str,
    not_before: Optional[datetime],
    limit: int = RETRY_RECONCILE_LIMIT,
) -> list[int]:
    now = datetime.utcnow()
    query = (
        db.query(model.id)
        .filter(model.chain_key == str(chain_key or "").strip().lower())
        .filter(model.status == "FAILED")
        .filter(model.tx_hash.is_(None) | (model.tx_hash == ""))
        .filter(model.next_retry_at.isnot(None))
        .filter(model.next_retry_at <= now)
        .filter(model.retry_count < model.max_retry)
    )
    if not_before is not None:
        query = query.filter(model.updated_at >= not_before)
    rows = query.order_by(model.next_retry_at.asc(), model.id.asc()).limit(max(1, int(limit))).all()
    return [int(row[0]) for row in rows]


def _partition_created_collection_task_ids(db, task_ids: list[int]) -> tuple[list[int], list[int]]:
    normalized_ids = list(dict.fromkeys(int(task_id) for task_id in task_ids))
    if not normalized_ids:
        return [], []
    waiting_statuses = {
        CollectionTaskStatus.GAS_REQUIRED.value,
        CollectionTaskStatus.GAS_QUEUED.value,
        "WAITING_GAS",
        "WAIT_GAS",
        "GAS_CONFIRMING",
        "WAITING_GAS_CONFIRM",
        "PENDING_GAS",
    }
    rows = (
        db.query(CollectionTask.id, CollectionTask.status, CollectionTask.gas_task_id)
        .filter(CollectionTask.id.in_(normalized_ids))
        .all()
    )
    row_by_id = {int(row[0]): row for row in rows}
    ready_ids: list[int] = []
    waiting_ids: list[int] = []
    for task_id in normalized_ids:
        row = row_by_id.get(task_id)
        if row is None:
            continue
        status = str(row[1] or "").strip().upper()
        gas_task_id = row[2]
        if gas_task_id is not None or status in waiting_statuses:
            waiting_ids.append(task_id)
        else:
            ready_ids.append(task_id)
    return ready_ids, waiting_ids


def _load_confirmed_gas_waiting_collection_ids(
    db,
    *,
    chain_key: str,
    limit: int = CONFIRMED_GAS_CONTINUE_LIMIT,
) -> list[int]:
    waiting_statuses = {
        CollectionTaskStatus.GAS_REQUIRED.value,
        CollectionTaskStatus.GAS_QUEUED.value,
        "WAITING_GAS",
        "WAIT_GAS",
        "GAS_CONFIRMING",
        "WAITING_GAS_CONFIRM",
        "PENDING_GAS",
    }
    rows = (
        db.query(GasTask.id)
        .join(CollectionTask, CollectionTask.gas_task_id == GasTask.id)
        .filter(GasTask.chain_key == str(chain_key or "").strip().lower())
        .filter(GasTask.status == GasTaskStatus.CONFIRMED.value)
        .filter(GasTask.tx_hash.isnot(None))
        .filter(GasTask.tx_hash != "")
        .filter(CollectionTask.status.in_(waiting_statuses))
        .filter(CollectionTask.tx_hash.is_(None) | (CollectionTask.tx_hash == ""))
        .order_by(GasTask.confirmed_at.asc(), GasTask.id.asc())
        .limit(max(1, int(limit)))
        .all()
    )
    return list(dict.fromkeys(int(row[0]) for row in rows))


def _record_enqueue_failure(db, *, model, task_id: int, message: str) -> None:
    db.rollback()
    task = db.query(model).filter(model.id == int(task_id)).first()
    if not task or str(task.tx_hash or "").strip():
        return
    status = str(task.status or "").upper()
    if model is CollectionTask:
        allowed_statuses = {
            CollectionTaskStatus.PENDING.value,
            CollectionTaskStatus.READY.value,
            CollectionTaskStatus.FAILED.value,
        }
    else:
        allowed_statuses = {GasTaskStatus.PENDING.value, GasTaskStatus.FAILED.value}
    if status not in allowed_statuses:
        return
    now = datetime.utcnow()
    task.status = "FAILED"
    task.last_error = str(message or "AUTO_ENQUEUE_FAILED")[:1000]
    task.next_retry_at = (
        now + timedelta(minutes=2)
        if int(task.retry_count or 0) < int(task.max_retry or 0)
        else None
    )
    task.locked_at = None
    task.updated_at = now
    if model is CollectionTask:
        refresh_collection_batch_aggregate(db, task.batch_id)
    db.commit()


def _load_stale_tx_confirm_task_ids(
    db,
    *,
    model,
    sent_statuses: tuple[str, ...],
    confirming_statuses: tuple[str, ...],
    limit: int = TX_CONFIRM_RECONCILE_LIMIT,
) -> list[int]:
    now = datetime.utcnow()
    sent_cutoff = now - timedelta(seconds=TX_CONFIRM_SENT_GRACE_SECONDS)
    confirming_cutoff = now - timedelta(seconds=TX_CONFIRM_CONFIRMING_GRACE_SECONDS)
    rows = (
        db.query(model.id)
        .filter(model.tx_hash.isnot(None))
        .filter(model.tx_hash != "")
        .filter(
            or_(
                and_(model.status.in_(sent_statuses), model.updated_at <= sent_cutoff),
                and_(model.status.in_(confirming_statuses), model.updated_at <= confirming_cutoff),
            )
        )
        .order_by(model.updated_at.asc(), model.id.asc())
        .limit(max(1, int(limit)))
        .all()
    )
    return [int(row[0]) for row in rows]


def _enqueue_stale_tx_confirm_tasks(db) -> dict[str, Any]:
    collection_ids = _load_stale_tx_confirm_task_ids(
        db,
        model=CollectionTask,
        sent_statuses=(CollectionTaskStatus.SENT.value, "COLLECTION_SENT"),
        confirming_statuses=("CONFIRMING", "COLLECTION_CONFIRMING"),
    )
    gas_ids = _load_stale_tx_confirm_task_ids(
        db,
        model=GasTask,
        sent_statuses=(GasTaskStatus.SENT.value,),
        confirming_statuses=(GasTaskStatus.CONFIRMING.value,),
    )
    errors: list[str] = []
    collection_jobs: list[str] = []
    gas_jobs: list[str] = []
    for task_id in collection_ids:
        try:
            collection_jobs.append(enqueue_tx_confirm_collection_task(task_id))
        except Exception as exc:
            logger.warning("stale collection tx_confirm enqueue failed task_id=%s", task_id, exc_info=True)
            errors.append(f"collection task {task_id}: {type(exc).__name__}:{str(exc)[:180]}")
    for task_id in gas_ids:
        try:
            gas_jobs.append(enqueue_tx_confirm_gas_task(task_id))
        except Exception as exc:
            logger.warning("stale gas tx_confirm enqueue failed task_id=%s", task_id, exc_info=True)
            errors.append(f"gas task {task_id}: {type(exc).__name__}:{str(exc)[:180]}")
    return {
        "collection_candidate_count": len(collection_ids),
        "gas_candidate_count": len(gas_ids),
        "collection_enqueued_count": len(collection_jobs),
        "gas_enqueued_count": len(gas_jobs),
        "errors": errors,
    }


def _load_candidate_symbols(db, chain_key: str) -> list[str]:
    rows = db.execute(
        text(
            """
        SELECT DISTINCT UPPER(asset_symbol) AS coin_symbol
        FROM collection_candidates
        WHERE LOWER(chain_key)=:chain_key
          AND NULLIF(asset_symbol, '') IS NOT NULL
        ORDER BY UPPER(asset_symbol)
        """
        ),
        {"chain_key": chain_key},
    ).mappings().all()
    return [str(row.get("coin_symbol") or "").strip().upper() for row in rows if row.get("coin_symbol")]


def process_collection_auto_scheduler_once() -> dict[str, Any]:
    db = None
    started_at = datetime.utcnow()
    summary: dict[str, Any] = {"ok": True, "started_at": started_at.isoformat(timespec="seconds") + "Z", "chains": []}
    try:
        db = SessionLocal()
        settings = admin_query_collection_auto_settings(db)
        tx_confirm_reconcile = _enqueue_stale_tx_confirm_tasks(db)
        summary["tx_confirm_reconcile"] = tx_confirm_reconcile
        if tx_confirm_reconcile.get("errors"):
            summary["ok"] = False
        retry_reconcile_requested = _env_enabled(RETRY_RECONCILE_ENABLED_ENV)
        retry_not_before = _retry_reconcile_not_before()
        retry_reconcile_enabled = bool(retry_reconcile_requested and retry_not_before is not None)
        if retry_reconcile_requested and retry_not_before is None:
            summary["ok"] = False
            summary["retry_reconcile_error"] = f"{RETRY_RECONCILE_NOT_BEFORE_ENV} is required when retry reconcile is enabled"
            logger.error(summary["retry_reconcile_error"])
        for rule in settings.get("rules") or []:
            chain_key = str(rule.get("chain_key") or "").strip().lower()
            if not chain_key:
                continue
            interval = max(60, int(rule.get("scan_interval_seconds") or 300))
            max_addresses = max(1, min(500, int(rule.get("max_addresses") or 200)))
            last_run_at = _load_last_run_at(db, chain_key)
            due = last_run_at is None or datetime.utcnow() - last_run_at >= timedelta(seconds=interval)
            if not rule.get("auto_task_enabled"):
                summary["chains"].append({"chain_key": chain_key, "status": "skipped", "reason": "AUTO_COLLECTION_DISABLED"})
                continue
            if not due:
                summary["chains"].append({"chain_key": chain_key, "status": "skipped", "reason": "NOT_DUE"})
                continue

            chain_started_at = datetime.utcnow()
            chain_result: dict[str, Any] = {
                "chain_key": chain_key,
                "status": "running",
                "started_at": chain_started_at.isoformat(timespec="seconds") + "Z",
            }
            try:
                symbols = _load_candidate_symbols(db, chain_key)
                if not symbols:
                    symbols = ["USDT"]
                created_task_ids: list[int] = []
                created_gas_task_ids: list[int] = []
                retry_collection_task_ids: list[int] = []
                retry_gas_task_ids: list[int] = []
                terminal_gas_released_task_ids = reconcile_terminal_gas_required_collection_tasks(
                    db,
                    chain_key=chain_key,
                )
                db.commit()
                confirmed_gas_continue_ids = _load_confirmed_gas_waiting_collection_ids(
                    db,
                    chain_key=chain_key,
                )
                confirmed_gas_continue_results: list[dict[str, Any]] = []
                for gas_task_id in confirmed_gas_continue_ids:
                    confirmed_gas_continue_results.append(
                        {
                            "gas_task_id": gas_task_id,
                            "result": enqueue_collection_after_real_gas_confirmed(gas_task_id),
                        }
                    )
                db.expire_all()
                skipped_count = 0
                warnings: list[str] = []
                if retry_reconcile_enabled:
                    retry_collection_task_ids = _load_due_retry_task_ids(
                        db,
                        model=CollectionTask,
                        chain_key=chain_key,
                        not_before=retry_not_before,
                    )
                    if rule.get("auto_gas_enabled"):
                        retry_gas_task_ids = _load_due_retry_task_ids(
                            db,
                            model=GasTask,
                            chain_key=chain_key,
                            not_before=retry_not_before,
                        )
                for symbol in symbols:
                    scan_result = admin_create_collection_tasks(
                        db,
                        chain_key=chain_key,
                        asset_symbol=symbol,
                        min_amount=_decimal_or_none(rule.get("min_collect_amount_form")),
                        limit=max_addresses,
                        candidate_source="events",
                        trigger_type="AUTO",
                    )
                    created_task_ids.extend(scan_result.created_task_ids)
                    created_gas_task_ids.extend(scan_result.created_gas_task_ids)
                    skipped_count += scan_result.skipped_count
                    warnings.extend(scan_result.warnings)
                created_collection_enqueue_ids, waiting_gas_collection_task_ids = _partition_created_collection_task_ids(
                    db,
                    created_task_ids,
                )
                db.commit()
                enqueued_collection = []
                enqueued_gas = []
                enqueue_errors: list[str] = []
                skipped_active_retry_count = 0
                collection_enqueue_ids = list(dict.fromkeys(created_collection_enqueue_ids + retry_collection_task_ids))
                gas_enqueue_ids = list(dict.fromkeys(created_gas_task_ids + retry_gas_task_ids))
                retry_collection_id_set = set(retry_collection_task_ids)
                retry_gas_id_set = set(retry_gas_task_ids)
                for task_id in collection_enqueue_ids:
                    if task_id in retry_collection_id_set and is_collection_task_job_active(int(task_id)):
                        skipped_active_retry_count += 1
                        continue
                    try:
                        enqueued_collection.append(enqueue_collection_task(int(task_id), allow_real_send=True))
                    except Exception as exc:
                        if is_collection_task_job_active(int(task_id)):
                            skipped_active_retry_count += 1
                            continue
                        logger.warning("collection auto enqueue collection failed task_id=%s reason=%r", task_id, exc)
                        enqueue_errors.append(f"collection task {task_id}: {exc!r}")
                        _record_enqueue_failure(
                            db,
                            model=CollectionTask,
                            task_id=int(task_id),
                            message=f"AUTO_ENQUEUE_FAILED:{type(exc).__name__}:{str(exc)[:180]}",
                        )
                if rule.get("auto_gas_enabled"):
                    for gas_task_id in gas_enqueue_ids:
                        if gas_task_id in retry_gas_id_set and is_gas_task_job_active(int(gas_task_id)):
                            skipped_active_retry_count += 1
                            continue
                        try:
                            enqueued_gas.append(enqueue_gas_task(int(gas_task_id), allow_real_send=True))
                        except Exception as exc:
                            if is_gas_task_job_active(int(gas_task_id)):
                                skipped_active_retry_count += 1
                                continue
                            logger.warning("collection auto enqueue gas failed gas_task_id=%s reason=%r", gas_task_id, exc)
                            enqueue_errors.append(f"gas task {gas_task_id}: {exc!r}")
                            _record_enqueue_failure(
                                db,
                                model=GasTask,
                                task_id=int(gas_task_id),
                                message=f"AUTO_ENQUEUE_FAILED:{type(exc).__name__}:{str(exc)[:180]}",
                            )
                if enqueue_errors:
                    summary["ok"] = False
                chain_result.update(
                    {
                        "status": "partial" if enqueue_errors else "completed",
                        "symbols": symbols,
                        "created_task_count": len(created_task_ids),
                        "created_gas_task_count": len(created_gas_task_ids),
                        "created_task_ids": created_task_ids,
                        "created_gas_task_ids": created_gas_task_ids,
                        "retry_reconcile_enabled": retry_reconcile_enabled,
                        "retry_not_before": retry_not_before.isoformat() + "Z" if retry_not_before else "",
                        "retry_collection_task_count": len(retry_collection_task_ids),
                        "retry_gas_task_count": len(retry_gas_task_ids),
                        "terminal_gas_released_task_count": len(terminal_gas_released_task_ids),
                        "terminal_gas_released_task_ids": terminal_gas_released_task_ids,
                        "confirmed_gas_continue_count": len(confirmed_gas_continue_ids),
                        "confirmed_gas_continue_results": confirmed_gas_continue_results,
                        "waiting_gas_collection_task_count": len(waiting_gas_collection_task_ids),
                        "waiting_gas_collection_task_ids": waiting_gas_collection_task_ids,
                        "skipped_active_retry_count": skipped_active_retry_count,
                        "enqueued_collection_count": len(enqueued_collection),
                        "enqueued_gas_count": len(enqueued_gas),
                        "skipped_count": skipped_count,
                        "warnings": warnings,
                        "enqueue_errors": enqueue_errors,
                    }
                )
            except Exception as exc:
                _rollback_scheduler_session(db)
                chain_result.update({"status": "failed", "error": str(exc)[:240]})
                summary["ok"] = False
                logger.exception("collection auto scheduler chain failed chain=%s", chain_key)
            finally:
                chain_result["finished_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
                _save_last_run(db, chain_key, chain_result)
                db.commit()
                summary["chains"].append(chain_result)
        summary["finished_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        _record_scheduler_tick(summary)
        return summary
    except Exception as exc:
        _rollback_scheduler_session(db)
        logger.exception("collection auto scheduler tick failed")
        summary.update(
            {
                "ok": False,
                "error": repr(exc),
                "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            }
        )
        _record_scheduler_tick(summary)
        return summary
    finally:
        _close_scheduler_session(db)


def run_collection_auto_scheduler_forever(tick_seconds: int = DEFAULT_TICK_SECONDS) -> None:
    tick = max(5, int(tick_seconds or DEFAULT_TICK_SECONDS))
    while True:
        try:
            result = process_collection_auto_scheduler_once()
            log_method = logger.info if result.get("ok") else logger.error
            log_method("collection auto scheduler tick result=%s", json.dumps(result, ensure_ascii=False, default=str))
        except Exception as exc:
            result = {"ok": False, "error": repr(exc)}
            _record_scheduler_tick(result)
            logger.exception("collection auto scheduler unexpected tick failure")
        time.sleep(tick)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the collection auto scheduler.")
    parser.add_argument("--once", action="store_true", help="run one scheduler tick and exit")
    parser.add_argument("--tick-seconds", type=int, default=int(os.getenv("COLLECTION_AUTO_SCHEDULER_TICK_SECONDS", "30")))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if args.once:
        result = process_collection_auto_scheduler_once()
        print(json.dumps(result, ensure_ascii=False, default=str))
        return 0 if result.get("ok") else 1
    heartbeat_stop_event = start_heartbeat_thread(
        SCHEDULER_SERVICE_NAME,
        extra_payload_factory=get_collection_auto_scheduler_heartbeat_payload,
    )
    try:
        run_collection_auto_scheduler_forever(args.tick_seconds)
    finally:
        heartbeat_stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
