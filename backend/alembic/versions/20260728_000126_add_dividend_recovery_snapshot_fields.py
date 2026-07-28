"""add dividend recovery snapshot audit fields

Revision ID: 20260728_000126
Revises: 20260728_000125
Create Date: 2026-07-28
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260728_000126"
down_revision = "20260728_000125"
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
    if _has_table("dividend_eligibility_snapshots"):
        if not _has_column("dividend_eligibility_snapshots", "source"):
            op.add_column(
                "dividend_eligibility_snapshots",
                sa.Column(
                    "source",
                    sa.String(length=20),
                    nullable=False,
                    server_default=sa.text("'AUTO'"),
                ),
            )
        if not _has_column("dividend_eligibility_snapshots", "created_by"):
            op.add_column(
                "dividend_eligibility_snapshots",
                sa.Column("created_by", sa.BigInteger(), nullable=True),
            )

    if _has_table("dividend_eligibility_snapshot_items") and not _has_column(
        "dividend_eligibility_snapshot_items", "dividend_rate"
    ):
        op.add_column(
            "dividend_eligibility_snapshot_items",
            sa.Column(
                "dividend_rate",
                sa.Numeric(18, 8),
                nullable=False,
                server_default=sa.text("'0.05'"),
            ),
        )


def downgrade() -> None:
    if _has_column("dividend_eligibility_snapshot_items", "dividend_rate"):
        op.drop_column("dividend_eligibility_snapshot_items", "dividend_rate")
    if _has_column("dividend_eligibility_snapshots", "created_by"):
        op.drop_column("dividend_eligibility_snapshots", "created_by")
    if _has_column("dividend_eligibility_snapshots", "source"):
        op.drop_column("dividend_eligibility_snapshots", "source")
