"""set BTCUSDT_PERP price precision

Revision ID: 20260501_000017
Revises: 20260501_000016
Create Date: 2026-05-01 00:00:17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000017"
down_revision = "20260501_000016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("contract_symbols"):
        return

    op.execute(
        sa.text(
            "UPDATE contract_symbols "
            "SET price_precision = 1, updated_at = NOW() "
            "WHERE symbol = 'BTCUSDT_PERP'"
        )
    )


def downgrade() -> None:
    pass
