from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.db_lifecycle_cleanup_job import CLEANUP_EXECUTE_CONFIRM_TEXT, MAX_BATCH_SIZE, run_db_lifecycle_cleanup_job


def main() -> int:
    parser = argparse.ArgumentParser(description="Run DB lifecycle cleanup. Defaults to dry-run.")
    parser.add_argument("--execute", action="store_true", help="Actually delete matched rows from allowed tables.")
    parser.add_argument("--confirm", default="", help=f"Required with --execute: {CLEANUP_EXECUTE_CONFIRM_TEXT}")
    parser.add_argument("--batch-size", type=int, default=MAX_BATCH_SIZE, help="Batch size, capped at 1000.")
    args = parser.parse_args()

    if args.execute and str(args.confirm or "").strip() != CLEANUP_EXECUTE_CONFIRM_TEXT:
        print(
            f"Refusing --execute: pass --confirm {CLEANUP_EXECUTE_CONFIRM_TEXT} to acknowledge non-core temp data deletion.",
            file=sys.stderr,
        )
        return 2

    result = run_db_lifecycle_cleanup_job(
        dry_run=not args.execute,
        batch_size=args.batch_size,
        confirm_text=args.confirm,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
