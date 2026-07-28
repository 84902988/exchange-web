from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import text


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal  # noqa: E402
from app.jobs.withdraw_tx_watcher import DEFAULT_INTERVAL_SECONDS, DEFAULT_MAX_BATCH, process_once  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


logger = logging.getLogger(__name__)
SERVICE_NAME = "withdraw_tx_watcher"
_health_lock = threading.Lock()
_health: dict[str, Any] = {
    "last_tick_at": None,
    "last_tick_ok": None,
    "last_tick_error": "",
    "last_processed_count": 0,
    "pending_sent_count": 0,
    "consecutive_failures": 0,
}


def _utc_timestamp() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def get_withdraw_tx_watcher_heartbeat_payload() -> dict[str, Any]:
    with _health_lock:
        return dict(_health)


def _pending_sent_count(db) -> int:
    return int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM withdraw_logs
                WHERE status IN ('SENT', 'SENDING')
                  AND tx_hash IS NOT NULL
                  AND tx_hash <> ''
                """
            )
        ).scalar()
        or 0
    )


def _record_tick(result: dict[str, Any]) -> None:
    ok = bool(result.get("ok"))
    with _health_lock:
        _health.update(
            {
                "last_tick_at": str(result.get("finished_at") or _utc_timestamp()),
                "last_tick_ok": ok,
                "last_tick_error": str(result.get("error") or "")[:240],
                "last_processed_count": int(result.get("processed_count") or 0),
                "pending_sent_count": int(result.get("pending_sent_count") or 0),
                "consecutive_failures": 0 if ok else int(_health.get("consecutive_failures") or 0) + 1,
            }
        )


def process_withdraw_tx_watcher_once(
    *,
    session_factory: Callable[[], Any] = SessionLocal,
    max_batch: int = DEFAULT_MAX_BATCH,
) -> dict[str, Any]:
    db = session_factory()
    started_at = _utc_timestamp()
    try:
        processed_count = int(process_once(db, max_batch=max(1, int(max_batch))))
        pending_count = _pending_sent_count(db)
        result = {
            "ok": True,
            "started_at": started_at,
            "finished_at": _utc_timestamp(),
            "processed_count": processed_count,
            "pending_sent_count": pending_count,
        }
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            logger.warning("withdraw tx watcher rollback failed", exc_info=True)
        result = {
            "ok": False,
            "started_at": started_at,
            "finished_at": _utc_timestamp(),
            "processed_count": 0,
            "pending_sent_count": 0,
            "error": f"{type(exc).__name__}:{str(exc)[:220]}",
        }
        logger.exception("withdraw tx watcher tick failed")
    finally:
        try:
            db.close()
        except Exception:
            logger.warning("withdraw tx watcher session close failed", exc_info=True)
    _record_tick(result)
    return result


def run_withdraw_tx_watcher_forever(
    stop_event: threading.Event,
    *,
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
) -> None:
    interval = max(5, int(interval_seconds or DEFAULT_INTERVAL_SECONDS))
    while not stop_event.is_set():
        result = process_withdraw_tx_watcher_once()
        log_method = logger.info if result.get("ok") else logger.error
        log_method("withdraw tx watcher tick result=%s", json.dumps(result, ensure_ascii=False, default=str))
        stop_event.wait(interval)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the withdraw transaction confirmation watcher.")
    parser.add_argument("--once", action="store_true", help="run one watcher tick and exit")
    parser.add_argument("--interval-seconds", type=int, default=DEFAULT_INTERVAL_SECONDS)
    parser.add_argument("--max-batch", type=int, default=DEFAULT_MAX_BATCH)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if args.once:
        result = process_withdraw_tx_watcher_once(max_batch=args.max_batch)
        print(json.dumps(result, ensure_ascii=False, default=str))
        return 0 if result.get("ok") else 1

    stop_event = threading.Event()

    def _stop(_signum, _frame) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    heartbeat_stop_event = start_heartbeat_thread(
        SERVICE_NAME,
        stop_event=stop_event,
        extra_payload_factory=get_withdraw_tx_watcher_heartbeat_payload,
    )
    try:
        run_withdraw_tx_watcher_forever(stop_event, interval_seconds=args.interval_seconds)
    finally:
        heartbeat_stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
