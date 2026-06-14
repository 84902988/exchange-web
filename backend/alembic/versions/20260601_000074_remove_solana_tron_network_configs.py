"""remove current solana and tron network configs

Revision ID: 20260601_000074
Revises: 20260601_000073
Create Date: 2026-06-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260601_000074"
down_revision = "20260601_000073"
branch_labels = None
depends_on = None


TARGET_CHAIN_KEYS = ("solana", "tron")


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _delete_by_chain_id(bind, table_name: str) -> None:
    if not _has_table(bind, table_name):
        return
    bind.execute(
        sa.text(
            f"""
            DELETE FROM {table_name}
            WHERE chain_id IN (
                SELECT id
                FROM chains
                WHERE LOWER(chain_key) IN :chain_keys
            )
            """
        ).bindparams(sa.bindparam("chain_keys", expanding=True)),
        {"chain_keys": TARGET_CHAIN_KEYS},
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "chains"):
        return

    # Derived address rows hold a non-null FK to chains. Remove only the
    # decommissioned-network rows so the chain config records can be deleted.
    _delete_by_chain_id(bind, "user_chain_addresses")
    _delete_by_chain_id(bind, "asset_chains")

    bind.execute(
        sa.text(
            """
            DELETE FROM chains
            WHERE LOWER(chain_key) IN :chain_keys
            """
        ).bindparams(sa.bindparam("chain_keys", expanding=True)),
        {"chain_keys": TARGET_CHAIN_KEYS},
    )


def downgrade() -> None:
    # Data removal is intentionally not reversed. Future Solana/Tron support
    # should be reintroduced through fresh seed/config migrations.
    return
