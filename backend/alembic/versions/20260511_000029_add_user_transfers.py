"""add user transfers

Revision ID: 20260511_000029
Revises: 20260510_000028
Create Date: 2026-05-11
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260511_000029"
down_revision = "20260510_000028"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str]) -> None:
    if not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "user_transfers"):
        op.create_table(
            "user_transfers",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("transfer_no", sa.String(length=64), nullable=False),
            sa.Column("request_id", sa.String(length=64), nullable=False),
            sa.Column("from_user_id", sa.BigInteger(), nullable=False),
            sa.Column("to_user_id", sa.BigInteger(), nullable=False),
            sa.Column("coin_symbol", sa.String(length=32), nullable=False),
            sa.Column("from_account", sa.String(length=32), nullable=False, server_default="funding"),
            sa.Column("to_account", sa.String(length=32), nullable=False, server_default="funding"),
            sa.Column("amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("fee_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("net_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="SUCCESS"),
            sa.Column("recipient_email_mask", sa.String(length=191), nullable=False),
            sa.Column("sender_available_before", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("sender_available_after", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("receiver_available_before", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("receiver_available_after", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("remark", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("transfer_no", name="uq_user_transfers_transfer_no"),
            sa.UniqueConstraint("from_user_id", "request_id", name="uq_user_transfers_from_request"),
        )

    _create_index_if_missing(bind, "idx_user_transfers_from_time", "user_transfers", ["from_user_id", "created_at"])
    _create_index_if_missing(bind, "idx_user_transfers_to_time", "user_transfers", ["to_user_id", "created_at"])
    _create_index_if_missing(bind, "idx_user_transfers_coin_time", "user_transfers", ["coin_symbol", "created_at"])
    _create_index_if_missing(bind, "idx_user_transfers_status_time", "user_transfers", ["status", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "user_transfers"):
        op.drop_table("user_transfers")
