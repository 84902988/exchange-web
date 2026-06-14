"""add admin large table p0 indexes

Revision ID: 20260529_000057
Revises: 20260527_000056
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000057"
down_revision = "20260527_000056"
branch_labels = None
depends_on = None


INDEXES = (
    ("balance_logs", "idx_balance_logs_created_id", ("created_at", "id")),
    ("deposits", "idx_deposits_created_id", ("created_at", "id")),
    ("withdraw_logs", "idx_withdraw_logs_created_id", ("created_at", "id")),
    ("user_transfers", "idx_user_transfers_created_id", ("created_at", "id")),
)


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_columns(bind, table_name: str, column_names: tuple[str, ...]) -> bool:
    if not _has_table(bind, table_name):
        return False
    existing = {column.get("name") for column in sa.inspect(bind).get_columns(table_name)}
    return all(column_name in existing for column_name in column_names)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    for table_name, index_name, column_names in INDEXES:
        if not _has_columns(bind, table_name, column_names):
            continue
        if _has_index(bind, table_name, index_name):
            continue
        op.create_index(index_name, table_name, list(column_names))


def downgrade() -> None:
    bind = op.get_bind()
    for table_name, index_name, _column_names in reversed(INDEXES):
        if not _has_index(bind, table_name, index_name):
            continue
        op.drop_index(index_name, table_name=table_name)
