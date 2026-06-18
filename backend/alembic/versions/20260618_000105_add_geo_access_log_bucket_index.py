"""add geo access log bucket index

Revision ID: 20260618_000105
Revises: 20260618_000104
Create Date: 2026-06-18 00:01:05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260618_000105"
down_revision = "20260618_000104"
branch_labels = None
depends_on = None


def _has_index(bind, table_name: str, index_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_index(bind, "geo_access_logs", "idx_geo_access_logs_bucket"):
        op.create_index(
            "idx_geo_access_logs_bucket",
            "geo_access_logs",
            ["ip_address", "country_code", "source", "decision", "reason", "created_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, "geo_access_logs", "idx_geo_access_logs_bucket"):
        op.drop_index("idx_geo_access_logs_bucket", table_name="geo_access_logs")
