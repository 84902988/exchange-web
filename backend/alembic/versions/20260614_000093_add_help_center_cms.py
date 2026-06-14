"""add help center cms tables

Revision ID: 20260614_000093
Revises: 20260614_000092
Create Date: 2026-06-14
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260614_000093"
down_revision: Union[str, None] = "20260614_000092"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_index(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    if not _has_table("help_categories"):
        op.create_table(
            "help_categories",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("category_key", sa.String(length=100), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("title_i18n", sa.JSON(), nullable=True),
            sa.Column("description", sa.String(length=500), nullable=True),
            sa.Column("description_i18n", sa.JSON(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("category_key", name="uq_help_categories_category_key"),
        )
    if not _has_index("help_categories", "ix_help_categories_enabled_sort"):
        op.create_index(
            "ix_help_categories_enabled_sort",
            "help_categories",
            ["enabled", "sort_order", "id"],
            unique=False,
        )

    if not _has_table("help_articles"):
        op.create_table(
            "help_articles",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("category_id", sa.BigInteger(), nullable=False),
            sa.Column("slug", sa.String(length=191), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("title_i18n", sa.JSON(), nullable=True),
            sa.Column("summary", sa.String(length=500), nullable=True),
            sa.Column("summary_i18n", sa.JSON(), nullable=True),
            sa.Column("content", sa.Text(), nullable=True),
            sa.Column("content_i18n", sa.JSON(), nullable=True),
            sa.Column("tags_json", sa.JSON(), nullable=True),
            sa.Column("is_hot", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("source_type", sa.String(length=50), nullable=False, server_default="cms"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["category_id"], ["help_categories.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("slug", name="uq_help_articles_slug"),
        )
    if not _has_index("help_articles", "ix_help_articles_category_enabled_sort"):
        op.create_index(
            "ix_help_articles_category_enabled_sort",
            "help_articles",
            ["category_id", "enabled", "sort_order", "id"],
            unique=False,
        )
    if not _has_index("help_articles", "ix_help_articles_enabled_hot_sort"):
        op.create_index(
            "ix_help_articles_enabled_hot_sort",
            "help_articles",
            ["enabled", "is_hot", "sort_order", "id"],
            unique=False,
        )


def downgrade() -> None:
    if _has_table("help_articles"):
        if _has_index("help_articles", "ix_help_articles_enabled_hot_sort"):
            op.drop_index("ix_help_articles_enabled_hot_sort", table_name="help_articles")
        if _has_index("help_articles", "ix_help_articles_category_enabled_sort"):
            op.drop_index("ix_help_articles_category_enabled_sort", table_name="help_articles")
        op.drop_table("help_articles")

    if _has_table("help_categories"):
        if _has_index("help_categories", "ix_help_categories_enabled_sort"):
            op.drop_index("ix_help_categories_enabled_sort", table_name="help_categories")
        op.drop_table("help_categories")
