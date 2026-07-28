from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts import start_withdraw_tx_watcher as runner  # noqa: E402
from app.jobs import withdraw_tx_watcher as watcher  # noqa: E402


class FakeSession:
    def __init__(self) -> None:
        self.closed = False
        self.rolled_back = False
        self.committed = False

    def close(self) -> None:
        self.closed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def commit(self) -> None:
        self.committed = True


def test_success_tick_records_health_and_closes_session() -> None:
    db = FakeSession()
    with patch.object(runner, "process_once", return_value=2), patch.object(
        runner, "_pending_sent_count", return_value=1
    ):
        result = runner.process_withdraw_tx_watcher_once(session_factory=lambda: db, max_batch=25)

    assert result["ok"] is True
    assert result["processed_count"] == 2
    assert result["pending_sent_count"] == 1
    assert db.closed and not db.rolled_back
    health = runner.get_withdraw_tx_watcher_heartbeat_payload()
    assert health["last_tick_ok"] is True
    assert health["pending_sent_count"] == 1
    assert health["consecutive_failures"] == 0


def test_failed_tick_rolls_back_and_stays_alive() -> None:
    db = FakeSession()
    with patch.object(runner, "process_once", side_effect=RuntimeError("rpc unavailable")):
        result = runner.process_withdraw_tx_watcher_once(session_factory=lambda: db)

    assert result["ok"] is False
    assert result["error"] == "RuntimeError:rpc unavailable"
    assert db.closed and db.rolled_back
    health = runner.get_withdraw_tx_watcher_heartbeat_payload()
    assert health["last_tick_ok"] is False
    assert health["consecutive_failures"] >= 1


def test_settlement_failure_keeps_withdraw_pending_for_retry() -> None:
    db = FakeSession()
    row = {"id": 64, "chain_key": "bsc", "tx_hash": "0xabc"}
    with patch.object(watcher, "_get_chain_rpc_map", return_value={"bsc": {"rpc_urls": ["https://rpc"]}}), patch.object(
        watcher, "_fetch_sent_withdraws", return_value=[row]
    ), patch.object(watcher, "_get_receipt_with_rpc_fallback", return_value=({"status": 1}, 100)), patch.object(
        watcher, "_receipt_status_value", return_value=1
    ), patch.object(watcher, "_validate_erc20_transfer", return_value=(True, "ok")), patch.object(
        watcher, "_settle_withdraw_success", side_effect=RuntimeError("ledger unavailable")
    ), patch.object(watcher, "_log"):
        processed = watcher.process_once(db, max_batch=1)

    assert processed == 1
    assert db.rolled_back is True
    assert db.committed is True


def main() -> int:
    tests = [
        test_success_tick_records_health_and_closes_session,
        test_failed_tick_rolls_back_and_stays_alive,
        test_settlement_failure_keeps_withdraw_pending_for_retry,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(f"PASS total={len(tests)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
