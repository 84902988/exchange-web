"""extend geo access log rollup fields

Revision ID: 20260618_000104
Revises: 20260618_000103
Create Date: 2026-06-18
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260618_000104"
down_revision = "20260618_000103"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in sa.inspect(bind).get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in sa.inspect(bind).get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "geo_access_logs"):
        return

    if not _has_column(bind, "geo_access_logs", "hit_count"):
        op.add_column(
            "geo_access_logs",
            sa.Column("hit_count", sa.Integer(), nullable=False, server_default="1"),
        )
    if not _has_column(bind, "geo_access_logs", "first_seen_at"):
        op.add_column(
            "geo_access_logs",
            sa.Column("first_seen_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
    if not _has_column(bind, "geo_access_logs", "last_seen_at"):
        op.add_column(
            "geo_access_logs",
            sa.Column("last_seen_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
    if not _has_column(bind, "geo_access_logs", "last_path"):
        op.add_column(
            "geo_access_logs",
            sa.Column("last_path", sa.String(length=512), nullable=False, server_default=""),
        )

    op.execute(
        sa.text(
            """
            UPDATE geo_access_logs
            SET
                hit_count = COALESCE(NULLIF(hit_count, 0), 1),
                first_seen_at = COALESCE(first_seen_at, created_at),
                last_seen_at = COALESCE(last_seen_at, created_at),
                last_path = CASE WHEN COALESCE(last_path, '') = '' THEN path ELSE last_path END
            """
        )
    )

    if not _has_index(bind, "geo_access_logs", "idx_geo_access_logs_aggregate"):
        op.create_index(
            "idx_geo_access_logs_aggregate",
            "geo_access_logs",
            ["ip_address", "country_code", "decision", "reason", "last_seen_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "geo_access_logs"):
        return

    if _has_index(bind, "geo_access_logs", "idx_geo_access_logs_aggregate"):
        op.drop_index("idx_geo_access_logs_aggregate", table_name="geo_access_logs")
    if _has_column(bind, "geo_access_logs", "last_path"):
        op.drop_column("geo_access_logs", "last_path")
    if _has_column(bind, "geo_access_logs", "last_seen_at"):
        op.drop_column("geo_access_logs", "last_seen_at")
    if _has_column(bind, "geo_access_logs", "first_seen_at"):
        op.drop_column("geo_access_logs", "first_seen_at")
    if _has_column(bind, "geo_access_logs", "hit_count"):
        op.drop_column("geo_access_logs", "hit_count")
