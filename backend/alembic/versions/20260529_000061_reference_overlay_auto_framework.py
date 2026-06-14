"""reference overlay auto framework

Revision ID: 20260529_000061
Revises: 20260529_000060
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000061"
down_revision = "20260529_000060"
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
        sa.Column("price_source", sa.String(length=20), nullable=False, server_default=sa.text("'MANUAL'")),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("auto_source", sa.String(length=50), nullable=True),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("refresh_interval_sec", sa.Integer(), nullable=False, server_default=sa.text("300")),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("last_ref_price", sa.Numeric(36, 18), nullable=True),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("last_ref_label", sa.String(length=255), nullable=True),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("last_sync_at", sa.DateTime(), nullable=True),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("sync_status", sa.String(length=20), nullable=False, server_default=sa.text("'PENDING'")),
    )
    _add_column_if_missing(
        bind,
        "reference_overlays",
        sa.Column("sync_error", sa.Text(), nullable=True),
    )

    bind.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET price_source = COALESCE(NULLIF(price_source, ''), 'MANUAL'),
                sync_status = COALESCE(NULLIF(sync_status, ''), 'PENDING'),
                refresh_interval_sec = COALESCE(refresh_interval_sec, 300)
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    for column_name in [
        "sync_error",
        "sync_status",
        "last_sync_at",
        "last_ref_label",
        "last_ref_price",
        "refresh_interval_sec",
        "auto_source",
        "price_source",
    ]:
        if _has_column(bind, "reference_overlays", column_name):
            op.drop_column("reference_overlays", column_name)
