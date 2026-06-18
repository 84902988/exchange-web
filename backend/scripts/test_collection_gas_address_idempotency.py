from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
import sys

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.models.collection import CollectionBatch, CollectionBatchStatus, CollectionTask, CollectionTaskStatus, GasTask, GasTaskStatus
from app.services.collection_send_helper import send_erc20_collect_transfer
from app.services.collection_send_guard import validate_collection_send_allowed
from app.services.collection_service import create_gas_task
from app.tasks import collection_tasks


TARGET = "0x8dbeed9e9f8e95af04f2d7aa551f156298afb68c"
HOT = "0x1111111111111111111111111111111111111111"
COLLECT = "0x2222222222222222222222222222222222222222"


@dataclass
class FakeEvaluation:
    should_collect: bool = True
    gas_required: bool = False
    min_collect_amount: Decimal = Decimal("0.01")
    reason: str = "GAS_BALANCE_SUFFICIENT"
    token_balance: Decimal = Decimal("12")
    native_balance: Decimal = Decimal("0.02")
    gas_topup_amount: Decimal = Decimal("0")
    required_native_balance: Decimal = Decimal("0.005")


@contextmanager
def patched(obj, name: str, value):
    old_value = getattr(obj, name)
    setattr(obj, name, value)
    try:
        yield
    finally:
        setattr(obj, name, old_value)


def make_session_factory():
    engine = create_engine("sqlite:///:memory:")
    CollectionBatch.__table__.create(engine)
    CollectionTask.__table__.create(engine)
    GasTask.__table__.create(engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE chains (
                    id INTEGER PRIMARY KEY,
                    chain_key VARCHAR(32) NOT NULL,
                    enabled INTEGER NOT NULL,
                    collection_address VARCHAR(128),
                    hot_wallet_address VARCHAR(128),
                    hot_wallet_private_key_encrypted TEXT,
                    collection_real_send_enabled INTEGER,
                    collection_max_single_gas_native NUMERIC,
                    collection_daily_gas_native_limit NUMERIC
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE assets (
                    id INTEGER PRIMARY KEY,
                    symbol VARCHAR(32) NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE asset_chains (
                    id INTEGER PRIMARY KEY,
                    asset_id INTEGER NOT NULL,
                    chain_id INTEGER NOT NULL,
                    enabled INTEGER NOT NULL,
                    collection_enabled INTEGER,
                    collection_real_send_enabled INTEGER,
                    contract_address VARCHAR(128),
                    decimals INTEGER,
                    collection_min_amount NUMERIC,
                    collection_max_single_amount NUMERIC,
                    collection_daily_amount_limit NUMERIC
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO chains (
                    id, chain_key, enabled, collection_address, hot_wallet_address,
                    hot_wallet_private_key_encrypted, collection_real_send_enabled,
                    collection_max_single_gas_native, collection_daily_gas_native_limit
                )
                VALUES (1, 'ethereum', 1, :collect, :hot, 'encrypted', 1, 0.02, 0.1)
                """
            ),
            {"collect": COLLECT, "hot": HOT},
        )
        conn.execute(text("INSERT INTO assets (id, symbol) VALUES (1, 'USDT'), (2, 'USDC')"))
        conn.execute(
            text(
                """
                INSERT INTO asset_chains (
                    id, asset_id, chain_id, enabled, collection_enabled,
                    collection_real_send_enabled, contract_address, decimals,
                    collection_min_amount, collection_max_single_amount, collection_daily_amount_limit
                )
                VALUES
                    (1, 1, 1, 1, 1, 1, '0x3333333333333333333333333333333333333333', 6, 0.01, 100000, 1000000),
                    (2, 2, 1, 1, 1, 0, '0x4444444444444444444444444444444444444444', 6, 0.01, 100000, 1000000)
                """
            )
        )
    return sessionmaker(bind=engine)


def add_batch(db, batch_id: int = 1):
    db.add(
        CollectionBatch(
            id=batch_id,
            batch_no=f"B{batch_id}",
            trigger_type="MANUAL",
            target_address=COLLECT,
            chain_key="ethereum",
            coin_symbol="USDT",
            status=CollectionBatchStatus.PENDING.value,
            total_tasks=0,
        )
    )


def add_collection_task(db, task_id: int, *, status: str, symbol: str = "USDT", gas_task_id: int | None = None):
    db.add(
        CollectionTask(
            id=task_id,
            task_no=f"CT{task_id}",
            batch_id=1,
            user_id=100,
            chain_key="ethereum",
            coin_symbol=symbol,
            asset_chain_id=1 if symbol == "USDT" else 2,
            from_address=TARGET,
            to_address=COLLECT,
            amount=Decimal("12"),
            status=status,
            gas_task_id=gas_task_id,
            retry_count=0,
            max_retry=3,
        )
    )


def add_gas_task(db, gas_id: int, *, status: str, collection_task_id: int | None = 29):
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
            tx_hash="0x" + "a" * 64 if status == GasTaskStatus.CONFIRMED.value else None,
            retry_count=0,
            max_retry=3,
            confirmed_at=datetime.utcnow() if status == GasTaskStatus.CONFIRMED.value else None,
        )
    )


def test_address_level_gas_task_reuse(Session):
    db = Session()
    try:
        add_gas_task(db, 17, status=GasTaskStatus.PENDING.value, collection_task_id=29)
        db.commit()
        gas_task = create_gas_task(
            db,
            collection_task_id=35,
            user_id=100,
            chain_key="ethereum",
            gas_coin_symbol="ETH",
            from_address=HOT,
            to_address=TARGET,
            topup_amount=Decimal("0.02"),
            target_balance=Decimal("0.02"),
            estimate_source="TEST",
        )
        assert int(gas_task.id) == 17, gas_task.id
        assert db.query(GasTask).count() == 1
    finally:
        db.close()


def test_gas_required_native_sufficient_does_not_create_gas(Session):
    db = Session()
    try:
        add_batch(db)
        add_collection_task(db, 29, status=CollectionTaskStatus.GAS_REQUIRED.value)
        db.commit()
    finally:
        db.close()

    sent_calls: list[int] = []

    def fake_send(**kwargs):
        sent_calls.append(1)
        return type(
            "SendResult",
            (),
            {
                "ok": True,
                "tx_hash": "DRYRUN_test",
                "dry_run": True,
                "error_message": None,
            },
        )()

    with patched(collection_tasks, "SessionLocal", Session), patched(
        collection_tasks,
        "confirm_collection_candidate_onchain",
        lambda **kwargs: FakeEvaluation(),
    ), patched(collection_tasks, "send_erc20_collect_transfer", fake_send), patched(
        collection_tasks,
        "enqueue_tx_confirm_collection_task",
        lambda *args, **kwargs: None,
    ):
        result = collection_tasks.process_collection_task(29, allow_real_send=False)

    db = Session()
    try:
        assert result["ok"] is True, result
        assert db.query(GasTask).count() == 0
        assert len(sent_calls) == 1
    finally:
        db.close()


def test_confirmed_gas_wakes_same_address_waiters(Session):
    db = Session()
    try:
        add_batch(db)
        add_gas_task(db, 17, status=GasTaskStatus.CONFIRMED.value, collection_task_id=29)
        add_collection_task(db, 29, status=CollectionTaskStatus.GAS_REQUIRED.value, symbol="USDT", gas_task_id=17)
        add_collection_task(db, 35, status=CollectionTaskStatus.GAS_REQUIRED.value, symbol="USDC", gas_task_id=25)
        db.commit()
    finally:
        db.close()

    enqueued: list[int] = []
    with patched(collection_tasks, "SessionLocal", Session), patched(
        collection_tasks,
        "confirm_collection_candidate_onchain",
        lambda **kwargs: FakeEvaluation(),
    ), patched(collection_tasks, "is_collection_task_job_active", lambda task_id: False), patched(
        collection_tasks,
        "enqueue_collection_task",
        lambda task_id, **kwargs: enqueued.append(int(task_id)) or f"job-{task_id}",
    ):
        result = collection_tasks.enqueue_collection_after_real_gas_confirmed(17)

    assert result["continued"] is True, result
    assert enqueued == [29, 35], enqueued


def test_disabled_asset_chain_guard_blocks_real_send(Session):
    db = Session()
    old_master = os.environ.get("COLLECTION_REAL_SEND_MASTER_SWITCH")
    os.environ["COLLECTION_REAL_SEND_MASTER_SWITCH"] = "true"
    try:
        guard = validate_collection_send_allowed(
            db=db,
            chain_key="ethereum",
            to_address=COLLECT,
            amount=Decimal("12"),
            coin_symbol="USDC",
            is_gas=False,
        )
        assert guard.allowed is False
        assert guard.reason == "ASSET_CHAIN_NOT_ALLOWED", guard
        send_result = send_erc20_collect_transfer(
            chain_key="ethereum",
            token_contract_address="0x4444444444444444444444444444444444444444",
            token_decimals=6,
            from_private_key="not-used-before-guard",
            from_address=TARGET,
            to_address=COLLECT,
            amount=Decimal("12"),
            coin_symbol="USDC",
            db=db,
        )
        assert send_result.ok is False
        assert send_result.raw_tx_created is False
        assert send_result.signed is False
        assert send_result.broadcasted is False
        assert send_result.error_message == "GUARD_REJECTED:ASSET_CHAIN_NOT_ALLOWED", send_result
    finally:
        if old_master is None:
            os.environ.pop("COLLECTION_REAL_SEND_MASTER_SWITCH", None)
        else:
            os.environ["COLLECTION_REAL_SEND_MASTER_SWITCH"] = old_master
        db.close()


def main():
    tests = [
        test_address_level_gas_task_reuse,
        test_gas_required_native_sufficient_does_not_create_gas,
        test_confirmed_gas_wakes_same_address_waiters,
        test_disabled_asset_chain_guard_blocks_real_send,
    ]
    for test in tests:
        Session = make_session_factory()
        test(Session)
        print(f"PASS {test.__name__}")


if __name__ == "__main__":
    main()
