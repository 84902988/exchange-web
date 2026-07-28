from __future__ import annotations

import importlib.util
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from app.jobs import dividend_job


RUNNER_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "start_dividend_auto_scheduler.py"
)


class _FakeSession:
    def __init__(self) -> None:
        self.commit_count = 0
        self.rollback_count = 0
        self.close_count = 0

    def commit(self) -> None:
        self.commit_count += 1

    def rollback(self) -> None:
        self.rollback_count += 1

    def close(self) -> None:
        self.close_count += 1


def _load_runner():
    spec = importlib.util.spec_from_file_location("start_dividend_auto_scheduler", RUNNER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_automatic_dividend_skips_outside_configured_minute(monkeypatch) -> None:
    session = _FakeSession()
    monkeypatch.setattr(dividend_job, "SessionLocal", lambda: session)
    monkeypatch.setattr(dividend_job, "get_dividend_config", lambda _db: {"run_time_utc": "00:10"})
    monkeypatch.setattr(
        dividend_job,
        "_run_dividend_pool_state_machine",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not execute")),
    )

    result = dividend_job.process_dividend_job_once(datetime(2026, 7, 29, 0, 9, 30))

    assert result == "SKIPPED_TIME"
    assert session.commit_count == 0
    assert session.rollback_count == 0
    assert session.close_count == 1


def test_automatic_dividend_executes_once_and_uses_previous_utc_date(monkeypatch) -> None:
    sessions: list[_FakeSession] = []

    def session_factory() -> _FakeSession:
        session = _FakeSession()
        sessions.append(session)
        return session

    observed: dict[str, object] = {}
    monkeypatch.setattr(dividend_job, "SessionLocal", session_factory)
    monkeypatch.setattr(dividend_job, "get_dividend_config", lambda _db: {"run_time_utc": "00:10"})
    monkeypatch.setattr(dividend_job, "_write_job_log", lambda **_kwargs: None)
    monkeypatch.setattr(
        dividend_job,
        "_run_dividend_pool_state_machine",
        lambda _db, **kwargs: (
            observed.update(kwargs) or ("CREATED_CALCULATED_PAID", "DISTRIBUTE", 7, "ok")
        ),
    )
    dividend_job._attempted_auto_dates.clear()
    now = datetime(2026, 7, 29, 0, 10, 10)

    first = dividend_job.process_dividend_job_once(now)
    second = dividend_job.process_dividend_job_once(now)

    assert first == "CREATED_CALCULATED_PAID"
    assert second == "SKIPPED_IN_PROCESS"
    assert observed == {"dividend_date": now.date().replace(day=28), "create_source": "AUTO"}
    assert sessions[0].commit_count == 1
    assert sessions[0].rollback_count == 0
    assert all(session.close_count == 1 for session in sessions)


def test_dedicated_runner_reports_success_and_failure() -> None:
    runner = _load_runner()

    success = runner.process_dividend_auto_scheduler_once(processor=lambda: "SKIPPED_TIME")
    failure = runner.process_dividend_auto_scheduler_once(processor=lambda: "FAILED")

    assert success["ok"] is True
    assert success["check_result"] == "SKIPPED_TIME"
    assert failure["ok"] is False
    assert failure["check_result"] == "FAILED"
    assert runner.get_dividend_auto_scheduler_heartbeat_payload()["last_tick_ok"] is False
