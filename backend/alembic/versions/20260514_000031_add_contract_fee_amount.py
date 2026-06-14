"""add contract fee amount columns

Revision ID: 20260514_000031
Revises: 20260511_000030
Create Date: 2026-05-14
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260514_000031"
down_revision = "20260511_000030"
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
    for table_name in ("contract_orders", "contract_trades"):
        if _has_table(bind, table_name) and not _has_column(bind, table_name, "fee_amount"):
            op.add_column(
                table_name,
                sa.Column("fee_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            )


def downgrade() -> None:
    bind = op.get_bind()
    for table_name in ("contract_trades", "contract_orders"):
        if _has_table(bind, table_name) and _has_column(bind, table_name, "fee_amount"):
            op.drop_column(table_name, "fee_amount")
