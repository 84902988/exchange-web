"""add db lifecycle cleanup logs

Revision ID: 20260619_000106
Revises: 20260618_000105
Create Date: 2026-06-19 00:01:06
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260619_000106"
down_revision = "20260618_000105"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_index(bind, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "db_lifecycle_cleanup_logs"):
        op.create_table(
            "db_lifecycle_cleanup_logs",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("job_name", sa.String(length=64), nullable=False),
            sa.Column("dry_run", sa.Boolean(), nullable=False, server_default=sa.text("1")),
            sa.Column("table_name", sa.String(length=64), nullable=False),
            sa.Column("matched_count", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("deleted_count", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("retention_days", sa.Integer(), nullable=False, server_default=sa.text("90")),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="SUCCESS"),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )

    for index_name, columns in (
        ("idx_db_lifecycle_cleanup_logs_job_started", ["job_name", "started_at"]),
        ("idx_db_lifecycle_cleanup_logs_table_started", ["table_name", "started_at"]),
        ("idx_db_lifecycle_cleanup_logs_status_started", ["status", "started_at"]),
    ):
        if not _has_index(bind, "db_lifecycle_cleanup_logs", index_name):
            op.create_index(index_name, "db_lifecycle_cleanup_logs", columns, unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "db_lifecycle_cleanup_logs"):
        return
    for index_name in (
        "idx_db_lifecycle_cleanup_logs_status_started",
        "idx_db_lifecycle_cleanup_logs_table_started",
        "idx_db_lifecycle_cleanup_logs_job_started",
    ):
        if _has_index(bind, "db_lifecycle_cleanup_logs", index_name):
            op.drop_index(index_name, table_name="db_lifecycle_cleanup_logs")
    op.drop_table("db_lifecycle_cleanup_logs")
