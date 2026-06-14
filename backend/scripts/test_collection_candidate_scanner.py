from __future__ import annotations

import os
import sys
from decimal import Decimal


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.session import SessionLocal  # noqa: E402
from app.services.collection_candidate_scanner import scan_collection_candidates  # noqa: E402


TARGET_ADDRESS = "0x9999999999999999999999999999999999999999"


def _print_result(label: str, result) -> None:
    print(label)
    print(f"  total_addresses={result.total_addresses}")
    print(f"  evaluated_count={result.evaluated_count}")
    print(f"  collectible_count={result.collectible_count}")
    print(f"  gas_required_count={result.gas_required_count}")
    print(f"  skipped_count={result.skipped_count}")
    print(f"  created_task_count={result.created_task_count}")
    print(f"  created_gas_task_count={result.created_gas_task_count}")
    print(f"  batch_id={result.batch_id} batch_no={result.batch_no}")
    if getattr(result, "warnings", None):
        print(f"  warnings={'; '.join(result.warnings)}")
    if getattr(result, "error_message", None):
        print(f"  error_message={result.error_message}")


def main() -> None:
    db = SessionLocal()
    try:
        dry_run = scan_collection_candidates(
            db,
            chain_key=None,
            coin_symbol="USDT",
            target_address=TARGET_ADDRESS,
            dry_run=True,
            create_tasks=False,
            limit=100,
            mock_token_balance=Decimal("100"),
            mock_native_balance=Decimal("0.01"),
        )
        _print_result("dry_run", dry_run)

        create_once = scan_collection_candidates(
            db,
            chain_key=None,
            coin_symbol="USDT",
            target_address=TARGET_ADDRESS,
            dry_run=False,
            create_tasks=True,
            limit=100,
            mock_token_balance=Decimal("100"),
            mock_native_balance=Decimal("0"),
        )
        db.commit()
        _print_result("create_tasks_once", create_once)

        create_twice = scan_collection_candidates(
            db,
            chain_key=None,
            coin_symbol="USDT",
            target_address=TARGET_ADDRESS,
            dry_run=False,
            create_tasks=True,
            batch_id=create_once.batch_id,
            limit=100,
            mock_token_balance=Decimal("100"),
            mock_native_balance=Decimal("0"),
        )
        db.commit()
        _print_result("create_tasks_repeat", create_twice)

        print(
            "idempotency "
            f"task_repeat_created={create_twice.created_task_count} "
            f"gas_repeat_created={create_twice.created_gas_task_count}"
        )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
