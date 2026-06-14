"""add content i18n json fields

Revision ID: 20260611_000088
Revises: 20260609_000087
Create Date: 2026-06-11
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260611_000088"
down_revision = "20260609_000087"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _add_column_if_missing(bind, table_name: str, column_name: str) -> None:
    if _has_table(bind, table_name) and not _has_column(bind, table_name, column_name):
        op.add_column(table_name, sa.Column(column_name, sa.JSON(), nullable=True))


def upgrade() -> None:
    bind = op.get_bind()

    for column_name in (
        "site_name_i18n",
        "site_slogan_i18n",
        "risk_disclaimer_i18n",
        "footer_disclaimer_i18n",
        "stock_token_locks_notice_title_i18n",
        "stock_token_locks_notice_content_i18n",
        "home_hero_title_i18n",
        "home_hero_subtitle_i18n",
        "home_hero_cta_text_i18n",
    ):
        _add_column_if_missing(bind, "site_settings", column_name)

    for column_name in ("title_i18n", "subtitle_i18n"):
        _add_column_if_missing(bind, "home_banners", column_name)
        _add_column_if_missing(bind, "activity_banners", column_name)

    for column_name in (
        "title_i18n",
        "subtitle_i18n",
        "description_i18n",
        "detail_content_i18n",
        "reward_text_i18n",
        "cta_text_i18n",
    ):
        _add_column_if_missing(bind, "activities", column_name)

    for column_name in ("title_i18n", "summary_i18n", "content_i18n"):
        _add_column_if_missing(bind, "announcements", column_name)


def downgrade() -> None:
    bind = op.get_bind()

    table_columns = {
        "announcements": ("content_i18n", "summary_i18n", "title_i18n"),
        "activities": (
            "cta_text_i18n",
            "reward_text_i18n",
            "detail_content_i18n",
            "description_i18n",
            "subtitle_i18n",
            "title_i18n",
        ),
        "activity_banners": ("subtitle_i18n", "title_i18n"),
        "home_banners": ("subtitle_i18n", "title_i18n"),
        "site_settings": (
            "home_hero_cta_text_i18n",
            "home_hero_subtitle_i18n",
            "home_hero_title_i18n",
            "stock_token_locks_notice_content_i18n",
            "stock_token_locks_notice_title_i18n",
            "footer_disclaimer_i18n",
            "risk_disclaimer_i18n",
            "site_slogan_i18n",
            "site_name_i18n",
        ),
    }
    for table_name, column_names in table_columns.items():
        if not _has_table(bind, table_name):
            continue
        for column_name in column_names:
            if _has_column(bind, table_name, column_name):
                op.drop_column(table_name, column_name)
