"""add legal pages to site settings

Revision ID: 20260616_000100
Revises: 20260616_000099
Create Date: 2026-06-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260616_000100"
down_revision = "20260616_000099"
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
    if _has_table(bind, "site_settings") and not _has_column(bind, "site_settings", "legal_pages_i18n"):
        op.add_column("site_settings", sa.Column("legal_pages_i18n", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "site_settings") and _has_column(bind, "site_settings", "legal_pages_i18n"):
        op.drop_column("site_settings", "legal_pages_i18n")
