"""add orders match scan index

Revision ID: 20260519_000044
Revises: 20260519_000043
Create Date: 2026-05-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260519_000044"
down_revision = "20260519_000043"
branch_labels = None
depends_on = None


INDEX_NAME = "idx_orders_match_scan"
TABLE_NAME = "orders"
INDEX_COLUMNS = [
    "trading_pair_id",
    "side",
    "order_type",
    "execution_mode",
    "status",
    "price",
    "id",
]


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, TABLE_NAME) and not _has_index(bind, TABLE_NAME, INDEX_NAME):
        op.create_index(INDEX_NAME, TABLE_NAME, INDEX_COLUMNS)


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, TABLE_NAME, INDEX_NAME):
        op.drop_index(INDEX_NAME, table_name=TABLE_NAME)
