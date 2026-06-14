"""Enable IMAA stock reference overlay auto refresh

Revision ID: 20260529_000068
Revises: 20260529_000067
Create Date: 2026-05-29 23:05:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260529_000068"
down_revision = "20260529_000067"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET enabled = 1,
                reference_type = 'STOCK',
                kind = 'STOCK',
                price_source = 'AUTO',
                auto_source = 'ITICK_STOCK',
                source_symbol = 'IMAA',
                source_region = 'US',
                refresh_interval_sec = 15,
                sync_status = 'PENDING',
                sync_error = NULL,
                last_sync_at = NULL,
                updated_at = UTC_TIMESTAMP()
            WHERE symbol = 'IMAA2USDT'
            """
        )
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET price_source = 'MANUAL',
                auto_source = NULL,
                refresh_interval_sec = 300,
                sync_status = 'PENDING',
                sync_error = NULL,
                updated_at = UTC_TIMESTAMP()
            WHERE symbol = 'IMAA2USDT'
            """
        )
    )
