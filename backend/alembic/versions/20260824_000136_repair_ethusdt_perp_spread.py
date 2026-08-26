"""repair erroneous ETHUSDT_PERP manual spread

Revision ID: 20260824_000136
Revises: 20260809_000135
Create Date: 2026-08-24 00:01:36
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260824_000136"
down_revision = "20260809_000135"
branch_labels = None
depends_on = None


def _has_contract_spread_column() -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("contract_symbols"):
        return False
    return any(
        column.get("name") == "spread_x"
        for column in inspector.get_columns("contract_symbols")
    )


def upgrade() -> None:
    if not _has_contract_spread_column():
        return

    # ETHUSDT_PERP is seeded with no manual addon. Repair only the exact
    # accidental upper-bound value so later operator-managed values remain
    # untouched.
    op.execute(
        sa.text(
            """
            UPDATE contract_symbols
            SET spread_x = :correct_spread,
                updated_at = CURRENT_TIMESTAMP
            WHERE symbol = :symbol
              AND spread_x = :erroneous_spread
            """
        ).bindparams(
            symbol="ETHUSDT_PERP",
            erroneous_spread=100,
            correct_spread=0,
        )
    )


def downgrade() -> None:
    # Do not restore a known-bad live trading configuration.
    return
