"""add mobile announcement reads and support reply cursor

Revision ID: 20260802_000130
Revises: 20260802_000129
Create Date: 2026-08-02
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "20260802_000130"
down_revision: Union[str, None] = "20260802_000129"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID_TYPE = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def _has_table(bind, table_name: str) -> bool:
    return table_name in sa.inspect(bind).get_table_names()


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(
        column.get("name") == column_name
        for column in sa.inspect(bind).get_columns(table_name)
    )


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(
        index.get("name") == index_name
        for index in sa.inspect(bind).get_indexes(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "mobile_announcement_reads"):
        op.create_table(
            "mobile_announcement_reads",
            sa.Column("id", ID_TYPE, autoincrement=True, nullable=False),
            sa.Column("user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("announcement_id", ID_TYPE, nullable=False),
            sa.Column("read_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(
                ["announcement_id"],
                ["mobile_announcements.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "user_id",
                "announcement_id",
                name="uq_mobile_announcement_reads_user_announcement",
            ),
        )
    if not _has_index(
        bind,
        "mobile_announcement_reads",
        "idx_mobile_announcement_reads_user_id",
    ):
        op.create_index(
            "idx_mobile_announcement_reads_user_id",
            "mobile_announcement_reads",
            ["user_id"],
            unique=False,
        )
    if not _has_index(
        bind,
        "mobile_announcement_reads",
        "idx_mobile_announcement_reads_announcement_id",
    ):
        op.create_index(
            "idx_mobile_announcement_reads_announcement_id",
            "mobile_announcement_reads",
            ["announcement_id"],
            unique=False,
        )

    if not _has_column(bind, "support_tickets", "user_last_read_message_id"):
        op.add_column(
            "support_tickets",
            sa.Column("user_last_read_message_id", mysql.BIGINT(unsigned=True), nullable=True),
        )
    if not _has_column(bind, "support_tickets", "user_last_read_at"):
        op.add_column(
            "support_tickets",
            sa.Column("user_last_read_at", sa.DateTime(), nullable=True),
        )
    if not _has_index(
        bind,
        "support_ticket_messages",
        "ix_support_ticket_messages_ticket_sender_id",
    ):
        op.create_index(
            "ix_support_ticket_messages_ticket_sender_id",
            "support_ticket_messages",
            ["ticket_id", "sender_type", "id"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(
        bind,
        "support_ticket_messages",
        "ix_support_ticket_messages_ticket_sender_id",
    ):
        op.drop_index(
            "ix_support_ticket_messages_ticket_sender_id",
            table_name="support_ticket_messages",
        )
    if _has_column(bind, "support_tickets", "user_last_read_at"):
        op.drop_column("support_tickets", "user_last_read_at")
    if _has_column(bind, "support_tickets", "user_last_read_message_id"):
        op.drop_column("support_tickets", "user_last_read_message_id")

    if _has_table(bind, "mobile_announcement_reads"):
        if _has_index(
            bind,
            "mobile_announcement_reads",
            "idx_mobile_announcement_reads_announcement_id",
        ):
            op.drop_index(
                "idx_mobile_announcement_reads_announcement_id",
                table_name="mobile_announcement_reads",
            )
        if _has_index(
            bind,
            "mobile_announcement_reads",
            "idx_mobile_announcement_reads_user_id",
        ):
            op.drop_index(
                "idx_mobile_announcement_reads_user_id",
                table_name="mobile_announcement_reads",
            )
        op.drop_table("mobile_announcement_reads")
