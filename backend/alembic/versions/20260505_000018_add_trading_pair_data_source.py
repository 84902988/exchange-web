"""add trading pair market data source fields

Revision ID: 20260505_000018
Revises: 20260501_000017
Create Date: 2026-05-05 00:00:18
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260505_000018"
down_revision = "20260501_000017"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    columns = sa.inspect(bind).get_columns(table_name)
    return any(column["name"] == column_name for column in columns)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    indexes = sa.inspect(bind).get_indexes(table_name)
    return any(index["name"] == index_name for index in indexes)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    if not _has_column(bind, "trading_pairs", "asset_type"):
        op.add_column(
            "trading_pairs",
            sa.Column("asset_type", sa.String(length=20), nullable=False, server_default="CRYPTO"),
        )
    if not _has_column(bind, "trading_pairs", "data_source"):
        op.add_column(
            "trading_pairs",
            sa.Column("data_source", sa.String(length=20), nullable=False, server_default="INTERNAL"),
        )
    if not _has_column(bind, "trading_pairs", "external_symbol"):
        op.add_column("trading_pairs", sa.Column("external_symbol", sa.String(length=64), nullable=True))
    if not _has_column(bind, "trading_pairs", "external_region"):
        op.add_column("trading_pairs", sa.Column("external_region", sa.String(length=20), nullable=True))

    if not _has_index(bind, "trading_pairs", "idx_trading_pairs_asset_type"):
        op.create_index("idx_trading_pairs_asset_type", "trading_pairs", ["asset_type"])
    if not _has_index(bind, "trading_pairs", "idx_trading_pairs_data_source"):
        op.create_index("idx_trading_pairs_data_source", "trading_pairs", ["data_source"])

    op.execute(
        sa.text(
            "UPDATE trading_pairs "
            "SET asset_type = 'CRYPTO', data_source = 'BINANCE', external_symbol = symbol "
            "WHERE symbol IN ('BTCUSDT', 'ETHUSDT')"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "trading_pairs"):
        return

    for index_name in ("idx_trading_pairs_data_source", "idx_trading_pairs_asset_type"):
        if _has_index(bind, "trading_pairs", index_name):
            op.drop_index(index_name, table_name="trading_pairs")

    for column_name in ("external_region", "external_symbol", "data_source", "asset_type"):
        if _has_column(bind, "trading_pairs", column_name):
            op.drop_column("trading_pairs", column_name)
