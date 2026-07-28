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
    / "20260728_000125_add_dividend_eligibility_snapshots.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "migration_20260728_000125",
        MIGRATION_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dividend_snapshot_migration_is_idempotent_and_complete(monkeypatch) -> None:
    engine = sa.create_engine("sqlite://")
    migration = _load_migration()

    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
                CREATE TABLE dividend_pools (
                    id INTEGER PRIMARY KEY,
                    dividend_date DATE NOT NULL,
                    rcb_price_used NUMERIC(36, 18) NOT NULL
                )
                """
            )
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(migration, "op", operations)

        migration.upgrade()
        migration.upgrade()

        inspector = sa.inspect(connection)
        assert inspector.has_table("dividend_eligibility_snapshots")
        assert inspector.has_table("dividend_eligibility_snapshot_items")
        assert {
            column["name"] for column in inspector.get_columns("dividend_pools")
        } == {
            "id",
            "dividend_date",
            "rcb_price_used",
            "rcb_price_snapshot_at",
            "rcb_price_source_trade_id",
            "rcb_price_source_trade_at",
        }
        assert {column["name"] for column in inspector.get_columns("dividend_eligibility_snapshots")} == {
            "id",
            "dividend_date",
            "snapshot_at",
            "status",
            "eligible_user_count",
            "created_at",
        }
        assert {
            column["name"] for column in inspector.get_columns("dividend_eligibility_snapshot_items")
        } == {
            "id",
            "snapshot_id",
            "user_id",
            "level_code",
            "qualified_lock_amount",
            "required_lock_amount",
            "required_lock_period_days",
            "created_at",
        }
        assert {
            item["name"] for item in inspector.get_unique_constraints("dividend_eligibility_snapshots")
        } == {"uq_dividend_eligibility_snapshots_date"}
        assert {
            item["name"]
            for item in inspector.get_unique_constraints("dividend_eligibility_snapshot_items")
        } == {"uq_dividend_eligibility_snapshot_items_user"}

        migration.downgrade()
        assert not sa.inspect(connection).has_table("dividend_eligibility_snapshot_items")
        assert not sa.inspect(connection).has_table("dividend_eligibility_snapshots")
        assert {
            column["name"] for column in sa.inspect(connection).get_columns("dividend_pools")
        } == {"id", "dividend_date", "rcb_price_used"}
