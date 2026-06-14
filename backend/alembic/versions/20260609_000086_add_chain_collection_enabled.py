"""add chain collection enabled switch

Revision ID: 20260609_000086
Revises: 20260608_000085
Create Date: 2026-06-09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260609_000086"
down_revision = "20260608_000085"
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
    if _has_table(bind, "chains") and not _has_column(bind, "chains", "collection_enabled"):
        op.add_column(
            "chains",
            sa.Column("collection_enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "chains") and _has_column(bind, "chains", "collection_enabled"):
        op.drop_column("chains", "collection_enabled")
