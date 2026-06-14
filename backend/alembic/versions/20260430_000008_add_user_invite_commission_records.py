"""add user invite commission records

Revision ID: 20260430_000008
Revises: 20260430_000007
Create Date: 2026-04-30 00:00:08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "20260430_000008"
down_revision = "20260430_000007"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def _has_unique_constraint(bind, table_name: str, constraint_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(
        constraint["name"] == constraint_name
        for constraint in inspector.get_unique_constraints(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "user_invite_commission_records"):
        op.create_table(
            "user_invite_commission_records",
            sa.Column("id", mysql.BIGINT(unsigned=True), primary_key=True, autoincrement=True),
            sa.Column("inviter_user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("invitee_user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("trade_id", mysql.BIGINT(unsigned=True), nullable=True),
            sa.Column("order_id", mysql.BIGINT(unsigned=True), nullable=True),
            sa.Column("fee_asset_id", mysql.BIGINT(unsigned=True), nullable=True),
            sa.Column("fee_coin_symbol", sa.String(length=20), nullable=False),
            sa.Column("fee_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("commission_rate", sa.Numeric(10, 6), nullable=False, server_default="0.150000"),
            sa.Column("commission_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="PENDING"),
            sa.Column("paid_at", sa.DateTime(), nullable=True),
            sa.Column("fail_reason", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint(
                "trade_id",
                "invitee_user_id",
                "fee_coin_symbol",
                name="uq_user_invite_commission_trade_fee",
            ),
        )

    for index_name, columns in (
        ("idx_user_invite_comm_records_inviter_user_id", ["inviter_user_id"]),
        ("idx_user_invite_comm_records_invitee_user_id", ["invitee_user_id"]),
        ("idx_user_invite_comm_records_status", ["status"]),
        ("idx_user_invite_comm_records_trade_id", ["trade_id"]),
        ("idx_user_invite_comm_records_order_id", ["order_id"]),
    ):
        if not _has_index(bind, "user_invite_commission_records", index_name):
            op.create_index(index_name, "user_invite_commission_records", columns, unique=False)


def downgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "user_invite_commission_records"):
        return

    for index_name in (
        "idx_user_invite_comm_records_inviter_user_id",
        "idx_user_invite_comm_records_invitee_user_id",
        "idx_user_invite_comm_records_status",
        "idx_user_invite_comm_records_trade_id",
        "idx_user_invite_comm_records_order_id",
    ):
        if _has_index(bind, "user_invite_commission_records", index_name):
            op.drop_index(index_name, table_name="user_invite_commission_records")

    if _has_unique_constraint(
        bind,
        "user_invite_commission_records",
        "uq_user_invite_commission_trade_fee",
    ):
        op.drop_constraint(
            "uq_user_invite_commission_trade_fee",
            "user_invite_commission_records",
            type_="unique",
        )

    op.drop_table("user_invite_commission_records")
