"""add spot dealer execution evidence

Revision ID: 20260711_000120
Revises: 20260710_000119
Create Date: 2026-07-11
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260711_000120"
down_revision = "20260710_000119"
branch_labels = None
depends_on = None


_COLUMNS = (
    sa.Column("dealer_provider", sa.String(length=64), nullable=True),
    sa.Column("dealer_provider_symbol", sa.String(length=64), nullable=True),
    sa.Column("dealer_event_time_ms", sa.BigInteger(), nullable=True),
    sa.Column("dealer_received_at_ms", sa.BigInteger(), nullable=True),
    sa.Column("dealer_freshness", sa.String(length=32), nullable=True),
    sa.Column("dealer_snapshot_id", sa.String(length=64), nullable=True),
    sa.Column("dealer_provider_generation", sa.BigInteger(), nullable=True),
    sa.Column("dealer_snapshot_max_age_ms", sa.Integer(), nullable=True),
)


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trades"):
        return
    for column in _COLUMNS:
        if not _has_column(bind, "trades", column.name):
            op.add_column("trades", column.copy())


def downgrade() -> None:
    bind = op.get_bind()
    for column in reversed(_COLUMNS):
        if _has_column(bind, "trades", column.name):
            op.drop_column("trades", column.name)
