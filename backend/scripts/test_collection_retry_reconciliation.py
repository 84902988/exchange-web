from __future__ import annotations

import sys
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch, sentinel

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from web3 import Web3


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.collection import CollectionBatch, CollectionTask, GasTask  # noqa: E402
from app.services import collection_candidate_scanner, collection_send_helper, collection_service  # noqa: E402
from app.services.collection_tx_confirm_service import confirm_collection_task_tx, confirm_gas_task_tx  # noqa: E402
from app.tasks import collection_tasks  # noqa: E402
from scripts import start_collection_auto_scheduler as scheduler  # noqa: E402


def _session_factory():
    engine = create_engine("sqlite:///:memory:", future=True)
    CollectionBatch.__table__.create(engine)
    CollectionTask.__table__.create(engine)
    GasTask.__table__.create(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def _collection_task(task_id: int, *, updated_at: datetime, next_retry_at: datetime, retry_count: int = 1):
    return CollectionTask(
        id=task_id,
        task_no=f"CT{task_id}",
        batch_id=1,
        user_id=1,
        chain_key="bsc",
        coin_symbol="USDT",
        from_address="0x" + "1" * 40,
        to_address="0x" + "2" * 40,
        amount=Decimal("1"),
        status="FAILED",
        retry_count=retry_count,
        max_retry=3,
        next_retry_at=next_retry_at,
        created_at=updated_at,
        updated_at=updated_at,
    )


def _gas_task(task_id: int, *, updated_at: datetime, next_retry_at: datetime):
    return GasTask(
        id=task_id,
        task_no=f"GT{task_id}",
        collection_task_id=None,
        user_id=1,
        chain_key="bsc",
        gas_coin_symbol="BNB",
        from_address="0x" + "3" * 40,
        to_address="0x" + "1" * 40,
        topup_amount=Decimal("0.01"),
        target_balance=Decimal("0.01"),
        status="FAILED",
        retry_count=1,
        max_retry=3,
        next_retry_at=next_retry_at,
        created_at=updated_at,
        updated_at=updated_at,
    )


def test_due_retry_query_honors_cutoff_due_time_retry_limit_and_tx_hash() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    cutoff = now - timedelta(minutes=10)
    db = Session()
    try:
        db.add(
            CollectionBatch(
                id=1,
                batch_no="CB1",
                trigger_type="MANUAL",
                target_address="0x" + "2" * 40,
                status="PENDING",
            )
        )
        db.add(_collection_task(1, updated_at=cutoff + timedelta(minutes=1), next_retry_at=now - timedelta(seconds=1)))
        db.add(_collection_task(2, updated_at=cutoff - timedelta(minutes=1), next_retry_at=now - timedelta(seconds=1)))
        db.add(_collection_task(3, updated_at=cutoff + timedelta(minutes=1), next_retry_at=now + timedelta(minutes=1)))
        db.add(_collection_task(4, updated_at=cutoff + timedelta(minutes=1), next_retry_at=now - timedelta(seconds=1), retry_count=3))
        sent = _collection_task(5, updated_at=cutoff + timedelta(minutes=1), next_retry_at=now - timedelta(seconds=1))
        sent.tx_hash = "0x" + "a" * 64
        db.add(sent)
        db.add(_gas_task(11, updated_at=cutoff + timedelta(minutes=1), next_retry_at=now - timedelta(seconds=1)))
        db.add(_gas_task(12, updated_at=cutoff - timedelta(minutes=1), next_retry_at=now - timedelta(seconds=1)))
        db.commit()

        assert scheduler._load_due_retry_task_ids(
            db, model=CollectionTask, chain_key="bsc", not_before=cutoff
        ) == [1]
        assert scheduler._load_due_retry_task_ids(
            db, model=GasTask, chain_key="bsc", not_before=cutoff
        ) == [11]
    finally:
        db.close()


def test_enqueue_failure_becomes_due_without_consuming_business_retry() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(
            CollectionBatch(
                id=1,
                batch_no="CB1",
                trigger_type="MANUAL",
                target_address="0x" + "2" * 40,
                status="PENDING",
            )
        )
        task = _collection_task(1, updated_at=now, next_retry_at=now + timedelta(minutes=10))
        task.status = "PENDING"
        task.retry_count = 0
        db.add(task)
        db.commit()

        scheduler._record_enqueue_failure(
            db,
            model=CollectionTask,
            task_id=1,
            message="AUTO_ENQUEUE_FAILED:ConnectionError",
        )

        db.expire_all()
        saved = db.query(CollectionTask).filter(CollectionTask.id == 1).one()
        assert saved.status == "FAILED"
        assert saved.retry_count == 0
        assert saved.next_retry_at is not None
        assert saved.last_error == "AUTO_ENQUEUE_FAILED:ConnectionError"
    finally:
        db.close()


class _NoteSession:
    def __init__(self) -> None:
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True


class _CommitOrderSession:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    def commit(self) -> None:
        self.events.append("commit")


def test_unhandled_worker_failures_are_persisted_in_isolated_sessions() -> None:
    collection_session = _NoteSession()
    gas_session = _NoteSession()
    sessions = iter([collection_session, gas_session])
    collection_messages: list[tuple[int, str]] = []
    gas_messages: list[tuple[int, str]] = []

    with patch.object(collection_tasks, "SessionLocal", side_effect=lambda: next(sessions)), patch.object(
        collection_tasks,
        "record_collection_task_failure_note",
        side_effect=lambda _db, task_id, message: collection_messages.append((int(task_id), str(message))),
    ), patch.object(
        collection_tasks,
        "record_gas_task_failure_note",
        side_effect=lambda _db, task_id, message: gas_messages.append((int(task_id), str(message))),
    ):
        collection_tasks._record_unhandled_collection_task_failure(7, ValueError("address mismatch"))
        collection_tasks._record_unhandled_gas_task_failure(8, RuntimeError("key validation failed"))

    assert collection_messages == [(7, "UNHANDLED_COLLECTION_EXCEPTION:ValueError:address mismatch")]
    assert gas_messages == [(8, "UNHANDLED_GAS_EXCEPTION:RuntimeError:key validation failed")]
    assert collection_session.committed and collection_session.closed and not collection_session.rolled_back
    assert gas_session.committed and gas_session.closed and not gas_session.rolled_back


def test_sent_state_commits_before_tx_confirm_enqueue() -> None:
    events: list[str] = []
    db = _CommitOrderSession(events)

    with patch.object(
        collection_tasks,
        "enqueue_tx_confirm_collection_task",
        side_effect=lambda task_id: events.append(f"enqueue:{task_id}") or f"job-{task_id}",
    ):
        job_id, error = collection_tasks._commit_sent_and_enqueue_tx_confirm(
            db,
            task_type="collection",
            task_id=79,
            dry_run=False,
        )

    assert events == ["commit", "enqueue:79"]
    assert job_id == "job-79"
    assert error is None


def test_tx_confirm_enqueue_failure_is_compensatable() -> None:
    events: list[str] = []
    db = _CommitOrderSession(events)

    with patch.object(
        collection_tasks,
        "enqueue_tx_confirm_gas_task",
        side_effect=lambda _task_id: events.append("enqueue") or (_ for _ in ()).throw(ConnectionError("redis down")),
    ), patch.object(
        collection_tasks,
        "_record_tx_confirm_enqueue_failure",
        side_effect=lambda task_type, task_id, message: events.append(f"record:{task_type}:{task_id}:{message}"),
    ):
        job_id, error = collection_tasks._commit_sent_and_enqueue_tx_confirm(
            db,
            task_type="gas",
            task_id=28,
            dry_run=False,
        )

    assert events[0:2] == ["commit", "enqueue"]
    assert events[2].startswith("record:gas:28:TX_CONFIRM_ENQUEUE_FAILED:ConnectionError:")
    assert job_id is None
    assert str(error or "").startswith("TX_CONFIRM_ENQUEUE_FAILED:ConnectionError:")


def test_stale_tx_confirm_query_uses_bounded_grace_windows() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(CollectionBatch(id=1, batch_no="CB1", trigger_type="AUTO", target_address="0x" + "2" * 40, status="PROCESSING"))
        sent_old = _collection_task(1, updated_at=now - timedelta(minutes=2), next_retry_at=now)
        sent_old.status = "SENT"
        sent_old.tx_hash = "0x" + "1" * 64
        sent_recent = _collection_task(2, updated_at=now, next_retry_at=now)
        sent_recent.status = "SENT"
        sent_recent.tx_hash = "0x" + "2" * 64
        confirming_old = _collection_task(3, updated_at=now - timedelta(minutes=20), next_retry_at=now)
        confirming_old.status = "CONFIRMING"
        confirming_old.tx_hash = "0x" + "3" * 64
        confirming_recent = _collection_task(4, updated_at=now - timedelta(minutes=5), next_retry_at=now)
        confirming_recent.status = "CONFIRMING"
        confirming_recent.tx_hash = "0x" + "4" * 64
        db.add_all([sent_old, sent_recent, confirming_old, confirming_recent])
        db.commit()

        ids = scheduler._load_stale_tx_confirm_task_ids(
            db,
            model=CollectionTask,
            sent_statuses=("SENT",),
            confirming_statuses=("CONFIRMING",),
        )
        assert ids == [3, 1]
    finally:
        db.close()


def test_empty_tx_hash_is_retryable_not_terminal() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(CollectionBatch(id=1, batch_no="CB1", trigger_type="AUTO", target_address="0x" + "2" * 40, status="PROCESSING"))
        collection = _collection_task(1, updated_at=now, next_retry_at=now)
        collection.status = "SENT"
        collection.tx_hash = None
        gas = _gas_task(11, updated_at=now, next_retry_at=now)
        gas.status = "SENT"
        gas.tx_hash = None
        db.add_all([collection, gas])
        db.commit()

        assert confirm_collection_task_tx(db, 1).status == "PENDING"
        assert confirm_gas_task_tx(db, 11).status == "PENDING"
    finally:
        db.close()


def test_terminal_gas_reconcile_releases_all_linked_waiting_collections() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(CollectionBatch(id=1, batch_no="CB1", trigger_type="AUTO", target_address="0x" + "2" * 40, status="PROCESSING"))
        first = _collection_task(1, updated_at=now, next_retry_at=now)
        first.status = "GAS_REQUIRED"
        first.gas_task_id = 11
        first.next_retry_at = None
        second = _collection_task(2, updated_at=now, next_retry_at=now)
        second.status = "GAS_REQUIRED"
        second.coin_symbol = "USDC"
        second.gas_task_id = 11
        second.next_retry_at = None
        gas = _gas_task(11, updated_at=now, next_retry_at=now)
        gas.collection_task_id = 1
        gas.status = "FAILED"
        gas.retry_count = 3
        gas.next_retry_at = None
        gas.last_error = "hot wallet balance insufficient"
        db.add_all([first, second, gas])
        db.commit()

        released_ids = collection_service.reconcile_terminal_gas_required_collection_tasks(db, chain_key="bsc")
        db.commit()

        assert released_ids == [1, 2]
        saved = db.query(CollectionTask).order_by(CollectionTask.id.asc()).all()
        assert [item.status for item in saved] == ["FAILED", "FAILED"]
        assert all(item.next_retry_at is None for item in saved)
        assert all(str(item.reason or "").startswith("GAS_TASK_TERMINAL_RESCAN_REQUIRED:FAILED") for item in saved)
    finally:
        db.close()


def test_retryable_or_broadcast_gas_does_not_release_waiting_collection() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(CollectionBatch(id=1, batch_no="CB1", trigger_type="AUTO", target_address="0x" + "2" * 40, status="PROCESSING"))
        retry_parent = _collection_task(1, updated_at=now, next_retry_at=now)
        retry_parent.status = "GAS_REQUIRED"
        retry_parent.gas_task_id = 11
        retry_parent.next_retry_at = None
        retry_gas = _gas_task(11, updated_at=now, next_retry_at=now + timedelta(minutes=2))
        retry_gas.collection_task_id = 1

        broadcast_parent = _collection_task(2, updated_at=now, next_retry_at=now)
        broadcast_parent.status = "GAS_REQUIRED"
        broadcast_parent.coin_symbol = "USDC"
        broadcast_parent.gas_task_id = 12
        broadcast_parent.next_retry_at = None
        broadcast_gas = _gas_task(12, updated_at=now, next_retry_at=now)
        broadcast_gas.collection_task_id = 2
        broadcast_gas.retry_count = 3
        broadcast_gas.next_retry_at = None
        broadcast_gas.tx_hash = "0x" + "a" * 64
        db.add_all([retry_parent, retry_gas, broadcast_parent, broadcast_gas])
        db.commit()

        assert collection_service.reconcile_terminal_gas_required_collection_tasks(db, chain_key="bsc") == []
        assert db.query(CollectionTask).filter(CollectionTask.id == 1).one().status == "GAS_REQUIRED"
        assert db.query(CollectionTask).filter(CollectionTask.id == 2).one().status == "GAS_REQUIRED"
    finally:
        db.close()


def test_terminal_mark_gas_failed_releases_parent_immediately() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(CollectionBatch(id=1, batch_no="CB1", trigger_type="AUTO", target_address="0x" + "2" * 40, status="PROCESSING"))
        parent = _collection_task(1, updated_at=now, next_retry_at=now)
        parent.status = "GAS_REQUIRED"
        parent.gas_task_id = 11
        parent.next_retry_at = None
        gas = _gas_task(11, updated_at=now, next_retry_at=now)
        gas.collection_task_id = 1
        gas.status = "SENDING"
        gas.retry_count = 2
        gas.next_retry_at = None
        db.add_all([parent, gas])
        db.commit()

        saved_gas = collection_service.mark_gas_task_failed(db, 11, "send failed", retryable=True)
        db.commit()

        assert saved_gas.status == "FAILED"
        assert saved_gas.retry_count == 3
        assert saved_gas.next_retry_at is None
        saved_parent = db.query(CollectionTask).filter(CollectionTask.id == 1).one()
        assert saved_parent.status == "FAILED"
        assert str(saved_parent.reason or "").startswith("GAS_TASK_TERMINAL_RESCAN_REQUIRED:FAILED")
    finally:
        db.close()


def test_admin_create_forwards_auto_batch_trigger_type() -> None:
    with patch.object(
        collection_candidate_scanner,
        "scan_collection_candidates",
        return_value=sentinel.scan_result,
    ) as scan:
        result = collection_candidate_scanner.admin_create_collection_tasks(
            object(),
            chain_key="bsc",
            asset_symbol="USDT",
            trigger_type="AUTO",
        )

    assert result is sentinel.scan_result
    assert scan.call_args.kwargs["trigger_type"] == "AUTO"


def test_initial_scheduler_enqueue_excludes_tasks_waiting_for_gas() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(CollectionBatch(id=1, batch_no="CB1", trigger_type="AUTO", target_address="0x" + "2" * 40, status="PROCESSING"))
        ready = _collection_task(1, updated_at=now, next_retry_at=now)
        ready.status = "PENDING"
        ready.next_retry_at = None
        waiting = _collection_task(2, updated_at=now, next_retry_at=now)
        waiting.status = "GAS_REQUIRED"
        waiting.coin_symbol = "USDC"
        waiting.gas_task_id = 11
        waiting.next_retry_at = None
        defensive = _collection_task(3, updated_at=now, next_retry_at=now)
        defensive.status = "PENDING"
        defensive.coin_symbol = "RCB"
        defensive.gas_task_id = 11
        defensive.next_retry_at = None
        db.add_all([ready, waiting, defensive])
        db.commit()

        ready_ids, waiting_ids = scheduler._partition_created_collection_task_ids(db, [1, 2, 3])

        assert ready_ids == [1]
        assert waiting_ids == [2, 3]
    finally:
        db.close()


def test_scheduler_finds_confirmed_gas_with_waiting_collection() -> None:
    Session = _session_factory()
    now = datetime.utcnow()
    db = Session()
    try:
        db.add(CollectionBatch(id=1, batch_no="CB1", trigger_type="AUTO", target_address="0x" + "2" * 40, status="PROCESSING"))
        waiting = _collection_task(1, updated_at=now, next_retry_at=now)
        waiting.status = "GAS_REQUIRED"
        waiting.gas_task_id = 11
        waiting.next_retry_at = None
        confirmed = _gas_task(11, updated_at=now, next_retry_at=now)
        confirmed.collection_task_id = 1
        confirmed.status = "CONFIRMED"
        confirmed.tx_hash = "0x" + "a" * 64
        confirmed.confirmed_at = now
        confirmed.next_retry_at = None
        db.add_all([waiting, confirmed])
        db.commit()

        assert scheduler._load_confirmed_gas_waiting_collection_ids(db, chain_key="bsc") == [11]
        waiting.tx_hash = "0x" + "b" * 64
        db.commit()
        assert scheduler._load_confirmed_gas_waiting_collection_ids(db, chain_key="bsc") == []
    finally:
        db.close()


class _BroadcastProvider:
    def __init__(self, endpoint_uri: str) -> None:
        self.endpoint_uri = endpoint_uri


class _BroadcastEth:
    def __init__(self, result: object) -> None:
        self.result = result
        self.calls = 0

    def send_raw_transaction(self, _raw_tx: bytes):
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _BroadcastWeb3:
    def __init__(self, endpoint_uri: str, result: object) -> None:
        self.provider = _BroadcastProvider(endpoint_uri)
        self.eth = _BroadcastEth(result)


def test_evm_raw_transaction_is_broadcast_to_all_configured_rpcs() -> None:
    raw_tx = b"signed-transaction"
    expected_hash = Web3.keccak(raw_tx)
    primary = _BroadcastWeb3("https://rpc-1", expected_hash)
    secondary = _BroadcastWeb3("https://rpc-2", expected_hash)
    unauthorized = _BroadcastWeb3("https://rpc-3", ValueError("unauthorized"))

    with patch.object(
        collection_send_helper,
        "_web3_for_broadcast_rpc",
        side_effect=lambda url: {"https://rpc-2": secondary, "https://rpc-3": unauthorized}[url],
    ):
        result = collection_send_helper._broadcast_raw_transaction_to_rpc_pool(
            primary,
            raw_tx,
            ["https://rpc-1", "https://rpc-2", "https://rpc-3"],
        )

    assert result == Web3.keccak(raw_tx).hex().lower()
    assert primary.eth.calls == 1
    assert secondary.eth.calls == 1
    assert unauthorized.eth.calls == 1


def test_evm_raw_transaction_requires_at_least_one_rpc_acknowledgement() -> None:
    raw_tx = b"signed-transaction"
    primary = _BroadcastWeb3("https://rpc-1", ConnectionError("offline"))
    secondary = _BroadcastWeb3("https://rpc-2", ValueError("unauthorized"))

    with patch.object(collection_send_helper, "_web3_for_broadcast_rpc", return_value=secondary):
        try:
            collection_send_helper._broadcast_raw_transaction_to_rpc_pool(
                primary,
                raw_tx,
                ["https://rpc-1", "https://rpc-2"],
            )
        except RuntimeError as exc:
            assert str(exc).startswith("EVM_RPC_BROADCAST_FAILED:")
        else:
            raise AssertionError("expected RPC broadcast failure")


class _ScalarResult:
    def scalar(self) -> int:
        return 1


class _LockConnection:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    def execute(self, statement, _params):
        self.events.append(str(statement))
        return _ScalarResult()

    def invalidate(self) -> None:
        self.events.append("invalidate")

    def close(self) -> None:
        self.events.append("close")


class _MySqlBind:
    class _Dialect:
        name = "mysql"

    dialect = _Dialect()

    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.engine = self

    def connect(self) -> _LockConnection:
        self.events.append("connect")
        return _LockConnection(self.events)


class _MySqlSession:
    def __init__(self, events: list[str]) -> None:
        self.bind = _MySqlBind(events)

    def get_bind(self):
        return self.bind


def test_evm_nonce_lock_is_cross_process_and_released() -> None:
    events: list[str] = []
    with collection_send_helper._evm_nonce_send_lock(
        db=_MySqlSession(events),
        chain_key="polygon",
        from_address="0x" + "9" * 40,
    ):
        events.append("broadcast")

    assert events[0] == "connect"
    assert "GET_LOCK" in events[1]
    assert events[2] == "broadcast"
    assert "RELEASE_LOCK" in events[3]
    assert events[4] == "close"


def main() -> int:
    tests = [
        test_due_retry_query_honors_cutoff_due_time_retry_limit_and_tx_hash,
        test_enqueue_failure_becomes_due_without_consuming_business_retry,
        test_unhandled_worker_failures_are_persisted_in_isolated_sessions,
        test_sent_state_commits_before_tx_confirm_enqueue,
        test_tx_confirm_enqueue_failure_is_compensatable,
        test_stale_tx_confirm_query_uses_bounded_grace_windows,
        test_empty_tx_hash_is_retryable_not_terminal,
        test_terminal_gas_reconcile_releases_all_linked_waiting_collections,
        test_retryable_or_broadcast_gas_does_not_release_waiting_collection,
        test_terminal_mark_gas_failed_releases_parent_immediately,
        test_admin_create_forwards_auto_batch_trigger_type,
        test_initial_scheduler_enqueue_excludes_tasks_waiting_for_gas,
        test_scheduler_finds_confirmed_gas_with_waiting_collection,
        test_evm_raw_transaction_is_broadcast_to_all_configured_rpcs,
        test_evm_raw_transaction_requires_at_least_one_rpc_acknowledgement,
        test_evm_nonce_lock_is_cross_process_and_released,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(f"PASS total={len(tests)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
