"""add admin orders query indexes

Revision ID: 20260519_000046
Revises: 20260519_000045
Create Date: 2026-05-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260519_000046"
down_revision = "20260519_000045"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_columns(bind, table_name: str, columns: list[str]) -> bool:
    if not _has_table(bind, table_name):
        return False
    existing = {column.get("name") for column in sa.inspect(bind).get_columns(table_name)}
    return all(column in existing for column in columns)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_possible(bind, table_name: str, index_name: str, columns: list[str]) -> None:
    if _has_columns(bind, table_name, columns) and not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns)


def upgrade() -> None:
    bind = op.get_bind()

    _create_index_if_possible(bind, "orders", "idx_orders_created_id", ["created_at", "id"])
    _create_index_if_possible(bind, "orders", "idx_orders_symbol_created", ["symbol", "created_at"])
    _create_index_if_possible(bind, "orders", "idx_orders_pair_created", ["trading_pair_id", "created_at"])
    _create_index_if_possible(bind, "orders", "idx_orders_user_created", ["user_id", "created_at"])
    _create_index_if_possible(bind, "orders", "idx_orders_order_no", ["order_no"])
    _create_index_if_possible(bind, "orders", "idx_orders_side_created", ["side", "created_at"])
    _create_index_if_possible(bind, "orders", "idx_orders_type_created", ["order_type", "created_at"])
    _create_index_if_possible(bind, "orders", "idx_orders_status_created", ["status", "created_at"])
    _create_index_if_possible(bind, "orders", "idx_orders_exec_mode_created", ["execution_mode", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    for index_name in (
        "idx_orders_exec_mode_created",
        "idx_orders_status_created",
        "idx_orders_type_created",
        "idx_orders_side_created",
        "idx_orders_order_no",
        "idx_orders_user_created",
        "idx_orders_pair_created",
        "idx_orders_symbol_created",
        "idx_orders_created_id",
    ):
        if _has_index(bind, "orders", index_name):
            op.drop_index(index_name, table_name="orders")
