"""add stock token lock tables

Revision ID: 20260430_000010
Revises: 20260430_000009
Create Date: 2026-04-30 00:00:10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "20260430_000010"
down_revision = "20260430_000009"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "stock_token_lock_configs"):
        op.create_table(
            "stock_token_lock_configs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("lock_symbol", sa.String(length=50), nullable=False),
            sa.Column("trade_symbol", sa.String(length=50), nullable=False),
            sa.Column("display_name", sa.String(length=100), nullable=False),
            sa.Column("lock_days", sa.Integer(), nullable=False, server_default="90"),
            sa.Column("daily_release_rate", sa.Numeric(18, 8), nullable=False, server_default="0.05000000"),
            sa.Column(
                "conversion_rate",
                sa.Numeric(36, 18),
                nullable=False,
                server_default="1.000000000000000000",
            ),
            sa.Column("is_active", mysql.TINYINT(display_width=1), nullable=False, server_default="1"),
            sa.Column("remark", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
        )
        op.create_index("idx_stock_token_lock_configs_lock_symbol", "stock_token_lock_configs", ["lock_symbol"])
        op.create_index("idx_stock_token_lock_configs_trade_symbol", "stock_token_lock_configs", ["trade_symbol"])

    if not _has_table(bind, "user_stock_token_locks"):
        op.create_table(
            "user_stock_token_locks",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("config_id", sa.BigInteger(), nullable=False),
            sa.Column("lock_symbol", sa.String(length=50), nullable=False),
            sa.Column("total_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("locked_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("available_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("converted_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("daily_release_rate_snapshot", sa.Numeric(18, 8), nullable=False, server_default="0.05000000"),
            sa.Column("start_at", sa.DateTime(), nullable=False),
            sa.Column("end_at", sa.DateTime(), nullable=False),
            sa.Column("status", sa.String(length=30), nullable=False, server_default="ACTIVE"),
            sa.Column("source_type", sa.String(length=50), nullable=False, server_default="OTC_DEPOSIT"),
            sa.Column("source_id", sa.BigInteger(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
        )

    for index_name, columns in (
        ("idx_user_stock_token_locks_user", ["user_id"]),
        ("idx_user_stock_token_locks_config", ["config_id"]),
        ("idx_user_stock_token_locks_status", ["status"]),
        ("idx_user_stock_token_locks_symbol", ["lock_symbol"]),
    ):
        if not _has_index(bind, "user_stock_token_locks", index_name):
            op.create_index(index_name, "user_stock_token_locks", columns, unique=False)

    if not _has_table(bind, "stock_token_convert_records"):
        op.create_table(
            "stock_token_convert_records",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("config_id", sa.BigInteger(), nullable=False),
            sa.Column("from_symbol", sa.String(length=50), nullable=False),
            sa.Column("to_symbol", sa.String(length=50), nullable=False),
            sa.Column("from_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("to_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("conversion_rate", sa.Numeric(36, 18), nullable=False),
            sa.Column("status", sa.String(length=30), nullable=False, server_default="SUCCESS"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )

    for index_name, columns in (
        ("idx_stock_token_convert_records_user", ["user_id"]),
        ("idx_stock_token_convert_records_config", ["config_id"]),
        ("idx_stock_token_convert_records_status", ["status"]),
    ):
        if not _has_index(bind, "stock_token_convert_records", index_name):
            op.create_index(index_name, "stock_token_convert_records", columns, unique=False)


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "stock_token_convert_records"):
        for index_name in (
            "idx_stock_token_convert_records_user",
            "idx_stock_token_convert_records_config",
            "idx_stock_token_convert_records_status",
        ):
            if _has_index(bind, "stock_token_convert_records", index_name):
                op.drop_index(index_name, table_name="stock_token_convert_records")
        op.drop_table("stock_token_convert_records")

    if _has_table(bind, "user_stock_token_locks"):
        for index_name in (
            "idx_user_stock_token_locks_user",
            "idx_user_stock_token_locks_config",
            "idx_user_stock_token_locks_status",
            "idx_user_stock_token_locks_symbol",
        ):
            if _has_index(bind, "user_stock_token_locks", index_name):
                op.drop_index(index_name, table_name="user_stock_token_locks")
        op.drop_table("user_stock_token_locks")

    if _has_table(bind, "stock_token_lock_configs"):
        for index_name in (
            "idx_stock_token_lock_configs_lock_symbol",
            "idx_stock_token_lock_configs_trade_symbol",
        ):
            if _has_index(bind, "stock_token_lock_configs", index_name):
                op.drop_index(index_name, table_name="stock_token_lock_configs")
        op.drop_table("stock_token_lock_configs")
