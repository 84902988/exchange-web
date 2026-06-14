"""add stock token release logs and conversion snapshot

Revision ID: 20260430_000011
Revises: 20260430_000010
Create Date: 2026-04-30 00:00:11
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260430_000011"
down_revision = "20260430_000010"
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

    if _has_table(bind, "user_stock_token_locks") and not _has_column(
        bind,
        "user_stock_token_locks",
        "conversion_rate_snapshot",
    ):
        op.add_column(
            "user_stock_token_locks",
            sa.Column(
                "conversion_rate_snapshot",
                sa.Numeric(36, 18),
                nullable=False,
                server_default="1.000000000000000000",
            ),
        )
        op.execute(
            """
            UPDATE user_stock_token_locks AS l
            JOIN stock_token_lock_configs AS c ON c.id = l.config_id
            SET l.conversion_rate_snapshot = c.conversion_rate
            """
        )

    if not _has_table(bind, "stock_token_release_logs"):
        op.create_table(
            "stock_token_release_logs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("run_time", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("trigger_type", sa.String(length=20), nullable=False, server_default="AUTO"),
            sa.Column("status", sa.String(length=30), nullable=False, server_default="SUCCESS"),
            sa.Column("scanned_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("released_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_release_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("item_ids", sa.Text(), nullable=True),
            sa.Column("message", sa.String(length=500), nullable=False, server_default=""),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )

    for index_name, columns in (
        ("idx_stock_token_release_logs_trigger", ["trigger_type"]),
        ("idx_stock_token_release_logs_status", ["status"]),
        ("idx_stock_token_release_logs_created_at", ["created_at"]),
    ):
        if not _has_index(bind, "stock_token_release_logs", index_name):
            op.create_index(index_name, "stock_token_release_logs", columns, unique=False)


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "stock_token_release_logs"):
        for index_name in (
            "idx_stock_token_release_logs_trigger",
            "idx_stock_token_release_logs_status",
            "idx_stock_token_release_logs_created_at",
        ):
            if _has_index(bind, "stock_token_release_logs", index_name):
                op.drop_index(index_name, table_name="stock_token_release_logs")
        op.drop_table("stock_token_release_logs")

    if _has_table(bind, "user_stock_token_locks") and _has_column(
        bind,
        "user_stock_token_locks",
        "conversion_rate_snapshot",
    ):
        op.drop_column("user_stock_token_locks", "conversion_rate_snapshot")
