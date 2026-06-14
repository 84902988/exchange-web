"""add chain moralis watch config

Revision ID: 20260530_000071
Revises: 20260530_000070
Create Date: 2026-05-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260530_000071"
down_revision = "20260530_000070"
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
    if not _has_column(bind, "chains", "moralis_stream_id"):
        op.add_column("chains", sa.Column("moralis_stream_id", sa.String(length=64), nullable=True))
    if not _has_column(bind, "chains", "moralis_stream_enabled"):
        op.add_column(
            "chains",
            sa.Column("moralis_stream_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if not _has_column(bind, "chains", "moralis_chain_id"):
        op.add_column("chains", sa.Column("moralis_chain_id", sa.String(length=32), nullable=True))
    if not _has_column(bind, "chains", "webhook_chain_key"):
        op.add_column("chains", sa.Column("webhook_chain_key", sa.String(length=32), nullable=True))
    if not _has_column(bind, "chains", "watch_enabled"):
        op.add_column("chains", sa.Column("watch_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
    if not _has_column(bind, "chains", "last_watch_check_at"):
        op.add_column("chains", sa.Column("last_watch_check_at", sa.DateTime(), nullable=True))
    if not _has_column(bind, "chains", "watch_status"):
        op.add_column("chains", sa.Column("watch_status", sa.String(length=32), nullable=True))
    if not _has_column(bind, "chains", "watch_error"):
        op.add_column("chains", sa.Column("watch_error", sa.String(length=255), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    for column_name in (
        "watch_error",
        "watch_status",
        "last_watch_check_at",
        "watch_enabled",
        "webhook_chain_key",
        "moralis_chain_id",
        "moralis_stream_enabled",
        "moralis_stream_id",
    ):
        if _has_column(bind, "chains", column_name):
            op.drop_column("chains", column_name)
