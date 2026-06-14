"""add activity center tables

Revision ID: 20260518_000040
Revises: 20260518_000039
Create Date: 2026-05-18 22:40:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260518_000040"
down_revision = "20260518_000039"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str]) -> None:
    if _has_table(bind, table_name) and not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "activities"):
        op.create_table(
            "activities",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("subtitle", sa.String(length=255), nullable=True),
            sa.Column("description", sa.String(length=500), nullable=True),
            sa.Column("detail_content", sa.Text(), nullable=True),
            sa.Column("reward_text", sa.String(length=255), nullable=True),
            sa.Column("reward_value", sa.Numeric(28, 8), nullable=True),
            sa.Column("cover_url", sa.String(length=500), nullable=True),
            sa.Column("banner_url", sa.String(length=500), nullable=True),
            sa.Column("banner_type", sa.String(length=20), nullable=False, server_default="image"),
            sa.Column("video_url", sa.String(length=500), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("start_at", sa.DateTime(), nullable=True),
            sa.Column("end_at", sa.DateTime(), nullable=True),
            sa.Column("cta_text", sa.String(length=100), nullable=True),
            sa.Column("cta_url", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
        )
    _create_index_if_missing(bind, "idx_activities_status_sort", "activities", ["status", "sort_order"])
    _create_index_if_missing(bind, "idx_activities_window", "activities", ["start_at", "end_at"])

    if not _has_table(bind, "activity_banners"):
        op.create_table(
            "activity_banners",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("subtitle", sa.String(length=255), nullable=True),
            sa.Column("media_type", sa.String(length=20), nullable=False, server_default="image"),
            sa.Column("media_url", sa.String(length=500), nullable=True),
            sa.Column("link_url", sa.String(length=500), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
            sa.Column("start_at", sa.DateTime(), nullable=True),
            sa.Column("end_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
        )
    _create_index_if_missing(
        bind,
        "idx_activity_banners_enabled_sort",
        "activity_banners",
        ["enabled", "sort_order"],
    )
    _create_index_if_missing(bind, "idx_activity_banners_window", "activity_banners", ["start_at", "end_at"])


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "activity_banners"):
        for index_name in ("idx_activity_banners_window", "idx_activity_banners_enabled_sort"):
            if _has_index(bind, "activity_banners", index_name):
                op.drop_index(index_name, table_name="activity_banners")
        op.drop_table("activity_banners")

    if _has_table(bind, "activities"):
        for index_name in ("idx_activities_window", "idx_activities_status_sort"):
            if _has_index(bind, "activities", index_name):
                op.drop_index(index_name, table_name="activities")
        op.drop_table("activities")
