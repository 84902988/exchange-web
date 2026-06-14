"""add asset deposit display config

Revision ID: 20260603_000079
Revises: 20260602_000078
Create Date: 2026-06-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260603_000079"
down_revision = "20260602_000078"
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
    if not _has_table(bind, "assets"):
        return
    if not _has_column(bind, "assets", "deposit_sort_order"):
        op.add_column(
            "assets",
            sa.Column("deposit_sort_order", sa.Integer(), nullable=False, server_default="100"),
        )
    if not _has_column(bind, "assets", "deposit_quick_enabled"):
        op.add_column(
            "assets",
            sa.Column("deposit_quick_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if not _has_column(bind, "assets", "deposit_default_enabled"):
        op.add_column(
            "assets",
            sa.Column("deposit_default_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "assets", "deposit_default_enabled"):
        op.drop_column("assets", "deposit_default_enabled")
    if _has_column(bind, "assets", "deposit_quick_enabled"):
        op.drop_column("assets", "deposit_quick_enabled")
    if _has_column(bind, "assets", "deposit_sort_order"):
        op.drop_column("assets", "deposit_sort_order")
