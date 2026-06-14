from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from sqlalchemy import bindparam, text


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

load_dotenv(dotenv_path=BACKEND_DIR / ".env", override=False)

from app.db.session import SessionLocal  # noqa: E402
from app.db.models.collection import CollectionTask  # noqa: E402
from app.services.collection_service import (  # noqa: E402
    mark_collection_task_confirmed,
    mark_collection_task_failed,
    queue_collection_task_changed,
    refresh_collection_batch_aggregate,
)
from app.services.collection_tx_confirm_service import _receipt_status_and_block  # noqa: E402


CONFIRM_CANDIDATE_STATUSES = (
    "SENT",
    "CONFIRMING",
    "QUEUED",
    "PROCESSING",
    "GAS_REQUIRED",
    "COLLECTION_SENT",
    "COLLECTION_CONFIRMING",
)
SUCCESS_STATUSES = ("CONFIRMED", "SUCCESS", "COMPLETED")


def _json_default(value: Any) -> str:
    return str(value)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Confirm collection tasks with existing real tx_hash receipts and refresh batch aggregate.",
    )
    parser.add_argument("--batch-id", type=int, default=None, help="Limit to one collection batch id.")
    parser.add_argument("--batch-no", type=str, action="append", default=[], help="Limit to one or more collection batch numbers.")
    parser.add_argument("--task-id", type=int, action="append", default=[], help="Limit to one or more collection task ids.")
    parser.add_argument("--apply", action="store_true", help="Write DB fixes. Default is dry-run only.")
    return parser.parse_args()


def _load_candidates(db, *, batch_id: int | None, batch_nos: list[str], task_ids: list[int]) -> list[dict[str, Any]]:
    where = [
        "LOWER(COALESCE(ct.tx_hash, '')) LIKE '0x%'",
        "UPPER(COALESCE(ct.tx_hash, '')) NOT LIKE 'DRYRUN_%'",
        "UPPER(COALESCE(ct.tx_hash, '')) NOT LIKE 'DRYGAS_%'",
        "("
        "UPPER(ct.status) IN :candidate_statuses "
        "OR ct.confirmed_at IS NULL "
        "OR UPPER(COALESCE(cb.status, '')) NOT IN ('COMPLETED', 'SUCCESS') "
        "OR (UPPER(ct.status) IN :success_statuses AND NULLIF(TRIM(COALESCE(ct.last_error, '')), '') IS NOT NULL)"
        ")",
    ]
    params: dict[str, Any] = {
        "candidate_statuses": CONFIRM_CANDIDATE_STATUSES,
        "success_statuses": SUCCESS_STATUSES,
    }
    if batch_id is not None:
        where.append("ct.batch_id = :batch_id")
        params["batch_id"] = int(batch_id)
    if batch_nos:
        where.append("cb.batch_no IN :batch_nos")
        params["batch_nos"] = tuple(item.strip() for item in batch_nos if item.strip())
    if task_ids:
        where.append("ct.id IN :task_ids")
        params["task_ids"] = tuple(int(item) for item in task_ids)
    stmt = text(
        f"""
        SELECT ct.id AS task_id,
               ct.batch_id,
               cb.batch_no,
               cb.status AS batch_status,
               cb.success_tasks,
               cb.failed_tasks,
               ct.chain_key,
               ct.status,
               ct.tx_hash,
               ct.confirmed_at,
               ct.last_error
        FROM collection_tasks ct
        JOIN collection_batches cb ON cb.id = ct.batch_id
        WHERE {" AND ".join(where)}
        ORDER BY ct.batch_id ASC, ct.id ASC
        """
    ).bindparams(bindparam("candidate_statuses", expanding=True))
    stmt = stmt.bindparams(bindparam("success_statuses", expanding=True))
    if batch_nos:
        stmt = stmt.bindparams(bindparam("batch_nos", expanding=True))
    if task_ids:
        stmt = stmt.bindparams(bindparam("task_ids", expanding=True))
    return [dict(row) for row in db.execute(stmt, params).mappings().all()]


def main() -> int:
    args = _parse_args()
    db = SessionLocal()
    summary: dict[str, Any] = {
        "mode": "apply" if args.apply else "dry-run",
        "batch_id": args.batch_id,
        "batch_no": args.batch_no,
        "checked": 0,
        "receipt_success": 0,
        "receipt_failed": 0,
        "receipt_pending": 0,
        "updated_confirmed": 0,
        "updated_failed": 0,
        "refreshed_batches": [],
        "items": [],
    }
    touched_batch_ids: set[int] = set()
    try:
        candidates = _load_candidates(db, batch_id=args.batch_id, batch_nos=args.batch_no, task_ids=args.task_id)
        for item in candidates:
            summary["checked"] += 1
            current_status = str(item.get("status") or "").upper()
            receipt_status, block_number, error = _receipt_status_and_block(
                db=db,
                chain_key=str(item.get("chain_key") or ""),
                tx_hash=str(item.get("tx_hash") or ""),
            )
            action = "noop"
            if error:
                receipt_state = "error"
                action = "keep_current"
            elif receipt_status is None:
                receipt_state = "pending"
                summary["receipt_pending"] += 1
                action = "keep_current"
            elif int(receipt_status) == 1:
                receipt_state = "success"
                summary["receipt_success"] += 1
                already_confirmed = current_status in SUCCESS_STATUSES and item.get("confirmed_at")
                has_stale_error = bool(str(item.get("last_error") or "").strip())
                if already_confirmed and has_stale_error:
                    action = "clear_last_error" if args.apply else "would_clear_last_error"
                else:
                    action = "refresh_batch" if already_confirmed else ("mark_confirmed" if args.apply else "would_mark_confirmed")
                if args.apply:
                    if already_confirmed:
                        if has_stale_error:
                            collection_task = (
                                db.query(CollectionTask)
                                .filter(CollectionTask.id == int(item["task_id"]))
                                .with_for_update()
                                .first()
                            )
                            if collection_task and collection_task.last_error:
                                collection_task.last_error = None
                                db.flush()
                                queue_collection_task_changed(db, collection_task)
                                summary.setdefault("cleared_last_error", 0)
                                summary["cleared_last_error"] += 1
                        refresh_collection_batch_aggregate(db, int(item["batch_id"]))
                    else:
                        mark_collection_task_confirmed(db, int(item["task_id"]), block_number=block_number)
                        summary["updated_confirmed"] += 1
                    touched_batch_ids.add(int(item["batch_id"]))
            else:
                receipt_state = "failed"
                summary["receipt_failed"] += 1
                action = "mark_failed" if args.apply else "would_mark_failed"
                if args.apply:
                    mark_collection_task_failed(
                        db,
                        int(item["task_id"]),
                        f"TX_FAILED status={receipt_status}",
                        retryable=False,
                    )
                    summary["updated_failed"] += 1
                    touched_batch_ids.add(int(item["batch_id"]))

            summary["items"].append(
                {
                    "task_id": item.get("task_id"),
                    "batch_id": item.get("batch_id"),
                    "batch_no": item.get("batch_no"),
                    "tx_hash": item.get("tx_hash"),
                    "current_status": item.get("status"),
                    "confirmed_at": item.get("confirmed_at"),
                    "batch_status": item.get("batch_status"),
                    "receipt_state": receipt_state,
                    "receipt_status": receipt_status,
                    "block_number": block_number,
                    "error": error,
                    "action": action,
                }
            )

        if args.apply:
            for batch_id_value in sorted(touched_batch_ids):
                aggregate = refresh_collection_batch_aggregate(db, batch_id_value)
                summary["refreshed_batches"].append(aggregate)
            db.commit()
        else:
            db.rollback()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
