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

from sqlalchemy import text


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.system_config import SystemConfig  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.admin_queries import admin_query_collection_auto_settings  # noqa: E402
from app.services.collection_candidate_scanner import admin_create_collection_tasks  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402
from app.tasks.collection_tasks import enqueue_collection_task, enqueue_gas_task  # noqa: E402


logger = logging.getLogger(__name__)

LAST_RUN_PREFIX = "collection_auto_last_run:"
SCHEDULER_SERVICE_NAME = "collection_auto_scheduler"
DEFAULT_TICK_SECONDS = 30
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
                skipped_count = 0
                warnings: list[str] = []
                for symbol in symbols:
                    scan_result = admin_create_collection_tasks(
                        db,
                        chain_key=chain_key,
                        asset_symbol=symbol,
                        min_amount=_decimal_or_none(rule.get("min_collect_amount_form")),
                        limit=max_addresses,
                        candidate_source="events",
                    )
                    created_task_ids.extend(scan_result.created_task_ids)
                    created_gas_task_ids.extend(scan_result.created_gas_task_ids)
                    skipped_count += scan_result.skipped_count
                    warnings.extend(scan_result.warnings)
                db.commit()
                enqueued_collection = []
                enqueued_gas = []
                enqueue_errors: list[str] = []
                for task_id in created_task_ids:
                    try:
                        enqueued_collection.append(enqueue_collection_task(int(task_id), allow_real_send=True))
                    except Exception as exc:
                        logger.warning("collection auto enqueue collection failed task_id=%s reason=%r", task_id, exc)
                        enqueue_errors.append(f"collection task {task_id}: {exc!r}")
                if rule.get("auto_gas_enabled"):
                    for gas_task_id in created_gas_task_ids:
                        try:
                            enqueued_gas.append(enqueue_gas_task(int(gas_task_id), allow_real_send=True))
                        except Exception as exc:
                            logger.warning("collection auto enqueue gas failed gas_task_id=%s reason=%r", gas_task_id, exc)
                            enqueue_errors.append(f"gas task {gas_task_id}: {exc!r}")
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
