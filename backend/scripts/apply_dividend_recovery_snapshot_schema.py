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


EXPECTED_REVISION = "20260728_000125"
TARGET_REVISION = "20260728_000126"
COLUMN_DDL = {
    "dividend_eligibility_snapshots": {
        "source": "VARCHAR(20) NOT NULL DEFAULT 'AUTO'",
        "created_by": "BIGINT NULL",
    },
    "dividend_eligibility_snapshot_items": {
        "dividend_rate": "NUMERIC(18, 8) NOT NULL DEFAULT 0.05",
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
            f"unsupported Alembic revision {revision!r}; "
            f"expected {EXPECTED_REVISION!r} or {TARGET_REVISION!r}"
        )

    inspector = sa.inspect(connection)
    actions: list[str] = []
    for table_name, columns in COLUMN_DDL.items():
        if not inspector.has_table(table_name):
            raise RuntimeError(f"{table_name} table is missing")
        current_columns = _column_names(connection, table_name)
        for column_name in columns:
            if column_name not in current_columns:
                actions.append(f"add {table_name}.{column_name}")
    if revision == EXPECTED_REVISION:
        actions.append(f"advance Alembic revision to {TARGET_REVISION}")
    return actions


def _verify_schema(connection: Connection) -> None:
    inspector = sa.inspect(connection)
    for table_name, columns in COLUMN_DDL.items():
        if not inspector.has_table(table_name):
            raise RuntimeError(f"{table_name} table is missing after migration")
        missing_columns = set(columns) - _column_names(connection, table_name)
        if missing_columns:
            raise RuntimeError(
                f"{table_name} columns missing after migration: "
                + ", ".join(sorted(missing_columns))
            )


def apply_dividend_recovery_snapshot_schema(
    engine: Engine,
    *,
    execute: bool,
) -> dict[str, Any]:
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

        for table_name, columns in COLUMN_DDL.items():
            current_columns = _column_names(connection, table_name)
            for column_name, column_ddl in columns.items():
                if column_name not in current_columns:
                    connection.execute(
                        sa.text(
                            f"ALTER TABLE {table_name} "
                            f"ADD COLUMN {column_name} {column_ddl}"
                        )
                    )
                    current_columns.add(column_name)

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
        description="Apply the bounded dividend recovery snapshot schema migration."
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply schema changes. Without this flag the command is read-only.",
    )
    args = parser.parse_args()

    from app.db.session import engine

    try:
        result = apply_dividend_recovery_snapshot_schema(
            engine,
            execute=bool(args.execute),
        )
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "error": repr(exc)},
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
