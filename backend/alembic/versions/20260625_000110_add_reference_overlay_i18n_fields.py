"""add reference overlay i18n fields

Revision ID: 20260625_000110
Revises: 20260619_000109
Create Date: 2026-06-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260625_000110"
down_revision = "20260619_000109"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _add_json_column_if_missing(bind, table_name: str, column_name: str) -> None:
    if _has_table(bind, table_name) and not _has_column(bind, table_name, column_name):
        op.add_column(table_name, sa.Column(column_name, sa.JSON(), nullable=True))


def upgrade() -> None:
    bind = op.get_bind()
    for column_name in (
        "title_i18n",
        "source_label_i18n",
        "description_i18n",
        "line_title_i18n",
        "display_value_label_i18n",
    ):
        _add_json_column_if_missing(bind, "reference_overlays", column_name)


def downgrade() -> None:
    bind = op.get_bind()
    for column_name in (
        "display_value_label_i18n",
        "line_title_i18n",
        "description_i18n",
        "source_label_i18n",
        "title_i18n",
    ):
        if _has_column(bind, "reference_overlays", column_name):
            op.drop_column("reference_overlays", column_name)
