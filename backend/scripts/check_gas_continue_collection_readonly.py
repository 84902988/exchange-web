from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal  # noqa: E402
from app.tasks.collection_tasks import is_collection_task_job_active  # noqa: E402


REAL_GAS_CONFIRMED_STATUSES = {"CONFIRMED", "SUCCESS", "COMPLETED"}
COLLECTION_CONTINUE_ALLOWED_STATUSES = {
    "PENDING",
    "QUEUED",
    "READY",
    "FAILED",
    "SKIPPED",
    "GAS_REQUIRED",
    "GAS_QUEUED",
    "TIMEOUT",
    "WAITING",
    "WAITING_GAS",
}
COLLECTION_CONTINUE_BLOCKED_STATUSES = {
    "SENDING",
    "SENT",
    "CONFIRMED",
    "CANCELED",
    "SUCCESS",
    "COMPLETED",
    "RUNNING",
    "PROCESSING",
}


def _as_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _upper(value: Any) -> str:
    return _as_text(value).upper()


def _is_dry_run_gas_hash(value: Any) -> bool:
    tx_hash = _upper(value)
    return tx_hash.startswith("DRYGAS_") or tx_hash.startswith("DRYRUN_")


def _check_row(row: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    gas_status = _upper(row.get("gas_status"))
    gas_tx_hash = _as_text(row.get("gas_tx_hash"))
    collection_status = _upper(row.get("collection_status"))
    collection_tx_hash = _as_text(row.get("collection_tx_hash"))
    batch_status = _upper(row.get("batch_status"))

    if gas_status not in REAL_GAS_CONFIRMED_STATUSES:
        reasons.append(f"gas status is not confirmed/success/completed: {gas_status or '-'}")
    if not gas_tx_hash:
        reasons.append("gas tx_hash is empty")
    elif _is_dry_run_gas_hash(gas_tx_hash):
        reasons.append(f"gas tx_hash is dry-run: {gas_tx_hash}")

    if not row.get("collection_task_id"):
        reasons.append("collection_task_id is empty")
    if not row.get("gas_task_id"):
        reasons.append("gas_task_id is empty")
    if row.get("gas_collection_task_id") and row.get("gas_collection_task_id") != row.get("collection_task_id"):
        reasons.append(
            "gas_tasks.collection_task_id does not match collection_tasks.id: "
            f"{row.get('gas_collection_task_id')} != {row.get('collection_task_id')}"
        )
    if row.get("collection_gas_task_id") and row.get("collection_gas_task_id") != row.get("gas_task_id"):
        reasons.append(
            "collection_tasks.gas_task_id does not match gas_tasks.id: "
            f"{row.get('collection_gas_task_id')} != {row.get('gas_task_id')}"
        )

    if collection_tx_hash:
        reasons.append(f"collection task already has tx_hash: {collection_tx_hash}")
    if collection_status in COLLECTION_CONTINUE_BLOCKED_STATUSES:
        reasons.append(f"collection status is blocked: {collection_status}")
    elif collection_status not in COLLECTION_CONTINUE_ALLOWED_STATUSES:
        reasons.append(f"collection status is not retryable for auto-continue: {collection_status or '-'}")

    retry_count = int(row.get("retry_count") or 0)
    max_retry = int(row.get("max_retry") or 0)
    if retry_count >= max_retry:
        reasons.append(f"retry limit reached: retry_count={retry_count}, max_retry={max_retry}")

    if batch_status == "CANCELED":
        reasons.append("batch is canceled")

    try:
        if row.get("collection_task_id") and is_collection_task_job_active(int(row["collection_task_id"])):
            reasons.append("collection task has active RQ job")
    except Exception as exc:
        reasons.append(f"active RQ job check failed: {type(exc).__name__}:{str(exc)[:120]}")

    return not reasons, reasons


def main() -> int:
    db = SessionLocal()
    try:
        rows = (
            db.execute(
                text(
                    """
                    SELECT
                      ct.id AS collection_task_id,
                      ct.task_no AS collection_task_no,
                      ct.status AS collection_status,
                      ct.tx_hash AS collection_tx_hash,
                      ct.retry_count,
                      ct.max_retry,
                      ct.gas_task_id AS collection_gas_task_id,
                      ct.batch_id,
                      cb.status AS batch_status,
                      gt.id AS gas_task_id,
                      gt.task_no AS gas_task_no,
                      gt.collection_task_id AS gas_collection_task_id,
                      gt.status AS gas_status,
                      gt.tx_hash AS gas_tx_hash,
                      gt.topup_amount AS gas_topup_amount,
                      gt.gas_coin_symbol,
                      gt.sent_at AS gas_sent_at,
                      gt.confirmed_at AS gas_confirmed_at,
                      COALESCE(gt.confirmed_at, gt.sent_at, gt.updated_at, gt.created_at) AS gas_sort_time
                    FROM gas_tasks gt
                    LEFT JOIN collection_tasks ct
                      ON ct.id = gt.collection_task_id OR ct.gas_task_id = gt.id
                    LEFT JOIN collection_batches cb ON cb.id = ct.batch_id
                    WHERE ct.id IS NOT NULL
                    ORDER BY gas_sort_time DESC, gt.id DESC
                    LIMIT 10
                    """
                )
            )
            .mappings()
            .all()
        )
        print("Gas confirmed -> collection auto-continue readonly check")
        print("mode: READONLY; no DB write; no requeue; no real send")
        print(f"related task pairs found: {len(rows)}")
        if not rows:
            print("No related gas_tasks / collection_tasks found.")
            return 0

        for index, raw_row in enumerate(rows, start=1):
            row = dict(raw_row)
            ok, reasons = _check_row(row)
            print("")
            print(f"[{index}] collection_task_id={row.get('collection_task_id')} gas_task_id={row.get('gas_task_id')}")
            print(f"    collection_task_no={row.get('collection_task_no') or '-'} gas_task_no={row.get('gas_task_no') or '-'}")
            print(
                "    collection: "
                f"status={row.get('collection_status') or '-'} "
                f"tx_hash={row.get('collection_tx_hash') or '-'} "
                f"retry_count={row.get('retry_count') or 0} "
                f"max_retry={row.get('max_retry') or 0}"
            )
            print(
                "    gas: "
                f"status={row.get('gas_status') or '-'} "
                f"tx_hash={row.get('gas_tx_hash') or '-'} "
                f"topup={row.get('gas_topup_amount') or '-'} {row.get('gas_coin_symbol') or ''}".strip()
            )
            print(f"    batch: id={row.get('batch_id') or '-'} status={row.get('batch_status') or '-'}")
            if ok:
                print("    auto_continue_eligible=YES")
            else:
                print("    auto_continue_eligible=NO")
                for reason in reasons:
                    print(f"      - {reason}")
        return 0
    finally:
        db.rollback()
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
