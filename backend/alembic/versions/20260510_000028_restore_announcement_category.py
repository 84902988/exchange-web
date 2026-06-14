"""restore announcement category

Revision ID: 20260510_000028
Revises: 20260510_000027
Create Date: 2026-05-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260510_000028"
down_revision = "20260510_000027"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "announcements") and not _has_column(bind, "announcements", "category"):
        op.add_column(
            "announcements",
            sa.Column("category", sa.String(length=20), nullable=True, server_default="platform"),
        )
    if _has_table(bind, "announcements") and not _has_index(bind, "announcements", "idx_announcements_category"):
        op.create_index("idx_announcements_category", "announcements", ["category"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "announcements") and _has_index(bind, "announcements", "idx_announcements_category"):
        op.drop_index("idx_announcements_category", table_name="announcements")
    if _has_table(bind, "announcements") and _has_column(bind, "announcements", "category"):
        op.drop_column("announcements", "category")
