"""add chain icon url

Revision ID: 20260603_000082
Revises: 20260603_000081
Create Date: 2026-06-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260603_000082"
down_revision = "20260603_000081"
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
    if not _has_column(bind, "chains", "icon_url"):
        op.add_column("chains", sa.Column("icon_url", sa.String(length=512), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "chains", "icon_url"):
        op.drop_column("chains", "icon_url")
