"""fix missing effective_level_code on user_vip_snapshots

Revision ID: 20260420_000003
Revises: 20260420_000002
Create Date: 2026-04-20 00:00:03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260420_000003"
down_revision = "20260420_000002"
branch_labels = None
depends_on = None


TABLE_NAME = "user_vip_snapshots"
COLUMN_NAME = "effective_level_code"


def _has_table(bind) -> bool:
    inspector = sa.inspect(bind)
    return inspector.has_table(TABLE_NAME)


def _has_column(bind) -> bool:
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return False
    return COLUMN_NAME in {column["name"] for column in inspector.get_columns(TABLE_NAME)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind) or _has_column(bind):
        return

    op.add_column(TABLE_NAME, sa.Column(COLUMN_NAME, sa.String(length=30), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind) or not _has_column(bind):
        return

    op.drop_column(TABLE_NAME, COLUMN_NAME)
