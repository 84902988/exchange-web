"""add asset chain withdraw fee maintenance fields

Revision ID: 20260601_000075
Revises: 20260601_000074
Create Date: 2026-06-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260601_000075"
down_revision = "20260601_000074"
branch_labels = None
depends_on = None


AMOUNT = sa.Numeric(36, 18)


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _add_column_if_missing(table_name: str, column: sa.Column) -> None:
    bind = op.get_bind()
    if not _has_column(bind, table_name, column.name):
        op.add_column(table_name, column)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "asset_chains"):
        return

    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee", AMOUNT, nullable=False, server_default="0.005"))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_auto_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_min", AMOUNT, nullable=False, server_default="0.005"))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_max", AMOUNT, nullable=False, server_default="100"))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_multiplier", sa.Numeric(18, 8), nullable=False, server_default="1.3"))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_update_threshold", AMOUNT, nullable=False, server_default="0.001"))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_last_estimated_cost", AMOUNT, nullable=True))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_suggested", AMOUNT, nullable=True))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_last_estimated_at", sa.DateTime(), nullable=True))
    _add_column_if_missing("asset_chains", sa.Column("withdraw_fee_last_error", sa.String(length=512), nullable=True))

    bind.execute(
        sa.text(
            """
            UPDATE asset_chains
            SET withdraw_fee = COALESCE(NULLIF(withdraw_fee, 0), 0.005),
                withdraw_fee_min = COALESCE(NULLIF(withdraw_fee_min, 0), 0.005),
                withdraw_fee_max = COALESCE(NULLIF(withdraw_fee_max, 0), 100),
                withdraw_fee_multiplier = COALESCE(NULLIF(withdraw_fee_multiplier, 0), 1.3),
                withdraw_fee_update_threshold = COALESCE(NULLIF(withdraw_fee_update_threshold, 0), 0.001)
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "asset_chains"):
        return
    for column_name in (
        "withdraw_fee_last_error",
        "withdraw_fee_last_estimated_at",
        "withdraw_fee_suggested",
        "withdraw_fee_last_estimated_cost",
        "withdraw_fee_update_threshold",
        "withdraw_fee_multiplier",
        "withdraw_fee_max",
        "withdraw_fee_min",
        "withdraw_fee_auto_enabled",
        "withdraw_fee",
    ):
        if _has_column(bind, "asset_chains", column_name):
            op.drop_column("asset_chains", column_name)
