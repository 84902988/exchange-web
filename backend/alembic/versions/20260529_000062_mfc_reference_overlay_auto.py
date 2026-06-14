"""mfc reference overlay auto

Revision ID: 20260529_000062
Revises: 20260529_000061
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000062"
down_revision = "20260529_000061"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    bind.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET price_source = 'AUTO',
                auto_source = 'IRON62',
                refresh_interval_sec = 300,
                updated_at = CURRENT_TIMESTAMP
            WHERE symbol = 'MFCUSDT'
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    bind.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET price_source = 'MANUAL',
                auto_source = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE symbol = 'MFCUSDT'
            """
        )
    )
