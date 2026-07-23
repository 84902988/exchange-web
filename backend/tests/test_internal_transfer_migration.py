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
    / "20260724_000124_add_internal_transfers.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "migration_20260724_000124",
        MIGRATION_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_internal_transfer_migration_is_idempotent_and_complete(monkeypatch):
    engine = sa.create_engine("sqlite://")
    migration = _load_migration()

    with engine.begin() as connection:
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(migration, "op", operations)

        migration.upgrade()
        migration.upgrade()

        inspector = sa.inspect(connection)
        assert inspector.has_table("internal_transfers")
        assert {column["name"] for column in inspector.get_columns("internal_transfers")} == {
            "id",
            "transfer_no",
            "user_id",
            "coin_symbol",
            "from_account",
            "to_account",
            "amount",
            "status",
            "from_available_before",
            "from_available_after",
            "to_available_before",
            "to_available_after",
            "remark",
            "created_at",
            "updated_at",
        }
        assert {index["name"] for index in inspector.get_indexes("internal_transfers")} == {
            "ix_internal_transfer_user_symbol_time",
            "ix_internal_transfer_user_time",
            "ix_internal_transfers_coin_symbol",
            "ix_internal_transfers_user_id",
        }
        assert {item["name"] for item in inspector.get_unique_constraints("internal_transfers")} == {
            "uq_internal_transfer_no",
        }

        migration.downgrade()
        assert not sa.inspect(connection).has_table("internal_transfers")
