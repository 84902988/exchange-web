from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.models.collection import CollectionBatch  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_service import refresh_collection_batch_aggregate  # noqa: E402


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair collection_batches aggregate fields from collection_tasks.")
    parser.add_argument("--batch-id", type=int, default=0, help="Only repair one batch id.")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of batches; 0 means no limit.")
    parser.add_argument("--apply", action="store_true", help="Commit changes. Default is dry-run and rolls back.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    db = SessionLocal()
    try:
        query = db.query(CollectionBatch).order_by(CollectionBatch.id.asc())
        if args.batch_id:
            query = query.filter(CollectionBatch.id == int(args.batch_id))
        if args.limit and args.limit > 0:
            query = query.limit(int(args.limit))
        batches = query.all()
        print(f"mode={'apply' if args.apply else 'dry-run'} batches={len(batches)}", flush=True)
        for batch in batches:
            before = {
                "status": batch.status,
                "total_tasks": int(batch.total_tasks or 0),
                "success_tasks": int(batch.success_tasks or 0),
                "failed_tasks": int(batch.failed_tasks or 0),
                "skipped_tasks": int(batch.skipped_tasks or 0),
                "coin_symbol": batch.coin_symbol or "",
                "total_amount": str(batch.total_amount or 0),
                "success_amount": str(batch.success_amount or 0),
            }
            result = refresh_collection_batch_aggregate(db, int(batch.id))
            after = {
                "status": batch.status,
                "total_tasks": int(batch.total_tasks or 0),
                "success_tasks": int(batch.success_tasks or 0),
                "failed_tasks": int(batch.failed_tasks or 0),
                "skipped_tasks": int(batch.skipped_tasks or 0),
                "coin_symbol": batch.coin_symbol or "",
                "total_amount": str(batch.total_amount or 0),
                "success_amount": str(batch.success_amount or 0),
            }
            changed = before != after
            print(
                f"batch_id={batch.id} batch_no={batch.batch_no} changed={changed} "
                f"before={before} after={after} counts={result}",
                flush=True,
            )
        if args.apply:
            db.commit()
            print("committed", flush=True)
        else:
            db.rollback()
            print("dry-run rolled back", flush=True)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
