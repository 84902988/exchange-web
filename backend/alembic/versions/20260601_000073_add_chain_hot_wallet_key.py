"""add encrypted chain hot wallet key fields

Revision ID: 20260601_000073
Revises: 20260530_000072
Create Date: 2026-06-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260601_000073"
down_revision = "20260530_000072"
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
    if not _has_table(bind, "chains"):
        return
    if not _has_column(bind, "chains", "hot_wallet_private_key_encrypted"):
        op.add_column("chains", sa.Column("hot_wallet_private_key_encrypted", sa.Text(), nullable=True))
    if not _has_column(bind, "chains", "hot_wallet_key_status"):
        op.add_column("chains", sa.Column("hot_wallet_key_status", sa.String(length=32), nullable=True))
    if not _has_column(bind, "chains", "hot_wallet_key_updated_at"):
        op.add_column("chains", sa.Column("hot_wallet_key_updated_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "chains", "hot_wallet_key_updated_at"):
        op.drop_column("chains", "hot_wallet_key_updated_at")
    if _has_column(bind, "chains", "hot_wallet_key_status"):
        op.drop_column("chains", "hot_wallet_key_status")
    if _has_column(bind, "chains", "hot_wallet_private_key_encrypted"):
        op.drop_column("chains", "hot_wallet_private_key_encrypted")
