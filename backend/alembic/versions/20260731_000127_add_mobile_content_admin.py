"""add isolated mobile content tables and admin permission

Revision ID: 20260731_000127
Revises: 20260728_000126
Create Date: 2026-07-31
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "20260731_000127"
down_revision: Union[str, None] = "20260728_000126"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PERMISSION_CODE = "mobile_content.manage"
PERMISSION_DESCRIPTION = "可维护独立的手机端设置、Banner、公告与移动图片"
ID_TYPE = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def _has_table(bind, table_name: str) -> bool:
    return table_name in sa.inspect(bind).get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    op.create_table(
        "mobile_content_settings",
        sa.Column("id", ID_TYPE, autoincrement=True, nullable=False),
        sa.Column("app_name", sa.String(length=100), nullable=False, server_default="Exchange"),
        sa.Column("app_name_i18n", sa.JSON(), nullable=True),
        sa.Column("logo_url", sa.String(length=500), nullable=True),
        sa.Column("logo_width", sa.Integer(), nullable=True),
        sa.Column("logo_height", sa.Integer(), nullable=True),
        sa.Column("logo_byte_size", sa.Integer(), nullable=True),
        sa.Column("logo_mime_type", sa.String(length=50), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "mobile_home_banners",
        sa.Column("id", ID_TYPE, autoincrement=True, nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("title_i18n", sa.JSON(), nullable=True),
        sa.Column("subtitle", sa.String(length=500), nullable=True),
        sa.Column("subtitle_i18n", sa.JSON(), nullable=True),
        sa.Column("image_url", sa.String(length=500), nullable=False),
        sa.Column("image_width", sa.Integer(), nullable=False),
        sa.Column("image_height", sa.Integer(), nullable=False),
        sa.Column("image_byte_size", sa.Integer(), nullable=False),
        sa.Column("image_mime_type", sa.String(length=50), nullable=False),
        sa.Column("placement", sa.String(length=20), nullable=False, server_default="PROMO"),
        sa.Column("action_type", sa.String(length=20), nullable=True),
        sa.Column("action_route", sa.String(length=20), nullable=True),
        sa.Column("aspect_ratio", sa.String(length=20), nullable=False, server_default="3:1"),
        sa.Column("recommended_size", sa.String(length=20), nullable=False, server_default="1200x400"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"),
        sa.Column("start_at", sa.DateTime(), nullable=True),
        sa.Column("end_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_mobile_home_banners_status_sort",
        "mobile_home_banners",
        ["status", "sort_order"],
        unique=False,
    )
    op.create_index(
        "idx_mobile_home_banners_window",
        "mobile_home_banners",
        ["start_at", "end_at"],
        unique=False,
    )

    op.create_table(
        "mobile_announcements",
        sa.Column("id", ID_TYPE, autoincrement=True, nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("title_i18n", sa.JSON(), nullable=True),
        sa.Column("slug", sa.String(length=191), nullable=False),
        sa.Column("summary", sa.String(length=500), nullable=True),
        sa.Column("summary_i18n", sa.JSON(), nullable=True),
        sa.Column("category_label", sa.String(length=40), nullable=False, server_default="公告"),
        sa.Column(
            "content",
            sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql"),
            nullable=False,
        ),
        sa.Column("content_i18n", sa.JSON(), nullable=True),
        sa.Column("content_format", sa.String(length=20), nullable=False, server_default="PLAIN_TEXT"),
        sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="DRAFT"),
        sa.Column("publish_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug", name="uq_mobile_announcements_slug"),
    )
    op.create_index(
        "idx_mobile_announcements_status_publish",
        "mobile_announcements",
        ["status", "publish_at"],
        unique=False,
    )
    op.create_index(
        "idx_mobile_announcements_pinned",
        "mobile_announcements",
        ["is_pinned"],
        unique=False,
    )

    op.execute(
        sa.text(
            """
            INSERT INTO mobile_content_settings
                (app_name, created_at, updated_at)
            SELECT 'Exchange', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            WHERE NOT EXISTS (SELECT 1 FROM mobile_content_settings)
            """
        )
    )

    if _has_table(bind, "admin_permissions"):
        op.execute(
            sa.text(
                """
                INSERT INTO admin_permissions (code, name, group_code, description, created_at, updated_at)
                SELECT :code, '手机端内容管理', 'content',
                       :description,
                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (SELECT 1 FROM admin_permissions WHERE code = :code)
                """
            ).bindparams(code=PERMISSION_CODE, description=PERMISSION_DESCRIPTION)
        )
    if all(_has_table(bind, table) for table in ("admin_roles", "admin_permissions", "admin_role_permissions")):
        op.execute(
            sa.text(
                """
                INSERT INTO admin_role_permissions (role_id, permission_id, created_at)
                SELECT r.id, p.id, CURRENT_TIMESTAMP
                FROM admin_roles r
                JOIN admin_permissions p ON p.code = :code
                WHERE r.code = 'super_admin'
                  AND NOT EXISTS (
                    SELECT 1 FROM admin_role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id
                  )
                """
            ).bindparams(code=PERMISSION_CODE)
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "admin_role_permissions") and _has_table(bind, "admin_permissions"):
        op.execute(
            sa.text(
                """
                DELETE FROM admin_role_permissions
                WHERE permission_id IN (
                    SELECT id
                    FROM admin_permissions
                    WHERE code = :code
                      AND description = :description
                )
                """
            ).bindparams(code=PERMISSION_CODE, description=PERMISSION_DESCRIPTION)
        )
    if _has_table(bind, "admin_permissions"):
        op.execute(
            sa.text(
                """
                DELETE FROM admin_permissions
                WHERE code = :code
                  AND description = :description
                """
            ).bindparams(code=PERMISSION_CODE, description=PERMISSION_DESCRIPTION)
        )

    op.drop_index("idx_mobile_announcements_pinned", table_name="mobile_announcements")
    op.drop_index("idx_mobile_announcements_status_publish", table_name="mobile_announcements")
    op.drop_table("mobile_announcements")
    op.drop_index("idx_mobile_home_banners_window", table_name="mobile_home_banners")
    op.drop_index("idx_mobile_home_banners_status_sort", table_name="mobile_home_banners")
    op.drop_table("mobile_home_banners")
    op.drop_table("mobile_content_settings")
