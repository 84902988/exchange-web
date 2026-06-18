"""add trade id to contract accounting logs

Revision ID: 20260616_000098
Revises: 20260616_000097
Create Date: 2026-06-16
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "20260616_000098"
down_revision: Union[str, None] = "20260616_000097"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(table_name: str, column_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def _has_index(table_name: str, index_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    if _has_table("balance_logs") and not _has_column("balance_logs", "trade_id"):
        op.add_column("balance_logs", sa.Column("trade_id", mysql.BIGINT(unsigned=True), nullable=True))
    if _has_table("balance_logs") and not _has_index("balance_logs", "idx_balance_logs_trade_id"):
        op.create_index("idx_balance_logs_trade_id", "balance_logs", ["trade_id"], unique=False)

    if _has_table("contract_margin_logs") and not _has_column("contract_margin_logs", "trade_id"):
        op.add_column("contract_margin_logs", sa.Column("trade_id", mysql.BIGINT(unsigned=True), nullable=True))
    if _has_table("contract_margin_logs") and not _has_index("contract_margin_logs", "idx_contract_margin_logs_trade"):
        op.create_index("idx_contract_margin_logs_trade", "contract_margin_logs", ["trade_id"], unique=False)


def downgrade() -> None:
    if _has_table("contract_margin_logs"):
        if _has_index("contract_margin_logs", "idx_contract_margin_logs_trade"):
            op.drop_index("idx_contract_margin_logs_trade", table_name="contract_margin_logs")
        if _has_column("contract_margin_logs", "trade_id"):
            op.drop_column("contract_margin_logs", "trade_id")
    if _has_table("balance_logs"):
        if _has_index("balance_logs", "idx_balance_logs_trade_id"):
            op.drop_index("idx_balance_logs_trade_id", table_name="balance_logs")
        if _has_column("balance_logs", "trade_id"):
            op.drop_column("balance_logs", "trade_id")
