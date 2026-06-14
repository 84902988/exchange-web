from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional

from dotenv import load_dotenv
from sqlalchemy import create_engine, text

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

load_dotenv(dotenv_path=BACKEND_DIR / ".env", override=False)

from app.core.config import settings  # noqa: E402
from app.services.evm_wallet import derive_evm_address_by_chain  # noqa: E402


def mask_address(address: Optional[str]) -> str:
    value = (address or "").strip()
    if len(value) <= 10:
        return value
    return f"{value[:6]}...{value[-4:]}"


def _get_columns(conn, table_name: str) -> set[str]:
    rows = conn.execute(
        text(
            """
            SELECT COLUMN_NAME
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = :table_name
            """
        ),
        {"table_name": table_name},
    ).mappings().all()
    return {str(row["COLUMN_NAME"]) for row in rows}


def _active_filter(columns: set[str]) -> str:
    if "is_active" in columns:
        return " AND COALESCE(uca.is_active, 0) = 1"
    if "enabled" in columns:
        return " AND COALESCE(uca.enabled, 0) = 1"
    return ""


def _load_address_rows(conn) -> List[Mapping[str, Any]]:
    columns = _get_columns(conn, "user_chain_addresses")
    if not {"user_id", "address"}.issubset(columns):
        raise RuntimeError("user_chain_addresses must contain user_id and address columns")

    has_chain_key = "chain_key" in columns
    has_chain_id = "chain_id" in columns
    if not has_chain_key and not has_chain_id:
        raise RuntimeError("user_chain_addresses must contain chain_key or chain_id")

    chain_key_expr = "uca.chain_key" if has_chain_key else "NULL"
    chain_id_expr = "uca.chain_id" if has_chain_id else "NULL"
    join_sql = "LEFT JOIN chains c ON c.id = uca.chain_id" if has_chain_id else ""
    chain_lookup_expr = "COALESCE(NULLIF(LOWER(TRIM({chain_key_expr})), ''), LOWER(TRIM(c.chain_key)))".format(
        chain_key_expr=chain_key_expr
    )

    sql = f"""
        SELECT
          uca.id,
          uca.user_id,
          uca.address,
          {chain_id_expr} AS chain_id,
          {chain_lookup_expr} AS chain_key
        FROM user_chain_addresses uca
        {join_sql}
        WHERE uca.user_id IS NOT NULL
          AND uca.address IS NOT NULL
          AND TRIM(uca.address) <> ''
          {_active_filter(columns)}
        ORDER BY uca.id ASC
    """
    return conn.execute(text(sql)).mappings().all()


def _empty_chain_stat() -> Dict[str, int]:
    return {
        "total": 0,
        "matched": 0,
        "mismatched": 0,
        "skipped": 0,
    }


def _print_group_stats(group_stats: Mapping[str, Mapping[str, int]]) -> None:
    print("by_chain_key:")
    for chain_key in sorted(group_stats):
        stat = group_stats[chain_key]
        print(
            "  {chain}: total={total} matched={matched} mismatched={mismatched} skipped={skipped}".format(
                chain=chain_key,
                total=stat["total"],
                matched=stat["matched"],
                mismatched=stat["mismatched"],
                skipped=stat["skipped"],
            )
        )


def audit_rows(rows: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
    total_count = 0
    matched_count = 0
    mismatched_count = 0
    skipped_count = 0
    group_stats: Dict[str, Dict[str, int]] = defaultdict(_empty_chain_stat)
    mismatches: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for row in rows:
        total_count += 1

        user_id = row.get("user_id")
        chain_key = (row.get("chain_key") or "").strip().lower()
        db_address = (row.get("address") or "").strip().lower()
        stat_key = chain_key or "unknown"
        group_stats[stat_key]["total"] += 1

        if not user_id or not chain_key or not db_address:
            skipped_count += 1
            group_stats[stat_key]["skipped"] += 1
            skipped.append(
                {
                    "id": row.get("id"),
                    "user_id": user_id,
                    "chain_key": chain_key or None,
                    "db_address": mask_address(db_address),
                    "reason": "missing user_id, chain_key, or address",
                }
            )
            continue

        try:
            derived_address = derive_evm_address_by_chain(int(user_id), chain_key).lower()
        except Exception as exc:
            skipped_count += 1
            group_stats[stat_key]["skipped"] += 1
            skipped.append(
                {
                    "id": row.get("id"),
                    "user_id": user_id,
                    "chain_key": chain_key,
                    "db_address": mask_address(db_address),
                    "reason": str(exc),
                }
            )
            continue

        if derived_address == db_address:
            matched_count += 1
            group_stats[stat_key]["matched"] += 1
        else:
            mismatched_count += 1
            group_stats[stat_key]["mismatched"] += 1
            mismatches.append(
                {
                    "id": row.get("id"),
                    "user_id": int(user_id),
                    "chain_key": chain_key,
                    "db_address": mask_address(db_address),
                    "derived_address": mask_address(derived_address),
                }
            )

    return {
        "total_count": total_count,
        "matched_count": matched_count,
        "mismatched_count": mismatched_count,
        "skipped_count": skipped_count,
        "group_stats": group_stats,
        "mismatches": mismatches,
        "skipped": skipped,
    }


def print_report(result: Mapping[str, Any]) -> None:
    print("audit_derived_deposit_addresses")
    print(f"total_count={result['total_count']}")
    print(f"matched_count={result['matched_count']}")
    print(f"mismatched_count={result['mismatched_count']}")
    print(f"skipped_count={result['skipped_count']}")
    _print_group_stats(result["group_stats"])

    if result["mismatches"]:
        print("mismatches:")
        for item in result["mismatches"]:
            print(
                "  user_id={user_id} chain_key={chain_key} db_address={db_address} derived_address={derived_address}".format(
                    **item
                )
            )
    else:
        print("mismatches: none")

    if result["skipped"]:
        print("skipped:")
        for item in result["skipped"]:
            print(
                "  user_id={user_id} chain_key={chain_key} db_address={db_address} reason={reason}".format(
                    **item
                )
            )


def main() -> None:
    engine = create_engine(settings.database_url, pool_pre_ping=True, pool_recycle=3600)
    with engine.connect() as conn:
        rows = _load_address_rows(conn)
        result = audit_rows(rows)
    print_report(result)


if __name__ == "__main__":
    main()
