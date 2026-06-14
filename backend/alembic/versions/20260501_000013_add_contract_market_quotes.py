"""add contract market quotes

Revision ID: 20260501_000013
Revises: 20260501_000012
Create Date: 2026-05-01 00:00:13
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000013"
down_revision = "20260501_000012"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "contract_market_quotes"):
        op.create_table(
            "contract_market_quotes",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("symbol", sa.String(length=64), nullable=False),
            sa.Column("provider", sa.String(length=20), nullable=False),
            sa.Column("provider_symbol", sa.String(length=64), nullable=False),
            sa.Column("bid_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("ask_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("last_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("mark_price", sa.Numeric(36, 18), nullable=False),
            sa.Column("source", sa.String(length=20), nullable=False, server_default="LIVE"),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.UniqueConstraint("symbol", name="uk_contract_market_quotes_symbol"),
        )

    for index_name, columns in (
        ("idx_contract_market_quotes_provider", ["provider"]),
        ("idx_contract_market_quotes_updated_at", ["updated_at"]),
    ):
        if not _has_index(bind, "contract_market_quotes", index_name):
            op.create_index(index_name, "contract_market_quotes", columns, unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "contract_market_quotes"):
        op.drop_table("contract_market_quotes")
