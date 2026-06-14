"""add admin trades query indexes

Revision ID: 20260519_000045
Revises: 20260519_000044
Create Date: 2026-05-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260519_000045"
down_revision = "20260519_000044"
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

    _create_index_if_possible(bind, "trades", "idx_trades_created_id", ["created_at", "id"])
    _create_index_if_possible(bind, "trades", "idx_trades_symbol_created", ["symbol", "created_at"])
    _create_index_if_possible(bind, "trades", "idx_trades_pair_created", ["trading_pair_id", "created_at"])
    _create_index_if_possible(bind, "trades", "idx_trades_buyer_created", ["buyer_user_id", "created_at"])
    _create_index_if_possible(bind, "trades", "idx_trades_seller_created", ["seller_user_id", "created_at"])
    _create_index_if_possible(bind, "trades", "idx_trades_buy_order", ["buy_order_id"])
    _create_index_if_possible(bind, "trades", "idx_trades_sell_order", ["sell_order_id"])
    _create_index_if_possible(bind, "trades", "idx_trades_counterparty_created", ["counterparty_type", "created_at"])

    _create_index_if_possible(bind, "balance_logs", "idx_balance_logs_biz_id", ["biz_id"])
    _create_index_if_possible(bind, "balance_logs", "idx_balance_logs_request_id", ["request_id"])
    _create_index_if_possible(bind, "balance_logs", "idx_balance_logs_change_type_created", ["change_type", "created_at"])
    _create_index_if_possible(bind, "balance_logs", "idx_balance_logs_biz_type_created", ["biz_type", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    for table_name, index_name in (
        ("balance_logs", "idx_balance_logs_biz_type_created"),
        ("balance_logs", "idx_balance_logs_change_type_created"),
        ("balance_logs", "idx_balance_logs_request_id"),
        ("balance_logs", "idx_balance_logs_biz_id"),
        ("trades", "idx_trades_counterparty_created"),
        ("trades", "idx_trades_sell_order"),
        ("trades", "idx_trades_buy_order"),
        ("trades", "idx_trades_seller_created"),
        ("trades", "idx_trades_buyer_created"),
        ("trades", "idx_trades_pair_created"),
        ("trades", "idx_trades_symbol_created"),
        ("trades", "idx_trades_created_id"),
    ):
        if _has_index(bind, table_name, index_name):
            op.drop_index(index_name, table_name=table_name)
