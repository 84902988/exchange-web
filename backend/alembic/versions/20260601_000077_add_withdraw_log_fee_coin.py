"""add withdraw log fee coin

Revision ID: 20260601_000077
Revises: 20260601_000076
Create Date: 2026-06-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260601_000077"
down_revision = "20260601_000076"
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
    if not _has_table(bind, "withdraw_logs"):
        return
    if not _has_column(bind, "withdraw_logs", "fee_coin"):
        op.add_column(
            "withdraw_logs",
            sa.Column("fee_coin", sa.String(length=32), nullable=False, server_default="USDT"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "withdraw_logs", "fee_coin"):
        op.drop_column("withdraw_logs", "fee_coin")
