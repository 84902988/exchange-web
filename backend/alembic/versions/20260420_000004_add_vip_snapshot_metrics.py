"""add vip snapshot metric columns

Revision ID: 20260420_000004
Revises: 20260420_000003
Create Date: 2026-04-20 00:00:04
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260420_000004"
down_revision = "20260420_000003"
branch_labels = None
depends_on = None


TABLE_NAME = "user_vip_snapshots"
METRIC_COLUMNS = {
    "volume_30d": sa.Column(
        "volume_30d",
        sa.Numeric(36, 18),
        nullable=False,
        server_default=sa.text("0"),
    ),
    "rcb_available": sa.Column(
        "rcb_available",
        sa.Numeric(36, 18),
        nullable=False,
        server_default=sa.text("0"),
    ),
    "rcb_locked": sa.Column(
        "rcb_locked",
        sa.Numeric(36, 18),
        nullable=False,
        server_default=sa.text("0"),
    ),
}


def _has_table(bind) -> bool:
    return sa.inspect(bind).has_table(TABLE_NAME)


def _columns(bind) -> set[str]:
    inspector = sa.inspect(bind)
    if not inspector.has_table(TABLE_NAME):
        return set()
    return {column["name"] for column in inspector.get_columns(TABLE_NAME)}


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind):
        return

    existing_columns = _columns(bind)
    for column_name, column in METRIC_COLUMNS.items():
        if column_name not in existing_columns:
            op.add_column(TABLE_NAME, column.copy())


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind):
        return

    existing_columns = _columns(bind)
    for column_name in reversed(tuple(METRIC_COLUMNS)):
        if column_name in existing_columns:
            op.drop_column(TABLE_NAME, column_name)
