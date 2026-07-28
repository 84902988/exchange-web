from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "apply_dividend_recovery_snapshot_schema.py"
)


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "apply_dividend_recovery_snapshot_schema",
        SCRIPT_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_125_database() -> sa.Engine:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            sa.text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        )
        connection.execute(
            sa.text("INSERT INTO alembic_version VALUES ('20260728_000125')")
        )
        connection.execute(
            sa.text(
                """
                CREATE TABLE dividend_eligibility_snapshots (
                    id INTEGER PRIMARY KEY,
                    dividend_date DATE NOT NULL,
                    snapshot_at DATETIME NOT NULL,
                    status VARCHAR(20) NOT NULL,
                    eligible_user_count INTEGER NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )
        connection.execute(
            sa.text(
                """
                CREATE TABLE dividend_eligibility_snapshot_items (
                    id INTEGER PRIMARY KEY,
                    snapshot_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    level_code VARCHAR(30) NOT NULL,
                    qualified_lock_amount NUMERIC(36, 18) NOT NULL,
                    required_lock_amount NUMERIC(36, 18) NOT NULL,
                    required_lock_period_days INTEGER NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )
    return engine


def test_installer_previews_then_applies_126_idempotently() -> None:
    script = _load_script()
    engine = _build_125_database()

    preview = script.apply_dividend_recovery_snapshot_schema(engine, execute=False)
    assert preview["revision_before"] == "20260728_000125"
    assert preview["revision_after"] == "20260728_000125"
    assert preview["actions"] == [
        "add dividend_eligibility_snapshots.source",
        "add dividend_eligibility_snapshots.created_by",
        "add dividend_eligibility_snapshot_items.dividend_rate",
        "advance Alembic revision to 20260728_000126",
    ]

    applied = script.apply_dividend_recovery_snapshot_schema(engine, execute=True)
    assert applied["revision_after"] == "20260728_000126"
    assert script.apply_dividend_recovery_snapshot_schema(engine, execute=True)[
        "actions"
    ] == []

    with engine.begin() as connection:
        assert connection.execute(
            sa.text("SELECT version_num FROM alembic_version")
        ).scalar_one() == "20260728_000126"
        snapshot_columns = {
            column["name"]
            for column in sa.inspect(connection).get_columns(
                "dividend_eligibility_snapshots"
            )
        }
        item_columns = {
            column["name"]
            for column in sa.inspect(connection).get_columns(
                "dividend_eligibility_snapshot_items"
            )
        }
        assert {"source", "created_by"} <= snapshot_columns
        assert "dividend_rate" in item_columns
