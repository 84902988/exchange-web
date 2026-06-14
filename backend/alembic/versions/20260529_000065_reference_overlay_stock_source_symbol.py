"""reference overlay stock source symbol

Revision ID: 20260529_000065
Revises: 20260529_000064
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000065"
down_revision = "20260529_000064"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    for symbol, source_symbol in {
        "BON-2USDT": "BON",
        "CREG-2USDT": "CREG",
        "IMAA-2USDT": "IMAA",
    }.items():
        bind.execute(
            sa.text(
                """
                UPDATE reference_overlays
                SET source_symbol = :source_symbol,
                    updated_at = CURRENT_TIMESTAMP
                WHERE symbol = :symbol
                """
            ),
            {"symbol": symbol, "source_symbol": source_symbol},
        )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    bind.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET source_symbol = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE symbol IN ('BON-2USDT', 'CREG-2USDT', 'IMAA-2USDT')
            """
        )
    )
