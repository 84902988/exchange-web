"""add site footer link config

Revision ID: 20260510_000024
Revises: 20260510_000023
Create Date: 2026-05-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260510_000024"
down_revision = "20260510_000023"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _add_column_if_missing(bind, column: sa.Column) -> None:
    if not _has_column(bind, "site_settings", column.name):
        op.add_column("site_settings", column)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "site_settings"):
        return

    _add_column_if_missing(
        bind,
        sa.Column("show_risk_link", sa.Boolean(), nullable=False, server_default=sa.text("1")),
    )
    _add_column_if_missing(bind, sa.Column("risk_link_url", sa.String(length=500), nullable=True))
    _add_column_if_missing(
        bind,
        sa.Column("show_terms_link", sa.Boolean(), nullable=False, server_default=sa.text("1")),
    )
    _add_column_if_missing(bind, sa.Column("terms_link_url", sa.String(length=500), nullable=True))
    _add_column_if_missing(
        bind,
        sa.Column("show_privacy_link", sa.Boolean(), nullable=False, server_default=sa.text("1")),
    )
    _add_column_if_missing(bind, sa.Column("privacy_link_url", sa.String(length=500), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "site_settings"):
        return

    for column_name in (
        "privacy_link_url",
        "show_privacy_link",
        "terms_link_url",
        "show_terms_link",
        "risk_link_url",
        "show_risk_link",
    ):
        if _has_column(bind, "site_settings", column_name):
            op.drop_column("site_settings", column_name)
