"""add asset withdraw display config

Revision ID: 20260603_000080
Revises: 20260603_000079
Create Date: 2026-06-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260603_000080"
down_revision = "20260603_000079"
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
    if not _has_column(bind, "assets", "withdraw_sort_order"):
        op.add_column(
            "assets",
            sa.Column("withdraw_sort_order", sa.Integer(), nullable=False, server_default="100"),
        )
    if not _has_column(bind, "assets", "withdraw_quick_enabled"):
        op.add_column(
            "assets",
            sa.Column("withdraw_quick_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if not _has_column(bind, "assets", "withdraw_default_enabled"):
        op.add_column(
            "assets",
            sa.Column("withdraw_default_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "assets", "withdraw_default_enabled"):
        op.drop_column("assets", "withdraw_default_enabled")
    if _has_column(bind, "assets", "withdraw_quick_enabled"):
        op.drop_column("assets", "withdraw_quick_enabled")
    if _has_column(bind, "assets", "withdraw_sort_order"):
        op.drop_column("assets", "withdraw_sort_order")
