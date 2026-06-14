"""add contract take profit stop loss fields

Revision ID: 20260501_000016
Revises: 20260501_000015
Create Date: 2026-05-01 00:00:16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000016"
down_revision = "20260501_000015"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "contract_orders") and not _has_column(bind, "contract_orders", "take_profit_price"):
        op.add_column("contract_orders", sa.Column("take_profit_price", sa.Numeric(36, 18), nullable=True))
    if _has_table(bind, "contract_orders") and not _has_column(bind, "contract_orders", "stop_loss_price"):
        op.add_column("contract_orders", sa.Column("stop_loss_price", sa.Numeric(36, 18), nullable=True))

    if _has_table(bind, "contract_positions") and not _has_column(bind, "contract_positions", "take_profit_price"):
        op.add_column("contract_positions", sa.Column("take_profit_price", sa.Numeric(36, 18), nullable=True))
    if _has_table(bind, "contract_positions") and not _has_column(bind, "contract_positions", "stop_loss_price"):
        op.add_column("contract_positions", sa.Column("stop_loss_price", sa.Numeric(36, 18), nullable=True))
    if _has_table(bind, "contract_positions") and not _has_column(bind, "contract_positions", "close_reason"):
        op.add_column("contract_positions", sa.Column("close_reason", sa.String(length=30), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "contract_positions") and _has_column(bind, "contract_positions", "close_reason"):
        op.drop_column("contract_positions", "close_reason")
    if _has_table(bind, "contract_positions") and _has_column(bind, "contract_positions", "stop_loss_price"):
        op.drop_column("contract_positions", "stop_loss_price")
    if _has_table(bind, "contract_positions") and _has_column(bind, "contract_positions", "take_profit_price"):
        op.drop_column("contract_positions", "take_profit_price")

    if _has_table(bind, "contract_orders") and _has_column(bind, "contract_orders", "stop_loss_price"):
        op.drop_column("contract_orders", "stop_loss_price")
    if _has_table(bind, "contract_orders") and _has_column(bind, "contract_orders", "take_profit_price"):
        op.drop_column("contract_orders", "take_profit_price")
