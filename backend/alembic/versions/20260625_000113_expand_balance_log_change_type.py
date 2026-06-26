"""expand balance log change type length

Revision ID: 20260625_000113
Revises: 20260625_000112
Create Date: 2026-06-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260625_000113"
down_revision = "20260625_000112"
branch_labels = None
depends_on = None


def _column_length(bind, table_name: str, column_name: str) -> int | None:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table_name):
        return None
    for column in inspector.get_columns(table_name):
        if column.get("name") == column_name:
            length = getattr(column.get("type"), "length", None)
            return int(length) if length is not None else None
    return None


def upgrade() -> None:
    bind = op.get_bind()
    length = _column_length(bind, "balance_logs", "change_type")
    if length is None or length >= 64:
        return

    op.alter_column(
        "balance_logs",
        "change_type",
        existing_type=sa.String(length=length),
        type_=sa.String(length=64),
        existing_nullable=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    length = _column_length(bind, "balance_logs", "change_type")
    if length is None or length <= 24:
        return

    op.alter_column(
        "balance_logs",
        "change_type",
        existing_type=sa.String(length=length),
        type_=sa.String(length=24),
        existing_nullable=False,
    )
