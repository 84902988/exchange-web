"""add db lifecycle cleanup skip fields

Revision ID: 20260619_000107
Revises: 20260619_000106
Create Date: 2026-06-19 00:01:07
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260619_000107"
down_revision = "20260619_000106"
branch_labels = None
depends_on = None


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "db_lifecycle_cleanup_logs", "skipped"):
        op.add_column(
            "db_lifecycle_cleanup_logs",
            sa.Column("skipped", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        )
    if not _has_column(bind, "db_lifecycle_cleanup_logs", "reason"):
        op.add_column("db_lifecycle_cleanup_logs", sa.Column("reason", sa.String(length=64), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "db_lifecycle_cleanup_logs", "reason"):
        op.drop_column("db_lifecycle_cleanup_logs", "reason")
    if _has_column(bind, "db_lifecycle_cleanup_logs", "skipped"):
        op.drop_column("db_lifecycle_cleanup_logs", "skipped")
