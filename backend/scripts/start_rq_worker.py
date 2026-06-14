from __future__ import annotations

import argparse
import os
import sys
import threading
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

ENV_PATH = Path(BACKEND_DIR) / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=False)

from app.core.rq import QUEUE_NAMES, RQNotInstalledError, get_queue, get_redis_url  # noqa: E402


WORKER_HEARTBEAT_INTERVAL_SECONDS = 10


def _mask_redis_url(redis_url: str) -> str:
    value = str(redis_url or "").strip()
    if not value:
        return ""
    parsed = urlsplit(value)
    if not parsed.password:
        return value

    username = parsed.username or ""
    hostname = parsed.hostname or ""
    port = f":{parsed.port}" if parsed.port is not None else ""
    auth = f"{username}:***@" if username else "***@"
    netloc = f"{auth}{hostname}{port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start an RQ SimpleWorker for one or more configured queues.",
    )
    parser.add_argument(
        "queues",
        nargs="*",
        help=f"Queue names to work. Defaults to all configured queues: {', '.join(QUEUE_NAMES)}",
    )
    return parser.parse_args(argv)


def _resolve_queue_names(requested_names: list[str]) -> list[str]:
    names = [str(name or "").strip() for name in requested_names if str(name or "").strip()]
    if not names:
        return list(QUEUE_NAMES)

    unknown_names = [name for name in names if name not in QUEUE_NAMES]
    if unknown_names:
        raise ValueError(
            "unsupported queue(s): "
            + ", ".join(unknown_names)
            + ". supported queues: "
            + ", ".join(QUEUE_NAMES)
        )

    return names


def _start_simple_worker_heartbeat(worker: object, interval_seconds: int = WORKER_HEARTBEAT_INTERVAL_SECONDS) -> threading.Event:
    stop_event = threading.Event()

    def _beat() -> None:
        while not stop_event.wait(max(1, int(interval_seconds or WORKER_HEARTBEAT_INTERVAL_SECONDS))):
            try:
                heartbeat = getattr(worker, "heartbeat", None)
                if callable(heartbeat):
                    heartbeat()
            except Exception:
                pass

    thread = threading.Thread(target=_beat, name="rq-simple-worker-heartbeat", daemon=True)
    thread.start()
    return stop_event


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        queue_names = _resolve_queue_names(args.queues)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    try:
        from rq import SimpleWorker
    except ModuleNotFoundError:
        print("RQ_NOT_INSTALLED", file=sys.stderr)
        return 1

    try:
        queues = [get_queue(name) for name in queue_names]
    except RQNotInstalledError:
        print("RQ_NOT_INSTALLED", file=sys.stderr)
        return 1

    print("rq worker starting")
    print("started_at:", datetime.utcnow().isoformat(timespec="seconds") + "Z")
    print("worker_type:", "SimpleWorker")
    print("redis_url:", _mask_redis_url(get_redis_url()))
    print("configured_queues:", ", ".join(QUEUE_NAMES))
    print("loaded_queues:", ", ".join(queue.name for queue in queues))

    worker = SimpleWorker(queues)
    heartbeat_stop_event = _start_simple_worker_heartbeat(worker)
    try:
        worker.work()
    finally:
        heartbeat_stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
