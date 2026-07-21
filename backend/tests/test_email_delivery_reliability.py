from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import rq

from app.core.rq import QUEUE_EMAIL, QUEUE_PAYOUT, QUEUE_RELEASE
from app.tasks import email_tasks
from app.tasks.email_tasks import _verification_code_delivery_expired
from scripts import start_rq_worker
from scripts.start_rq_worker import _scheduler_required


@pytest.mark.parametrize("queue_name", [QUEUE_EMAIL, QUEUE_PAYOUT, QUEUE_RELEASE])
def test_retry_queues_enable_rq_scheduler(queue_name: str) -> None:
    assert _scheduler_required([queue_name]) is True


def test_non_retry_queue_does_not_enable_rq_scheduler() -> None:
    assert _scheduler_required(["collection"]) is False


@pytest.mark.parametrize(
    ("queue_name", "expected_scheduler"),
    [(QUEUE_EMAIL, True), ("collection", False)],
)
def test_worker_main_passes_scheduler_mode_to_rq(
    monkeypatch: pytest.MonkeyPatch,
    queue_name: str,
    expected_scheduler: bool,
) -> None:
    observed: dict[str, object] = {}

    class FakeWorker:
        def __init__(self, queues: list[object]) -> None:
            observed["queues"] = queues

        def work(self, **kwargs: object) -> None:
            observed["work_kwargs"] = kwargs

    class FakeStopEvent:
        def set(self) -> None:
            observed["heartbeat_stopped"] = True

    monkeypatch.setattr(rq, "SimpleWorker", FakeWorker)
    monkeypatch.setattr(start_rq_worker, "get_queue", lambda name: SimpleNamespace(name=name))
    monkeypatch.setattr(start_rq_worker, "get_redis_url", lambda: "redis://127.0.0.1:6379/0")
    monkeypatch.setattr(
        start_rq_worker,
        "_start_simple_worker_heartbeat",
        lambda worker: FakeStopEvent(),
    )

    assert start_rq_worker.main([queue_name]) == 0
    assert observed["work_kwargs"] == {"with_scheduler": expected_scheduler}
    assert observed["heartbeat_stopped"] is True


def test_verification_email_is_skipped_after_code_expiry() -> None:
    now = datetime(2026, 7, 21, 6, 0, tzinfo=timezone.utc)
    assert _verification_code_delivery_expired(
        expire_minutes=10,
        created_at=now - timedelta(minutes=10),
        now=now,
    ) is True


def test_verification_email_can_retry_while_code_is_valid() -> None:
    now = datetime(2026, 7, 21, 6, 0, tzinfo=timezone.utc)
    assert _verification_code_delivery_expired(
        expire_minutes=10,
        created_at=now - timedelta(minutes=9, seconds=59),
        now=now,
    ) is False


def test_direct_call_without_rq_job_is_not_treated_as_expired() -> None:
    assert _verification_code_delivery_expired(expire_minutes=10, created_at=None) is False


def test_verification_job_description_does_not_expose_recipient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, object] = {}

    class FakeQueue:
        def enqueue_call(self, **kwargs: object) -> SimpleNamespace:
            observed.update(kwargs)
            return SimpleNamespace(id="email-job-id")

    recipient = "private-user@example.com"
    monkeypatch.setattr(email_tasks, "get_queue", lambda queue_name: FakeQueue())

    assert email_tasks.enqueue_send_verify_code_email(
        to_email=recipient,
        code="123456",
        scene="register",
        expire_minutes=10,
    ) == "email-job-id"
    assert observed["description"] == "send verify email scene=register"
    assert recipient not in str(observed["description"])
