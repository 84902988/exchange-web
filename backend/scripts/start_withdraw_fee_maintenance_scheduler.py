from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.withdraw_fee_maintenance_scheduler import (  # noqa: E402
    process_withdraw_fee_maintenance_scheduler_once,
    run_withdraw_fee_maintenance_scheduler_forever,
)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the withdraw fee maintenance enqueue scheduler.")
    parser.add_argument("--once", action="store_true", help="enqueue one scheduler tick and exit")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if args.once:
        result = process_withdraw_fee_maintenance_scheduler_once()
        print(json.dumps(result, ensure_ascii=False, default=str))
        return 0 if result.get("ok") else 1
    run_withdraw_fee_maintenance_scheduler_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
