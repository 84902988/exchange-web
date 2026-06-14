from __future__ import annotations

import json
import logging
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.withdraw_fee_maintenance_job import process_withdraw_fee_maintenance_job_once  # noqa: E402


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    chain_keys = [item.strip().lower() for item in sys.argv[1:] if item.strip()]
    result = process_withdraw_fee_maintenance_job_once(chain_keys or None)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0 if result.get("status") == "OK" else 1


if __name__ == "__main__":
    raise SystemExit(main())
