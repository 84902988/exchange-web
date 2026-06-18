"""add db lifecycle cleanup operation mode

Revision ID: 20260619_000108
Revises: 20260619_000107
Create Date: 2026-06-19 00:01:08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260619_000108"
down_revision = "20260619_000107"
branch_labels = None
depends_on = None


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "db_lifecycle_cleanup_logs", "operation_mode"):
        op.add_column(
            "db_lifecycle_cleanup_logs",
            sa.Column("operation_mode", sa.String(length=32), nullable=False, server_default="DRY_RUN"),
        )
    if not _has_column(bind, "db_lifecycle_cleanup_logs", "risk_level"):
        op.add_column(
            "db_lifecycle_cleanup_logs",
            sa.Column("risk_level", sa.String(length=32), nullable=False, server_default="SAFE_DRY_RUN"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "db_lifecycle_cleanup_logs", "risk_level"):
        op.drop_column("db_lifecycle_cleanup_logs", "risk_level")
    if _has_column(bind, "db_lifecycle_cleanup_logs", "operation_mode"):
        op.drop_column("db_lifecycle_cleanup_logs", "operation_mode")
