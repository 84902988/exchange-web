"""add support ticket tables

Revision ID: 20260614_000094
Revises: 20260614_000093
Create Date: 2026-06-14
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "20260614_000094"
down_revision: Union[str, None] = "20260614_000093"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_index(table_name: str, index_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    if not _has_table("support_tickets"):
        op.create_table(
            "support_tickets",
            sa.Column("id", mysql.BIGINT(unsigned=True), autoincrement=True, nullable=False),
            sa.Column("ticket_no", sa.String(length=32), nullable=False),
            sa.Column("user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("category", sa.String(length=32), nullable=False),
            sa.Column("subject", sa.String(length=255), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="OPEN"),
            sa.Column("priority", sa.String(length=20), nullable=False, server_default="NORMAL"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("last_reply_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("ticket_no", name="uq_support_tickets_ticket_no"),
        )
    if not _has_index("support_tickets", "ix_support_tickets_user_status_updated"):
        op.create_index(
            "ix_support_tickets_user_status_updated",
            "support_tickets",
            ["user_id", "status", "updated_at"],
            unique=False,
        )
    if not _has_index("support_tickets", "ix_support_tickets_status_updated"):
        op.create_index(
            "ix_support_tickets_status_updated",
            "support_tickets",
            ["status", "updated_at"],
            unique=False,
        )

    if not _has_table("support_ticket_messages"):
        op.create_table(
            "support_ticket_messages",
            sa.Column("id", mysql.BIGINT(unsigned=True), autoincrement=True, nullable=False),
            sa.Column("ticket_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("sender_type", sa.String(length=20), nullable=False),
            sa.Column("sender_user_id", mysql.BIGINT(unsigned=True), nullable=True),
            sa.Column("admin_user_id", mysql.BIGINT(unsigned=True), nullable=True),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["ticket_id"], ["support_tickets.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
    if not _has_index("support_ticket_messages", "ix_support_ticket_messages_ticket_created"):
        op.create_index(
            "ix_support_ticket_messages_ticket_created",
            "support_ticket_messages",
            ["ticket_id", "created_at"],
            unique=False,
        )

    op.execute(
        sa.text(
            """
            INSERT INTO admin_permissions (code, name, group_code, description, created_at, updated_at)
            SELECT
                'support_tickets.manage',
                '支持工单管理',
                'users',
                '可查看、回复和更新用户支持工单状态',
                NOW(),
                NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM admin_permissions WHERE code = 'support_tickets.manage'
            )
            """
        )
    )
    op.execute(
        sa.text(
            """
            INSERT INTO admin_role_permissions (role_id, permission_id, created_at)
            SELECT r.id, p.id, NOW()
            FROM admin_roles r
            JOIN admin_permissions p ON p.code = 'support_tickets.manage'
            WHERE r.code = 'super_admin'
              AND NOT EXISTS (
                  SELECT 1
                  FROM admin_role_permissions rp
                  WHERE rp.role_id = r.id AND rp.permission_id = p.id
              )
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DELETE rp
            FROM admin_role_permissions rp
            JOIN admin_permissions p ON p.id = rp.permission_id
            WHERE p.code = 'support_tickets.manage'
            """
        )
    )
    op.execute(sa.text("DELETE FROM admin_permissions WHERE code = 'support_tickets.manage'"))

    if _has_table("support_ticket_messages"):
        if _has_index("support_ticket_messages", "ix_support_ticket_messages_ticket_created"):
            op.drop_index("ix_support_ticket_messages_ticket_created", table_name="support_ticket_messages")
        op.drop_table("support_ticket_messages")

    if _has_table("support_tickets"):
        if _has_index("support_tickets", "ix_support_tickets_status_updated"):
            op.drop_index("ix_support_tickets_status_updated", table_name="support_tickets")
        if _has_index("support_tickets", "ix_support_tickets_user_status_updated"):
            op.drop_index("ix_support_tickets_user_status_updated", table_name="support_tickets")
        op.drop_table("support_tickets")
