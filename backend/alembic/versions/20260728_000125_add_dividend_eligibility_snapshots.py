"""add immutable dividend eligibility snapshots

Revision ID: 20260728_000125
Revises: 20260724_000124
Create Date: 2026-07-28
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260728_000125"
down_revision = "20260724_000124"
branch_labels = None
depends_on = None


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    return sa.inspect(op.get_bind()).has_table(table_name)


def _has_column(table_name: str, column_name: str) -> bool:
    if not _has_table(table_name):
        return False
    return any(
        str(column.get("name") or "") == column_name
        for column in sa.inspect(op.get_bind()).get_columns(table_name)
    )


def upgrade() -> None:
    if _has_table("dividend_pools"):
        if not _has_column("dividend_pools", "rcb_price_snapshot_at"):
            op.add_column(
                "dividend_pools",
                sa.Column("rcb_price_snapshot_at", sa.DateTime(), nullable=True),
            )
        if not _has_column("dividend_pools", "rcb_price_source_trade_id"):
            op.add_column(
                "dividend_pools",
                sa.Column("rcb_price_source_trade_id", sa.BigInteger(), nullable=True),
            )
        if not _has_column("dividend_pools", "rcb_price_source_trade_at"):
            op.add_column(
                "dividend_pools",
                sa.Column("rcb_price_source_trade_at", sa.DateTime(), nullable=True),
            )

    if not _has_table("dividend_eligibility_snapshots"):
        op.create_table(
            "dividend_eligibility_snapshots",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("dividend_date", sa.Date(), nullable=False),
            sa.Column("snapshot_at", sa.DateTime(), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("eligible_user_count", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint(
                "dividend_date",
                name="uq_dividend_eligibility_snapshots_date",
            ),
        )
        op.create_index(
            "idx_dividend_eligibility_snapshots_status",
            "dividend_eligibility_snapshots",
            ["status"],
            unique=False,
        )

    if not _has_table("dividend_eligibility_snapshot_items"):
        op.create_table(
            "dividend_eligibility_snapshot_items",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("snapshot_id", sa.BigInteger(), nullable=False),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("level_code", sa.String(length=30), nullable=False),
            sa.Column("qualified_lock_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("required_lock_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("required_lock_period_days", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["snapshot_id"],
                ["dividend_eligibility_snapshots.id"],
                name="fk_dividend_eligibility_snapshot_items_snapshot",
            ),
            sa.UniqueConstraint(
                "snapshot_id",
                "user_id",
                name="uq_dividend_eligibility_snapshot_items_user",
            ),
        )
        op.create_index(
            "idx_dividend_eligibility_snapshot_items_level",
            "dividend_eligibility_snapshot_items",
            ["snapshot_id", "level_code"],
            unique=False,
        )


def downgrade() -> None:
    if _has_table("dividend_eligibility_snapshot_items"):
        op.drop_table("dividend_eligibility_snapshot_items")
    if _has_table("dividend_eligibility_snapshots"):
        op.drop_table("dividend_eligibility_snapshots")
    if _has_column("dividend_pools", "rcb_price_source_trade_id"):
        op.drop_column("dividend_pools", "rcb_price_source_trade_id")
    if _has_column("dividend_pools", "rcb_price_source_trade_at"):
        op.drop_column("dividend_pools", "rcb_price_source_trade_at")
    if _has_column("dividend_pools", "rcb_price_snapshot_at"):
        op.drop_column("dividend_pools", "rcb_price_snapshot_at")
