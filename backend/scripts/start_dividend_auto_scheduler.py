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


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs.dividend_job import process_dividend_job_once  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


SERVICE_NAME = "dividend_auto_scheduler"
DEFAULT_INTERVAL_SECONDS = 30
logger = logging.getLogger(__name__)
_health_lock = threading.Lock()
_health: dict[str, Any] = {
    "last_tick_at": None,
    "last_tick_ok": None,
    "last_tick_error": "",
    "last_check_result": "NOT_STARTED",
    "consecutive_failures": 0,
}


def _utc_timestamp() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def get_dividend_auto_scheduler_heartbeat_payload() -> dict[str, Any]:
    with _health_lock:
        return dict(_health)


def process_dividend_auto_scheduler_once(
    *,
    processor: Callable[[], str] = process_dividend_job_once,
) -> dict[str, Any]:
    started_at = _utc_timestamp()
    try:
        check_result = str(processor() or "UNKNOWN")
        ok = check_result != "FAILED"
        error = "" if ok else "dividend automatic execution failed"
    except Exception as exc:
        check_result = "FAILED"
        ok = False
        error = f"{type(exc).__name__}:{str(exc)[:220]}"
        logger.exception("dividend automatic scheduler tick failed")

    result = {
        "ok": ok,
        "started_at": started_at,
        "finished_at": _utc_timestamp(),
        "check_result": check_result,
        "error": error,
    }
    with _health_lock:
        _health.update(
            {
                "last_tick_at": result["finished_at"],
                "last_tick_ok": ok,
                "last_tick_error": error,
                "last_check_result": check_result,
                "consecutive_failures": (
                    0 if ok else int(_health.get("consecutive_failures") or 0) + 1
                ),
            }
        )
    return result


def run_dividend_auto_scheduler_forever(
    stop_event: threading.Event,
    *,
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
) -> None:
    interval = max(5, int(interval_seconds or DEFAULT_INTERVAL_SECONDS))
    while not stop_event.is_set():
        result = process_dividend_auto_scheduler_once()
        if not result["ok"]:
            logger.error(
                "dividend automatic scheduler tick result=%s",
                json.dumps(result, ensure_ascii=False, default=str),
            )
        elif result["check_result"] != "SKIPPED_TIME":
            logger.info(
                "dividend automatic scheduler tick result=%s",
                json.dumps(result, ensure_ascii=False, default=str),
            )
        stop_event.wait(interval)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the dedicated single-instance automatic dividend scheduler."
    )
    parser.add_argument("--once", action="store_true", help="run one scheduler tick and exit")
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if args.once:
        result = process_dividend_auto_scheduler_once()
        print(json.dumps(result, ensure_ascii=False, default=str))
        return 0 if result["ok"] else 1

    stop_event = threading.Event()

    def _stop(_signum, _frame) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    heartbeat_stop_event = start_heartbeat_thread(
        SERVICE_NAME,
        stop_event=stop_event,
        extra_payload_factory=get_dividend_auto_scheduler_heartbeat_payload,
    )
    try:
        run_dividend_auto_scheduler_forever(
            stop_event,
            interval_seconds=args.interval_seconds,
        )
    finally:
        heartbeat_stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
