"""add trading pair spot logo fields

Revision ID: 20260609_000087
Revises: 20260609_000086
Create Date: 2026-06-09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260609_000087"
down_revision = "20260609_000086"
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
    if not _has_table(bind, "trading_pairs"):
        return

    if not _has_column(bind, "trading_pairs", "show_spot_logo"):
        op.add_column(
            "trading_pairs",
            sa.Column("show_spot_logo", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        )
    if not _has_column(bind, "trading_pairs", "spot_logo_url"):
        op.add_column("trading_pairs", sa.Column("spot_logo_url", sa.String(length=512), nullable=True))
    if not _has_column(bind, "trading_pairs", "spot_logo_alt"):
        op.add_column("trading_pairs", sa.Column("spot_logo_alt", sa.String(length=120), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    for column_name in ("spot_logo_alt", "spot_logo_url", "show_spot_logo"):
        if _has_column(bind, "trading_pairs", column_name):
            op.drop_column("trading_pairs", column_name)
