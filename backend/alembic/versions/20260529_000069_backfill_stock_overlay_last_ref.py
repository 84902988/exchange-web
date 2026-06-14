"""Backfill stock overlay last reference values

Revision ID: 20260529_000069
Revises: 20260529_000068
Create Date: 2026-05-29 23:35:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260529_000069"
down_revision = "20260529_000068"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET last_ref_price = display_price,
                last_ref_label = display_value_label,
                updated_at = UTC_TIMESTAMP()
            WHERE reference_type = 'STOCK'
              AND price_source = 'AUTO'
              AND display_price IS NOT NULL
              AND display_price > 0
              AND last_ref_price IS NULL
            """
        )
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET last_ref_price = NULL,
                last_ref_label = NULL,
                updated_at = UTC_TIMESTAMP()
            WHERE reference_type = 'STOCK'
              AND price_source = 'AUTO'
              AND sync_status = 'FAILED'
            """
        )
    )
