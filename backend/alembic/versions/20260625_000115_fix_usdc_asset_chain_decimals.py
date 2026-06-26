"""fix usdc asset chain decimals

Revision ID: 20260625_000115
Revises: 20260625_000114
Create Date: 2026-06-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260625_000115"
down_revision = "20260625_000114"
branch_labels = None
depends_on = None


USDC_CHAIN_DECIMALS = {
    "avaxc": 6,
    "bsc": 18,
    "ethereum": 6,
    "optimism": 6,
    "polygon": 6,
}


def _has_tables(bind, *table_names: str) -> bool:
    inspector = sa.inspect(bind)
    return all(inspector.has_table(table_name) for table_name in table_names)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_tables(bind, "assets", "chains", "asset_chains"):
        return

    for chain_key, decimals in USDC_CHAIN_DECIMALS.items():
        op.execute(
            sa.text(
                """
                UPDATE asset_chains ac
                JOIN assets a ON a.id = ac.asset_id
                JOIN chains c ON c.id = ac.chain_id
                SET ac.decimals = :decimals,
                    ac.updated_at = UTC_TIMESTAMP()
                WHERE a.symbol = 'USDC'
                  AND c.chain_key = :chain_key
                  AND ac.decimals <> :decimals
                """
            ).bindparams(chain_key=chain_key, decimals=decimals)
        )


def downgrade() -> None:
    # This migration records corrected production configuration. Reverting would
    # restore known-bad token decimals and can break withdrawals.
    return
