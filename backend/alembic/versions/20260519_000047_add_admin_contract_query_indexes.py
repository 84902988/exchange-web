"""add admin contract query indexes

Revision ID: 20260519_000047
Revises: 20260519_000046
Create Date: 2026-05-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260519_000047"
down_revision = "20260519_000046"
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

    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_created_id", ["created_at", "id"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_order_no", ["order_no"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_user_created", ["user_id", "created_at"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_symbol_created", ["symbol", "created_at"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_position_created", ["position_id", "created_at"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_side_created", ["side", "created_at"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_position_side_created", ["position_side", "created_at"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_action_created", ["action", "created_at"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_type_created", ["order_type", "created_at"])
    _create_index_if_possible(bind, "contract_orders", "idx_contract_orders_status_created", ["status", "created_at"])

    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_created_id", ["created_at", "id"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_user_created", ["user_id", "created_at"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_symbol_created", ["symbol", "created_at"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_order_created", ["order_id", "created_at"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_position_created", ["position_id", "created_at"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_side_created", ["side", "created_at"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_position_side_created", ["position_side", "created_at"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_action_created", ["action", "created_at"])
    _create_index_if_possible(bind, "contract_trades", "idx_contract_trades_type_created", ["order_type", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    for table_name, index_name in (
        ("contract_trades", "idx_contract_trades_type_created"),
        ("contract_trades", "idx_contract_trades_action_created"),
        ("contract_trades", "idx_contract_trades_position_side_created"),
        ("contract_trades", "idx_contract_trades_side_created"),
        ("contract_trades", "idx_contract_trades_position_created"),
        ("contract_trades", "idx_contract_trades_order_created"),
        ("contract_trades", "idx_contract_trades_symbol_created"),
        ("contract_trades", "idx_contract_trades_user_created"),
        ("contract_trades", "idx_contract_trades_created_id"),
        ("contract_orders", "idx_contract_orders_status_created"),
        ("contract_orders", "idx_contract_orders_type_created"),
        ("contract_orders", "idx_contract_orders_action_created"),
        ("contract_orders", "idx_contract_orders_position_side_created"),
        ("contract_orders", "idx_contract_orders_side_created"),
        ("contract_orders", "idx_contract_orders_position_created"),
        ("contract_orders", "idx_contract_orders_symbol_created"),
        ("contract_orders", "idx_contract_orders_user_created"),
        ("contract_orders", "idx_contract_orders_order_no"),
        ("contract_orders", "idx_contract_orders_created_id"),
    ):
        if _has_index(bind, table_name, index_name):
            op.drop_index(index_name, table_name=table_name)
