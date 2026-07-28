from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20260728_000126_add_dividend_recovery_snapshot_fields.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "migration_20260728_000126",
        MIGRATION_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_recovery_snapshot_migration_upgrades_existing_125_schema(monkeypatch) -> None:
    engine = sa.create_engine("sqlite://")
    migration = _load_migration()

    with engine.begin() as connection:
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
        connection.execute(
            sa.text(
                """
                INSERT INTO dividend_eligibility_snapshots (
                    id, dividend_date, snapshot_at, status,
                    eligible_user_count, created_at
                ) VALUES (
                    1, '2026-07-27', '2026-07-28 00:05:00', 'READY',
                    1, '2026-07-28 00:05:00'
                )
                """
            )
        )
        connection.execute(
            sa.text(
                """
                INSERT INTO dividend_eligibility_snapshot_items (
                    id, snapshot_id, user_id, level_code,
                    qualified_lock_amount, required_lock_amount,
                    required_lock_period_days, created_at
                ) VALUES (
                    1, 1, 8, 'LP', 100000, 100000,
                    1095, '2026-07-28 00:05:00'
                )
                """
            )
        )

        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(migration, "op", operations)

        migration.upgrade()
        migration.upgrade()

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

        snapshot_row = connection.execute(
            sa.text(
                "SELECT source, created_by FROM dividend_eligibility_snapshots WHERE id = 1"
            )
        ).mappings().one()
        item_rate = connection.execute(
            sa.text(
                "SELECT dividend_rate FROM dividend_eligibility_snapshot_items WHERE id = 1"
            )
        ).scalar_one()
        assert snapshot_row["source"] == "AUTO"
        assert snapshot_row["created_by"] is None
        assert float(item_rate) == 0.05

        migration.downgrade()
        assert "source" not in {
            column["name"]
            for column in sa.inspect(connection).get_columns(
                "dividend_eligibility_snapshots"
            )
        }
        assert "dividend_rate" not in {
            column["name"]
            for column in sa.inspect(connection).get_columns(
                "dividend_eligibility_snapshot_items"
            )
        }
