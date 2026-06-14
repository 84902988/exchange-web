from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Iterable


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.user_rcb_lock import UserRcbLock  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.vip_service import calculate_user_vip_snapshot  # noqa: E402


USER_ID = 100000029
RCB_SYMBOL = "RCB"
TARGET_LOCK_DAYS = 1095


def _fmt_decimal(value: Decimal | None) -> str:
    if value is None:
        return "0"
    return format(Decimal(str(value)), "f")


def _fmt_datetime(value: datetime | None) -> str:
    return value.isoformat(sep=" ") if value is not None else "-"


def _print_locks(title: str, locks: Iterable[UserRcbLock]) -> None:
    print(title)
    print("id | amount | lock_period_days | end_time")
    print("---|--------|------------------|---------")
    for lock in locks:
        print(
            f"{lock.id} | "
            f"{_fmt_decimal(lock.lock_amount)} | "
            f"{int(lock.lock_period_days or 0)} | "
            f"{_fmt_datetime(lock.end_time)}"
        )
    print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="One-time repair for user 100000029 RCB lock period before LP snapshot recalculation.",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Persist the repair. Without this flag the script runs as dry-run and rolls back.",
    )
    args = parser.parse_args()

    now = datetime.utcnow()
    renewed_end_time = now + timedelta(days=TARGET_LOCK_DAYS)

    with SessionLocal() as db:
        locks = (
            db.query(UserRcbLock)
            .filter(UserRcbLock.user_id == USER_ID)
            .filter(UserRcbLock.asset_symbol == RCB_SYMBOL)
            .filter(UserRcbLock.status == "LOCKED")
            .filter(UserRcbLock.end_time >= now)
            .order_by(UserRcbLock.id.asc())
            .with_for_update()
            .all()
        )

        _print_locks("Before repair:", locks)

        if not locks:
            print(f"No active LOCKED {RCB_SYMBOL} locks found for user_id={USER_ID}.")
            db.rollback()
            return 1

        for lock in locks:
            lock.lock_period_days = TARGET_LOCK_DAYS
            lock.end_time = renewed_end_time
            lock.updated_at = now

        db.flush()
        snapshot = calculate_user_vip_snapshot(db, user_id=USER_ID)
        db.flush()

        _print_locks("After repair:", locks)
        print("Snapshot after repair:")
        print(f"svip_level_code: {snapshot.svip_level_code}")
        print(f"effective_level_code: {snapshot.effective_level_code}")
        print(f"rcb_locked: {_fmt_decimal(snapshot.rcb_locked)}")
        print()

        if args.commit:
            db.commit()
            print("Committed repair.")
        else:
            db.rollback()
            print("Dry-run only. Rolled back; run with --commit to persist.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
