"""add user fee preferences

Revision ID: 20260420_000005
Revises: 20260420_000004
Create Date: 2026-04-20 00:00:05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260420_000005"
down_revision = "20260420_000004"
branch_labels = None
depends_on = None


TABLE_NAME = "user_fee_preferences"
INDEX_NAME = "idx_user_fee_preferences_user_id"


def _has_table(bind) -> bool:
    return sa.inspect(bind).has_table(TABLE_NAME)


def _has_index(bind) -> bool:
    if not _has_table(bind):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == INDEX_NAME for index in inspector.get_indexes(TABLE_NAME))


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind):
        if not _has_index(bind):
            op.create_index(INDEX_NAME, TABLE_NAME, ["user_id"], unique=True)
        return

    op.create_table(
        TABLE_NAME,
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("use_rcb_fee", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index(INDEX_NAME, TABLE_NAME, ["user_id"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind):
        return

    if _has_index(bind):
        op.drop_index(INDEX_NAME, table_name=TABLE_NAME)
    op.drop_table(TABLE_NAME)
