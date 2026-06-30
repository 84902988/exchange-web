"""backfill contract closed market execution mode

Revision ID: 20260630_000118
Revises: 20260630_000117
Create Date: 2026-06-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260630_000118"
down_revision = "20260630_000117"
branch_labels = None
depends_on = None


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    return sa.inspect(bind).has_table(table_name)


def _has_column(table_name: str, column_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _has_table("contract_symbols"):
        return
    if not _has_column("contract_symbols", "closed_market_execution_mode"):
        return

    op.execute(
        """
        UPDATE contract_symbols
        SET closed_market_execution_mode = 'LAST_GOOD_BBO'
        WHERE COALESCE(closed_market_execution_mode, 'DISABLED') = 'DISABLED'
          AND (
            UPPER(COALESCE(category, '')) IN (
              'STOCK',
              'CFD',
              'INDEX',
              'METAL',
              'GOLD',
              'COMMODITY',
              'FUTURES',
              'FOREX'
            )
            OR UPPER(COALESCE(provider, '')) = 'ITICK'
          )
          AND UPPER(COALESCE(category, '')) <> 'CRYPTO'
          AND UPPER(COALESCE(provider_symbol, '')) NOT LIKE '%SWAP%'
          AND UPPER(COALESCE(provider_symbol, '')) NOT LIKE '%PERP%'
          AND UPPER(COALESCE(symbol, '')) NOT IN (
            'BTCUSDT_PERP',
            'ETHUSDT_PERP',
            'SOLUSDT_PERP',
            'XRPUSDT_PERP',
            'DOGEUSDT_PERP',
            'BNBUSDT_PERP',
            'ADAUSDT_PERP'
          )
        """
    )


def downgrade() -> None:
    # Data backfill is intentionally not reversed: after deployment, operators may
    # manually adjust individual symbols, and a blind downgrade would overwrite
    # those decisions.
    return
