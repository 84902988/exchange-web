from __future__ import annotations

import argparse
import json
import sys
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.models.dividend import DividendPool, DividendPoolItem, UserDividendRecord  # noqa: E402
from app.db.models.dividend_job_log import DividendJobLog  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services import dividend_service  # noqa: E402


SOURCE_POOL_ID = 60
SOURCE_DIVIDEND_DATE = date(2026, 6, 9)
COMPENSATION_STORAGE_DATE = date(26, 6, 9)
EXPECTED_TOTAL_FEE_USDT = Decimal("255.079896837368")
COMPENSATION_REMARK = "2026-06-09 fee omission compensation"
Q18 = Decimal("0.000000000000000001")
DIAGNOSTIC_TOLERANCE = Decimal("0.000000000001")


def _q18(value: Any) -> Decimal:
    return Decimal(str(value or "0")).quantize(Q18)


def _json_default(value: Any) -> str:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value)


def _print_startup_notice(*, dry_run: bool, distribute: bool) -> None:
    notice = {
        "safety_notice": "one-off dividend compensation script",
        "original_dividend_date": SOURCE_DIVIDEND_DATE,
        "stored_dividend_date": COMPENSATION_STORAGE_DATE,
        "source_pool_id": SOURCE_POOL_ID,
        "source_pool_will_be_modified": False,
        "default_distribution": False,
        "dry_run": dry_run,
        "requested_distribution": distribute,
        "remark": COMPENSATION_REMARK,
    }
    print(json.dumps(notice, ensure_ascii=False, indent=2, default=_json_default), flush=True)


def _rows(db, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return [dict(row) for row in db.execute(text(sql), params or {}).mappings().all()]


def _load_source_pool(db) -> DividendPool:
    pool = (
        db.query(DividendPool)
        .filter(DividendPool.id == SOURCE_POOL_ID)
        .with_for_update()
        .first()
    )
    if pool is None:
        raise RuntimeError(f"source dividend pool {SOURCE_POOL_ID} not found")
    if pool.dividend_date != SOURCE_DIVIDEND_DATE:
        raise RuntimeError(f"source pool date mismatch: {pool.dividend_date}")
    if str(pool.status or "").upper() != "PAID":
        raise RuntimeError(f"source pool status must be PAID, got {pool.status}")
    if _q18(pool.total_fee_usdt) != Decimal("0").quantize(Q18):
        raise RuntimeError(f"source pool total_fee_usdt must be 0, got {pool.total_fee_usdt}")
    return pool


def _load_compensation_pool(db) -> DividendPool | None:
    return (
        db.query(DividendPool)
        .filter(DividendPool.dividend_date == COMPENSATION_STORAGE_DATE)
        .with_for_update()
        .first()
    )


def _assert_storage_date_available(db) -> None:
    existing = _load_compensation_pool(db)
    if existing is not None:
        raise RuntimeError(
            "compensation storage date already has a pool: "
            f"pool_id={existing.id} date={COMPENSATION_STORAGE_DATE}"
        )


def _fee_credit_summary(db) -> list[dict[str, Any]]:
    return _rows(
        db,
        """
        SELECT UPPER(COALESCE(coin_symbol, '')) AS coin_symbol,
               COUNT(*) AS fee_log_count,
               COALESCE(SUM(change_amount), 0) AS fee_amount
        FROM balance_logs
        WHERE user_id = 99999999
          AND change_type = 'TRADE_FEE_CREDIT'
          AND created_at >= :start_at
          AND created_at < DATE_ADD(:start_at, INTERVAL 1 DAY)
        GROUP BY UPPER(COALESCE(coin_symbol, ''))
        ORDER BY coin_symbol ASC
        """,
        {"start_at": SOURCE_DIVIDEND_DATE},
    )


def _assert_diagnostic_amount(db, rcb_price: Decimal) -> Decimal:
    calculated = dividend_service.calculate_total_fee_usdt(db, SOURCE_DIVIDEND_DATE, rcb_price)
    if abs(calculated - EXPECTED_TOTAL_FEE_USDT) > DIAGNOSTIC_TOLERANCE:
        raise RuntimeError(
            "diagnostic total_fee_usdt mismatch: "
            f"expected={EXPECTED_TOTAL_FEE_USDT} calculated={calculated}"
        )
    return calculated


@contextmanager
def _compensation_calculation_patch() -> Iterator[None]:
    original_total_fee = dividend_service.calculate_total_fee_usdt
    original_svip_users = dividend_service._load_eligible_svip_users

    def calculate_total_fee_usdt_patch(db, dividend_date, rcb_price=None):
        if dividend_date == COMPENSATION_STORAGE_DATE:
            return _q18(EXPECTED_TOTAL_FEE_USDT)
        return original_total_fee(db, dividend_date, rcb_price)

    def load_eligible_svip_users_patch(db, dividend_date):
        if dividend_date == COMPENSATION_STORAGE_DATE:
            return original_svip_users(db, SOURCE_DIVIDEND_DATE)
        return original_svip_users(db, dividend_date)

    dividend_service.calculate_total_fee_usdt = calculate_total_fee_usdt_patch
    dividend_service._load_eligible_svip_users = load_eligible_svip_users_patch
    try:
        yield
    finally:
        dividend_service.calculate_total_fee_usdt = original_total_fee
        dividend_service._load_eligible_svip_users = original_svip_users


def _create_pool(db, source_pool: DividendPool) -> DividendPool:
    now = datetime.utcnow()
    pool = DividendPool(
        dividend_date=COMPENSATION_STORAGE_DATE,
        total_fee_usdt=_q18(EXPECTED_TOTAL_FEE_USDT),
        rcb_price_used=_q18(source_pool.rcb_price_used),
        total_dividend_usdt=_q18(Decimal("0")),
        total_dividend_rcb=_q18(Decimal("0")),
        status="PENDING",
        run_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(pool)
    db.flush()
    db.add(
        DividendJobLog(
            dividend_date=SOURCE_DIVIDEND_DATE,
            run_time=now,
            trigger_type="MANUAL",
            status="CREATED",
            step="COMPENSATION_CREATE",
            pool_id=int(pool.id),
            message=COMPENSATION_REMARK,
            created_at=now,
        )
    )
    db.flush()
    return pool


def _pool_result(db, pool: DividendPool, *, diagnostic_total: Decimal) -> dict[str, Any]:
    user_count = int(
        db.query(UserDividendRecord.user_id)
        .filter(UserDividendRecord.pool_id == int(pool.id))
        .distinct()
        .count()
    )
    item_count = int(
        db.query(DividendPoolItem.id)
        .filter(DividendPoolItem.pool_id == int(pool.id))
        .count()
    )
    total_rcb = _q18(pool.total_dividend_rcb)
    total_usdt = _q18(pool.total_dividend_usdt)
    return {
        "source_pool_id": SOURCE_POOL_ID,
        "original_dividend_date": SOURCE_DIVIDEND_DATE,
        "compensation_pool_id": int(pool.id),
        "stored_dividend_date": COMPENSATION_STORAGE_DATE,
        "remark": COMPENSATION_REMARK,
        "status": pool.status,
        "total_fee_usdt": _q18(pool.total_fee_usdt),
        "diagnostic_expected_total_fee_usdt": _q18(diagnostic_total),
        "matches_diagnostic": abs(_q18(pool.total_fee_usdt) - _q18(diagnostic_total)) <= DIAGNOSTIC_TOLERANCE,
        "svip_eligibility_date": SOURCE_DIVIDEND_DATE,
        "level_item_count": item_count,
        "user_count": user_count,
        "total_dividend_usdt": total_usdt,
        "total_rcb": total_rcb,
        "trade_fee_credit_by_coin": _fee_credit_summary(db),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create the one-off 2026-06-09 dividend compensation pool."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run creation/calculation in a transaction and roll it back.",
    )
    parser.add_argument(
        "--confirm-create",
        action="store_true",
        help="Required for real writes. Not required with --dry-run.",
    )
    parser.add_argument(
        "--distribute",
        action="store_true",
        help="Also distribute after calculation. Off by default.",
    )
    parser.add_argument(
        "--confirm-distribute",
        action="store_true",
        help="Required together with --distribute to prevent accidental payout.",
    )
    args = parser.parse_args()

    _print_startup_notice(dry_run=bool(args.dry_run), distribute=bool(args.distribute))

    if not args.dry_run and not args.confirm_create and not (args.distribute and args.confirm_distribute):
        raise RuntimeError("--confirm-create is required unless --dry-run is used")
    if args.distribute and not args.confirm_distribute:
        raise RuntimeError("--distribute requires --confirm-distribute")

    db = SessionLocal()
    try:
        source_pool = _load_source_pool(db)
        diagnostic_total = _assert_diagnostic_amount(db, _q18(source_pool.rcb_price_used))
        existing_pool = _load_compensation_pool(db)
        if existing_pool is not None:
            if not args.distribute:
                raise RuntimeError(
                    "compensation pool already exists: "
                    f"pool_id={existing_pool.id} date={COMPENSATION_STORAGE_DATE}"
                )
            pool = existing_pool
        else:
            _assert_storage_date_available(db)
            pool = _create_pool(db, source_pool)
        with _compensation_calculation_patch():
            if str(pool.status or "").upper() == "PENDING":
                pool = dividend_service.calculate_dividend_pool(db, int(pool.id))
                db.flush()
                db.refresh(pool)
            if args.distribute:
                pool = dividend_service.distribute_dividend_pool(db, int(pool.id))
                db.flush()
                db.refresh(pool)

        result = _pool_result(db, pool, diagnostic_total=diagnostic_total)
        result["dry_run"] = bool(args.dry_run)
        result["distributed"] = bool(args.distribute)
        if args.dry_run:
            db.rollback()
            result["transaction"] = "rolled_back"
        else:
            db.commit()
            result["transaction"] = "committed"
        print(json.dumps(result, ensure_ascii=False, indent=2, default=_json_default))
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
