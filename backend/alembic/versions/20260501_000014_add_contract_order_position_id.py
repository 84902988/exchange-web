"""add contract order position id

Revision ID: 20260501_000014
Revises: 20260501_000013
Create Date: 2026-05-01 00:00:14
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000014"
down_revision = "20260501_000013"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "contract_orders") and not _has_column(bind, "contract_orders", "position_id"):
        op.add_column("contract_orders", sa.Column("position_id", sa.BigInteger(), nullable=True))

    if _has_table(bind, "contract_orders") and not _has_index(bind, "contract_orders", "idx_contract_orders_position"):
        op.create_index("idx_contract_orders_position", "contract_orders", ["position_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "contract_orders") and _has_index(bind, "contract_orders", "idx_contract_orders_position"):
        op.drop_index("idx_contract_orders_position", table_name="contract_orders")

    if _has_table(bind, "contract_orders") and _has_column(bind, "contract_orders", "position_id"):
        op.drop_column("contract_orders", "position_id")
