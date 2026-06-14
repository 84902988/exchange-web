"""add user withdraw lock

Revision ID: 20260527_000056
Revises: 20260523_000055
Create Date: 2026-05-27
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260527_000056"
down_revision = "20260523_000055"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "users", "withdraw_locked"):
        op.add_column(
            "users",
            sa.Column("withdraw_locked", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if not _has_column(bind, "users", "withdraw_locked_reason"):
        op.add_column("users", sa.Column("withdraw_locked_reason", sa.String(length=255), nullable=True))
    if not _has_column(bind, "users", "withdraw_locked_at"):
        op.add_column("users", sa.Column("withdraw_locked_at", sa.DateTime(), nullable=True))
    if not _has_column(bind, "users", "withdraw_locked_by"):
        op.add_column("users", sa.Column("withdraw_locked_by", sa.BigInteger(), nullable=True))

    if not _has_table(bind, "user_withdraw_lock_logs"):
        op.create_table(
            "user_withdraw_lock_logs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("action", sa.String(length=16), nullable=False),
            sa.Column("reason", sa.String(length=255), nullable=True),
            sa.Column("admin_user", sa.String(length=64), nullable=True),
            sa.Column("admin_user_id", sa.BigInteger(), nullable=True),
            sa.Column("admin_ip", sa.String(length=64), nullable=True),
            sa.Column("user_agent", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        )
        op.create_index(
            "idx_user_withdraw_lock_logs_user_time",
            "user_withdraw_lock_logs",
            ["user_id", "created_at"],
        )
        op.create_index(
            "idx_user_withdraw_lock_logs_admin_time",
            "user_withdraw_lock_logs",
            ["admin_user", "created_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "user_withdraw_lock_logs"):
        op.drop_index("idx_user_withdraw_lock_logs_admin_time", table_name="user_withdraw_lock_logs")
        op.drop_index("idx_user_withdraw_lock_logs_user_time", table_name="user_withdraw_lock_logs")
        op.drop_table("user_withdraw_lock_logs")
    if _has_column(bind, "users", "withdraw_locked_by"):
        op.drop_column("users", "withdraw_locked_by")
    if _has_column(bind, "users", "withdraw_locked_at"):
        op.drop_column("users", "withdraw_locked_at")
    if _has_column(bind, "users", "withdraw_locked_reason"):
        op.drop_column("users", "withdraw_locked_reason")
    if _has_column(bind, "users", "withdraw_locked"):
        op.drop_column("users", "withdraw_locked")
