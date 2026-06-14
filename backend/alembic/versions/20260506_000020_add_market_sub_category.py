"""add market sub category to trading pairs

Revision ID: 20260506_000020
Revises: 20260505_000019
Create Date: 2026-05-06 00:00:20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260506_000020"
down_revision = "20260505_000019"
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

    if not _has_column(bind, "trading_pairs", "market_sub_category"):
        op.add_column(
            "trading_pairs",
            sa.Column("market_sub_category", sa.String(length=50), nullable=True),
        )

    if not _has_index(bind, "trading_pairs", "idx_trading_pairs_market_sub_category"):
        op.create_index(
            "idx_trading_pairs_market_sub_category",
            "trading_pairs",
            ["market_sub_category"],
        )

    op.execute(
        """
        UPDATE trading_pairs
        SET market_sub_category = 'STOCK_TOKEN'
        WHERE market_category = 'STOCK'
          AND asset_type = 'STOCK'
          AND market_sub_category IS NULL
          AND (symbol LIKE '%ONUSDT' OR external_symbol IS NOT NULL)
        """
    )
    op.execute(
        """
        UPDATE trading_pairs
        SET market_sub_category = 'US_STOCK'
        WHERE market_category = 'STOCK'
          AND asset_type = 'STOCK'
          AND market_sub_category IS NULL
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    if _has_index(bind, "trading_pairs", "idx_trading_pairs_market_sub_category"):
        op.drop_index("idx_trading_pairs_market_sub_category", table_name="trading_pairs")

    if _has_column(bind, "trading_pairs", "market_sub_category"):
        op.drop_column("trading_pairs", "market_sub_category")
