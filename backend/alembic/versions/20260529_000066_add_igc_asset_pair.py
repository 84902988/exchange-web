"""add IGC asset and IGCUSDT pair

Revision ID: 20260529_000066
Revises: 20260529_000065
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000066"
down_revision = "20260529_000065"
branch_labels = None
depends_on = None


IGC_CONTRACT_ADDRESS = "0x94290de7c447e0edae0b06f29ff1543f41af7c3c"


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    required_tables = {"assets", "chains", "asset_chains", "trading_pairs"}
    if any(not _has_table(bind, table_name) for table_name in required_tables):
        return

    bind.execute(
        sa.text(
            """
            INSERT INTO assets (
                symbol, name, asset_type, display_precision, enabled,
                icon_url, sort_order, created_at, updated_at
            )
            VALUES (
                'IGC', 'IGC', 'token', 6, 1,
                NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                asset_type = VALUES(asset_type),
                display_precision = VALUES(display_precision),
                enabled = 1,
                updated_at = CURRENT_TIMESTAMP
            """
        )
    )

    bind.execute(
        sa.text(
            """
            UPDATE chains
            SET enabled = 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE LOWER(chain_key) = 'bsc'
            """
        )
    )

    bind.execute(
        sa.text(
            """
            INSERT INTO asset_chains (
                asset_id, chain_id, contract_address, decimals,
                deposit_enabled, withdraw_enabled, enabled,
                min_deposit, min_withdraw, confirmations, sort,
                created_at, updated_at
            )
            SELECT
                a.id,
                c.id,
                :contract_address,
                18,
                0,
                0,
                1,
                0,
                0,
                NULL,
                0,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            FROM assets a
            JOIN chains c ON LOWER(c.chain_key) = 'bsc'
            WHERE a.symbol = 'IGC'
            ON DUPLICATE KEY UPDATE
                contract_address = VALUES(contract_address),
                decimals = VALUES(decimals),
                deposit_enabled = 0,
                withdraw_enabled = 0,
                enabled = 1,
                updated_at = CURRENT_TIMESTAMP
            """
        ),
        {"contract_address": IGC_CONTRACT_ADDRESS},
    )

    bind.execute(
        sa.text(
            """
            INSERT INTO trading_pairs (
                base_asset_id, quote_asset_id, symbol,
                price_precision, amount_precision,
                min_amount, min_notional,
                maker_fee_rate, taker_fee_rate,
                status, market_mode, asset_type, data_source,
                external_symbol, external_region,
                market_category, market_sub_category, display_category,
                display_group, sort_order, is_hot,
                created_at, updated_at
            )
            SELECT
                base.id,
                quote.id,
                'IGCUSDT',
                6,
                4,
                0.0001,
                5,
                0.00100000,
                0.00100000,
                1,
                'INTERNAL',
                'CRYPTO',
                'INTERNAL',
                NULL,
                NULL,
                'CRYPTO',
                NULL,
                'RWA',
                NULL,
                0,
                0,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            FROM assets base
            JOIN assets quote ON quote.symbol = 'USDT'
            WHERE base.symbol = 'IGC'
            ON DUPLICATE KEY UPDATE
                price_precision = VALUES(price_precision),
                amount_precision = VALUES(amount_precision),
                min_amount = VALUES(min_amount),
                min_notional = VALUES(min_notional),
                maker_fee_rate = VALUES(maker_fee_rate),
                taker_fee_rate = VALUES(taker_fee_rate),
                status = 1,
                market_mode = VALUES(market_mode),
                asset_type = VALUES(asset_type),
                data_source = VALUES(data_source),
                external_symbol = NULL,
                external_region = NULL,
                market_category = VALUES(market_category),
                market_sub_category = VALUES(market_sub_category),
                display_category = VALUES(display_category),
                display_group = VALUES(display_group),
                sort_order = VALUES(sort_order),
                is_hot = VALUES(is_hot),
                updated_at = CURRENT_TIMESTAMP
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "trading_pairs"):
        bind.execute(sa.text("UPDATE trading_pairs SET status = 0, updated_at = CURRENT_TIMESTAMP WHERE symbol = 'IGCUSDT'"))
    if _has_table(bind, "asset_chains") and _has_table(bind, "assets") and _has_table(bind, "chains"):
        bind.execute(
            sa.text(
                """
                UPDATE asset_chains ac
                JOIN assets a ON a.id = ac.asset_id
                JOIN chains c ON c.id = ac.chain_id
                SET ac.enabled = 0,
                    ac.deposit_enabled = 0,
                    ac.withdraw_enabled = 0,
                    ac.updated_at = CURRENT_TIMESTAMP
                WHERE a.symbol = 'IGC'
                  AND LOWER(c.chain_key) = 'bsc'
                """
            )
        )
    if _has_table(bind, "assets"):
        bind.execute(sa.text("UPDATE assets SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE symbol = 'IGC'"))
