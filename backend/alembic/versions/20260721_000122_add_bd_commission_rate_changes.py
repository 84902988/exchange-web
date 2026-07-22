"""add bd commission rate changes

Revision ID: 20260721_000122
Revises: 20260715_000121
Create Date: 2026-07-21
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260721_000122"
down_revision = "20260715_000121"
branch_labels = None
depends_on = None


PERMISSION_CODE = "bd_commission_rate.manage"


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(item.get("name") == index_name for item in sa.inspect(bind).get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    table_name = "bd_commission_rate_change_logs"

    if not _has_table(bind, table_name):
        op.create_table(
            table_name,
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("bd_account_id", sa.BigInteger(), nullable=False),
            sa.Column("bd_user_id", sa.BigInteger(), nullable=False),
            sa.Column("application_id", sa.BigInteger(), nullable=False),
            sa.Column("old_commission_rate", sa.Numeric(10, 6), nullable=False),
            sa.Column("new_commission_rate", sa.Numeric(10, 6), nullable=False),
            sa.Column("changed_by_admin_id", sa.BigInteger(), nullable=False),
            sa.Column("reason", sa.String(length=500), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.PrimaryKeyConstraint("id", name="pk_bd_commission_rate_change_logs"),
        )

    if not _has_index(bind, table_name, "idx_bd_rate_change_logs_bd_user_id_id"):
        op.create_index(
            "idx_bd_rate_change_logs_bd_user_id_id",
            table_name,
            ["bd_user_id", "id"],
            unique=False,
        )
    if not _has_index(bind, table_name, "idx_bd_rate_change_logs_admin_created"):
        op.create_index(
            "idx_bd_rate_change_logs_admin_created",
            table_name,
            ["changed_by_admin_id", "created_at"],
            unique=False,
        )

    if _has_table(bind, "admin_permissions"):
        op.execute(
            sa.text(
                """
                INSERT INTO admin_permissions (code, name, group_code, description, created_at, updated_at)
                SELECT :code, :name, :group_code, :description, UTC_TIMESTAMP(), UTC_TIMESTAMP()
                WHERE NOT EXISTS (
                    SELECT 1 FROM admin_permissions WHERE code = :code
                )
                """
            ).bindparams(
                code=PERMISSION_CODE,
                name="BD分佣比例管理",
                group_code="business",
                description="可调整生效中 BD 账号的后续分佣比例",
            )
        )

    if all(
        _has_table(bind, table_name)
        for table_name in ("admin_roles", "admin_permissions", "admin_role_permissions")
    ):
        op.execute(
            sa.text(
                """
                INSERT IGNORE INTO admin_role_permissions (role_id, permission_id, created_at)
                SELECT eligible_roles.role_id, target_permission.id, UTC_TIMESTAMP()
                FROM (
                    SELECT r.id AS role_id
                    FROM admin_roles r
                    WHERE r.code = 'super_admin'
                    UNION
                    SELECT existing_rp.role_id
                    FROM admin_role_permissions existing_rp
                    JOIN admin_permissions existing_permission
                      ON existing_permission.id = existing_rp.permission_id
                    WHERE existing_permission.code = 'bd_accounts.manage'
                ) eligible_roles
                JOIN admin_permissions target_permission
                  ON target_permission.code = :code
                """
            ).bindparams(code=PERMISSION_CODE)
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "admin_permissions"):
        if _has_table(bind, "admin_role_permissions"):
            op.execute(
                sa.text(
                    """
                    DELETE rp
                    FROM admin_role_permissions rp
                    JOIN admin_permissions p ON p.id = rp.permission_id
                    WHERE p.code = :code
                    """
                ).bindparams(code=PERMISSION_CODE)
            )
        op.execute(sa.text("DELETE FROM admin_permissions WHERE code = :code").bindparams(code=PERMISSION_CODE))

    table_name = "bd_commission_rate_change_logs"
    if _has_table(bind, table_name):
        if _has_index(bind, table_name, "idx_bd_rate_change_logs_admin_created"):
            op.drop_index("idx_bd_rate_change_logs_admin_created", table_name=table_name)
        if _has_index(bind, table_name, "idx_bd_rate_change_logs_bd_user_id_id"):
            op.drop_index("idx_bd_rate_change_logs_bd_user_id_id", table_name=table_name)
        op.drop_table(table_name)
