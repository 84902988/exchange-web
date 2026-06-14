"""add market klines

Revision ID: 20260518_000039
Revises: 20260518_000038
Create Date: 2026-05-18 17:20:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260518_000039"
down_revision = "20260518_000038"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "market_klines"):
        return

    op.create_table(
        "market_klines",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("market_type", sa.String(length=16), nullable=False),
        sa.Column("symbol", sa.String(length=64), nullable=False),
        sa.Column("interval", sa.String(length=8), nullable=False),
        sa.Column("open_time", sa.BigInteger(), nullable=False),
        sa.Column("close_time", sa.BigInteger(), nullable=False),
        sa.Column("open", sa.Numeric(36, 18), nullable=False),
        sa.Column("high", sa.Numeric(36, 18), nullable=False),
        sa.Column("low", sa.Numeric(36, 18), nullable=False),
        sa.Column("close", sa.Numeric(36, 18), nullable=False),
        sa.Column("volume", sa.Numeric(36, 18), nullable=False),
        sa.Column("quote_volume", sa.Numeric(36, 18), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("is_closed", sa.Boolean(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "market_type",
            "symbol",
            "interval",
            "open_time",
            name="uq_market_klines_market_symbol_interval_open",
        ),
    )
    op.create_index(
        "idx_market_klines_symbol_interval_open",
        "market_klines",
        ["symbol", "interval", "open_time"],
        unique=False,
    )
    op.create_index(
        "idx_market_klines_market_symbol_interval_open",
        "market_klines",
        ["market_type", "symbol", "interval", "open_time"],
        unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "market_klines"):
        op.drop_index("idx_market_klines_market_symbol_interval_open", table_name="market_klines")
        op.drop_index("idx_market_klines_symbol_interval_open", table_name="market_klines")
        op.drop_table("market_klines")
