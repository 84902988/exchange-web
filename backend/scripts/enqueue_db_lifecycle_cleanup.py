from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.db_lifecycle_cleanup_job import enqueue_db_lifecycle_cleanup_job


def main() -> int:
    parser = argparse.ArgumentParser(description="Enqueue DB lifecycle cleanup into the maintenance queue.")
    parser.add_argument("--force", action="store_true", help="Bypass duplicate-window enqueue lock.")
    args = parser.parse_args()

    result = enqueue_db_lifecycle_cleanup_job(force=args.force)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
