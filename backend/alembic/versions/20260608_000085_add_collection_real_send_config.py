"""add collection real-send config

Revision ID: 20260608_000085
Revises: 20260607_000084
Create Date: 2026-06-08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260608_000085"
down_revision = "20260607_000084"
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
    if _has_table(bind, "chains"):
        if not _has_column(bind, "chains", "collection_real_send_enabled"):
            op.add_column(
                "chains",
                sa.Column("collection_real_send_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            )
        if not _has_column(bind, "chains", "collection_max_single_gas_native"):
            op.add_column(
                "chains",
                sa.Column("collection_max_single_gas_native", sa.Numeric(36, 18), nullable=True),
            )
        if not _has_column(bind, "chains", "collection_daily_gas_native_limit"):
            op.add_column(
                "chains",
                sa.Column("collection_daily_gas_native_limit", sa.Numeric(36, 18), nullable=True),
            )

    if _has_table(bind, "asset_chains"):
        if not _has_column(bind, "asset_chains", "collection_real_send_enabled"):
            op.add_column(
                "asset_chains",
                sa.Column("collection_real_send_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            )
        if not _has_column(bind, "asset_chains", "collection_max_single_amount"):
            op.add_column(
                "asset_chains",
                sa.Column("collection_max_single_amount", sa.Numeric(36, 18), nullable=True),
            )
        if not _has_column(bind, "asset_chains", "collection_daily_amount_limit"):
            op.add_column(
                "asset_chains",
                sa.Column("collection_daily_amount_limit", sa.Numeric(36, 18), nullable=True),
            )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "asset_chains"):
        if _has_column(bind, "asset_chains", "collection_daily_amount_limit"):
            op.drop_column("asset_chains", "collection_daily_amount_limit")
        if _has_column(bind, "asset_chains", "collection_max_single_amount"):
            op.drop_column("asset_chains", "collection_max_single_amount")
        if _has_column(bind, "asset_chains", "collection_real_send_enabled"):
            op.drop_column("asset_chains", "collection_real_send_enabled")

    if _has_table(bind, "chains"):
        if _has_column(bind, "chains", "collection_daily_gas_native_limit"):
            op.drop_column("chains", "collection_daily_gas_native_limit")
        if _has_column(bind, "chains", "collection_max_single_gas_native"):
            op.drop_column("chains", "collection_max_single_gas_native")
        if _has_column(bind, "chains", "collection_real_send_enabled"):
            op.drop_column("chains", "collection_real_send_enabled")
