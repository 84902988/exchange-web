"""add trading pair display category

Revision ID: 20260522_000050
Revises: 20260520_000049
Create Date: 2026-05-22
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260522_000050"
down_revision = "20260520_000049"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in sa.inspect(bind).get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in sa.inspect(bind).get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    if not _has_column(bind, "trading_pairs", "display_category"):
        op.add_column("trading_pairs", sa.Column("display_category", sa.String(length=32), nullable=True))

    if not _has_index(bind, "trading_pairs", "idx_trading_pairs_display_category"):
        op.create_index("idx_trading_pairs_display_category", "trading_pairs", ["display_category"])

    op.execute(
        """
        UPDATE trading_pairs
        SET display_category = 'PLATFORM'
        WHERE symbol IN ('MFCUSDT', 'RCBUSDT')
        """
    )
    op.execute(
        """
        UPDATE trading_pairs
        SET display_category = 'MAINSTREAM'
        WHERE symbol IN ('BTCUSDT', 'ETHUSDT')
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    if _has_index(bind, "trading_pairs", "idx_trading_pairs_display_category"):
        op.drop_index("idx_trading_pairs_display_category", table_name="trading_pairs")

    if _has_column(bind, "trading_pairs", "display_category"):
        op.drop_column("trading_pairs", "display_category")
