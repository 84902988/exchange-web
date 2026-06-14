"""add phone to user profiles

Revision ID: 20260517_000034
Revises: 20260517_000033
Create Date: 2026-05-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260517_000034"
down_revision = "20260517_000033"
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

    if not _has_table(bind, "user_profiles"):
        return

    if not _has_column(bind, "user_profiles", "phone"):
        op.add_column("user_profiles", sa.Column("phone", sa.String(length=32), nullable=True))

    if not _has_index(bind, "user_profiles", "ix_user_profiles_phone"):
        op.create_index("ix_user_profiles_phone", "user_profiles", ["phone"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "user_profiles"):
        return

    if _has_index(bind, "user_profiles", "ix_user_profiles_phone"):
        op.drop_index("ix_user_profiles_phone", table_name="user_profiles")

    if _has_column(bind, "user_profiles", "phone"):
        op.drop_column("user_profiles", "phone")
