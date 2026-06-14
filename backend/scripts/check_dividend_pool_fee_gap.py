from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.session import SessionLocal  # noqa: E402
from app.services.dividend_service import calculate_total_fee_usdt  # noqa: E402
from app.services.rcb_price_service import get_rcb_price_usdt  # noqa: E402


def _json_default(value: Any) -> str:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value)


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(str(value or "").strip())
    except ValueError as exc:
        raise argparse.ArgumentTypeError("dividend_date must be YYYY-MM-DD") from exc


def _rows(db, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(row) for row in db.execute(text(sql), params).mappings().all()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only dividend pool fee gap diagnostic.")
    parser.add_argument("dividend_date", type=_parse_date, help="Dividend date, e.g. 2026-06-09")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        pool_rows = _rows(
            db,
            """
            SELECT id, dividend_date, total_fee_usdt, rcb_price_used, status, created_at, updated_at
            FROM dividend_pools
            WHERE dividend_date = :dividend_date
            ORDER BY id ASC
            """,
            {"dividend_date": args.dividend_date},
        )
        pool = pool_rows[0] if pool_rows else None
        rcb_price = Decimal(str((pool or {}).get("rcb_price_used") or 0))
        if rcb_price <= Decimal("0"):
            rcb_price = get_rcb_price_usdt(db)

        expected_total_fee_usdt = calculate_total_fee_usdt(db, args.dividend_date, rcb_price)
        current_total_fee_usdt = Decimal(str((pool or {}).get("total_fee_usdt") or 0))
        gap = expected_total_fee_usdt - current_total_fee_usdt

        credit_rows = _rows(
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
            {"start_at": args.dividend_date},
        )
        credit_total_count = sum(int(row.get("fee_log_count") or 0) for row in credit_rows)

        result = {
            "dividend_date": args.dividend_date,
            "pool": pool,
            "rcb_price_used_for_check": rcb_price,
            "current_total_fee_usdt": current_total_fee_usdt,
            "expected_total_fee_usdt": expected_total_fee_usdt,
            "gap_usdt": gap,
            "trade_fee_credit_log_count": credit_total_count,
            "trade_fee_credit_by_coin": credit_rows,
            "note": "",
        }
        if pool and str(pool.get("status") or "").upper() == "PAID" and gap != Decimal("0"):
            result["note"] = "已支付池不可自动覆盖，请走人工补偿/重建方案"
        elif not pool:
            result["note"] = "未找到分红池，可按已结束日期正常创建"

        print(json.dumps(result, ensure_ascii=False, indent=2, default=_json_default))
    finally:
        db.rollback()
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
