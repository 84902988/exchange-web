from __future__ import annotations

import os
import sys


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.core.rq import QUEUE_NAMES, RQNotInstalledError, get_queue  # noqa: E402


def main() -> None:
    try:
        from rq import SimpleWorker
    except ModuleNotFoundError:
        print("RQ_NOT_INSTALLED")
        return

    try:
        queues = [get_queue(name) for name in QUEUE_NAMES]
    except RQNotInstalledError:
        print("RQ_NOT_INSTALLED")
        return

    print("queues loaded:", ", ".join(queue.name for queue in queues))
    worker = SimpleWorker(queues)
    worker.work()


if __name__ == "__main__":
    main()
