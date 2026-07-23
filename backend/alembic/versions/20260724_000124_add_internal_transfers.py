"""add internal transfers

Revision ID: 20260724_000124
Revises: 20260723_000123
Create Date: 2026-07-24
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260724_000124"
down_revision = "20260723_000123"
branch_labels = None
depends_on = None


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    return sa.inspect(op.get_bind()).has_table(table_name)


def upgrade() -> None:
    if _has_table("internal_transfers"):
        return

    op.create_table(
        "internal_transfers",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("transfer_no", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("coin_symbol", sa.String(length=32), nullable=False),
        sa.Column("from_account", sa.String(length=32), nullable=False),
        sa.Column("to_account", sa.String(length=32), nullable=False),
        sa.Column("amount", sa.Numeric(36, 18), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("from_available_before", sa.Numeric(36, 18), nullable=False),
        sa.Column("from_available_after", sa.Numeric(36, 18), nullable=False),
        sa.Column("to_available_before", sa.Numeric(36, 18), nullable=False),
        sa.Column("to_available_after", sa.Numeric(36, 18), nullable=False),
        sa.Column("remark", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("transfer_no", name="uq_internal_transfer_no"),
    )
    op.create_index(
        "ix_internal_transfers_user_id",
        "internal_transfers",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "ix_internal_transfers_coin_symbol",
        "internal_transfers",
        ["coin_symbol"],
        unique=False,
    )
    op.create_index(
        "ix_internal_transfer_user_time",
        "internal_transfers",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_internal_transfer_user_symbol_time",
        "internal_transfers",
        ["user_id", "coin_symbol", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    if _has_table("internal_transfers"):
        op.drop_table("internal_transfers")
