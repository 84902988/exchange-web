"""add bd commission asset symbol

Revision ID: 20260523_000052
Revises: 20260523_000051
Create Date: 2026-05-23
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260523_000052"
down_revision = "20260523_000051"
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
    if not _has_column(bind, "bd_commission_records", "commission_asset_symbol"):
        op.add_column(
            "bd_commission_records",
            sa.Column("commission_asset_symbol", sa.String(length=20), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "bd_commission_records", "commission_asset_symbol"):
        op.drop_column("bd_commission_records", "commission_asset_symbol")
