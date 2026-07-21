from __future__ import annotations

import os
from typing import Any

from redis import Redis

from app.core.config import settings


QUEUE_COLLECTION = "collection"
QUEUE_GAS = "gas"
QUEUE_TX_CONFIRM = "tx_confirm"
QUEUE_WITHDRAW = "withdraw"
QUEUE_EMAIL = "email"
QUEUE_RELEASE = "release"
QUEUE_PAYOUT = "payout"
QUEUE_MAINTENANCE = "maintenance"
QUEUE_NAMES = (
    QUEUE_COLLECTION,
    QUEUE_GAS,
    QUEUE_TX_CONFIRM,
    QUEUE_WITHDRAW,
    QUEUE_EMAIL,
    QUEUE_RELEASE,
    QUEUE_PAYOUT,
    QUEUE_MAINTENANCE,
)

# These queues enqueue delayed retries through rq.Retry(interval=...).  At
# least one worker serving each queue must run RQ's scheduler, otherwise failed
# jobs remain in ScheduledJobRegistry forever.
SCHEDULED_JOB_QUEUE_NAMES = frozenset(
    {
        QUEUE_EMAIL,
        QUEUE_PAYOUT,
        QUEUE_RELEASE,
    }
)


class RQNotInstalledError(RuntimeError):
    pass


def _require_rq():
    try:
        from rq import Queue
    except ModuleNotFoundError as exc:
        raise RQNotInstalledError("RQ_NOT_INSTALLED: install rq to use queue helpers") from exc
    return Queue


def get_redis_url() -> str:
    return os.getenv("REDIS_URL", "").strip() or settings.redis_url


def get_redis_connection() -> Redis:
    return Redis.from_url(get_redis_url())


def get_queue(name: str):
    if name not in QUEUE_NAMES:
        raise ValueError(f"unsupported queue: {name}")
    Queue = _require_rq()
    return Queue(name=name, connection=get_redis_connection())


def enqueue_job(queue_name: str, func: Any, *args: Any, job_id: str | None = None, **kwargs: Any):
    queue = get_queue(queue_name)
    if job_id:
        return queue.enqueue_call(func=func, args=args, kwargs=kwargs, job_id=job_id)
    return queue.enqueue(func, *args, **kwargs)
