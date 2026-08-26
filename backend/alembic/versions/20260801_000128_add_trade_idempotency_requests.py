"""add trade request idempotency records

Revision ID: 20260801_000128
Revises: 20260731_000127
Create Date: 2026-08-01
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "20260801_000128"
down_revision: Union[str, None] = "20260731_000127"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID_TYPE = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "trade_idempotency_requests",
        sa.Column("id", ID_TYPE, autoincrement=True, nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("market", sa.String(length=16), nullable=False),
        sa.Column("operation", sa.String(length=48), nullable=False),
        sa.Column("client_order_id", sa.String(length=64), nullable=False),
        sa.Column(
            "fingerprint_version",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="PENDING",
        ),
        sa.Column(
            "response_json",
            sa.Text().with_variant(mysql.LONGTEXT(), "mysql"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "market",
            "client_order_id",
            name="uq_trade_idempotency_user_market_client",
        ),
    )
    op.create_index(
        "idx_trade_idempotency_user_created",
        "trade_idempotency_requests",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "idx_trade_idempotency_created",
        "trade_idempotency_requests",
        ["created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_trade_idempotency_created",
        table_name="trade_idempotency_requests",
    )
    op.drop_index(
        "idx_trade_idempotency_user_created",
        table_name="trade_idempotency_requests",
    )
    op.drop_table("trade_idempotency_requests")
