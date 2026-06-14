"""Repair collection_tasks.gas_task_id links that point at another task.

Default mode is dry-run: it only prints what would change. Use --apply to write
DB changes, and --enqueue as an additional explicit opt-in to enqueue new gas
jobs. This script never sends on-chain transactions by itself.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except Exception:
    pass

from app.db.models.collection import CollectionTask, GasTask  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_service import create_gas_task, mark_collection_task_wait_gas  # noqa: E402
from app.tasks.collection_tasks import enqueue_gas_task  # noqa: E402


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Dry-run or repair invalid collection gas_task_id links."
    )
    parser.add_argument("--batch-id", type=int, default=None, help="Limit scan to one collection batch.")
    parser.add_argument("--limit", type=int, default=500, help="Maximum collection tasks to scan.")
    parser.add_argument("--apply", action="store_true", help="Apply DB changes. Without this, dry-run only.")
    parser.add_argument(
        "--enqueue",
        action="store_true",
        help="With --apply, enqueue newly created gas tasks. No enqueue happens by default.",
    )
    parser.add_argument(
        "--clear-only",
        action="store_true",
        help="Clear invalid gas_task_id instead of creating a replacement gas task.",
    )
    return parser.parse_args()


def _iter_tasks(db, *, batch_id: int | None, limit: int) -> Iterable[CollectionTask]:
    query = (
        db.query(CollectionTask)
        .filter(CollectionTask.gas_task_id.isnot(None))
    )
    if batch_id is not None:
        query = query.filter(CollectionTask.batch_id == int(batch_id))
    query = query.order_by(CollectionTask.id.asc()).limit(int(limit))
    return query.all()


def main() -> int:
    args = _parse_args()
    db = SessionLocal()
    scanned = 0
    invalid = 0
    cleared = 0
    created = 0
    enqueued = 0
    errors = 0
    try:
        for task in _iter_tasks(db, batch_id=args.batch_id, limit=args.limit):
            scanned += 1
            source_gas_task = db.query(GasTask).filter(GasTask.id == int(task.gas_task_id)).first()
            source_owner_id = getattr(source_gas_task, "collection_task_id", None)
            if source_gas_task and int(source_owner_id or 0) == int(task.id):
                continue

            invalid += 1
            print(
                "invalid_link "
                f"collection_task_id={task.id} batch_id={task.batch_id} "
                f"gas_task_id={task.gas_task_id} gas_owner={source_owner_id}"
            )

            if not args.apply:
                action = "clear"
                if source_gas_task and not args.clear_only:
                    action = "create_replacement"
                print(f"  dry_run action={action}")
                continue

            try:
                if source_gas_task and not args.clear_only:
                    new_gas_task = create_gas_task(
                        db,
                        collection_task_id=int(task.id),
                        user_id=int(task.user_id),
                        chain_key=str(task.chain_key or source_gas_task.chain_key),
                        gas_coin_symbol=str(source_gas_task.gas_coin_symbol),
                        from_address=str(source_gas_task.from_address),
                        to_address=str(task.from_address),
                        topup_amount=source_gas_task.topup_amount,
                        target_balance=source_gas_task.target_balance,
                    )
                    mark_collection_task_wait_gas(
                        db,
                        int(task.id),
                        gas_task_id=int(new_gas_task.id),
                        reason=f"WAIT_GAS:{new_gas_task.gas_coin_symbol}:{new_gas_task.topup_amount}",
                    )
                    created += 1
                    print(f"  created gas_task_id={new_gas_task.id}")
                    if args.enqueue:
                        job_id = enqueue_gas_task(int(new_gas_task.id), allow_real_send=True)
                        enqueued += 1
                        print(f"  enqueued job_id={job_id}")
                else:
                    task.gas_task_id = None
                    cleared += 1
                    print("  cleared gas_task_id")
                db.flush()
            except Exception as exc:
                db.rollback()
                errors += 1
                print(f"  error {type(exc).__name__}: {str(exc)[:200]}")
        if args.apply:
            db.commit()
        else:
            db.rollback()
    finally:
        db.close()

    mode = "apply" if args.apply else "dry-run"
    print(
        "summary "
        f"mode={mode} scanned={scanned} invalid={invalid} "
        f"created={created} cleared={cleared} enqueued={enqueued} errors={errors}"
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
