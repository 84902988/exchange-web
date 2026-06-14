"""add user invite commission rcb fields

Revision ID: 20260430_000009
Revises: 20260430_000008
Create Date: 2026-04-30 00:00:09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260430_000009"
down_revision = "20260430_000008"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    table_name = "user_invite_commission_records"

    if not _has_column(bind, table_name, "fee_usdt_value"):
        op.add_column(
            table_name,
            sa.Column("fee_usdt_value", sa.Numeric(36, 18), nullable=False, server_default="0"),
        )
    if not _has_column(bind, table_name, "rcb_price_used"):
        op.add_column(table_name, sa.Column("rcb_price_used", sa.Numeric(36, 18), nullable=True))
    if not _has_column(bind, table_name, "commission_asset_symbol"):
        op.add_column(
            table_name,
            sa.Column("commission_asset_symbol", sa.String(length=20), nullable=False, server_default="RCB"),
        )
    if not _has_column(bind, table_name, "commission_rcb_amount"):
        op.add_column(
            table_name,
            sa.Column("commission_rcb_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
        )

    op.execute(
        """
        UPDATE user_invite_commission_records
        SET
            commission_asset_symbol = 'RCB',
            commission_rcb_amount = commission_amount
        WHERE commission_rcb_amount = 0
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    table_name = "user_invite_commission_records"

    for column_name in (
        "commission_rcb_amount",
        "commission_asset_symbol",
        "rcb_price_used",
        "fee_usdt_value",
    ):
        if _has_column(bind, table_name, column_name):
            op.drop_column(table_name, column_name)
