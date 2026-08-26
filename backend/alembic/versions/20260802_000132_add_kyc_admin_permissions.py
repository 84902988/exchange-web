"""add dedicated KYC admin permissions

Revision ID: 20260802_000132
Revises: 20260802_000131
Create Date: 2026-08-02
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260802_000132"
down_revision: Union[str, None] = "20260802_000131"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

VIEW_CODE = "kyc.view"
VIEW_DESCRIPTION = "可查看身份认证记录和受保护的证件材料"
MANAGE_CODE = "kyc.manage"
MANAGE_DESCRIPTION = "可通过或拒绝身份认证申请"


def _has_table(bind, table_name: str) -> bool:
    return table_name in sa.inspect(bind).get_table_names()


def _insert_permission(code: str, name: str, description: str) -> None:
    op.execute(
        sa.text(
            """
            INSERT INTO admin_permissions (code, name, group_code, description, created_at, updated_at)
            SELECT :code, :name, 'users', :description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            WHERE NOT EXISTS (SELECT 1 FROM admin_permissions WHERE code = :code)
            """
        ).bindparams(code=code, name=name, description=description)
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "admin_permissions"):
        return

    _insert_permission(VIEW_CODE, "KYC 资料查看", VIEW_DESCRIPTION)
    _insert_permission(MANAGE_CODE, "KYC 审核管理", MANAGE_DESCRIPTION)

    if not all(_has_table(bind, table) for table in ("admin_roles", "admin_role_permissions")):
        return

    op.execute(
        sa.text(
            """
            INSERT INTO admin_role_permissions (role_id, permission_id, created_at)
            SELECT existing.role_id, kyc_view.id, CURRENT_TIMESTAMP
            FROM admin_role_permissions existing
            JOIN admin_permissions users_view ON users_view.id = existing.permission_id
            JOIN admin_permissions kyc_view ON kyc_view.code = :view_code
            WHERE users_view.code = 'users.view'
              AND NOT EXISTS (
                SELECT 1 FROM admin_role_permissions target
                WHERE target.role_id = existing.role_id
                  AND target.permission_id = kyc_view.id
              )
            """
        ).bindparams(view_code=VIEW_CODE)
    )
    op.execute(
        sa.text(
            """
            INSERT INTO admin_role_permissions (role_id, permission_id, created_at)
            SELECT role.id, permission.id, CURRENT_TIMESTAMP
            FROM admin_roles role
            JOIN admin_permissions permission ON permission.code = :manage_code
            WHERE role.code = 'super_admin'
              AND NOT EXISTS (
                SELECT 1 FROM admin_role_permissions target
                WHERE target.role_id = role.id
                  AND target.permission_id = permission.id
              )
            """
        ).bindparams(manage_code=MANAGE_CODE)
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "admin_permissions"):
        return

    if _has_table(bind, "admin_role_permissions"):
        op.execute(
            sa.text(
                """
                DELETE FROM admin_role_permissions
                WHERE permission_id IN (
                    SELECT id FROM admin_permissions
                    WHERE (code = :view_code AND description = :view_description)
                       OR (code = :manage_code AND description = :manage_description)
                )
                """
            ).bindparams(
                view_code=VIEW_CODE,
                view_description=VIEW_DESCRIPTION,
                manage_code=MANAGE_CODE,
                manage_description=MANAGE_DESCRIPTION,
            )
        )
    op.execute(
        sa.text(
            """
            DELETE FROM admin_permissions
            WHERE (code = :view_code AND description = :view_description)
               OR (code = :manage_code AND description = :manage_description)
            """
        ).bindparams(
            view_code=VIEW_CODE,
            view_description=VIEW_DESCRIPTION,
            manage_code=MANAGE_CODE,
            manage_description=MANAGE_DESCRIPTION,
        )
    )
