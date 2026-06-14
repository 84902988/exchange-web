"""add contract cfd v1 tables

Revision ID: 20260501_000012
Revises: 20260430_000011
Create Date: 2026-05-01 00:00:12
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000012"
down_revision = "20260430_000011"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str], unique: bool = False) -> None:
    if _has_table(bind, table_name) and not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=unique)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "contract_symbols"):
        op.create_table(
            "contract_symbols",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("symbol", sa.String(length=64), nullable=False),
            sa.Column("display_name", sa.String(length=100), nullable=False),
            sa.Column("category", sa.String(length=20), nullable=False),
            sa.Column("provider", sa.String(length=20), nullable=False),
            sa.Column("provider_symbol", sa.String(length=64), nullable=False),
            sa.Column("quote_asset", sa.String(length=20), nullable=False, server_default="USDT"),
            sa.Column("price_precision", sa.Integer(), nullable=False, server_default="8"),
            sa.Column("quantity_precision", sa.Integer(), nullable=False, server_default="8"),
            sa.Column("min_quantity", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("max_quantity", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("min_margin", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("max_leverage", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("spread_x", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("liquidation_threshold", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("warning_threshold", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.SmallInteger(), nullable=False, server_default="1"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("symbol", name="uk_contract_symbols_symbol"),
            sa.CheckConstraint("spread_x >= 0 AND spread_x <= 100", name="ck_contract_symbols_spread_x_range"),
            sa.CheckConstraint("max_leverage >= 1 AND max_leverage <= 200", name="ck_contract_symbols_max_leverage_range"),
            sa.CheckConstraint("status IN (0, 1)", name="ck_contract_symbols_status"),
        )

    for index_name, columns in (
        ("idx_contract_symbols_category", ["category"]),
        ("idx_contract_symbols_provider", ["provider"]),
        ("idx_contract_symbols_status", ["status"]),
    ):
        _create_index_if_missing(bind, index_name, "contract_symbols", columns)

    if not _has_table(bind, "contract_accounts"):
        op.create_table(
            "contract_accounts",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("margin_asset", sa.String(length=20), nullable=False, server_default="USDT"),
            sa.Column("available_margin", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("frozen_margin", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("position_margin", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("realized_pnl", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("unrealized_pnl", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("version", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("user_id", "margin_asset", name="uk_contract_accounts_user_asset"),
        )

    _create_index_if_missing(bind, "idx_contract_accounts_user", "contract_accounts", ["user_id"])

    if not _has_table(bind, "contract_positions"):
        op.create_table(
            "contract_positions",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("symbol", sa.String(length=64), nullable=False),
            sa.Column("side", sa.String(length=10), nullable=False),
            sa.Column("margin_mode", sa.String(length=20), nullable=False, server_default="ISOLATED"),
            sa.Column("leverage", sa.Integer(), nullable=False),
            sa.Column("quantity", sa.Numeric(36, 18), nullable=False),
            sa.Column("entry_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("mark_price", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("margin_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("open_fee", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("unrealized_pnl", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("realized_pnl", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("liquidation_price", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("warning_price", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="OPEN"),
            sa.Column("opened_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("closed_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
        )

    for index_name, columns in (
        ("idx_contract_positions_user", ["user_id"]),
        ("idx_contract_positions_symbol", ["symbol"]),
        ("idx_contract_positions_user_symbol_status", ["user_id", "symbol", "status"]),
        ("idx_contract_positions_status", ["status"]),
    ):
        _create_index_if_missing(bind, index_name, "contract_positions", columns)

    if not _has_table(bind, "contract_orders"):
        op.create_table(
            "contract_orders",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("order_no", sa.String(length=64), nullable=False),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("symbol", sa.String(length=64), nullable=False),
            sa.Column("side", sa.String(length=10), nullable=False),
            sa.Column("position_side", sa.String(length=10), nullable=False),
            sa.Column("action", sa.String(length=10), nullable=False),
            sa.Column("order_type", sa.String(length=20), nullable=False),
            sa.Column("price", sa.Numeric(36, 18), nullable=True),
            sa.Column("quantity", sa.Numeric(36, 18), nullable=False),
            sa.Column("leverage", sa.Integer(), nullable=False),
            sa.Column("margin_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("spread_x_snapshot", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("spread_fee", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("trigger_price", sa.Numeric(36, 18), nullable=True),
            sa.Column("filled_quantity", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("avg_price", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="NEW"),
            sa.Column("fail_reason", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("order_no", name="uk_contract_orders_order_no"),
        )

    for index_name, columns in (
        ("idx_contract_orders_user", ["user_id"]),
        ("idx_contract_orders_symbol", ["symbol"]),
        ("idx_contract_orders_user_symbol_status", ["user_id", "symbol", "status"]),
        ("idx_contract_orders_status_created_at", ["status", "created_at"]),
    ):
        _create_index_if_missing(bind, index_name, "contract_orders", columns)

    if not _has_table(bind, "contract_trades"):
        op.create_table(
            "contract_trades",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("trade_no", sa.String(length=64), nullable=False),
            sa.Column("order_id", sa.BigInteger(), nullable=False),
            sa.Column("position_id", sa.BigInteger(), nullable=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("symbol", sa.String(length=64), nullable=False),
            sa.Column("side", sa.String(length=10), nullable=False),
            sa.Column("position_side", sa.String(length=10), nullable=False),
            sa.Column("action", sa.String(length=10), nullable=False),
            sa.Column("price", sa.Numeric(36, 18), nullable=False),
            sa.Column("quantity", sa.Numeric(36, 18), nullable=False),
            sa.Column("notional", sa.Numeric(36, 18), nullable=False),
            sa.Column("leverage", sa.Integer(), nullable=False),
            sa.Column("margin_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("spread_fee", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("realized_pnl", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.UniqueConstraint("trade_no", name="uk_contract_trades_trade_no"),
        )

    for index_name, columns in (
        ("idx_contract_trades_order", ["order_id"]),
        ("idx_contract_trades_position", ["position_id"]),
        ("idx_contract_trades_user", ["user_id"]),
        ("idx_contract_trades_symbol", ["symbol"]),
        ("idx_contract_trades_created_at", ["created_at"]),
    ):
        _create_index_if_missing(bind, index_name, "contract_trades", columns)

    if not _has_table(bind, "contract_margin_logs"):
        op.create_table(
            "contract_margin_logs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("account_id", sa.BigInteger(), nullable=False),
            sa.Column("position_id", sa.BigInteger(), nullable=True),
            sa.Column("order_id", sa.BigInteger(), nullable=True),
            sa.Column("symbol", sa.String(length=64), nullable=True),
            sa.Column("change_type", sa.String(length=40), nullable=False),
            sa.Column("change_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("before_available", sa.Numeric(36, 18), nullable=False),
            sa.Column("after_available", sa.Numeric(36, 18), nullable=False),
            sa.Column("before_frozen", sa.Numeric(36, 18), nullable=False),
            sa.Column("after_frozen", sa.Numeric(36, 18), nullable=False),
            sa.Column("remark", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )

    for index_name, columns in (
        ("idx_contract_margin_logs_user", ["user_id"]),
        ("idx_contract_margin_logs_account", ["account_id"]),
        ("idx_contract_margin_logs_position", ["position_id"]),
        ("idx_contract_margin_logs_order", ["order_id"]),
        ("idx_contract_margin_logs_change_type", ["change_type"]),
        ("idx_contract_margin_logs_created_at", ["created_at"]),
    ):
        _create_index_if_missing(bind, index_name, "contract_margin_logs", columns)

    if not _has_table(bind, "contract_liquidation_records"):
        op.create_table(
            "contract_liquidation_records",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("position_id", sa.BigInteger(), nullable=False),
            sa.Column("symbol", sa.String(length=64), nullable=False),
            sa.Column("side", sa.String(length=10), nullable=False),
            sa.Column("leverage", sa.Integer(), nullable=False),
            sa.Column("quantity", sa.Numeric(36, 18), nullable=False),
            sa.Column("entry_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("mark_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("liquidation_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("margin_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("unrealized_pnl", sa.Numeric(36, 18), nullable=False),
            sa.Column("remaining_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="TRIGGERED"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
        )

    for index_name, columns in (
        ("idx_contract_liquidation_records_user", ["user_id"]),
        ("idx_contract_liquidation_records_position", ["position_id"]),
        ("idx_contract_liquidation_records_symbol", ["symbol"]),
        ("idx_contract_liquidation_records_status", ["status"]),
    ):
        _create_index_if_missing(bind, index_name, "contract_liquidation_records", columns)


def downgrade() -> None:
    bind = op.get_bind()

    for table_name in (
        "contract_liquidation_records",
        "contract_margin_logs",
        "contract_trades",
        "contract_orders",
        "contract_positions",
        "contract_accounts",
        "contract_symbols",
    ):
        if _has_table(bind, table_name):
            op.drop_table(table_name)
