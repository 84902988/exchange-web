from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.jobs import withdraw_fee_maintenance_scheduler as withdraw_scheduler
from app.services import admin_queries
from app.services import contract_private_ws
from scripts import start_collection_auto_scheduler as collection_scheduler


def _raise_db_unavailable() -> Any:
    raise RuntimeError("db unavailable")


class _BrokenCleanupSession:
    def rollback(self) -> None:
        raise RuntimeError("rollback unavailable")

    def close(self) -> None:
        raise RuntimeError("close unavailable")


def test_withdraw_fee_scheduler_keeps_health_when_session_creation_fails(monkeypatch) -> None:
    monkeypatch.setattr(withdraw_scheduler, "SessionLocal", _raise_db_unavailable)

    result = withdraw_scheduler.process_withdraw_fee_maintenance_scheduler_once()
    health = withdraw_scheduler.get_withdraw_fee_scheduler_heartbeat_payload()

    assert result["ok"] is False
    assert "db unavailable" in result["error"]
    assert health["last_tick_ok"] is False
    assert health["consecutive_failures"] >= 1
    assert "db unavailable" in health["last_tick_error"]
    assert str(health["last_tick_at"]).endswith("Z")


def test_collection_scheduler_keeps_health_when_session_creation_fails(monkeypatch) -> None:
    monkeypatch.setattr(collection_scheduler, "SessionLocal", _raise_db_unavailable)

    result = collection_scheduler.process_collection_auto_scheduler_once()
    health = collection_scheduler.get_collection_auto_scheduler_heartbeat_payload()

    assert result["ok"] is False
    assert "db unavailable" in result["error"]
    assert health["last_tick_ok"] is False
    assert health["consecutive_failures"] >= 1
    assert "db unavailable" in health["last_tick_error"]
    assert str(health["last_tick_at"]).endswith("Z")


def test_scheduler_cleanup_failures_do_not_escape() -> None:
    session = _BrokenCleanupSession()

    collection_scheduler._rollback_scheduler_session(session)
    collection_scheduler._close_scheduler_session(session)
    withdraw_scheduler._close_scheduler_session(session)


def test_alive_scheduler_with_failed_tick_is_reported_as_degraded(monkeypatch) -> None:
    payload = {
        "exists": True,
        "parse_error": False,
        "pid": 123,
        "hostname": "worker-1",
        "last_seen_at": "2026-07-22T00:00:10Z",
        "last_tick_at": "2026-07-22T00:00:09Z",
        "last_tick_ok": False,
        "last_tick_error": "db unavailable",
        "consecutive_failures": 2,
    }
    monkeypatch.setattr(admin_queries, "read_service_heartbeat", lambda _conn, _name: payload)
    monkeypatch.setattr(admin_queries, "heartbeat_age_seconds", lambda _payload: 1)
    monkeypatch.setattr(admin_queries, "is_heartbeat_alive", lambda _payload: True)

    result = admin_queries._admin_service_heartbeat_meta(object(), "withdraw_fee_scheduler")

    assert result["status"] == "degraded"
    assert result["observed"] == "运行异常"
    assert result["observed_badge"] == "danger"
    assert "consecutive failures 2" in result["detail"]
    assert "db unavailable" in result["detail"]


def test_disabled_dividend_job_is_not_reported_as_failed(monkeypatch) -> None:
    monkeypatch.delenv("ENABLE_DIVIDEND_JOB", raising=False)
    empty_workers = admin_queries._admin_service_empty_worker_counts()
    empty_heartbeats = admin_queries._admin_service_empty_heartbeats()
    monkeypatch.setattr(
        admin_queries,
        "_admin_service_observe_redis_and_workers",
        lambda: (True, empty_workers, empty_heartbeats, ""),
    )

    result = admin_queries.admin_query_service_overview()
    dividend = next(
        service
        for group in result["groups"]
        for service in group["services"]
        if service["key"] == "dividend_job"
    )

    assert dividend["observed"] == "未启用"
    assert dividend["observed_badge"] == "neutral"
    assert dividend["run_mode"] == "API 进程内嵌（可选）"


def test_dashboard_withdraw_fee_status_combines_config_and_runtime() -> None:
    offline = {
        "service_rows": [
            {"key": "withdraw_fee_scheduler", "status_key": "offline"},
        ]
    }
    running = {
        "service_rows": [
            {"key": "withdraw_fee_scheduler", "status_key": "running"},
        ]
    }

    assert admin_queries._admin_dashboard_withdraw_fee_status(5, 0, offline) == (
        "配置已启用，调度器未运行",
        "danger",
    )
    assert admin_queries._admin_dashboard_withdraw_fee_status(5, 0, running) == (
        "自动维护运行中",
        "success",
    )
    assert admin_queries._admin_dashboard_withdraw_fee_status(0, 0, offline) == (
        "未启用",
        "neutral",
    )
    assert admin_queries._admin_dashboard_withdraw_fee_status(5, 1, running) == (
        "维护配置有错误",
        "danger",
    )
    assert admin_queries._admin_dashboard_withdraw_fee_status(
        5,
        0,
        {"service_rows": [{"key": "withdraw_fee_scheduler", "status_key": "disabled"}]},
    ) == ("Windows 开发环境不启动", "neutral")


def test_funds_automation_schedulers_are_linux_only() -> None:
    for service_name in ("withdraw_fee_scheduler", "collection_auto_scheduler"):
        assert admin_queries._admin_service_runtime_enabled(service_name, "nt") is False
        assert admin_queries._admin_service_runtime_enabled(service_name, "posix") is True

    assert admin_queries._admin_service_runtime_enabled("dealer_loop", "nt") is True


def test_dashboard_runtime_statuses_use_real_monitoring_results(monkeypatch) -> None:
    monkeypatch.setattr(
        admin_queries,
        "admin_query_operations_center",
        lambda: {
            "summary": {
                "redis_status": "已连接",
                "failed_total": 1,
                "queued_total": 0,
                "stale_workers": 0,
            },
            "queue_rows": [{"name": "email", "online_workers": 1}],
            "service_rows": [
                {"key": "contract_user_event_subscriber", "status_key": "running"},
                {"key": "spot_private_event_relay", "status_key": "running"},
                {"key": "spot_private_event_subscriber", "status_key": "running"},
                {"key": "spot_public_depth_event_subscriber", "status_key": "degraded"},
            ],
        },
    )
    monkeypatch.setattr(
        admin_queries,
        "get_market_cache_metrics_snapshot",
        lambda: {
            "overview": {
                "loader_error": 2,
                "redis_unavailable": 1,
                "hit": 10,
            }
        },
    )

    statuses = {item["label"]: item for item in admin_queries._admin_dashboard_runtime_statuses()}

    assert statuses["Redis"]["status"] == "已连接"
    assert statuses["RQ"]["status"] == "有失败注册 1"
    assert statuses["RQ"]["tone"] == "warning"
    assert statuses["实时事件"]["status"] == "1 项异常"
    assert statuses["实时事件"]["tone"] == "danger"
    assert statuses["行情缓存"]["status"] == "今日降级 3"


def test_rq_failed_registry_is_visible_without_claiming_current_outage() -> None:
    status_key, status_label, status_badge = admin_queries._admin_ops_queue_status(
        online_workers=1,
        queued=0,
        deferred=0,
        scheduled=0,
        failed=1,
    )

    assert status_key == "failed_registry"
    assert status_label == "有失败注册"
    assert status_badge == "warning"


def test_operations_center_reuses_rq_snapshot_and_separates_history(monkeypatch) -> None:
    queue_rows = []
    for queue_name in admin_queries.ADMIN_RQ_QUEUE_NAMES:
        queue_rows.append(
            {
                "name": queue_name,
                "worker_count": 1,
                "stale_worker_count": 0,
                "queued_count": 0,
                "deferred_count": 0,
                "scheduled_count": 0,
                "failed_count": 1 if queue_name == "maintenance" else 0,
            }
        )
    rq_status = {
        "redis_connected": True,
        "summary": {"worker_count": len(queue_rows), "stale_worker_count": 2},
        "queues": queue_rows,
        "workers": [],
    }
    observed_arguments: list[Any] = []
    heartbeats = {
        service_name: {
            "status": "alive",
            "age_seconds": 1,
            "payload": {"pid": 100, "hostname": "worker-1"},
        }
        for service_name in admin_queries.ADMIN_HEARTBEAT_SERVICE_NAMES
    }
    worker_counts = admin_queries._admin_service_empty_worker_counts()
    for queue_name in worker_counts:
        worker_counts[queue_name]["online"] = 1

    monkeypatch.delenv("ENABLE_DIVIDEND_JOB", raising=False)
    monkeypatch.setattr(admin_queries, "admin_query_rq_status", lambda: rq_status)

    def observe(snapshot=None):
        observed_arguments.append(snapshot)
        return True, worker_counts, heartbeats, ""

    monkeypatch.setattr(admin_queries, "_admin_service_observe_redis_and_workers", observe)

    result = admin_queries.admin_query_operations_center()

    assert observed_arguments == [rq_status]
    assert result["summary"]["failed_total"] == 1
    assert result["summary"]["stale_workers"] == 2
    assert result["failed_queue_rows"][0]["status_key"] == "failed_registry"
    assert result["failed_queue_rows"][0]["status_badge"] == "warning"
    dividend = next(row for row in result["service_rows"] if row["key"] == "dividend_job")
    assert dividend["status_key"] == "disabled"
    assert dividend not in result["abnormal_services"]


def test_contract_heartbeat_failure_does_not_escape(monkeypatch) -> None:
    monkeypatch.setattr(contract_private_ws, "_event_redis", _raise_db_unavailable)

    contract_private_ws._beat_contract_user_event_subscriber("subscribed")
