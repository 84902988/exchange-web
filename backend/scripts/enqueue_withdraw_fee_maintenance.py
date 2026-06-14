from __future__ import annotations

import json
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.withdraw_fee_maintenance_rq_job import enqueue_withdraw_fee_maintenance_job  # noqa: E402


def main() -> int:
    result = enqueue_withdraw_fee_maintenance_job()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
