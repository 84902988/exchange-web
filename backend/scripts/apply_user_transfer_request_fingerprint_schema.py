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


EXPECTED_REVISION = "20260728_000126"
TARGET_REVISION = "20260803_000133"
TABLE_NAME = "user_transfers"
COLUMN_NAME = "request_fingerprint"
COLUMN_DDL = "VARCHAR(64) NULL"


def _revision(connection: Connection) -> str:
    inspector = sa.inspect(connection)
    if not inspector.has_table("alembic_version"):
        raise RuntimeError("alembic_version table is missing")
    rows = connection.execute(
        sa.text("SELECT version_num FROM alembic_version")
    ).scalars().all()
    if len(rows) != 1:
        raise RuntimeError(f"expected exactly one Alembic revision, found {len(rows)}")
    return str(rows[0] or "").strip()


def _fingerprint_column(connection: Connection) -> dict[str, Any] | None:
    inspector = sa.inspect(connection)
    if not inspector.has_table(TABLE_NAME):
        raise RuntimeError(f"{TABLE_NAME} table is missing")
    return next(
        (
            column
            for column in inspector.get_columns(TABLE_NAME)
            if str(column.get("name") or "") == COLUMN_NAME
        ),
        None,
    )


def _verify_column(connection: Connection) -> None:
    column = _fingerprint_column(connection)
    if column is None:
        raise RuntimeError(f"{TABLE_NAME}.{COLUMN_NAME} is missing after migration")
    column_type = column.get("type")
    if not isinstance(column_type, sa.String) or int(column_type.length or 0) != 64:
        raise RuntimeError(
            f"unexpected {TABLE_NAME}.{COLUMN_NAME} type: {column_type!s}"
        )
    if not bool(column.get("nullable")):
        raise RuntimeError(f"{TABLE_NAME}.{COLUMN_NAME} must remain nullable")


def _plan(connection: Connection) -> list[str]:
    revision = _revision(connection)
    if revision not in {EXPECTED_REVISION, TARGET_REVISION}:
        raise RuntimeError(
            f"unsupported Alembic revision {revision!r}; "
            f"expected {EXPECTED_REVISION!r} or {TARGET_REVISION!r}"
        )

    actions: list[str] = []
    column = _fingerprint_column(connection)
    if column is None:
        actions.append(f"add {TABLE_NAME}.{COLUMN_NAME}")
    else:
        _verify_column(connection)
    if revision == EXPECTED_REVISION:
        actions.append(f"advance Alembic revision to {TARGET_REVISION}")
    return actions


def apply_user_transfer_request_fingerprint_schema(
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

        if _fingerprint_column(connection) is None:
            connection.execute(
                sa.text(
                    f"ALTER TABLE {TABLE_NAME} "
                    f"ADD COLUMN {COLUMN_NAME} {COLUMN_DDL}"
                )
            )

        _verify_column(connection)
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
        description="Apply only the user-transfer request fingerprint hotfix schema."
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply schema changes. Without this flag the command is read-only.",
    )
    args = parser.parse_args()

    from app.db.session import engine

    try:
        result = apply_user_transfer_request_fingerprint_schema(
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
