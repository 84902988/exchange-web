from __future__ import annotations

import logging
import threading
from typing import Any, Optional


logger = logging.getLogger(__name__)


class ContractLimitOrderJob:
    def __init__(self, session_factory: Any, interval_seconds: int = 2) -> None:
        self.session_factory = session_factory
        self.interval_seconds = max(1, int(interval_seconds or 2))
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="contract-limit-order-job", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1)
        self._thread = None

    def _run(self) -> None:
        from app.services.contract_order_service import scan_and_execute_contract_limit_orders

        while not self._stop_event.is_set():
            db = None
            try:
                db = self.session_factory()
                results = scan_and_execute_contract_limit_orders(db, limit=100)
                if results:
                    logger.info("[contract_limit_order_job] executed=%s", len(results))
            except Exception as exc:
                if db is not None:
                    try:
                        db.rollback()
                    except Exception:
                        pass
                logger.exception("[contract_limit_order_job] round failed")
            finally:
                if db is not None:
                    db.close()

            self._stop_event.wait(self.interval_seconds)
