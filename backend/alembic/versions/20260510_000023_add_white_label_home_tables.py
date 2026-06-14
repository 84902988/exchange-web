"""add white-label home content tables

Revision ID: 20260510_000023
Revises: 20260510_000022
Create Date: 2026-05-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260510_000023"
down_revision = "20260510_000022"
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

    if not _has_table(bind, "site_settings"):
        op.create_table(
            "site_settings",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("site_name", sa.String(length=100), nullable=False, server_default="Royal Exchange"),
            sa.Column("site_slogan", sa.String(length=255), nullable=True),
            sa.Column("logo_url", sa.String(length=500), nullable=True),
            sa.Column("support_email", sa.String(length=191), nullable=True),
            sa.Column("risk_disclaimer", sa.Text(), nullable=True),
            sa.Column("footer_disclaimer", sa.Text(), nullable=True),
            sa.Column("home_hero_title", sa.String(length=255), nullable=True),
            sa.Column("home_hero_subtitle", sa.String(length=500), nullable=True),
            sa.Column("home_hero_cta_text", sa.String(length=100), nullable=True),
            sa.Column("home_hero_cta_link", sa.String(length=500), nullable=True),
            sa.Column("home_hero_image", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
        )

    if not _has_table(bind, "home_banners"):
        op.create_table(
            "home_banners",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("image_url", sa.String(length=500), nullable=True),
            sa.Column("link_url", sa.String(length=500), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"),
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
    _create_index_if_missing(bind, "idx_home_banners_status_sort", "home_banners", ["status", "sort_order"])
    _create_index_if_missing(bind, "idx_home_banners_window", "home_banners", ["start_at", "end_at"])

    if not _has_table(bind, "announcements"):
        op.create_table(
            "announcements",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("slug", sa.String(length=191), nullable=False),
            sa.Column("summary", sa.String(length=500), nullable=True),
            sa.Column("content", sa.Text(), nullable=True),
            sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="PUBLISHED"),
            sa.Column("publish_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("slug", name="uq_announcements_slug"),
        )
    _create_index_if_missing(bind, "idx_announcements_status_publish", "announcements", ["status", "publish_at"])
    _create_index_if_missing(bind, "idx_announcements_pinned", "announcements", ["is_pinned"])

    op.execute(
        """
        INSERT INTO site_settings (
            id,
            site_name,
            site_slogan,
            support_email,
            footer_disclaimer,
            home_hero_title,
            home_hero_subtitle,
            home_hero_cta_text,
            home_hero_cta_link
        )
        VALUES (
            1,
            'Royal Exchange',
            'Global digital asset trading platform',
            'support@example.com',
            'Digital asset trading involves risk. Please trade responsibly.',
            'Reconstructing a New Order of Global Crypto Finance',
            'Trade digital assets with a fast, secure, and configurable exchange experience.',
            'Get Started',
            '/register'
        )
        ON DUPLICATE KEY UPDATE updated_at = updated_at
        """
    )


def downgrade() -> None:
    bind = op.get_bind()

    for table_name, indexes in (
        ("announcements", ["idx_announcements_status_publish", "idx_announcements_pinned"]),
        ("home_banners", ["idx_home_banners_status_sort", "idx_home_banners_window"]),
    ):
        if _has_table(bind, table_name):
            for index_name in indexes:
                if _has_index(bind, table_name, index_name):
                    op.drop_index(index_name, table_name=table_name)

    for table_name in ("announcements", "home_banners", "site_settings"):
        if _has_table(bind, table_name):
            op.drop_table(table_name)
