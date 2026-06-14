from __future__ import annotations

import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.dividend import DividendPool, UserDividendRecord  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


TEST_USER_ID = 5


TEST_RECORDS: list[dict[str, Any]] = [
    {
        "dividend_date": date(2026, 4, 26),
        "pool_status": "PAID",
        "record_status": "PAID",
        "level_code": "SVIP1",
        "total_fee_usdt": Decimal("1000"),
        "rcb_price_used": Decimal("1.000000000000000000"),
        "total_dividend_usdt": Decimal("50"),
        "total_dividend_rcb": Decimal("50"),
        "dividend_usdt": Decimal("12.340000000000000000"),
        "dividend_rcb": Decimal("12.340000000000000000"),
        "paid_at": datetime(2026, 4, 27, 0, 10, 0),
    },
    {
        "dividend_date": date(2026, 4, 27),
        "pool_status": "CALCULATED",
        "record_status": "PENDING",
        "level_code": "SVIP2",
        "total_fee_usdt": Decimal("2000"),
        "rcb_price_used": Decimal("1.000000000000000000"),
        "total_dividend_usdt": Decimal("100"),
        "total_dividend_rcb": Decimal("100"),
        "dividend_usdt": Decimal("23.450000000000000000"),
        "dividend_rcb": Decimal("23.450000000000000000"),
        "paid_at": None,
    },
    {
        "dividend_date": date(2026, 4, 28),
        "pool_status": "FAILED",
        "record_status": "FAILED",
        "level_code": "SVIP3",
        "total_fee_usdt": Decimal("3000"),
        "rcb_price_used": Decimal("1.000000000000000000"),
        "total_dividend_usdt": Decimal("150"),
        "total_dividend_rcb": Decimal("150"),
        "dividend_usdt": Decimal("34.560000000000000000"),
        "dividend_rcb": Decimal("34.560000000000000000"),
        "paid_at": None,
    },
]


def _get_or_create_pool(db, item: dict[str, Any], now: datetime) -> tuple[DividendPool, bool]:
    pool = (
        db.query(DividendPool)
        .filter(DividendPool.dividend_date == item["dividend_date"])
        .first()
    )
    if pool:
        return pool, False

    pool = DividendPool(
        dividend_date=item["dividend_date"],
        total_fee_usdt=item["total_fee_usdt"],
        rcb_price_used=item["rcb_price_used"],
        total_dividend_usdt=item["total_dividend_usdt"],
        total_dividend_rcb=item["total_dividend_rcb"],
        status=item["pool_status"],
        run_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(pool)
    db.flush()
    return pool, True


def _create_record_if_missing(db, pool: DividendPool, item: dict[str, Any], now: datetime) -> bool:
    exists = (
        db.query(UserDividendRecord.id)
        .filter(
            UserDividendRecord.pool_id == pool.id,
            UserDividendRecord.user_id == TEST_USER_ID,
        )
        .first()
    )
    if exists:
        return False

    record = UserDividendRecord(
        pool_id=pool.id,
        user_id=TEST_USER_ID,
        level_code=item["level_code"],
        dividend_usdt=item["dividend_usdt"],
        rcb_price_used=item["rcb_price_used"],
        dividend_rcb=item["dividend_rcb"],
        status=item["record_status"],
        paid_at=item["paid_at"],
        created_at=now,
        updated_at=now,
    )
    db.add(record)
    db.flush()
    return True


def seed_dividend_test_records() -> None:
    db = SessionLocal()
    now = datetime.utcnow()
    pool_inserted = 0
    pool_skipped = 0
    record_inserted = 0
    record_skipped = 0

    try:
        for item in TEST_RECORDS:
            pool, created_pool = _get_or_create_pool(db, item, now)
            created_record = _create_record_if_missing(db, pool, item, now)

            pool_inserted += int(created_pool)
            pool_skipped += int(not created_pool)
            record_inserted += int(created_record)
            record_skipped += int(not created_record)

            print(
                f"{item['dividend_date']} "
                f"pool={'inserted' if created_pool else 'skipped'} "
                f"record={'inserted' if created_record else 'skipped'} "
                f"status={item['record_status']}"
            )

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print(
        "Seeded dividend test records: "
        f"pools inserted={pool_inserted}, pools skipped={pool_skipped}, "
        f"records inserted={record_inserted}, records skipped={record_skipped}"
    )


if __name__ == "__main__":
    seed_dividend_test_records()
