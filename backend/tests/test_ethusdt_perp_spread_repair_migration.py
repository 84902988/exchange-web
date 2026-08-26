from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20260824_000136_repair_ethusdt_perp_spread.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "repair_ethusdt_perp_spread",
        MIGRATION_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _MigrationOp:
    def __init__(self, connection: sa.Connection):
        self.connection = connection

    def get_bind(self) -> sa.Connection:
        return self.connection

    def execute(self, statement):
        return self.connection.execute(statement)


def test_upgrade_repairs_only_the_exact_eth_upper_bound_value():
    migration = _load_migration()
    engine = sa.create_engine("sqlite:///:memory:")

    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
                CREATE TABLE contract_symbols (
                    symbol VARCHAR(64) PRIMARY KEY,
                    spread_x NUMERIC(36, 18) NOT NULL,
                    updated_at DATETIME
                )
                """
            )
        )
        connection.execute(
            sa.text(
                """
                INSERT INTO contract_symbols (symbol, spread_x)
                VALUES
                    ('ETHUSDT_PERP', 100),
                    ('BTCUSDT_PERP', 100),
                    ('ETH_CUSTOM_PERP', 1)
                """
            )
        )
        migration.op = _MigrationOp(connection)

        migration.upgrade()

        rows = dict(
            connection.execute(
                sa.text("SELECT symbol, spread_x FROM contract_symbols")
            ).all()
        )

    assert rows["ETHUSDT_PERP"] == 0
    assert rows["BTCUSDT_PERP"] == 100
    assert rows["ETH_CUSTOM_PERP"] == 1


def test_upgrade_is_safe_when_contract_symbols_is_missing():
    migration = _load_migration()
    engine = sa.create_engine("sqlite:///:memory:")

    with engine.begin() as connection:
        migration.op = _MigrationOp(connection)
        migration.upgrade()
