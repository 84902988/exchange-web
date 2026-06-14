"""add asset-chain withdraw risk config

Revision ID: 20260519_000041
Revises: 20260518_000040
Create Date: 2026-05-19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260519_000041"
down_revision = "20260518_000040"
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
    if not _has_table(bind, "asset_chains"):
        return

    if not _has_column(bind, "asset_chains", "force_manual_review"):
        op.add_column(
            "asset_chains",
            sa.Column(
                "force_manual_review",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
                comment="是否强制人工审核该币种网络的所有提现",
            ),
        )

    if not _has_column(bind, "asset_chains", "daily_withdraw_count_limit"):
        op.add_column(
            "asset_chains",
            sa.Column(
                "daily_withdraw_count_limit",
                sa.Integer(),
                nullable=True,
                comment="用户每日该币种网络提现次数达到该值后进入人工审核",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "asset_chains", "daily_withdraw_count_limit"):
        op.drop_column("asset_chains", "daily_withdraw_count_limit")
    if _has_column(bind, "asset_chains", "force_manual_review"):
        op.drop_column("asset_chains", "force_manual_review")
