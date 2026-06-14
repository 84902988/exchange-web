"""add asset-chain withdraw review threshold

Revision ID: 20260511_000030
Revises: 20260511_000029
Create Date: 2026-05-11
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260511_000030"
down_revision = "20260511_000029"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "asset_chains") and not _has_column(bind, "asset_chains", "review_threshold_amount"):
        op.add_column(
            "asset_chains",
            sa.Column(
                "review_threshold_amount",
                sa.Numeric(36, 18),
                nullable=True,
                comment="单笔提现达到该金额后进入人工审核",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "asset_chains", "review_threshold_amount"):
        op.drop_column("asset_chains", "review_threshold_amount")
