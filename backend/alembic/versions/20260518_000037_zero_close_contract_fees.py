"""zero fees on close contract orders and trades

Revision ID: 20260518_000037
Revises: 20260517_000036
Create Date: 2026-05-18 00:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260518_000037"
down_revision = "20260517_000036"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _zero_close_fees(table_name: str) -> None:
    bind = op.get_bind()
    if not _has_table(bind, table_name) or not _has_column(bind, table_name, "action"):
        return

    assignments: list[str] = []
    if _has_column(bind, table_name, "fee_amount"):
        assignments.append("fee_amount = 0")
    if _has_column(bind, table_name, "spread_fee"):
        assignments.append("spread_fee = 0")
    if not assignments:
        return

    op.execute(sa.text(f"UPDATE {table_name} SET {', '.join(assignments)} WHERE action = 'CLOSE'"))


def upgrade() -> None:
    _zero_close_fees("contract_orders")
    _zero_close_fees("contract_trades")


def downgrade() -> None:
    pass
