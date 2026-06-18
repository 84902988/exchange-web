"""add collection gas cost records

Revision ID: 20260616_000096
Revises: 20260615_000095
Create Date: 2026-06-16
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "20260616_000096"
down_revision: Union[str, None] = "20260615_000095"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_index(table_name: str, index_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    if not _has_table("collection_gas_cost_records"):
        op.create_table(
            "collection_gas_cost_records",
            sa.Column("id", mysql.BIGINT(unsigned=True), autoincrement=True, nullable=False),
            sa.Column("collection_task_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("chain_key", sa.String(length=32), nullable=False),
            sa.Column("token_symbol", sa.String(length=32), nullable=False),
            sa.Column("tx_hash", sa.String(length=128), nullable=False),
            sa.Column("gas_used", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("gas_price_wei", sa.Numeric(65, 0), nullable=False),
            sa.Column("native_fee", sa.Numeric(36, 18), nullable=False),
            sa.Column("native_symbol", sa.String(length=32), nullable=False),
            sa.Column("receipt_status", sa.Integer(), nullable=False),
            sa.Column("transfer_verified", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("confirmed_at", sa.DateTime(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("collection_task_id", name="uk_collection_gas_cost_task"),
            sa.UniqueConstraint("tx_hash", name="uk_collection_gas_cost_tx_hash"),
        )

    if not _has_index("collection_gas_cost_records", "idx_collection_gas_cost_chain_token_confirmed"):
        op.create_index(
            "idx_collection_gas_cost_chain_token_confirmed",
            "collection_gas_cost_records",
            ["chain_key", "token_symbol", "confirmed_at"],
            unique=False,
        )
    if not _has_index("collection_gas_cost_records", "idx_collection_gas_cost_created_at"):
        op.create_index(
            "idx_collection_gas_cost_created_at",
            "collection_gas_cost_records",
            ["created_at"],
            unique=False,
        )


def downgrade() -> None:
    if _has_table("collection_gas_cost_records"):
        if _has_index("collection_gas_cost_records", "idx_collection_gas_cost_created_at"):
            op.drop_index("idx_collection_gas_cost_created_at", table_name="collection_gas_cost_records")
        if _has_index("collection_gas_cost_records", "idx_collection_gas_cost_chain_token_confirmed"):
            op.drop_index("idx_collection_gas_cost_chain_token_confirmed", table_name="collection_gas_cost_records")
        op.drop_table("collection_gas_cost_records")
