from __future__ import annotations

import logging
import os
import signal
import sys
import threading
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal  # noqa: E402
from app.services.contract_liquidation_service import scan_and_execute_liquidations  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


logger = logging.getLogger("liquidation_scanner")


def _env_int(name: str, default: int, minimum: int = 1, maximum: int = 1000) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except Exception:
        value = default
    return min(max(value, minimum), maximum)


def _install_stop_handlers(stop_event: threading.Event) -> None:
    def _handle_stop(signum, frame) -> None:
        logger.info("liquidation scanner stopping signal=%s", signum)
        stop_event.set()

    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is not None:
            try:
                signal.signal(sig, _handle_stop)
            except Exception:
                pass


def run_forever() -> None:
    stop_event = threading.Event()
    _install_stop_handlers(stop_event)
    start_heartbeat_thread("liquidation_scanner", stop_event=stop_event)
    interval = _env_int("CONTRACT_LIQUIDATION_INTERVAL", 2, minimum=1, maximum=60)
    limit = _env_int("CONTRACT_LIQUIDATION_LIMIT", 50, minimum=1, maximum=500)
    logger.info("liquidation scanner started interval=%ss limit=%s", interval, limit)

    while not stop_event.is_set():
        db = SessionLocal()
        try:
            results = scan_and_execute_liquidations(db, limit=limit)
            if results:
                logger.info("liquidation scanner executed=%s", len(results))
        except Exception:
            db.rollback()
            logger.exception("liquidation scanner round failed")
        finally:
            db.close()
        stop_event.wait(interval)

    logger.info("liquidation scanner stopped")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        run_forever()
    except KeyboardInterrupt:
        logger.info("liquidation scanner stopped by keyboard interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
