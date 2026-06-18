"""add core archive infrastructure

Revision ID: 20260619_000109
Revises: 20260619_000108
Create Date: 2026-06-19 00:01:09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260619_000109"
down_revision = "20260619_000108"
branch_labels = None
depends_on = None


AMOUNT = sa.Numeric(36, 18)


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "core_archive_batches"):
        op.create_table(
            "core_archive_batches",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("batch_id", sa.String(length=96), nullable=False),
            sa.Column("source_table", sa.String(length=64), nullable=False),
            sa.Column("archive_table", sa.String(length=64), nullable=False),
            sa.Column("archive_month", sa.String(length=7), nullable=False),
            sa.Column("period_start", sa.DateTime(), nullable=False),
            sa.Column("period_end", sa.DateTime(), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="DRY_RUN"),
            sa.Column("dry_run", sa.Boolean(), nullable=False, server_default=sa.text("1")),
            sa.Column("source_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("copied_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("verified_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("deleted_count", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("min_id", sa.BigInteger(), nullable=True),
            sa.Column("max_id", sa.BigInteger(), nullable=True),
            sa.Column("checksum_json", sa.Text(), nullable=True),
            sa.Column("sum_json", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_by", sa.String(length=64), nullable=True),
            sa.Column("approved_by", sa.String(length=64), nullable=True),
            sa.Column("approved_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("batch_id", name="uk_core_archive_batches_batch_id"),
        )
        op.create_index(
            "idx_core_archive_batches_source_month",
            "core_archive_batches",
            ["source_table", "archive_month"],
        )
        op.create_index(
            "idx_core_archive_batches_status_started",
            "core_archive_batches",
            ["status", "started_at"],
        )

    if not _has_table(bind, "archive_orders"):
        op.create_table(
            "archive_orders",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
            sa.Column("order_no", sa.String(length=64), nullable=False),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("trading_pair_id", sa.BigInteger(), nullable=False),
            sa.Column("side", sa.String(length=10), nullable=False),
            sa.Column("order_type", sa.String(length=20), nullable=False),
            sa.Column("execution_mode", sa.String(length=20), nullable=False),
            sa.Column("price", AMOUNT, nullable=True),
            sa.Column("amount", AMOUNT, nullable=False),
            sa.Column("filled_amount", AMOUNT, nullable=False),
            sa.Column("avg_price", AMOUNT, nullable=False),
            sa.Column("frozen_amount", AMOUNT, nullable=False),
            sa.Column("executed_quote_amount", AMOUNT, nullable=False),
            sa.Column("fee_amount", AMOUNT, nullable=False),
            sa.Column("fee_asset_symbol", sa.String(length=20), nullable=True),
            sa.Column("fee_asset_id", sa.BigInteger(), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("source", sa.String(length=20), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.Column("archive_month", sa.String(length=7), nullable=False),
            sa.Column("archive_batch_id", sa.String(length=96), nullable=False),
            sa.Column("archived_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("uk_archive_orders_order_no", "archive_orders", ["order_no"], unique=True)
        op.create_index("idx_archive_orders_user_created", "archive_orders", ["user_id", "created_at"])
        op.create_index("idx_archive_orders_pair_created", "archive_orders", ["trading_pair_id", "created_at"])
        op.create_index("idx_archive_orders_status_created", "archive_orders", ["status", "created_at"])
        op.create_index("idx_archive_orders_month", "archive_orders", ["archive_month"])
        op.create_index("idx_archive_orders_batch", "archive_orders", ["archive_batch_id"])

    if not _has_table(bind, "archive_trades"):
        op.create_table(
            "archive_trades",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
            sa.Column("trading_pair_id", sa.BigInteger(), nullable=False),
            sa.Column("buy_order_id", sa.BigInteger(), nullable=False),
            sa.Column("sell_order_id", sa.BigInteger(), nullable=False),
            sa.Column("buyer_user_id", sa.BigInteger(), nullable=False),
            sa.Column("seller_user_id", sa.BigInteger(), nullable=False),
            sa.Column("price", AMOUNT, nullable=False),
            sa.Column("amount", AMOUNT, nullable=False),
            sa.Column("quote_amount", AMOUNT, nullable=False),
            sa.Column("fee_amount", AMOUNT, nullable=True),
            sa.Column("fee_asset_symbol", sa.String(length=20), nullable=True),
            sa.Column("buyer_fee_amount", AMOUNT, nullable=True),
            sa.Column("buyer_fee_asset_symbol", sa.String(length=20), nullable=True),
            sa.Column("seller_fee_amount", AMOUNT, nullable=True),
            sa.Column("seller_fee_asset_symbol", sa.String(length=20), nullable=True),
            sa.Column("dealer_ref_price", AMOUNT, nullable=True),
            sa.Column("dealer_best_bid", AMOUNT, nullable=True),
            sa.Column("dealer_best_ask", AMOUNT, nullable=True),
            sa.Column("dealer_price_source", sa.String(length=32), nullable=True),
            sa.Column("dealer_spread_bps", sa.Numeric(18, 8), nullable=True),
            sa.Column("maker_order_id", sa.BigInteger(), nullable=False),
            sa.Column("taker_order_id", sa.BigInteger(), nullable=False),
            sa.Column("counterparty_type", sa.String(length=20), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("archive_month", sa.String(length=7), nullable=False),
            sa.Column("archive_batch_id", sa.String(length=96), nullable=False),
            sa.Column("archived_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("idx_archive_trades_buyer_created", "archive_trades", ["buyer_user_id", "created_at"])
        op.create_index("idx_archive_trades_seller_created", "archive_trades", ["seller_user_id", "created_at"])
        op.create_index("idx_archive_trades_pair_created", "archive_trades", ["trading_pair_id", "created_at"])
        op.create_index("idx_archive_trades_buy_order", "archive_trades", ["buy_order_id"])
        op.create_index("idx_archive_trades_sell_order", "archive_trades", ["sell_order_id"])
        op.create_index("idx_archive_trades_month", "archive_trades", ["archive_month"])
        op.create_index("idx_archive_trades_batch", "archive_trades", ["archive_batch_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "archive_trades"):
        op.drop_table("archive_trades")
    if _has_table(bind, "archive_orders"):
        op.drop_table("archive_orders")
    if _has_table(bind, "core_archive_batches"):
        op.drop_table("core_archive_batches")
