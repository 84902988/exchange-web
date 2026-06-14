"""relax stock token lock config uniqueness

Revision ID: 20260517_000036
Revises: 20260517_000035
Create Date: 2026-05-17 16:45:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260517_000036"
down_revision = "20260517_000035"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_index(bind, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def _has_unique_constraint(bind, table_name: str, constraint_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(
        constraint["name"] == constraint_name
        for constraint in inspector.get_unique_constraints(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "stock_token_lock_configs"):
        return

    for constraint_name in ("uk_stock_lock_symbol", "uk_stock_trade_symbol"):
        if _has_unique_constraint(bind, "stock_token_lock_configs", constraint_name):
            op.drop_constraint(constraint_name, "stock_token_lock_configs", type_="unique")

    for index_name, columns in (
        ("idx_stock_token_lock_configs_lock_symbol", ["lock_symbol"]),
        ("idx_stock_token_lock_configs_trade_symbol", ["trade_symbol"]),
    ):
        if not _has_index(bind, "stock_token_lock_configs", index_name):
            op.create_index(index_name, "stock_token_lock_configs", columns)


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "stock_token_lock_configs"):
        return

    for index_name in (
        "idx_stock_token_lock_configs_lock_symbol",
        "idx_stock_token_lock_configs_trade_symbol",
    ):
        if _has_index(bind, "stock_token_lock_configs", index_name):
            op.drop_index(index_name, table_name="stock_token_lock_configs")

    if not _has_unique_constraint(bind, "stock_token_lock_configs", "uk_stock_lock_symbol"):
        op.create_unique_constraint("uk_stock_lock_symbol", "stock_token_lock_configs", ["lock_symbol"])
    if not _has_unique_constraint(bind, "stock_token_lock_configs", "uk_stock_trade_symbol"):
        op.create_unique_constraint("uk_stock_trade_symbol", "stock_token_lock_configs", ["trade_symbol"])
