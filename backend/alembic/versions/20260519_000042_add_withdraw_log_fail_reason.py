"""add withdraw log reject reason

Revision ID: 20260519_000042
Revises: 20260519_000041
Create Date: 2026-05-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260519_000042"
down_revision = "20260519_000041"
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

    if not _has_column(bind, "withdraw_logs", "fail_reason"):
        op.add_column(
            "withdraw_logs",
            sa.Column(
                "fail_reason",
                sa.String(length=1000),
                nullable=True,
                comment="Withdraw review reject or risk reason",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "withdraw_logs", "fail_reason"):
        op.drop_column("withdraw_logs", "fail_reason")
