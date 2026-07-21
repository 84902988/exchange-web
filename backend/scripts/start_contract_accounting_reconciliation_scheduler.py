from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.jobs.contract_accounting_reconciliation_scheduler import (  # noqa: E402
    process_contract_accounting_reconciliation_scheduler_once,
    run_contract_accounting_reconciliation_scheduler_forever,
)
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Run contract accounting reconciliation scheduler.")
    parser.add_argument("--once", action="store_true", help="enqueue one scheduler tick and exit")
    args = parser.parse_args()

    log_level_name = str(os.getenv("LOG_LEVEL", "INFO") or "INFO").strip().upper()
    log_level = getattr(logging, log_level_name, logging.INFO)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger(__name__).info(
        "contract accounting reconciliation scheduler process starting mode=%s",
        "once" if args.once else "forever",
    )

    if args.once:
        result = process_contract_accounting_reconciliation_scheduler_once()
        print(json.dumps(result, ensure_ascii=False, default=str, indent=2))
        return

    heartbeat_stop_event = start_heartbeat_thread("contract_accounting_reconciliation_scheduler")
    try:
        run_contract_accounting_reconciliation_scheduler_forever()
    finally:
        heartbeat_stop_event.set()


if __name__ == "__main__":
    main()
