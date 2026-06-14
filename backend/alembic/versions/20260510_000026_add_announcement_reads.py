"""add announcement reads

Revision ID: 20260510_000026
Revises: 20260510_000024
Create Date: 2026-05-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "20260510_000026"
down_revision = "20260510_000024"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "announcement_reads"):
        op.create_table(
            "announcement_reads",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("announcement_id", sa.BigInteger(), nullable=False),
            sa.Column("read_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["announcement_id"], ["announcements.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("user_id", "announcement_id", name="uq_announcement_reads_user_announcement"),
        )

    if not _has_index(bind, "announcement_reads", "idx_announcement_reads_user_id"):
        op.create_index("idx_announcement_reads_user_id", "announcement_reads", ["user_id"], unique=False)
    if not _has_index(bind, "announcement_reads", "idx_announcement_reads_announcement_id"):
        op.create_index(
            "idx_announcement_reads_announcement_id",
            "announcement_reads",
            ["announcement_id"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "announcement_reads"):
        return

    for index_name in ("idx_announcement_reads_announcement_id", "idx_announcement_reads_user_id"):
        if _has_index(bind, "announcement_reads", index_name):
            op.drop_index(index_name, table_name="announcement_reads")

    op.drop_table("announcement_reads")
