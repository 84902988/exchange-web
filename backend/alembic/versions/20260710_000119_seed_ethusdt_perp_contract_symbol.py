"""seed ETHUSDT_PERP contract symbol

Revision ID: 20260710_000119
Revises: 20260630_000118
Create Date: 2026-07-10 00:01:19
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260710_000119"
down_revision = "20260630_000118"
branch_labels = None
depends_on = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    return sa.inspect(bind).has_table(table_name)


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _has_table("contract_symbols"):
        return

    closed_market_column = (
        "closed_market_execution_mode"
        if _has_column("contract_symbols", "closed_market_execution_mode")
        else None
    )
    tp_sl_column = (
        "tp_sl_trigger_price_type"
        if _has_column("contract_symbols", "tp_sl_trigger_price_type")
        else None
    )

    insert_columns = [
        "symbol",
        "display_name",
        "category",
        "provider",
        "provider_symbol",
        "quote_asset",
    ]
    select_values = [
        ":symbol",
        ":display_name",
        ":category",
        ":provider",
        ":provider_symbol",
        ":quote_asset",
    ]
    if tp_sl_column:
        insert_columns.append(tp_sl_column)
        select_values.append(":tp_sl_trigger_price_type")
    if closed_market_column:
        insert_columns.append(closed_market_column)
        select_values.append(":closed_market_execution_mode")
    insert_columns.extend(
        [
            "price_precision",
            "quantity_precision",
            "min_quantity",
            "max_quantity",
            "min_margin",
            "max_leverage",
            "spread_x",
            "liquidation_threshold",
            "warning_threshold",
            "status",
            "created_at",
            "updated_at",
        ]
    )
    select_values.extend(
        [
            ":price_precision",
            ":quantity_precision",
            ":min_quantity",
            ":max_quantity",
            ":min_margin",
            ":max_leverage",
            ":spread_x",
            ":liquidation_threshold",
            ":warning_threshold",
            ":status",
            "UTC_TIMESTAMP()",
            "UTC_TIMESTAMP()",
        ]
    )

    op.execute(
        sa.text(
            f"""
            INSERT INTO contract_symbols (
                {", ".join(insert_columns)}
            )
            SELECT
                {", ".join(select_values)}
            WHERE NOT EXISTS (
                SELECT 1
                FROM contract_symbols
                WHERE symbol = :symbol
            )
            """
        ).bindparams(
            symbol="ETHUSDT_PERP",
            display_name="ETH/USDT Perpetual CFD",
            category="CRYPTO",
            provider="BINANCE",
            provider_symbol="ETHUSDT",
            quote_asset="USDT",
            tp_sl_trigger_price_type="LAST_PRICE",
            closed_market_execution_mode="DISABLED",
            price_precision=2,
            quantity_precision=6,
            min_quantity=0,
            max_quantity=0,
            min_margin=0,
            max_leverage=200,
            spread_x=0,
            liquidation_threshold=0,
            warning_threshold=0,
            status=1,
        )
    )


def downgrade() -> None:
    # Do not delete operator-managed symbols on downgrade.
    return
