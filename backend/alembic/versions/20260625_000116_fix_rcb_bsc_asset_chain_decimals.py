"""fix rcb bsc asset chain decimals

Revision ID: 20260625_000116
Revises: 20260625_000115
Create Date: 2026-06-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260625_000116"
down_revision = "20260625_000115"
branch_labels = None
depends_on = None


def _has_tables(bind, *table_names: str) -> bool:
    inspector = sa.inspect(bind)
    return all(inspector.has_table(table_name) for table_name in table_names)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_tables(bind, "assets", "chains", "asset_chains"):
        return

    op.execute(
        sa.text(
            """
            UPDATE asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            SET ac.decimals = 8,
                ac.updated_at = UTC_TIMESTAMP()
            WHERE a.symbol = 'RCB'
              AND c.chain_key = 'bsc'
              AND ac.decimals <> 8
            """
        )
    )


def downgrade() -> None:
    # This migration records corrected production configuration. Reverting would
    # restore known-bad token decimals and can break withdrawals.
    return
