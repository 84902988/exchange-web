"""add asset chain collection min amount

Revision ID: 20260607_000084
Revises: 20260606_000083
Create Date: 2026-06-07
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260607_000084"
down_revision = "20260606_000083"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "asset_chains") and not _has_column(bind, "asset_chains", "collection_min_amount"):
        op.add_column(
            "asset_chains",
            sa.Column("collection_min_amount", sa.Numeric(36, 18), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "asset_chains") and _has_column(bind, "asset_chains", "collection_min_amount"):
        op.drop_column("asset_chains", "collection_min_amount")
