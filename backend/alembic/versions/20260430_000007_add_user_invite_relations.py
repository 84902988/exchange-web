"""add user invite relations

Revision ID: 20260430_000007
Revises: 20260429_000006
Create Date: 2026-04-30 00:00:07
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "20260430_000007"
down_revision = "20260429_000006"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "users", "invite_code"):
        op.add_column("users", sa.Column("invite_code", sa.String(length=64), nullable=True))

    if not _has_index(bind, "users", "uq_users_invite_code"):
        op.execute("UPDATE users SET invite_code = CONCAT('U', id) WHERE invite_code IS NULL")
        op.create_index("uq_users_invite_code", "users", ["invite_code"], unique=True)

    if not _has_table(bind, "user_invite_relations"):
        op.create_table(
            "user_invite_relations",
            sa.Column("id", mysql.BIGINT(unsigned=True), primary_key=True, autoincrement=True),
            sa.Column("inviter_user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("invitee_user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("invite_code", sa.String(length=64), nullable=False),
            sa.Column("commission_rate", sa.Numeric(10, 6), nullable=False, server_default="0.150000"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
        )

    if not _has_index(bind, "user_invite_relations", "idx_user_invite_relations_inviter_user_id"):
        op.create_index(
            "idx_user_invite_relations_inviter_user_id",
            "user_invite_relations",
            ["inviter_user_id"],
            unique=False,
        )
    if not _has_index(bind, "user_invite_relations", "uq_user_invite_relations_invitee_user_id"):
        op.create_index(
            "uq_user_invite_relations_invitee_user_id",
            "user_invite_relations",
            ["invitee_user_id"],
            unique=True,
        )
    if not _has_index(bind, "user_invite_relations", "idx_user_invite_relations_status"):
        op.create_index(
            "idx_user_invite_relations_status",
            "user_invite_relations",
            ["status"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "user_invite_relations"):
        for index_name in (
            "idx_user_invite_relations_inviter_user_id",
            "uq_user_invite_relations_invitee_user_id",
            "idx_user_invite_relations_status",
        ):
            if _has_index(bind, "user_invite_relations", index_name):
                op.drop_index(index_name, table_name="user_invite_relations")
        op.drop_table("user_invite_relations")

    if _has_index(bind, "users", "uq_users_invite_code"):
        op.drop_index("uq_users_invite_code", table_name="users")
    if _has_column(bind, "users", "invite_code"):
        op.drop_column("users", "invite_code")
