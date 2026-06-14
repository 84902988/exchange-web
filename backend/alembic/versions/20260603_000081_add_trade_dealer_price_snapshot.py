"""add trade dealer price snapshot

Revision ID: 20260603_000081
Revises: 20260603_000080
Create Date: 2026-06-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260603_000081"
down_revision = "20260603_000080"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trades"):
        return
    if not _has_column(bind, "trades", "dealer_ref_price"):
        op.add_column("trades", sa.Column("dealer_ref_price", sa.Numeric(36, 18), nullable=True))
    if not _has_column(bind, "trades", "dealer_best_bid"):
        op.add_column("trades", sa.Column("dealer_best_bid", sa.Numeric(36, 18), nullable=True))
    if not _has_column(bind, "trades", "dealer_best_ask"):
        op.add_column("trades", sa.Column("dealer_best_ask", sa.Numeric(36, 18), nullable=True))
    if not _has_column(bind, "trades", "dealer_price_source"):
        op.add_column("trades", sa.Column("dealer_price_source", sa.String(length=32), nullable=True))
    if not _has_column(bind, "trades", "dealer_spread_bps"):
        op.add_column("trades", sa.Column("dealer_spread_bps", sa.Numeric(18, 8), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "trades", "dealer_spread_bps"):
        op.drop_column("trades", "dealer_spread_bps")
    if _has_column(bind, "trades", "dealer_price_source"):
        op.drop_column("trades", "dealer_price_source")
    if _has_column(bind, "trades", "dealer_best_ask"):
        op.drop_column("trades", "dealer_best_ask")
    if _has_column(bind, "trades", "dealer_best_bid"):
        op.drop_column("trades", "dealer_best_bid")
    if _has_column(bind, "trades", "dealer_ref_price"):
        op.drop_column("trades", "dealer_ref_price")
