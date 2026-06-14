"""add fee asset symbol snapshots

Revision ID: 20260523_000051
Revises: 20260522_000050
Create Date: 2026-05-23
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260523_000051"
down_revision = "20260522_000050"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _add_column_if_missing(bind, table_name: str, column: sa.Column) -> None:
    if not _has_column(bind, table_name, column.name):
        op.add_column(table_name, column)


def _drop_column_if_exists(bind, table_name: str, column_name: str) -> None:
    if _has_column(bind, table_name, column_name):
        op.drop_column(table_name, column_name)


def upgrade() -> None:
    bind = op.get_bind()

    _add_column_if_missing(bind, "orders", sa.Column("fee_asset_symbol", sa.String(length=20), nullable=True))
    _add_column_if_missing(bind, "trades", sa.Column("fee_amount", sa.Numeric(36, 18), nullable=True))
    _add_column_if_missing(bind, "trades", sa.Column("fee_asset_symbol", sa.String(length=20), nullable=True))
    _add_column_if_missing(bind, "trades", sa.Column("buyer_fee_amount", sa.Numeric(36, 18), nullable=True))
    _add_column_if_missing(bind, "trades", sa.Column("buyer_fee_asset_symbol", sa.String(length=20), nullable=True))
    _add_column_if_missing(bind, "trades", sa.Column("seller_fee_amount", sa.Numeric(36, 18), nullable=True))
    _add_column_if_missing(bind, "trades", sa.Column("seller_fee_asset_symbol", sa.String(length=20), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()

    for column_name in (
        "seller_fee_asset_symbol",
        "seller_fee_amount",
        "buyer_fee_asset_symbol",
        "buyer_fee_amount",
        "fee_asset_symbol",
        "fee_amount",
    ):
        _drop_column_if_exists(bind, "trades", column_name)
    _drop_column_if_exists(bind, "orders", "fee_asset_symbol")
