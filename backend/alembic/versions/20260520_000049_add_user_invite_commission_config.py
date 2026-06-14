"""add user invite commission config

Revision ID: 20260520_000049
Revises: 20260520_000048
Create Date: 2026-05-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260520_000049"
down_revision = "20260520_000048"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "system_configs"):
        return

    op.execute(
        """
        INSERT INTO system_configs (config_key, config_value, description, created_at, updated_at)
        VALUES (
            'user_invite_commission_rate',
            '0.150000',
            'Normal user invite commission rate. Must be greater than 0 and not exceed 0.20.',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        ON DUPLICATE KEY UPDATE
            description = VALUES(description),
            updated_at = CURRENT_TIMESTAMP
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "system_configs"):
        return

    op.execute(
        """
        DELETE FROM system_configs
        WHERE config_key = 'user_invite_commission_rate'
        """
    )
