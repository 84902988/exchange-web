"""add spot market data providers

Revision ID: 20260616_000102
Revises: 20260616_000101
Create Date: 2026-06-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260616_000102"
down_revision = "20260616_000101"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "market_data_providers"):
        return

    provider_rows = (
        ("OKX_SPOT", "OKX 现货行情", "SPOT", True, 10, "https://www.okx.com", 3000, 60),
        ("BITGET_SPOT", "Bitget 现货行情", "SPOT", True, 20, "https://api.bitget.com", 3000, 60),
        ("BINANCE_SPOT", "Binance 现货行情", "SPOT", False, 30, "https://api.binance.com", 3000, 300),
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

    op.execute(
        sa.text(
            """
            UPDATE market_data_providers
            SET enabled = FALSE, updated_at = UTC_TIMESTAMP()
            WHERE provider_code = 'MANUAL'
            """
        )
    )

    if not _has_table(bind, "market_data_provider_symbols"):
        return

    symbol_rows = (
        ("OKX_SPOT", "BTCUSDT", "BTC-USDT"),
        ("BITGET_SPOT", "BTCUSDT", "BTCUSDT"),
        ("BINANCE_SPOT", "BTCUSDT", "BTCUSDT"),
        ("OKX_SPOT", "ETHUSDT", "ETH-USDT"),
        ("BITGET_SPOT", "ETHUSDT", "ETHUSDT"),
        ("BINANCE_SPOT", "ETHUSDT", "ETHUSDT"),
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
        op.execute(
            sa.text(
                """
                DELETE FROM market_data_provider_symbols
                WHERE provider_code IN ('OKX_SPOT', 'BITGET_SPOT', 'BINANCE_SPOT')
                  AND local_symbol IN ('BTCUSDT', 'ETHUSDT')
                """
            )
        )
    if _has_table(bind, "market_data_providers"):
        op.execute(
            sa.text(
                """
                DELETE FROM market_data_providers
                WHERE provider_code IN ('OKX_SPOT', 'BITGET_SPOT', 'BINANCE_SPOT')
                  AND market_type = 'SPOT'
                """
            )
        )
