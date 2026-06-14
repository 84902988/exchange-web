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
from app.services.contract_tp_sl_service import scan_and_execute_contract_tp_sl  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


logger = logging.getLogger("tp_sl_scanner")


def _env_int(name: str, default: int, minimum: int = 1, maximum: int = 1000) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except Exception:
        value = default
    return min(max(value, minimum), maximum)


def _install_stop_handlers(stop_event: threading.Event) -> None:
    def _handle_stop(signum, frame) -> None:
        logger.info("TP/SL scanner stopping signal=%s", signum)
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
    start_heartbeat_thread("tp_sl_scanner", stop_event=stop_event)
    interval = _env_int("CONTRACT_TP_SL_INTERVAL", 2, minimum=1, maximum=60)
    limit = _env_int("CONTRACT_TP_SL_LIMIT", 100, minimum=1, maximum=1000)
    symbol = str(os.getenv("CONTRACT_TP_SL_SYMBOL", "") or "").strip().upper() or None
    logger.info("TP/SL scanner started interval=%ss limit=%s symbol=%s", interval, limit, symbol or "-")

    while not stop_event.is_set():
        db = SessionLocal()
        try:
            results = scan_and_execute_contract_tp_sl(db, symbol=symbol, limit=limit)
            if results:
                logger.info("TP/SL scanner executed=%s", len(results))
        except Exception:
            db.rollback()
            logger.exception("TP/SL scanner round failed")
        finally:
            db.close()
        stop_event.wait(interval)

    logger.info("TP/SL scanner stopped")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        run_forever()
    except KeyboardInterrupt:
        logger.info("TP/SL scanner stopped by keyboard interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
