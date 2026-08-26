from __future__ import annotations

from scripts import start_rcb_lock_release_scheduler as scheduler


def test_scheduler_reports_successful_release_tick(monkeypatch) -> None:
    monkeypatch.setattr(
        scheduler,
        "process_rcb_lock_release_job_once",
        lambda: {
            "ok": True,
            "scanned_user_count": 1,
            "released_count": 2,
            "released_amount": "30.000000000000000000",
            "lock_ids": [4, 5],
            "failed_user_ids": [],
        },
    )

    result = scheduler.process_rcb_lock_release_scheduler_once()

    assert result["ok"] is True
    assert result["release"]["released_count"] == 2
    health = scheduler.get_rcb_lock_release_scheduler_heartbeat_payload()
    assert health["last_tick_ok"] is True
    assert health["last_released_count"] == 2
    assert health["consecutive_failures"] == 0


def test_scheduler_keeps_failure_visible_in_heartbeat(monkeypatch) -> None:
    def _raise():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(scheduler, "process_rcb_lock_release_job_once", _raise)

    result = scheduler.process_rcb_lock_release_scheduler_once()

    assert result["ok"] is False
    assert "RuntimeError" in result["error"]
    health = scheduler.get_rcb_lock_release_scheduler_heartbeat_payload()
    assert health["last_tick_ok"] is False
    assert health["consecutive_failures"] >= 1
