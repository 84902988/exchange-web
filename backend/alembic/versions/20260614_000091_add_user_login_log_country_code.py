"""add user login log country code

Revision ID: 20260614_000091
Revises: 20260613_000090
Create Date: 2026-06-14
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260614_000091"
down_revision = "20260613_000090"
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
    if _has_table(bind, "user_login_logs") and not _has_column(bind, "user_login_logs", "country_code"):
        op.add_column(
            "user_login_logs",
            sa.Column("country_code", sa.String(length=8), nullable=False, server_default="UNKNOWN"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "user_login_logs") and _has_column(bind, "user_login_logs", "country_code"):
        op.drop_column("user_login_logs", "country_code")
