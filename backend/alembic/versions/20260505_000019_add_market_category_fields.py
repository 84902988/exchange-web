"""add market category fields to trading pairs

Revision ID: 20260505_000019
Revises: 20260505_000018
Create Date: 2026-05-05 00:00:19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260505_000019"
down_revision = "20260505_000018"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    columns = sa.inspect(bind).get_columns(table_name)
    return any(column["name"] == column_name for column in columns)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    indexes = sa.inspect(bind).get_indexes(table_name)
    return any(index["name"] == index_name for index in indexes)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    if not _has_column(bind, "trading_pairs", "market_category"):
        op.add_column(
            "trading_pairs",
            sa.Column("market_category", sa.String(length=30), nullable=True, server_default="CRYPTO"),
        )
    if not _has_column(bind, "trading_pairs", "display_group"):
        op.add_column(
            "trading_pairs",
            sa.Column("display_group", sa.String(length=50), nullable=True),
        )
    if not _has_column(bind, "trading_pairs", "sort_order"):
        op.add_column(
            "trading_pairs",
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        )
    if not _has_column(bind, "trading_pairs", "is_hot"):
        op.add_column(
            "trading_pairs",
            sa.Column("is_hot", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    if not _has_index(bind, "trading_pairs", "idx_trading_pairs_market_category"):
        op.create_index("idx_trading_pairs_market_category", "trading_pairs", ["market_category"])
    if not _has_index(bind, "trading_pairs", "idx_trading_pairs_sort_order"):
        op.create_index("idx_trading_pairs_sort_order", "trading_pairs", ["sort_order"])
    if not _has_index(bind, "trading_pairs", "idx_trading_pairs_is_hot"):
        op.create_index("idx_trading_pairs_is_hot", "trading_pairs", ["is_hot"])


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    for index_name in (
        "idx_trading_pairs_is_hot",
        "idx_trading_pairs_sort_order",
        "idx_trading_pairs_market_category",
    ):
        if _has_index(bind, "trading_pairs", index_name):
            op.drop_index(index_name, table_name="trading_pairs")

    for column_name in ("is_hot", "sort_order", "display_group", "market_category"):
        if _has_column(bind, "trading_pairs", column_name):
            op.drop_column("trading_pairs", column_name)
