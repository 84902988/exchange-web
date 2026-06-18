from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.core_archive import CoreArchiveBatch
from app.db.session import SessionLocal


TERMINAL_ORDER_STATUSES = ("FILLED", "CANCELED", "FAILED")
SUPPORTED_STATUSES = {"DRY_RUN", "COPYING", "COPIED", "VERIFYING", "VERIFIED", "FAILED", "CANCELED"}
FORBIDDEN_STATUSES = {"MIGRATING_OUT", "COMPLETED"}


@dataclass(frozen=True)
class ArchiveSpec:
    source_table: str
    archive_table: str
    source_alias: str
    source_from_sql: str
    eligibility_sql: str
    source_columns: tuple[str, ...]
    sum_columns: tuple[str, ...]


ORDER_COLUMNS = (
    "id",
    "order_no",
    "user_id",
    "trading_pair_id",
    "side",
    "order_type",
    "execution_mode",
    "price",
    "amount",
    "filled_amount",
    "avg_price",
    "frozen_amount",
    "executed_quote_amount",
    "fee_amount",
    "fee_asset_symbol",
    "fee_asset_id",
    "status",
    "source",
    "created_at",
    "updated_at",
)

TRADE_COLUMNS = (
    "id",
    "trading_pair_id",
    "buy_order_id",
    "sell_order_id",
    "buyer_user_id",
    "seller_user_id",
    "price",
    "amount",
    "quote_amount",
    "fee_amount",
    "fee_asset_symbol",
    "buyer_fee_amount",
    "buyer_fee_asset_symbol",
    "seller_fee_amount",
    "seller_fee_asset_symbol",
    "dealer_ref_price",
    "dealer_best_bid",
    "dealer_best_ask",
    "dealer_price_source",
    "dealer_spread_bps",
    "maker_order_id",
    "taker_order_id",
    "counterparty_type",
    "created_at",
)

SPECS: dict[str, ArchiveSpec] = {
    "orders": ArchiveSpec(
        source_table="orders",
        archive_table="archive_orders",
        source_alias="o",
        source_from_sql="orders o",
        eligibility_sql=(
            "o.created_at >= :period_start AND o.created_at < :period_end "
            "AND o.status IN ('FILLED', 'CANCELED', 'FAILED')"
        ),
        source_columns=ORDER_COLUMNS,
        sum_columns=("amount", "filled_amount", "frozen_amount", "executed_quote_amount", "fee_amount"),
    ),
    "trades": ArchiveSpec(
        source_table="trades",
        archive_table="archive_trades",
        source_alias="t",
        source_from_sql=(
            "trades t "
            "JOIN orders bo ON bo.id = t.buy_order_id "
            "JOIN orders so ON so.id = t.sell_order_id"
        ),
        eligibility_sql=(
            "t.created_at >= :period_start AND t.created_at < :period_end "
            "AND bo.status IN ('FILLED', 'CANCELED', 'FAILED') "
            "AND so.status IN ('FILLED', 'CANCELED', 'FAILED')"
        ),
        source_columns=TRADE_COLUMNS,
        sum_columns=("amount", "quote_amount", "fee_amount", "buyer_fee_amount", "seller_fee_amount"),
    ),
}


def _json_default(value: Any) -> str:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return str(value)


def _parse_month(month: str) -> tuple[str, datetime, datetime]:
    try:
        start = datetime.strptime(str(month or "").strip(), "%Y-%m")
    except ValueError as exc:
        raise ValueError("month must use YYYY-MM format, for example 2026-03") from exc
    if start.month == 12:
        end = datetime(start.year + 1, 1, 1)
    else:
        end = datetime(start.year, start.month + 1, 1)
    return start.strftime("%Y-%m"), start, end


def _batch_id(table: str, month: str, explicit: str | None = None) -> str:
    value = str(explicit or "").strip()
    if value:
        return value
    return f"core_archive_{table}_{month.replace('-', '')}"


def _params(period_start: datetime, period_end: datetime) -> dict[str, Any]:
    return {"period_start": period_start, "period_end": period_end}


def _fetch_one(db: Session, sql: str, params: dict[str, Any]) -> dict[str, Any]:
    row = db.execute(text(sql), params).mappings().first()
    return dict(row or {})


def _fetch_all(db: Session, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(row) for row in db.execute(text(sql), params).mappings().all()]


def _sum_sql(spec: ArchiveSpec, alias: str) -> str:
    parts = [f"COALESCE(SUM({alias}.{column}), 0) AS sum_{column}" for column in spec.sum_columns]
    parts.append(f"COALESCE(SUM({alias}.id), 0) AS checksum_id_sum")
    return ", ".join(parts)


def _source_stats(db: Session, spec: ArchiveSpec, period_start: datetime, period_end: datetime) -> dict[str, Any]:
    alias = spec.source_alias
    sql = f"""
        SELECT
          COUNT(*) AS source_count,
          MIN({alias}.id) AS min_id,
          MAX({alias}.id) AS max_id,
          {_sum_sql(spec, alias)}
        FROM {spec.source_from_sql}
        WHERE {spec.eligibility_sql}
    """
    return _fetch_one(db, sql, _params(period_start, period_end))


def _archive_stats(db: Session, spec: ArchiveSpec, batch_id: str) -> dict[str, Any]:
    alias = "a"
    sql = f"""
        SELECT
          COUNT(*) AS copied_count,
          MIN({alias}.id) AS min_id,
          MAX({alias}.id) AS max_id,
          {_sum_sql(spec, alias)}
        FROM {spec.archive_table} {alias}
        WHERE {alias}.archive_batch_id = :batch_id
    """
    return _fetch_one(db, sql, {"batch_id": batch_id})


def _stats_payload(stats: dict[str, Any], spec: ArchiveSpec) -> tuple[dict[str, Any], dict[str, Any]]:
    sums = {column: stats.get(f"sum_{column}") for column in spec.sum_columns}
    checksum = {"id_sum": stats.get("checksum_id_sum")}
    return checksum, sums


def _dry_run(db: Session, table: str, month: str) -> dict[str, Any]:
    spec = SPECS[table]
    archive_month, period_start, period_end = _parse_month(month)
    stats = _source_stats(db, spec, period_start, period_end)
    checksum, sums = _stats_payload(stats, spec)
    return {
        "mode": "DRY_RUN",
        "dry_run": True,
        "source_table": spec.source_table,
        "archive_table": spec.archive_table,
        "archive_month": archive_month,
        "period_start": period_start,
        "period_end": period_end,
        "source_count": int(stats.get("source_count") or 0),
        "min_id": stats.get("min_id"),
        "max_id": stats.get("max_id"),
        "checksum": checksum,
        "sums": sums,
        "deleted_count": 0,
    }


def _get_or_create_batch(
    db: Session,
    *,
    spec: ArchiveSpec,
    batch_id: str,
    archive_month: str,
    period_start: datetime,
    period_end: datetime,
    created_by: str,
) -> CoreArchiveBatch:
    batch = db.query(CoreArchiveBatch).filter(CoreArchiveBatch.batch_id == batch_id).first()
    if batch is not None:
        if batch.source_table != spec.source_table or batch.archive_table != spec.archive_table:
            raise ValueError(f"batch_id {batch_id} belongs to another table")
        return batch
    now = datetime.utcnow()
    batch = CoreArchiveBatch(
        batch_id=batch_id,
        source_table=spec.source_table,
        archive_table=spec.archive_table,
        archive_month=archive_month,
        period_start=period_start,
        period_end=period_end,
        status="COPYING",
        dry_run=False,
        deleted_count=0,
        started_at=now,
        created_by=created_by or "manual",
        created_at=now,
        updated_at=now,
    )
    db.add(batch)
    db.commit()
    return batch


def _copy_only(db: Session, table: str, month: str, batch_id_value: str | None, created_by: str) -> dict[str, Any]:
    spec = SPECS[table]
    archive_month, period_start, period_end = _parse_month(month)
    batch_id = _batch_id(table, archive_month, batch_id_value)
    batch = _get_or_create_batch(
        db,
        spec=spec,
        batch_id=batch_id,
        archive_month=archive_month,
        period_start=period_start,
        period_end=period_end,
        created_by=created_by,
    )
    if batch.status in FORBIDDEN_STATUSES:
        raise ValueError(f"forbidden archive batch status: {batch.status}")
    was_verified = batch.status == "VERIFIED"

    started_at = datetime.utcnow()
    if not was_verified:
        batch.status = "COPYING"
    batch.dry_run = False
    batch.deleted_count = 0
    batch.started_at = batch.started_at or started_at
    batch.error_message = None
    batch.updated_at = started_at
    db.commit()

    source_stats = _source_stats(db, spec, period_start, period_end)
    checksum, sums = _stats_payload(source_stats, spec)
    source_columns = ", ".join(spec.source_columns)
    select_columns = ", ".join(f"{spec.source_alias}.{column}" for column in spec.source_columns)
    sql = f"""
        INSERT IGNORE INTO {spec.archive_table}
          ({source_columns}, archive_month, archive_batch_id, archived_at)
        SELECT
          {select_columns}, :archive_month, :batch_id, :archived_at
        FROM {spec.source_from_sql}
        WHERE {spec.eligibility_sql}
    """
    db.execute(
        text(sql),
        {
            **_params(period_start, period_end),
            "archive_month": archive_month,
            "batch_id": batch_id,
            "archived_at": datetime.utcnow(),
        },
    )
    db.commit()

    archive_stats = _archive_stats(db, spec, batch_id)
    finished_at = datetime.utcnow()
    batch.status = "VERIFIED" if was_verified else "COPIED"
    batch.source_count = int(source_stats.get("source_count") or 0)
    batch.copied_count = int(archive_stats.get("copied_count") or 0)
    batch.verified_count = batch.copied_count if was_verified else 0
    batch.deleted_count = 0
    batch.min_id = source_stats.get("min_id")
    batch.max_id = source_stats.get("max_id")
    batch.checksum_json = json.dumps(checksum, ensure_ascii=False, default=_json_default)
    batch.sum_json = json.dumps(sums, ensure_ascii=False, default=_json_default)
    batch.finished_at = finished_at
    batch.updated_at = finished_at
    db.commit()

    return {
        "mode": "COPY_ONLY",
        "batch_id": batch_id,
        "source_table": spec.source_table,
        "archive_table": spec.archive_table,
        "archive_month": archive_month,
        "source_count": batch.source_count,
        "copied_count": batch.copied_count,
        "verified_count": batch.verified_count,
        "deleted_count": batch.deleted_count,
        "status": batch.status,
        "checksum": checksum,
        "sums": sums,
    }


def _normalize_compare(value: Any) -> str:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return "" if value is None else str(value)


def _sample_mismatches(db: Session, spec: ArchiveSpec, batch_id: str) -> list[dict[str, Any]]:
    ids = [
        row["id"]
        for row in _fetch_all(
            db,
            f"SELECT id FROM {spec.archive_table} WHERE archive_batch_id = :batch_id ORDER BY RAND() LIMIT 10",
            {"batch_id": batch_id},
        )
    ]
    mismatches: list[dict[str, Any]] = []
    if not ids:
        return mismatches
    columns = ", ".join(spec.source_columns)
    for row_id in ids:
        source = _fetch_one(db, f"SELECT {columns} FROM {spec.source_table} WHERE id = :id", {"id": row_id})
        archive = _fetch_one(
            db,
            f"SELECT {columns} FROM {spec.archive_table} WHERE id = :id AND archive_batch_id = :batch_id",
            {"id": row_id, "batch_id": batch_id},
        )
        for column in spec.source_columns:
            if _normalize_compare(source.get(column)) != _normalize_compare(archive.get(column)):
                mismatches.append(
                    {
                        "id": row_id,
                        "column": column,
                        "source": _normalize_compare(source.get(column)),
                        "archive": _normalize_compare(archive.get(column)),
                    }
                )
                break
    return mismatches


def _verify(db: Session, batch_id: str) -> dict[str, Any]:
    batch = db.query(CoreArchiveBatch).filter(CoreArchiveBatch.batch_id == batch_id).first()
    if batch is None:
        raise ValueError(f"batch not found: {batch_id}")
    if batch.source_table not in SPECS:
        raise ValueError(f"unsupported source table: {batch.source_table}")
    if batch.status in FORBIDDEN_STATUSES:
        raise ValueError(f"forbidden archive batch status: {batch.status}")

    spec = SPECS[batch.source_table]
    started_at = datetime.utcnow()
    batch.status = "VERIFYING"
    batch.updated_at = started_at
    batch.deleted_count = 0
    db.commit()

    source_stats = _source_stats(db, spec, batch.period_start, batch.period_end)
    archive_stats = _archive_stats(db, spec, batch_id)
    source_checksum, source_sums = _stats_payload(source_stats, spec)
    archive_checksum, archive_sums = _stats_payload(archive_stats, spec)
    mismatches = _sample_mismatches(db, spec, batch_id)

    checks = {
        "count": int(source_stats.get("source_count") or 0) == int(archive_stats.get("copied_count") or 0),
        "min_id": source_stats.get("min_id") == archive_stats.get("min_id"),
        "max_id": source_stats.get("max_id") == archive_stats.get("max_id"),
        "checksum": source_checksum == archive_checksum,
        "sums": source_sums == archive_sums,
        "sample": not mismatches,
    }
    ok = all(checks.values())
    finished_at = datetime.utcnow()
    batch.status = "VERIFIED" if ok else "FAILED"
    batch.source_count = int(source_stats.get("source_count") or 0)
    batch.copied_count = int(archive_stats.get("copied_count") or 0)
    batch.verified_count = int(archive_stats.get("copied_count") or 0) if ok else 0
    batch.deleted_count = 0
    batch.min_id = source_stats.get("min_id")
    batch.max_id = source_stats.get("max_id")
    batch.checksum_json = json.dumps({"source": source_checksum, "archive": archive_checksum}, ensure_ascii=False, default=_json_default)
    batch.sum_json = json.dumps({"source": source_sums, "archive": archive_sums}, ensure_ascii=False, default=_json_default)
    batch.error_message = "" if ok else json.dumps({"checks": checks, "mismatches": mismatches[:10]}, ensure_ascii=False, default=_json_default)
    batch.finished_at = finished_at
    batch.updated_at = finished_at
    db.commit()

    return {
        "mode": "VERIFY",
        "batch_id": batch_id,
        "ok": ok,
        "status": batch.status,
        "checks": checks,
        "source_count": batch.source_count,
        "copied_count": batch.copied_count,
        "verified_count": batch.verified_count,
        "deleted_count": batch.deleted_count,
        "source_checksum": source_checksum,
        "archive_checksum": archive_checksum,
        "source_sums": source_sums,
        "archive_sums": archive_sums,
        "sample_mismatches": mismatches[:10],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Core ledger archive V2 pilot. Copy-only; no hot-table migrate-out.")
    parser.add_argument("--table", choices=sorted(SPECS), help="Source table to archive.")
    parser.add_argument("--month", help="Archive month in YYYY-MM format.")
    parser.add_argument("--batch-id", default="", help="Archive batch ID. Required for --verify; optional for --copy-only.")
    parser.add_argument("--created-by", default="manual", help="Operator label for copy-only batch rows.")
    parser.add_argument("--dry-run", action="store_true", help="Read-only eligibility preview.")
    parser.add_argument("--copy-only", action="store_true", help="Copy eligible rows into archive table; never delete hot rows.")
    parser.add_argument("--verify", action="store_true", help="Verify an existing archive batch.")
    args = parser.parse_args()

    selected_modes = sum(bool(item) for item in (args.dry_run, args.copy_only, args.verify))
    if selected_modes == 0:
        args.dry_run = True
        selected_modes = 1
    if selected_modes != 1:
        print("Choose exactly one mode: --dry-run, --copy-only, or --verify.", file=sys.stderr)
        return 2
    if args.verify:
        if not str(args.batch_id or "").strip():
            print("--verify requires --batch-id.", file=sys.stderr)
            return 2
    else:
        if not args.table or not args.month:
            print("--dry-run and --copy-only require --table and --month.", file=sys.stderr)
            return 2

    db = SessionLocal()
    try:
        if args.verify:
            result = _verify(db, str(args.batch_id).strip())
        elif args.copy_only:
            result = _copy_only(db, args.table, args.month, args.batch_id, args.created_by)
        else:
            result = _dry_run(db, args.table, args.month)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=_json_default))
        return 0
    except Exception as exc:
        db.rollback()
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2, default=_json_default), file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
