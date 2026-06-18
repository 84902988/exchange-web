from __future__ import annotations

import logging
import sys
import time
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.db_lifecycle_cleanup_job import _enqueue_interval_seconds, process_db_lifecycle_cleanup_scheduler_once


logger = logging.getLogger(__name__)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    interval = _enqueue_interval_seconds()
    logger.info("db lifecycle cleanup scheduler started interval=%ss", interval)
    while True:
        try:
            logger.info("db lifecycle cleanup scheduler result=%s", process_db_lifecycle_cleanup_scheduler_once())
        except Exception:
            logger.exception("db lifecycle cleanup scheduler iteration failed")
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
