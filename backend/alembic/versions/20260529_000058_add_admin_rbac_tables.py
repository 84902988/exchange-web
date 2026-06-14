"""add admin rbac tables

Revision ID: 20260529_000058
Revises: 20260529_000057
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000058"
down_revision = "20260529_000057"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str]) -> None:
    if _has_table(bind, table_name) and not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "admin_users"):
        op.create_table(
            "admin_users",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("username", sa.String(length=64), nullable=False),
            sa.Column("password_hash", sa.String(length=255), nullable=False),
            sa.Column("display_name", sa.String(length=100), nullable=False),
            sa.Column("email", sa.String(length=191), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"),
            sa.Column("last_login_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("username", name="uq_admin_users_username"),
        )
    _create_index_if_missing(bind, "idx_admin_users_status", "admin_users", ["status"])
    _create_index_if_missing(bind, "idx_admin_users_email", "admin_users", ["email"])

    if not _has_table(bind, "admin_roles"):
        op.create_table(
            "admin_roles",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(length=64), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("description", sa.String(length=255), nullable=True),
            sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("code", name="uq_admin_roles_code"),
        )
    _create_index_if_missing(bind, "idx_admin_roles_status", "admin_roles", ["status"])
    _create_index_if_missing(bind, "idx_admin_roles_is_system", "admin_roles", ["is_system"])

    if not _has_table(bind, "admin_permissions"):
        op.create_table(
            "admin_permissions",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(length=100), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("group_code", sa.String(length=64), nullable=False),
            sa.Column("description", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("code", name="uq_admin_permissions_code"),
        )
    _create_index_if_missing(bind, "idx_admin_permissions_group_code", "admin_permissions", ["group_code"])

    if not _has_table(bind, "admin_user_roles"):
        op.create_table(
            "admin_user_roles",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("admin_user_id", sa.BigInteger(), nullable=False),
            sa.Column("role_id", sa.BigInteger(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.ForeignKeyConstraint(
                ["admin_user_id"],
                ["admin_users.id"],
                name="fk_admin_user_roles_admin_user",
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(["role_id"], ["admin_roles.id"], name="fk_admin_user_roles_role", ondelete="CASCADE"),
            sa.UniqueConstraint("admin_user_id", "role_id", name="uq_admin_user_roles_user_role"),
        )
    _create_index_if_missing(bind, "idx_admin_user_roles_admin_user_id", "admin_user_roles", ["admin_user_id"])
    _create_index_if_missing(bind, "idx_admin_user_roles_role_id", "admin_user_roles", ["role_id"])

    if not _has_table(bind, "admin_role_permissions"):
        op.create_table(
            "admin_role_permissions",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("role_id", sa.BigInteger(), nullable=False),
            sa.Column("permission_id", sa.BigInteger(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.ForeignKeyConstraint(
                ["role_id"],
                ["admin_roles.id"],
                name="fk_admin_role_permissions_role",
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["permission_id"],
                ["admin_permissions.id"],
                name="fk_admin_role_permissions_permission",
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint("role_id", "permission_id", name="uq_admin_role_permissions_role_permission"),
        )
    _create_index_if_missing(bind, "idx_admin_role_permissions_role_id", "admin_role_permissions", ["role_id"])
    _create_index_if_missing(
        bind,
        "idx_admin_role_permissions_permission_id",
        "admin_role_permissions",
        ["permission_id"],
    )


def downgrade() -> None:
    bind = op.get_bind()

    for table_name in (
        "admin_role_permissions",
        "admin_user_roles",
        "admin_permissions",
        "admin_roles",
        "admin_users",
    ):
        if _has_table(bind, table_name):
            op.drop_table(table_name)
