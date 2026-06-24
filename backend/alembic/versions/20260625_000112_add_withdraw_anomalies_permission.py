"""add withdraw anomalies admin permission

Revision ID: 20260625_000112
Revises: 20260625_000111
Create Date: 2026-06-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260625_000112"
down_revision = "20260625_000111"
branch_labels = None
depends_on = None


PERMISSION_CODE = "withdraw_anomalies.view"


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "admin_permissions"):
        return

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
            name="提现异常治理查看",
            group_code="funds",
            description="可查看提现异常候选并释放未广播冻结资产",
        )
    )

    if _has_table(bind, "admin_roles") and _has_table(bind, "admin_role_permissions"):
        op.execute(
            sa.text(
                """
                INSERT IGNORE INTO admin_role_permissions (role_id, permission_id, created_at)
                SELECT r.id, p.id, UTC_TIMESTAMP()
                FROM admin_roles r
                JOIN admin_permissions p ON p.code = :code
                WHERE r.code = 'super_admin'
                """
            ).bindparams(code=PERMISSION_CODE)
        )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "admin_permissions"):
        return

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
