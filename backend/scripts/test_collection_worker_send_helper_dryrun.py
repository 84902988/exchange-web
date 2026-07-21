from __future__ import annotations

import os
import sys
from contextlib import ExitStack
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.services.collection_send_helper import is_collection_real_send_enabled  # noqa: E402
from app.tasks import collection_tasks  # noqa: E402


ENV_NAMES = {"COLLECTION_REAL_SEND_MASTER_SWITCH", "COLLECTION_ENABLE_REAL_SEND"}


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0
        self.flushes = 0
        self.closed = False

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def flush(self) -> None:
        self.flushes += 1

    def close(self) -> None:
        self.closed = True


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _replace_env(values: dict[str, str], fn) -> None:
    original = {name: os.environ.get(name) for name in ENV_NAMES}
    try:
        for name in ENV_NAMES:
            os.environ.pop(name, None)
        os.environ.update(values)
        fn()
    finally:
        for name, value in original.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _test_worker_dry_run_without_database_or_rpc() -> None:
    collection_session = _FakeSession()
    gas_session = _FakeSession()
    sessions = iter((collection_session, gas_session))
    collection_task = SimpleNamespace(
        id=701,
        batch_id=301,
        status="PENDING",
        chain_key="bsc",
        coin_symbol="USDT",
        from_address="0x1111111111111111111111111111111111111111",
        to_address="0x2222222222222222222222222222222222222222",
        amount=Decimal("4.56"),
        gas_task_id=None,
        reason="isolated worker dry-run test",
        last_error=None,
        tx_hash=None,
    )
    gas_task = SimpleNamespace(
        id=702,
        collection_task_id=701,
        status="PENDING",
        chain_key="bsc",
        gas_coin_symbol="BNB",
        from_address="0x3333333333333333333333333333333333333333",
        to_address=collection_task.from_address,
        topup_amount=Decimal("0.001"),
        target_balance=Decimal("0.001"),
        last_error=None,
        tx_hash=None,
    )
    evaluation = SimpleNamespace(
        should_collect=True,
        gas_required=False,
        collect_amount=Decimal("4.56"),
        min_collect_amount=Decimal("0.01"),
        reason="ISOLATED_DRY_RUN",
    )

    def mark_collection_sent(_db, _task_id: int, tx_hash: str) -> None:
        collection_task.status = "SENT"
        collection_task.tx_hash = tx_hash

    def mark_gas_sent(_db, _task_id: int, tx_hash: str) -> None:
        gas_task.status = "SENT"
        gas_task.tx_hash = tx_hash

    with ExitStack() as stack:
        stack.enter_context(patch.object(collection_tasks, "SessionLocal", side_effect=lambda: next(sessions)))
        stack.enter_context(patch.object(collection_tasks, "_get_collection_task", return_value=collection_task))
        stack.enter_context(patch.object(collection_tasks, "_get_gas_task", return_value=gas_task))
        stack.enter_context(patch.object(
            collection_tasks,
            "_load_asset_chain_meta",
            return_value={"contract_address": "0x4444444444444444444444444444444444444444", "decimals": 18},
        ))
        stack.enter_context(patch.object(collection_tasks, "_load_collection_min_amount", return_value=Decimal("0.01")))
        stack.enter_context(patch.object(collection_tasks, "confirm_collection_candidate_onchain", return_value=evaluation))
        stack.enter_context(patch.object(collection_tasks, "get_native_balance", return_value=Decimal("0")))
        stack.enter_context(patch.object(collection_tasks, "mark_collection_task_queued", return_value=None))
        stack.enter_context(patch.object(collection_tasks, "mark_collection_task_sending", return_value=None))
        stack.enter_context(patch.object(collection_tasks, "mark_collection_task_sent", side_effect=mark_collection_sent))
        stack.enter_context(patch.object(collection_tasks, "mark_gas_task_queued", return_value=None))
        stack.enter_context(patch.object(collection_tasks, "mark_gas_task_sending", return_value=None))
        stack.enter_context(patch.object(collection_tasks, "mark_gas_task_sent", side_effect=mark_gas_sent))
        collection_result = collection_tasks.process_collection_task(collection_task.id, allow_real_send=False)
        gas_result = collection_tasks.process_gas_task(gas_task.id, allow_real_send=False)

    _assert(collection_result.get("ok") is True, "collection worker dry-run must succeed")
    _assert(collection_result.get("status") == "SENT", "dry-run follows the current SENT worker state")
    _assert(collection_result.get("dry_run") is True, "collection result must be marked dry-run")
    _assert(str(collection_result.get("tx_hash") or "").startswith("DRYRUN_"), "collection hash must be a dry marker")
    _assert(gas_result.get("ok") is True, "gas worker dry-run must succeed")
    _assert(gas_result.get("status") == "SENT", "gas dry-run follows the current SENT worker state")
    _assert(gas_result.get("dry_run") is True, "gas result must be marked dry-run")
    _assert(str(gas_result.get("tx_hash") or "").startswith("DRYGAS_"), "gas hash must be a dry marker")
    _assert(collection_session.closed and gas_session.closed, "isolated sessions must be closed")
    _assert(collection_session.commits == 1 and gas_session.commits == 1, "each worker must commit once")


def main() -> None:
    def run() -> None:
        _assert(is_collection_real_send_enabled() is False, "test requires the real-send master switch to be disabled")
        _test_worker_dry_run_without_database_or_rpc()

    _replace_env(
        {"COLLECTION_REAL_SEND_MASTER_SWITCH": "false", "COLLECTION_ENABLE_REAL_SEND": "false"},
        run,
    )
    print("collection_worker_send_helper_dryrun_test")
    print("isolated_fake_session=true")
    print("database_writes=false")
    print("rpc_calls=false")
    print("collection_dry_run=true")
    print("gas_dry_run=true")


if __name__ == "__main__":
    main()
