from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from sqlalchemy import text


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

load_dotenv(dotenv_path=BACKEND_DIR / ".env", override=False)

from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_service import mark_gas_task_confirmed, mark_gas_task_failed  # noqa: E402
from app.services.collection_tx_confirm_service import _receipt_status_and_block  # noqa: E402
from app.tasks.collection_tasks import enqueue_collection_after_real_gas_confirmed  # noqa: E402


def _json_default(value: Any) -> str:
    return str(value)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Confirm SENT/CONFIRMING gas tasks whose on-chain receipts already exist.",
    )
    parser.add_argument("--batch-id", type=int, default=None, help="Limit to one collection batch id.")
    parser.add_argument("--gas-task-id", type=int, action="append", default=[], help="Limit to one or more gas task ids.")
    parser.add_argument("--apply", action="store_true", help="Write DB fixes. Default is dry-run only.")
    parser.add_argument(
        "--enqueue-collection",
        action="store_true",
        help="After --apply confirmation, enqueue the linked collection task. This may trigger real collection sending.",
    )
    return parser.parse_args()


def _load_candidates(db, *, batch_id: int | None, gas_task_ids: list[int]) -> list[dict[str, Any]]:
    where = [
        "UPPER(gt.status) IN ('SENT', 'CONFIRMING')",
        "LOWER(COALESCE(gt.tx_hash, '')) LIKE '0x%'",
        "gt.confirmed_at IS NULL",
    ]
    params: dict[str, Any] = {}
    if batch_id is not None:
        where.append("ct.batch_id = :batch_id")
        params["batch_id"] = int(batch_id)
    if gas_task_ids:
        where.append("gt.id IN :gas_task_ids")
        params["gas_task_ids"] = tuple(int(item) for item in gas_task_ids)
    where_sql = " AND ".join(where)
    stmt = text(
        f"""
        SELECT gt.id AS gas_task_id,
               gt.collection_task_id,
               ct.batch_id,
               gt.chain_key,
               gt.status,
               gt.tx_hash,
               gt.last_error,
               gt.confirmed_at
        FROM gas_tasks gt
        LEFT JOIN collection_tasks ct ON ct.id = gt.collection_task_id
        WHERE {where_sql}
        ORDER BY gt.id ASC
        """
    )
    if gas_task_ids:
        from sqlalchemy import bindparam

        stmt = stmt.bindparams(bindparam("gas_task_ids", expanding=True))
    return [dict(row) for row in db.execute(stmt, params).mappings().all()]


def main() -> int:
    args = _parse_args()
    db = SessionLocal()
    summary = {
        "mode": "apply" if args.apply else "dry-run",
        "batch_id": args.batch_id,
        "checked": 0,
        "receipt_success": 0,
        "receipt_failed": 0,
        "receipt_pending": 0,
        "updated_confirmed": 0,
        "updated_failed": 0,
        "collection_enqueued": 0,
        "items": [],
    }
    try:
        candidates = _load_candidates(db, batch_id=args.batch_id, gas_task_ids=args.gas_task_id)
        for item in candidates:
            summary["checked"] += 1
            receipt_status, block_number, error = _receipt_status_and_block(
                db=db,
                chain_key=str(item.get("chain_key") or ""),
                tx_hash=str(item.get("tx_hash") or ""),
            )
            action = "noop"
            continuation_result = None
            if error:
                receipt_state = "error"
                action = "keep_sent"
            elif receipt_status is None:
                receipt_state = "pending"
                summary["receipt_pending"] += 1
                action = "keep_sent"
            elif int(receipt_status) == 1:
                receipt_state = "success"
                summary["receipt_success"] += 1
                action = "mark_confirmed" if args.apply else "would_mark_confirmed"
                continuation_result = None
                if args.enqueue_collection:
                    continuation_result = enqueue_collection_after_real_gas_confirmed(
                        int(item["gas_task_id"]),
                        dry_run=True,
                        assume_gas_confirmed=True,
                    )
                if args.apply:
                    mark_gas_task_confirmed(db, int(item["gas_task_id"]), block_number=block_number)
                    summary["updated_confirmed"] += 1
                    if args.enqueue_collection and item.get("collection_task_id"):
                        db.commit()
                        continuation_result = enqueue_collection_after_real_gas_confirmed(int(item["gas_task_id"]))
                        if continuation_result.get("enqueued"):
                            summary["collection_enqueued"] += 1
                if continuation_result is not None:
                    action = f"{action}_and_enqueue_collection" if args.enqueue_collection else action
            else:
                receipt_state = "failed"
                summary["receipt_failed"] += 1
                action = "mark_failed" if args.apply else "would_mark_failed"
                if args.apply:
                    mark_gas_task_failed(
                        db,
                        int(item["gas_task_id"]),
                        f"TX_FAILED status={receipt_status}",
                        retryable=False,
                    )
                    summary["updated_failed"] += 1
            summary["items"].append(
                {
                    "gas_task_id": item.get("gas_task_id"),
                    "collection_task_id": item.get("collection_task_id"),
                    "batch_id": item.get("batch_id"),
                    "status": item.get("status"),
                    "tx_hash": item.get("tx_hash"),
                    "last_error": item.get("last_error"),
                    "receipt_state": receipt_state,
                    "receipt_status": receipt_status,
                    "block_number": block_number,
                    "error": error,
                    "action": action,
                    "collection_continue": continuation_result,
                }
            )
        if args.apply:
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
