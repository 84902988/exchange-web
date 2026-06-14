from __future__ import annotations

import os
import secrets
import sys
from decimal import Decimal


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.models.collection import CollectionTask  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_service import (  # noqa: E402
    create_collection_batch,
    create_collection_task,
    create_gas_task,
    mark_collection_task_queued,
    mark_collection_task_sending,
    mark_collection_task_sent,
    mark_gas_task_queued,
    mark_gas_task_sending,
    mark_gas_task_sent,
)
from app.services.collection_tx_confirm_service import confirm_collection_task_tx, confirm_gas_task_tx  # noqa: E402
from app.tasks.collection_tasks import process_tx_confirm_collection_task, process_tx_confirm_gas_task  # noqa: E402


def _addr(prefix: str) -> str:
    return "0x" + (prefix + secrets.token_hex(20))[:40]


def main() -> None:
    db = SessionLocal()
    try:
        target = _addr("aaaa")
        from_address = _addr("bbbb")
        gas_from = _addr("cccc")
        user_id = 920000 + secrets.randbelow(1000)

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
            amount=Decimal("1.23"),
            reason="tx confirm dry-run test",
        )
        mark_collection_task_queued(db, collection_task.id)
        mark_collection_task_sending(db, collection_task.id)
        mark_collection_task_sent(db, collection_task.id, f"DRYRUN_{secrets.token_hex(16)}")

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
        mark_gas_task_queued(db, gas_task.id)
        mark_gas_task_sending(db, gas_task.id)
        mark_gas_task_sent(db, gas_task.id, f"DRYGAS_{secrets.token_hex(16)}")

        pending_task = create_collection_task(
            db,
            batch_id=batch.id,
            user_id=user_id,
            chain_key="bsc",
            coin_symbol="USDT",
            asset_chain_id=None,
            from_address=_addr("dddd"),
            to_address=target,
            amount=Decimal("2.34"),
            reason="tx confirm skip test",
        )
        db.flush()

        collection_result = confirm_collection_task_tx(db, collection_task.id)
        gas_result = confirm_gas_task_tx(db, gas_task.id)
        skipped_result = confirm_collection_task_tx(db, pending_task.id)
        db.commit()

        db.refresh(collection_task)
        db.refresh(gas_task)
        db.refresh(pending_task)

        wrapper_collection = process_tx_confirm_collection_task(collection_task.id)
        wrapper_gas = process_tx_confirm_gas_task(gas_task.id)

        print("collection_tx_confirm_test")
        print(f"collection_result={collection_result}")
        print(f"gas_result={gas_result}")
        print(f"skipped_result={skipped_result}")
        print(
            "final_status "
            f"collection={collection_task.status} gas={gas_task.status} skipped={pending_task.status}"
        )
        print(f"rq_wrapper collection={wrapper_collection}")
        print(f"rq_wrapper gas={wrapper_gas}")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
