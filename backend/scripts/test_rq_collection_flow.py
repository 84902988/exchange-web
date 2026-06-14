from __future__ import annotations

import os
import secrets
import sys
from decimal import Decimal


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.core.rq import QUEUE_COLLECTION, QUEUE_GAS, RQNotInstalledError, get_queue  # noqa: E402
from app.db.models.collection import GasTask  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_service import create_collection_batch, create_collection_task, create_gas_task  # noqa: E402
from app.tasks.collection_tasks import enqueue_collection_task, enqueue_gas_task, process_collection_task, process_gas_task  # noqa: E402


def _addr(prefix: str) -> str:
    return "0x" + (prefix + secrets.token_hex(20))[:40]


def _try_enqueue_collection(task_id: int) -> str:
    try:
        return enqueue_collection_task(task_id)
    except Exception as exc:
        return f"ENQUEUE_SKIPPED:{type(exc).__name__}"


def _try_enqueue_gas(task_id: int) -> str:
    try:
        return enqueue_gas_task(task_id)
    except Exception as exc:
        return f"ENQUEUE_SKIPPED:{type(exc).__name__}"


def main() -> None:
    db = SessionLocal()
    try:
        try:
            collection_queue_name = get_queue(QUEUE_COLLECTION).name
            gas_queue_name = get_queue(QUEUE_GAS).name
        except Exception:
            collection_queue_name = QUEUE_COLLECTION
            gas_queue_name = QUEUE_GAS

        target = _addr("aaaa")
        from_address = _addr("bbbb")
        gas_from = _addr("cccc")
        user_id = 910000 + secrets.randbelow(1000)

        batch = create_collection_batch(
            db,
            trigger_type="MANUAL",
            target_address=target,
            chain_key="bsc",
            coin_symbol="USDT",
            created_by=0,
        )
        task = create_collection_task(
            db,
            batch_id=batch.id,
            user_id=user_id,
            chain_key="bsc",
            coin_symbol="USDT",
            asset_chain_id=None,
            from_address=from_address,
            to_address=target,
            amount=Decimal("3.21"),
            reason="rq dry-run test",
        )
        gas = create_gas_task(
            db,
            collection_task_id=task.id,
            user_id=user_id,
            chain_key="bsc",
            gas_coin_symbol="BNB",
            from_address=gas_from,
            to_address=from_address,
            topup_amount=Decimal("0.001"),
            target_balance=Decimal("0.001"),
        )
        db.commit()

        collection_job_id = _try_enqueue_collection(task.id)
        gas_job_id = _try_enqueue_gas(gas.id)

        task_id = int(task.id)
        gas_id = int(gas.id)
        batch_id = int(batch.id)
        db.close()

        collection_result = process_collection_task(task_id)
        gas_result = process_gas_task(gas_id)

        db = SessionLocal()
        from app.db.models.collection import CollectionBatch, CollectionTask

        batch = db.query(CollectionBatch).filter(CollectionBatch.id == batch_id).first()
        task = db.query(CollectionTask).filter(CollectionTask.id == task_id).first()
        gas = db.query(GasTask).filter(GasTask.id == gas_id).first()

        print("rq_collection_flow_test")
        print(f"queues collection={collection_queue_name} gas={gas_queue_name}")
        print(f"enqueue collection_job_id={collection_job_id} gas_job_id={gas_job_id}")
        print(
            "collection "
            f"task_id={task.id} status={task.status} tx_hash={task.tx_hash} result={collection_result}"
        )
        print(f"gas task_id={gas.id} status={gas.status} tx_hash={gas.tx_hash} result={gas_result}")
        print(
            "batch "
            f"id={batch.id} status={batch.status} total={batch.total_tasks} "
            f"success={batch.success_tasks} failed={batch.failed_tasks} skipped={batch.skipped_tasks}"
        )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
