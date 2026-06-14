"""add user login logs

Revision ID: 20260517_000032
Revises: 20260514_000031
Create Date: 2026-05-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "20260517_000032"
down_revision = "20260514_000031"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str]) -> None:
    if not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "users") and not _has_column(bind, "users", "password_changed_at"):
        op.add_column("users", sa.Column("password_changed_at", sa.DateTime(), nullable=True))

    if not _has_table(bind, "user_login_logs"):
        op.create_table(
            "user_login_logs",
            sa.Column("id", mysql.BIGINT(unsigned=True), primary_key=True, autoincrement=True),
            sa.Column("user_id", mysql.BIGINT(unsigned=True), nullable=True),
            sa.Column("email", sa.String(length=191), nullable=True),
            sa.Column("ip_address", sa.String(length=45), nullable=False, server_default=""),
            sa.Column("user_agent", sa.String(length=512), nullable=False, server_default=""),
            sa.Column("device_name", sa.String(length=128), nullable=False, server_default=""),
            sa.Column("login_status", sa.Enum("SUCCESS", "FAILED", name="user_login_status"), nullable=False),
            sa.Column("failure_reason", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_user_login_logs_user_id", ondelete="SET NULL"),
        )

    _create_index_if_missing(bind, "idx_user_login_logs_user_time", "user_login_logs", ["user_id", "created_at"])
    _create_index_if_missing(bind, "idx_user_login_logs_email_time", "user_login_logs", ["email", "created_at"])
    _create_index_if_missing(bind, "idx_user_login_logs_status_time", "user_login_logs", ["login_status", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "user_login_logs"):
        op.drop_table("user_login_logs")

    if _has_table(bind, "users") and _has_column(bind, "users", "password_changed_at"):
        op.drop_column("users", "password_changed_at")
