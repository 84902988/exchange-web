from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import Connection, Engine


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db import models  # noqa: E402,F401
from app.db.base import Base  # noqa: E402


EXPECTED_REVISION = "20260724_000124"
TARGET_REVISION = "20260728_000125"
POOL_COLUMN_DDL = {
    "rcb_price_snapshot_at": "DATETIME NULL",
    "rcb_price_source_trade_id": "BIGINT NULL",
    "rcb_price_source_trade_at": "DATETIME NULL",
}
SNAPSHOT_TABLES = (
    "dividend_eligibility_snapshots",
    "dividend_eligibility_snapshot_items",
)
REQUIRED_COLUMNS = {
    "dividend_eligibility_snapshots": {
        "id",
        "dividend_date",
        "snapshot_at",
        "status",
        "eligible_user_count",
        "created_at",
    },
    "dividend_eligibility_snapshot_items": {
        "id",
        "snapshot_id",
        "user_id",
        "level_code",
        "qualified_lock_amount",
        "required_lock_amount",
        "required_lock_period_days",
        "created_at",
    },
}
REQUIRED_UNIQUES = {
    "dividend_eligibility_snapshots": {"uq_dividend_eligibility_snapshots_date"},
    "dividend_eligibility_snapshot_items": {
        "uq_dividend_eligibility_snapshot_items_user"
    },
}
REQUIRED_INDEXES = {
    "dividend_eligibility_snapshots": {"idx_dividend_eligibility_snapshots_status"},
    "dividend_eligibility_snapshot_items": {
        "idx_dividend_eligibility_snapshot_items_level"
    },
}


def _revision(connection: Connection) -> str:
    inspector = sa.inspect(connection)
    if not inspector.has_table("alembic_version"):
        raise RuntimeError("alembic_version table is missing")
    rows = connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all()
    if len(rows) != 1:
        raise RuntimeError(f"expected exactly one Alembic revision, found {len(rows)}")
    return str(rows[0] or "").strip()


def _column_names(connection: Connection, table_name: str) -> set[str]:
    return {
        str(column.get("name") or "")
        for column in sa.inspect(connection).get_columns(table_name)
    }


def _plan(connection: Connection) -> list[str]:
    revision = _revision(connection)
    if revision not in {EXPECTED_REVISION, TARGET_REVISION}:
        raise RuntimeError(
            f"unsupported Alembic revision {revision!r}; expected {EXPECTED_REVISION!r}"
        )
    inspector = sa.inspect(connection)
    if not inspector.has_table("dividend_pools"):
        raise RuntimeError("dividend_pools table is missing")

    actions: list[str] = []
    pool_columns = _column_names(connection, "dividend_pools")
    for column_name in POOL_COLUMN_DDL:
        if column_name not in pool_columns:
            actions.append(f"add dividend_pools.{column_name}")
    for table_name in SNAPSHOT_TABLES:
        if not inspector.has_table(table_name):
            actions.append(f"create {table_name}")
    if revision == EXPECTED_REVISION:
        actions.append(f"advance Alembic revision to {TARGET_REVISION}")
    return actions


def _verify_schema(connection: Connection) -> None:
    inspector = sa.inspect(connection)
    pool_columns = _column_names(connection, "dividend_pools")
    missing_pool_columns = set(POOL_COLUMN_DDL) - pool_columns
    if missing_pool_columns:
        raise RuntimeError(
            "dividend_pools columns missing after migration: "
            + ", ".join(sorted(missing_pool_columns))
        )

    for table_name in SNAPSHOT_TABLES:
        if not inspector.has_table(table_name):
            raise RuntimeError(f"{table_name} table is missing after migration")
        missing_columns = REQUIRED_COLUMNS[table_name] - _column_names(connection, table_name)
        if missing_columns:
            raise RuntimeError(
                f"{table_name} columns missing after migration: "
                + ", ".join(sorted(missing_columns))
            )
        unique_names = {
            str(item.get("name") or "")
            for item in sa.inspect(connection).get_unique_constraints(table_name)
        }
        missing_uniques = REQUIRED_UNIQUES[table_name] - unique_names
        if missing_uniques:
            raise RuntimeError(
                f"{table_name} unique constraints missing after migration: "
                + ", ".join(sorted(missing_uniques))
            )
        index_names = {
            str(item.get("name") or "")
            for item in sa.inspect(connection).get_indexes(table_name)
        }
        missing_indexes = REQUIRED_INDEXES[table_name] - index_names
        if missing_indexes:
            raise RuntimeError(
                f"{table_name} indexes missing after migration: "
                + ", ".join(sorted(missing_indexes))
            )


def apply_dividend_snapshot_schema(engine: Engine, *, execute: bool) -> dict[str, Any]:
    with engine.begin() as connection:
        revision_before = _revision(connection)
        actions = _plan(connection)
        if not execute:
            return {
                "ok": True,
                "executed": False,
                "revision_before": revision_before,
                "revision_after": revision_before,
                "actions": actions,
            }

        pool_columns = _column_names(connection, "dividend_pools")
        for column_name, column_ddl in POOL_COLUMN_DDL.items():
            if column_name not in pool_columns:
                connection.execute(
                    sa.text(
                        f"ALTER TABLE dividend_pools ADD COLUMN {column_name} {column_ddl}"
                    )
                )
                pool_columns.add(column_name)

        inspector = sa.inspect(connection)
        for table_name in SNAPSHOT_TABLES:
            if not inspector.has_table(table_name):
                Base.metadata.tables[table_name].create(bind=connection, checkfirst=True)
                inspector = sa.inspect(connection)

        _verify_schema(connection)
        if revision_before == EXPECTED_REVISION:
            result = connection.execute(
                sa.text(
                    "UPDATE alembic_version "
                    "SET version_num = :target_revision "
                    "WHERE version_num = :expected_revision"
                ),
                {
                    "target_revision": TARGET_REVISION,
                    "expected_revision": EXPECTED_REVISION,
                },
            )
            if int(result.rowcount or 0) != 1:
                raise RuntimeError("Alembic revision update did not affect exactly one row")

        revision_after = _revision(connection)
        if revision_after != TARGET_REVISION:
            raise RuntimeError(
                f"unexpected Alembic revision after migration: {revision_after!r}"
            )
        return {
            "ok": True,
            "executed": True,
            "revision_before": revision_before,
            "revision_after": revision_after,
            "actions": actions,
        }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply the bounded dividend snapshot schema migration."
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply schema changes. Without this flag the command is read-only.",
    )
    args = parser.parse_args()

    from app.db.session import engine

    try:
        result = apply_dividend_snapshot_schema(engine, execute=bool(args.execute))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": repr(exc)}, ensure_ascii=False, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
