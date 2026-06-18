from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.jobs.contract_accounting_reconciliation_job import (  # noqa: E402
    enqueue_contract_accounting_reconciliation_job,
    run_contract_accounting_reconciliation_job,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run or enqueue contract accounting reconciliation.")
    parser.add_argument("--day", help="UTC day in YYYY-MM-DD format. Defaults to yesterday.")
    parser.add_argument("--enqueue", action="store_true", help="enqueue to maintenance RQ instead of running inline")
    parser.add_argument("--force", action="store_true", help="ignore daily enqueue lock")
    args = parser.parse_args()

    if args.enqueue:
        result = enqueue_contract_accounting_reconciliation_job(day=args.day, force=args.force)
    else:
        result = run_contract_accounting_reconciliation_job(day=args.day)
    print(json.dumps(result, ensure_ascii=False, default=str, indent=2))


if __name__ == "__main__":
    main()
