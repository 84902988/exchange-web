"""add market data provider config

Revision ID: 20260616_000101
Revises: 20260616_000100
Create Date: 2026-06-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260616_000101"
down_revision = "20260616_000100"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "market_data_providers"):
        op.create_table(
            "market_data_providers",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("provider_code", sa.String(length=32), nullable=False),
            sa.Column("provider_name", sa.String(length=100), nullable=False),
            sa.Column("market_type", sa.String(length=32), nullable=False, server_default="CONTRACT"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
            sa.Column("base_url", sa.String(length=255), nullable=True),
            sa.Column("timeout_ms", sa.Integer(), nullable=False, server_default="3000"),
            sa.Column("cooldown_seconds", sa.Integer(), nullable=False, server_default="60"),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="UNKNOWN"),
            sa.Column("last_check_at", sa.DateTime(), nullable=True),
            sa.Column("last_success_at", sa.DateTime(), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.UniqueConstraint("provider_code", "market_type", name="uk_market_data_providers_code_type"),
        )
        op.create_index(
            "idx_market_data_providers_market_priority",
            "market_data_providers",
            ["market_type", "enabled", "priority"],
        )
        op.create_index("idx_market_data_providers_status", "market_data_providers", ["status"])

    if not _has_table(bind, "market_data_provider_symbols"):
        op.create_table(
            "market_data_provider_symbols",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("provider_code", sa.String(length=32), nullable=False),
            sa.Column("local_symbol", sa.String(length=64), nullable=False),
            sa.Column("provider_symbol", sa.String(length=64), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.UniqueConstraint(
                "provider_code",
                "local_symbol",
                name="uk_market_data_provider_symbols_provider_local",
            ),
        )
        op.create_index(
            "idx_market_data_provider_symbols_local",
            "market_data_provider_symbols",
            ["local_symbol", "enabled"],
        )

    provider_rows = (
        ("OKX_SWAP", "OKX Swap", "CONTRACT", True, 10, "https://www.okx.com", 3000, 60),
        ("BITGET_USDT_FUTURES", "Bitget USDT Futures", "CONTRACT", True, 20, "https://api.bitget.com", 3000, 60),
        ("BINANCE_USDM", "Binance USDM Futures", "CONTRACT", False, 30, "https://fapi.binance.com", 3000, 300),
        ("LAST_GOOD", "Last Good Price", "CONTRACT", True, 999, None, 3000, 0),
    )
    for provider_code, provider_name, market_type, enabled, priority, base_url, timeout_ms, cooldown_seconds in provider_rows:
        op.execute(
            sa.text(
                """
                INSERT INTO market_data_providers (
                    provider_code, provider_name, market_type, enabled, priority, base_url,
                    timeout_ms, cooldown_seconds, status, created_at, updated_at
                )
                SELECT
                    :provider_code, :provider_name, :market_type, :enabled, :priority, :base_url,
                    :timeout_ms, :cooldown_seconds, 'UNKNOWN', UTC_TIMESTAMP(), UTC_TIMESTAMP()
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM market_data_providers
                    WHERE provider_code = :provider_code AND market_type = :market_type
                )
                """
            ).bindparams(
                provider_code=provider_code,
                provider_name=provider_name,
                market_type=market_type,
                enabled=enabled,
                priority=priority,
                base_url=base_url,
                timeout_ms=timeout_ms,
                cooldown_seconds=cooldown_seconds,
            )
        )

    symbol_rows = (
        ("OKX_SWAP", "BTCUSDT_PERP", "BTC-USDT-SWAP"),
        ("BITGET_USDT_FUTURES", "BTCUSDT_PERP", "BTCUSDT"),
        ("OKX_SWAP", "ETHUSDT_PERP", "ETH-USDT-SWAP"),
        ("BITGET_USDT_FUTURES", "ETHUSDT_PERP", "ETHUSDT"),
    )
    for provider_code, local_symbol, provider_symbol in symbol_rows:
        op.execute(
            sa.text(
                """
                INSERT INTO market_data_provider_symbols (
                    provider_code, local_symbol, provider_symbol, enabled, created_at, updated_at
                )
                SELECT :provider_code, :local_symbol, :provider_symbol, TRUE, UTC_TIMESTAMP(), UTC_TIMESTAMP()
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM market_data_provider_symbols
                    WHERE provider_code = :provider_code AND local_symbol = :local_symbol
                )
                """
            ).bindparams(
                provider_code=provider_code,
                local_symbol=local_symbol,
                provider_symbol=provider_symbol,
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "market_data_provider_symbols"):
        op.drop_index("idx_market_data_provider_symbols_local", table_name="market_data_provider_symbols")
        op.drop_table("market_data_provider_symbols")
    if _has_table(bind, "market_data_providers"):
        op.drop_index("idx_market_data_providers_status", table_name="market_data_providers")
        op.drop_index("idx_market_data_providers_market_priority", table_name="market_data_providers")
        op.drop_table("market_data_providers")
