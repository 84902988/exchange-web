"""add mobile announcement category translation field

Revision ID: 20260809_000135
Revises: 20260803_000134
Create Date: 2026-08-09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260809_000135"
down_revision = "20260803_000134"
branch_labels = None
depends_on = None


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table_name):
        return False
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "mobile_announcements", "category_label_i18n"):
        op.add_column(
            "mobile_announcements",
            sa.Column("category_label_i18n", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "mobile_announcements", "category_label_i18n"):
        op.drop_column("mobile_announcements", "category_label_i18n")
