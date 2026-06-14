"""move withdraw fee maintenance config to chains

Revision ID: 20260601_000076
Revises: 20260601_000075
Create Date: 2026-06-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260601_000076"
down_revision = "20260601_000075"
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


def _migrate_asset_chain_fee_values(bind) -> None:
    if not _has_table(bind, "asset_chains") or not _has_table(bind, "chains"):
        return
    if not _has_column(bind, "asset_chains", "withdraw_fee"):
        return

    bind.execute(
        sa.text(
            """
            UPDATE chains c
            JOIN (
                SELECT
                    chain_id,
                    MAX(NULLIF(withdraw_fee, 0)) AS withdraw_fee,
                    MAX(COALESCE(withdraw_fee_auto_enabled, 0)) AS withdraw_fee_auto_enabled,
                    MAX(NULLIF(withdraw_fee_min, 0)) AS withdraw_fee_min,
                    MAX(NULLIF(withdraw_fee_max, 0)) AS withdraw_fee_max,
                    MAX(NULLIF(withdraw_fee_multiplier, 0)) AS withdraw_fee_multiplier,
                    MAX(NULLIF(withdraw_fee_update_threshold, 0)) AS withdraw_fee_update_threshold,
                    MAX(withdraw_fee_last_estimated_cost) AS withdraw_fee_last_estimated,
                    MAX(withdraw_fee_suggested) AS withdraw_fee_last_suggested,
                    MAX(withdraw_fee_last_estimated_at) AS withdraw_fee_last_updated_at,
                    MAX(NULLIF(withdraw_fee_last_error, '')) AS withdraw_fee_last_error
                FROM asset_chains
                GROUP BY chain_id
            ) src ON src.chain_id = c.id
            SET c.withdraw_fee = COALESCE(src.withdraw_fee, c.withdraw_fee, 0.005),
                c.withdraw_fee_auto_enabled = COALESCE(src.withdraw_fee_auto_enabled, c.withdraw_fee_auto_enabled, 0),
                c.withdraw_fee_min = COALESCE(src.withdraw_fee_min, c.withdraw_fee_min, 0.005),
                c.withdraw_fee_max = COALESCE(src.withdraw_fee_max, c.withdraw_fee_max, 100),
                c.withdraw_fee_multiplier = COALESCE(src.withdraw_fee_multiplier, c.withdraw_fee_multiplier, 1.3),
                c.withdraw_fee_update_threshold = COALESCE(src.withdraw_fee_update_threshold, c.withdraw_fee_update_threshold, 0.001),
                c.withdraw_fee_last_estimated = COALESCE(src.withdraw_fee_last_estimated, c.withdraw_fee_last_estimated),
                c.withdraw_fee_last_suggested = COALESCE(src.withdraw_fee_last_suggested, c.withdraw_fee_last_suggested),
                c.withdraw_fee_last_updated_at = COALESCE(src.withdraw_fee_last_updated_at, c.withdraw_fee_last_updated_at),
                c.withdraw_fee_last_error = COALESCE(src.withdraw_fee_last_error, c.withdraw_fee_last_error)
            """
        )
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "chains"):
        return

    _add_column_if_missing("chains", sa.Column("withdraw_fee", AMOUNT, nullable=False, server_default="0.005"))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_auto_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_min", AMOUNT, nullable=False, server_default="0.005"))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_max", AMOUNT, nullable=False, server_default="100"))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_multiplier", sa.Numeric(18, 8), nullable=False, server_default="1.3"))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_update_threshold", AMOUNT, nullable=False, server_default="0.001"))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_last_estimated", AMOUNT, nullable=True))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_last_suggested", AMOUNT, nullable=True))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_last_updated_at", sa.DateTime(), nullable=True))
    _add_column_if_missing("chains", sa.Column("withdraw_fee_last_error", sa.String(length=512), nullable=True))

    _migrate_asset_chain_fee_values(bind)


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "chains"):
        return
    for column_name in (
        "withdraw_fee_last_error",
        "withdraw_fee_last_updated_at",
        "withdraw_fee_last_suggested",
        "withdraw_fee_last_estimated",
        "withdraw_fee_update_threshold",
        "withdraw_fee_multiplier",
        "withdraw_fee_max",
        "withdraw_fee_min",
        "withdraw_fee_auto_enabled",
        "withdraw_fee",
    ):
        if _has_column(bind, "chains", column_name):
            op.drop_column("chains", column_name)
