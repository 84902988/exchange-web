from __future__ import annotations

import os
import secrets
import sys
from decimal import Decimal


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.models.collection import CollectionTask, GasTask  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_send_helper import is_collection_real_send_enabled  # noqa: E402
from app.services.collection_service import create_collection_batch, create_collection_task, create_gas_task  # noqa: E402
from app.tasks.collection_tasks import process_collection_task, process_gas_task  # noqa: E402


def _addr(prefix: str) -> str:
    return "0x" + (prefix + secrets.token_hex(20))[:40]


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    _assert(is_collection_real_send_enabled() is False, "test requires COLLECTION_ENABLE_REAL_SEND=false")

    db = SessionLocal()
    try:
        user_id = 930000 + secrets.randbelow(1000)
        target = _addr("aaaa")
        from_address = _addr("bbbb")
        gas_from = _addr("cccc")

        batch = create_collection_batch(
            db,
            trigger_type="MANUAL",
            target_address=target,
            chain_key="bsc",
            coin_symbol="USDT",
            created_by=0,
        )
        collection_task = create_collection_task(
            db,
            batch_id=batch.id,
            user_id=user_id,
            chain_key="bsc",
            coin_symbol="USDT",
            asset_chain_id=None,
            from_address=from_address,
            to_address=target,
            amount=Decimal("4.56"),
            reason="worker send helper dry-run test",
        )
        gas_task = create_gas_task(
            db,
            collection_task_id=collection_task.id,
            user_id=user_id,
            chain_key="bsc",
            gas_coin_symbol="BNB",
            from_address=gas_from,
            to_address=from_address,
            topup_amount=Decimal("0.001"),
            target_balance=Decimal("0.001"),
        )
        collection_task_id = int(collection_task.id)
        gas_task_id = int(gas_task.id)
        db.commit()
        db.close()

        collection_result = process_collection_task(collection_task_id)
        gas_result = process_gas_task(gas_task_id)

        db = SessionLocal()
        collection_task = db.query(CollectionTask).filter(CollectionTask.id == collection_task_id).first()
        gas_task = db.query(GasTask).filter(GasTask.id == gas_task_id).first()

        _assert(collection_task.status == "CONFIRMED", "collection task must be confirmed in dry-run")
        _assert(str(collection_task.tx_hash or "").startswith("DRYRUN_"), "collection tx hash must use DRYRUN_")
        _assert(gas_task.status == "CONFIRMED", "gas task must be confirmed in dry-run")
        _assert(str(gas_task.tx_hash or "").startswith("DRYGAS_"), "gas tx hash must use DRYGAS_")
        _assert(collection_result.get("dry_run") is True, "collection result must be dry-run")
        _assert(gas_result.get("dry_run") is True, "gas result must be dry-run")

        print("collection_worker_send_helper_dryrun_test")
        print(f"real_send_enabled={is_collection_real_send_enabled()}")
        print(f"collection status={collection_task.status} tx_hash={collection_task.tx_hash}")
        print(f"collection result={collection_result}")
        print(f"gas status={gas_task.status} tx_hash={gas_task.tx_hash}")
        print(f"gas result={gas_result}")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
