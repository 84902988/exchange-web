from __future__ import annotations

import os
import secrets
import sys
from decimal import Decimal


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_service import (  # noqa: E402
    create_collection_batch,
    create_collection_task,
    create_gas_task,
    list_pending_collection_tasks,
    list_pending_gas_tasks,
    mark_collection_task_confirmed,
    mark_collection_task_queued,
    mark_collection_task_sending,
    mark_collection_task_sent,
)


def _test_address(prefix: str) -> str:
    return "0x" + (prefix + secrets.token_hex(20))[:40]


def main() -> None:
    db = SessionLocal()
    try:
        user_id = 900000 + secrets.randbelow(9999)
        chain_key = "bsc"
        coin_symbol = "USDT"
        amount = Decimal("12.345")
        from_address = _test_address("1111")
        to_address = _test_address("2222")
        gas_from_address = _test_address("3333")

        batch = create_collection_batch(
            db,
            trigger_type="MANUAL",
            target_address=to_address,
            chain_key=chain_key,
            coin_symbol=coin_symbol,
            created_by=0,
        )

        task = create_collection_task(
            db,
            batch_id=batch.id,
            user_id=user_id,
            chain_key=chain_key,
            coin_symbol=coin_symbol,
            asset_chain_id=None,
            from_address=from_address,
            to_address=to_address,
            amount=amount,
            reason="local collection service db test",
        )
        duplicate_task = create_collection_task(
            db,
            batch_id=batch.id,
            user_id=user_id,
            chain_key=chain_key,
            coin_symbol=coin_symbol,
            asset_chain_id=None,
            from_address=from_address,
            to_address=to_address,
            amount=amount,
            reason="local collection service db test duplicate",
        )

        gas_task = create_gas_task(
            db,
            collection_task_id=task.id,
            user_id=user_id,
            chain_key=chain_key,
            gas_coin_symbol="BNB",
            from_address=gas_from_address,
            to_address=from_address,
            topup_amount=Decimal("0.01"),
            target_balance=Decimal("0.01"),
        )
        duplicate_gas_task = create_gas_task(
            db,
            collection_task_id=task.id,
            user_id=user_id,
            chain_key=chain_key,
            gas_coin_symbol="BNB",
            from_address=gas_from_address,
            to_address=from_address,
            topup_amount=Decimal("0.01"),
            target_balance=Decimal("0.01"),
        )

        pending_collection_count = len(list_pending_collection_tasks(db, limit=10))
        pending_gas_count = len(list_pending_gas_tasks(db, limit=10))

        mark_collection_task_queued(db, task.id)
        mark_collection_task_sending(db, task.id)
        mark_collection_task_sent(db, task.id, "0x" + secrets.token_hex(32))
        mark_collection_task_confirmed(db, task.id, block_number=123456789)

        db.commit()
        db.refresh(batch)
        db.refresh(task)
        db.refresh(gas_task)

        print("collection_service_db_test")
        print(f"batch id={batch.id} batch_no={batch.batch_no} status={batch.status}")
        print(
            "batch_stats "
            f"total_tasks={batch.total_tasks} success_tasks={batch.success_tasks} "
            f"failed_tasks={batch.failed_tasks} skipped_tasks={batch.skipped_tasks} "
            f"total_amount={batch.total_amount} success_amount={batch.success_amount}"
        )
        print(
            "collection_task "
            f"id={task.id} duplicate_id={duplicate_task.id} "
            f"idempotent={task.id == duplicate_task.id} status={task.status} tx_hash_set={bool(task.tx_hash)}"
        )
        print(
            "gas_task "
            f"id={gas_task.id} duplicate_id={duplicate_gas_task.id} "
            f"idempotent={gas_task.id == duplicate_gas_task.id} status={gas_task.status}"
        )
        print(f"pending_before_flow collection={pending_collection_count} gas={pending_gas_count}")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
