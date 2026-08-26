from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.rcb_lock_release_job import process_rcb_lock_release_job_once  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


SERVICE_NAME = "rcb_lock_release_scheduler"
DEFAULT_INTERVAL_SECONDS = 60
logger = logging.getLogger(__name__)
_health_lock = threading.Lock()
_health: dict[str, Any] = {
    "last_tick_at": None,
    "last_tick_ok": None,
    "last_tick_error": "",
    "last_released_count": 0,
    "consecutive_failures": 0,
}


def _utc_timestamp() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def get_rcb_lock_release_scheduler_heartbeat_payload() -> dict[str, Any]:
    with _health_lock:
        return dict(_health)


def process_rcb_lock_release_scheduler_once() -> dict[str, Any]:
    started_at = _utc_timestamp()
    try:
        release_result = process_rcb_lock_release_job_once()
        ok = bool(release_result.get("ok"))
        error = "" if ok else "one or more user releases failed"
    except Exception as exc:
        release_result = {
            "ok": False,
            "released_count": 0,
            "error": f"{type(exc).__name__}:{str(exc)[:220]}",
        }
        ok = False
        error = str(release_result["error"])
        logger.exception("RCB lock release scheduler tick failed")

    result = {
        "ok": ok,
        "started_at": started_at,
        "finished_at": _utc_timestamp(),
        "release": release_result,
        "error": error,
    }
    with _health_lock:
        _health.update(
            {
                "last_tick_at": result["finished_at"],
                "last_tick_ok": ok,
                "last_tick_error": error,
                "last_released_count": int(release_result.get("released_count") or 0),
                "consecutive_failures": (
                    0 if ok else int(_health.get("consecutive_failures") or 0) + 1
                ),
            }
        )
    return result


def run_rcb_lock_release_scheduler_forever(
    stop_event: threading.Event,
    *,
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
) -> None:
    interval = max(10, int(interval_seconds or DEFAULT_INTERVAL_SECONDS))
    while not stop_event.is_set():
        result = process_rcb_lock_release_scheduler_once()
        log_method = logger.info if result["ok"] else logger.error
        log_method("RCB lock release scheduler tick=%s", json.dumps(result, ensure_ascii=False))
        stop_event.wait(interval)


def _parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the RCB matured-lock release scheduler.")
    parser.add_argument("--once", action="store_true", help="run one scheduler tick and exit")
    parser.add_argument("--interval-seconds", type=int, default=DEFAULT_INTERVAL_SECONDS)
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if args.once:
        result = process_rcb_lock_release_scheduler_once()
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1

    stop_event = threading.Event()

    def _stop(_signum, _frame) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    heartbeat_stop_event = start_heartbeat_thread(
        SERVICE_NAME,
        stop_event=stop_event,
        extra_payload_factory=get_rcb_lock_release_scheduler_heartbeat_payload,
    )
    try:
        run_rcb_lock_release_scheduler_forever(
            stop_event,
            interval_seconds=args.interval_seconds,
        )
    finally:
        heartbeat_stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
