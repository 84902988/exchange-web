"""add app download fields to site settings

Revision ID: 20260625_000111
Revises: 20260625_000110
Create Date: 2026-06-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260625_000111"
down_revision = "20260625_000110"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _add_column_if_missing(bind, table_name: str, column: sa.Column) -> None:
    if _has_table(bind, table_name) and not _has_column(bind, table_name, column.name):
        op.add_column(table_name, column)


def upgrade() -> None:
    bind = op.get_bind()
    _add_column_if_missing(bind, "site_settings", sa.Column("app_android_qr_url", sa.String(length=500), nullable=True))
    _add_column_if_missing(bind, "site_settings", sa.Column("app_ios_qr_url", sa.String(length=500), nullable=True))
    _add_column_if_missing(bind, "site_settings", sa.Column("app_download_title", sa.String(length=255), nullable=True))
    _add_column_if_missing(bind, "site_settings", sa.Column("app_download_title_i18n", sa.JSON(), nullable=True))
    _add_column_if_missing(bind, "site_settings", sa.Column("app_download_subtitle", sa.String(length=500), nullable=True))
    _add_column_if_missing(bind, "site_settings", sa.Column("app_download_subtitle_i18n", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    for column_name in (
        "app_download_subtitle_i18n",
        "app_download_subtitle",
        "app_download_title_i18n",
        "app_download_title",
        "app_ios_qr_url",
        "app_android_qr_url",
    ):
        if _has_column(bind, "site_settings", column_name):
            op.drop_column("site_settings", column_name)
