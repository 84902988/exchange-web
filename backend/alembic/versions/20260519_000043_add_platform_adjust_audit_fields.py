"""add platform adjust audit fields

Revision ID: 20260519_000043
Revises: 20260519_000042
Create Date: 2026-05-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260519_000043"
down_revision = "20260519_000042"
branch_labels = None
depends_on = None


AMOUNT = sa.Numeric(36, 18)


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _is_nullable(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return True
    for column in sa.inspect(bind).get_columns(table_name):
        if column.get("name") == column_name:
            return bool(column.get("nullable"))
    return True


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str]) -> None:
    if not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns)


def upgrade() -> None:
    bind = op.get_bind()
    table_name = "admin_balance_adjust_logs"

    if not _has_table(bind, table_name):
        op.create_table(
            table_name,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("admin_user", sa.String(length=64), nullable=True),
            sa.Column("admin_ip", sa.String(length=64), nullable=True),
            sa.Column("user_agent", sa.String(length=255), nullable=True),
            sa.Column("request_id", sa.String(length=64), nullable=True),
            sa.Column("target_user_id", sa.BigInteger(), nullable=False),
            sa.Column("coin_symbol", sa.String(length=32), nullable=False),
            sa.Column("chain_key", sa.String(length=32), nullable=False),
            sa.Column("direction", sa.String(length=16), nullable=False),
            sa.Column("amount", AMOUNT, nullable=False),
            sa.Column("before_available", AMOUNT, nullable=True),
            sa.Column("after_available", AMOUNT, nullable=True),
            sa.Column("reason", sa.String(length=64), nullable=False),
            sa.Column("remark", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
    else:
        if _has_column(bind, table_name, "admin_user") and not _is_nullable(bind, table_name, "admin_user"):
            op.alter_column(table_name, "admin_user", existing_type=sa.String(length=64), nullable=True)
        elif not _has_column(bind, table_name, "admin_user"):
            op.add_column(table_name, sa.Column("admin_user", sa.String(length=64), nullable=True))

        if not _has_column(bind, table_name, "before_available"):
            op.add_column(table_name, sa.Column("before_available", AMOUNT, nullable=True))

        if not _has_column(bind, table_name, "after_available"):
            op.add_column(table_name, sa.Column("after_available", AMOUNT, nullable=True))

        if not _has_column(bind, table_name, "admin_ip"):
            op.add_column(table_name, sa.Column("admin_ip", sa.String(length=64), nullable=True))

        if not _has_column(bind, table_name, "user_agent"):
            op.add_column(table_name, sa.Column("user_agent", sa.String(length=255), nullable=True))

        if not _has_column(bind, table_name, "request_id"):
            op.add_column(table_name, sa.Column("request_id", sa.String(length=64), nullable=True))

    _create_index_if_missing(bind, "idx_admin_adjust_target_time", table_name, ["target_user_id", "created_at"])
    _create_index_if_missing(bind, "idx_admin_adjust_coin_chain_time", table_name, ["coin_symbol", "chain_key", "created_at"])
    _create_index_if_missing(bind, "idx_admin_adjust_admin_time", table_name, ["admin_user", "created_at"])
    _create_index_if_missing(bind, "idx_admin_adjust_request_id", table_name, ["request_id"])


def downgrade() -> None:
    bind = op.get_bind()
    table_name = "admin_balance_adjust_logs"
    if not _has_table(bind, table_name):
        return

    if _has_index(bind, table_name, "idx_admin_adjust_request_id"):
        op.drop_index("idx_admin_adjust_request_id", table_name=table_name)

    for column_name in ("request_id", "user_agent", "admin_ip"):
        if _has_column(bind, table_name, column_name):
            op.drop_column(table_name, column_name)

    if _has_column(bind, table_name, "admin_user") and _is_nullable(bind, table_name, "admin_user"):
        op.execute("UPDATE admin_balance_adjust_logs SET admin_user = 'admin' WHERE admin_user IS NULL")
        op.alter_column(table_name, "admin_user", existing_type=sa.String(length=64), nullable=False)
