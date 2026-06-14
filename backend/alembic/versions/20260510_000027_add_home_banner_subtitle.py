"""add home banner subtitle

Revision ID: 20260510_000027
Revises: 20260510_000026
Create Date: 2026-05-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260510_000027"
down_revision = "20260510_000026"
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
    if _has_table(bind, "home_banners") and not _has_column(bind, "home_banners", "subtitle"):
        op.add_column("home_banners", sa.Column("subtitle", sa.String(length=255), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "home_banners") and _has_column(bind, "home_banners", "subtitle"):
        op.drop_column("home_banners", "subtitle")
