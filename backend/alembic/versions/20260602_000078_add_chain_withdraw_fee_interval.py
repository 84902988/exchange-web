"""add chain withdraw fee maintenance interval

Revision ID: 20260602_000078
Revises: 20260601_000077
Create Date: 2026-06-02
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260602_000078"
down_revision = "20260601_000077"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "chains"):
        return
    if not _has_column(bind, "chains", "withdraw_fee_maintenance_interval_sec"):
        op.add_column(
            "chains",
            sa.Column("withdraw_fee_maintenance_interval_sec", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "chains", "withdraw_fee_maintenance_interval_sec"):
        op.drop_column("chains", "withdraw_fee_maintenance_interval_sec")
