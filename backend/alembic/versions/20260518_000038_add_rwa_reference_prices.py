"""add rwa reference prices

Revision ID: 20260518_000038
Revises: 20260518_000037
Create Date: 2026-05-18 08:10:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260518_000038"
down_revision = "20260518_000037"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "rwa_reference_prices"):
        return

    op.create_table(
        "rwa_reference_prices",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=False),
        sa.Column("price_usd_per_ton", sa.Numeric(36, 18), nullable=True),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=False),
        sa.Column("raw_payload_json", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("error_message", sa.String(length=1000), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("symbol", "trade_date", name="uq_rwa_reference_prices_symbol_trade_date"),
    )
    op.create_index(
        "idx_rwa_reference_prices_symbol_status_date",
        "rwa_reference_prices",
        ["symbol", "status", "trade_date"],
        unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "rwa_reference_prices"):
        op.drop_index("idx_rwa_reference_prices_symbol_status_date", table_name="rwa_reference_prices")
        op.drop_table("rwa_reference_prices")
