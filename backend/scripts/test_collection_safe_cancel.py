from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from pathlib import Path
import sys

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.models.collection import CollectionBatch, CollectionBatchStatus, CollectionTask, CollectionTaskStatus, GasTask, GasTaskStatus
from app.services.collection_service import find_active_collection_task_duplicate, safe_cancel_collection_task


TARGET = "0x8dbeed9e9f8e95af04f2d7aa551f156298afb68c"
COLLECT = "0x4a27fad2ebd13db9f73f92bd521b96579649e2b9"
HOT = "0x1111111111111111111111111111111111111111"


def make_session_factory():
    engine = create_engine("sqlite:///:memory:")
    CollectionBatch.__table__.create(engine)
    CollectionTask.__table__.create(engine)
    GasTask.__table__.create(engine)
    return sessionmaker(bind=engine)


def add_batch(db, batch_id: int = 1):
    db.add(
        CollectionBatch(
            id=batch_id,
            batch_no=f"B{batch_id}",
            trigger_type="MANUAL",
            target_address=COLLECT,
            chain_key="ethereum",
            coin_symbol="USDC",
            status=CollectionBatchStatus.PENDING.value,
            total_tasks=0,
        )
    )


def add_task(
    db,
    task_id: int,
    *,
    status: str,
    tx_hash: str | None = None,
    gas_task_id: int | None = None,
    sent_at=None,
    confirmed_at=None,
    block_number=None,
):
    db.add(
        CollectionTask(
            id=task_id,
            task_no=f"CT{task_id}",
            batch_id=1,
            user_id=100,
            chain_key="ethereum",
            coin_symbol="USDC",
            asset_chain_id=29,
            from_address=TARGET,
            to_address=COLLECT,
            amount=Decimal("0.53"),
            status=status,
            tx_hash=tx_hash,
            gas_task_id=gas_task_id,
            retry_count=0,
            max_retry=3,
            sent_at=sent_at,
            confirmed_at=confirmed_at,
            block_number=block_number,
        )
    )


def add_gas(db, gas_id: int, *, status: str, tx_hash: str | None = None, collection_task_id: int | None = None):
    db.add(
        GasTask(
            id=gas_id,
            task_no=f"GT{gas_id}",
            collection_task_id=collection_task_id,
            user_id=100,
            chain_key="ethereum",
            gas_coin_symbol="ETH",
            from_address=HOT,
            to_address=TARGET,
            target_balance=Decimal("0.02"),
            topup_amount=Decimal("0.02"),
            status=status,
            tx_hash=tx_hash,
            retry_count=0,
            max_retry=3,
        )
    )


def assert_rejects(Session, *, task_status: str, tx_hash: str | None = None, sent_at=None, confirmed_at=None, block_number=None):
    db = Session()
    try:
        add_batch(db)
        add_task(
            db,
            1,
            status=task_status,
            tx_hash=tx_hash,
            sent_at=sent_at,
            confirmed_at=confirmed_at,
            block_number=block_number,
        )
        db.flush()
        try:
            safe_cancel_collection_task(db, 1)
        except ValueError:
            return
        raise AssertionError(f"expected safe cancel rejection for status={task_status} tx_hash={tx_hash}")
    finally:
        db.close()


def test_pending_no_tx_cancelable(Session):
    db = Session()
    try:
        add_batch(db)
        add_task(db, 1, status=CollectionTaskStatus.PENDING.value)
        db.flush()
        result = safe_cancel_collection_task(db, 1)
        assert result.task.status == CollectionTaskStatus.CANCELED.value
        assert result.task.reason == "ADMIN_CANCEL_STALE_AMOUNT_RESCAN_REQUIRED"
    finally:
        db.close()


def test_gas_required_no_tx_cancelable(Session):
    db = Session()
    try:
        add_batch(db)
        add_task(db, 1, status=CollectionTaskStatus.GAS_REQUIRED.value)
        db.flush()
        result = safe_cancel_collection_task(db, 1)
        assert result.task.status == CollectionTaskStatus.CANCELED.value
    finally:
        db.close()


def test_sent_confirmed_or_tx_hash_not_cancelable(Session):
    assert_rejects(Session, task_status=CollectionTaskStatus.SENT.value)
    assert_rejects(Session, task_status=CollectionTaskStatus.CONFIRMED.value)
    assert_rejects(Session, task_status=CollectionTaskStatus.PENDING.value, tx_hash="0x" + "a" * 64)
    assert_rejects(Session, task_status=CollectionTaskStatus.PENDING.value, sent_at=datetime.utcnow())
    assert_rejects(Session, task_status=CollectionTaskStatus.PENDING.value, confirmed_at=datetime.utcnow())
    assert_rejects(Session, task_status=CollectionTaskStatus.PENDING.value, block_number=123)


def test_linked_gas_without_tx_canceled(Session):
    db = Session()
    try:
        add_batch(db)
        add_gas(db, 17, status=GasTaskStatus.PENDING.value, collection_task_id=1)
        add_task(db, 1, status=CollectionTaskStatus.PENDING.value, gas_task_id=17)
        db.flush()
        result = safe_cancel_collection_task(db, 1)
        gas_task = db.query(GasTask).filter(GasTask.id == 17).first()
        assert result.gas_task_canceled is True
        assert gas_task.status == GasTaskStatus.CANCELED.value
        assert gas_task.last_error == "PARENT_COLLECTION_TASK_CANCELED"
    finally:
        db.close()


def test_linked_gas_confirmed_or_with_tx_preserved(Session):
    db = Session()
    try:
        add_batch(db)
        add_gas(db, 17, status=GasTaskStatus.CONFIRMED.value, tx_hash="0x" + "b" * 64, collection_task_id=1)
        add_task(db, 1, status=CollectionTaskStatus.GAS_REQUIRED.value, gas_task_id=17)
        db.flush()
        result = safe_cancel_collection_task(db, 1)
        gas_task = db.query(GasTask).filter(GasTask.id == 17).first()
        assert result.gas_task_preserved is True
        assert gas_task.status == GasTaskStatus.CONFIRMED.value
        assert gas_task.tx_hash == "0x" + "b" * 64
    finally:
        db.close()


def test_cancel_releases_active_duplicate_for_scanner(Session):
    db = Session()
    try:
        add_batch(db)
        add_task(db, 1, status=CollectionTaskStatus.PENDING.value)
        db.flush()
        before = find_active_collection_task_duplicate(
            db,
            user_id=100,
            chain_key="ethereum",
            coin_symbol="USDC",
            from_address=TARGET,
        )
        assert before is not None
        safe_cancel_collection_task(db, 1)
        after = find_active_collection_task_duplicate(
            db,
            user_id=100,
            chain_key="ethereum",
            coin_symbol="USDC",
            from_address=TARGET,
        )
        assert after is None
    finally:
        db.close()


def main():
    tests = [
        test_pending_no_tx_cancelable,
        test_gas_required_no_tx_cancelable,
        test_sent_confirmed_or_tx_hash_not_cancelable,
        test_linked_gas_without_tx_canceled,
        test_linked_gas_confirmed_or_with_tx_preserved,
        test_cancel_releases_active_duplicate_for_scanner,
    ]
    for test in tests:
        Session = make_session_factory()
        test(Session)
        print(f"PASS {test.__name__}")


if __name__ == "__main__":
    main()
