"""reference overlay market status

Revision ID: 20260529_000063
Revises: 20260529_000062
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000063"
down_revision = "20260529_000062"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _add_column_if_missing(bind, table_name: str, column: sa.Column) -> None:
    if not _has_column(bind, table_name, column.name):
        op.add_column(table_name, column)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("market_status", sa.String(length=20), nullable=False, server_default=sa.text("'UNKNOWN'")),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("market_status_text", sa.String(length=100), nullable=True),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("price_time", sa.DateTime(), nullable=True),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("is_realtime", sa.Boolean(), nullable=False, server_default=sa.text("0")),
    )

    bind.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET market_status = COALESCE(NULLIF(market_status, ''), 'UNKNOWN'),
                market_status_text = COALESCE(NULLIF(market_status_text, ''), '状态未知'),
                is_realtime = COALESCE(is_realtime, 0)
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    for column_name in ["is_realtime", "price_time", "market_status_text", "market_status"]:
        if _has_column(bind, "reference_overlays", column_name):
            op.drop_column("reference_overlays", column_name)
