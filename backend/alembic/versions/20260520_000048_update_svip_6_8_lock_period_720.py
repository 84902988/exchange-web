"""update svip 6-8 lock period to 720 days

Revision ID: 20260520_000048
Revises: 20260519_000047
Create Date: 2026-05-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260520_000048"
down_revision = "20260519_000047"
branch_labels = None
depends_on = None


def _has_tables(bind) -> bool:
    inspector = sa.inspect(bind)
    return inspector.has_table("vip_fee_levels") and inspector.has_table("vip_fee_level_conditions")


def _set_svip_6_8_lock_period(lock_period_days: int) -> None:
    bind = op.get_bind()
    if not _has_tables(bind):
        return

    bind.execute(
        sa.text(
            """
            UPDATE vip_fee_level_conditions
            SET lock_period_days = :lock_period_days
            WHERE vip_fee_level_id IN (
                SELECT id
                FROM vip_fee_levels
                WHERE vip_type = 'SVIP'
                  AND level_code IN ('SVIP6', 'SVIP7', 'SVIP8')
            )
            """
        ),
        {"lock_period_days": lock_period_days},
    )


def upgrade() -> None:
    _set_svip_6_8_lock_period(720)


def downgrade() -> None:
    pass
