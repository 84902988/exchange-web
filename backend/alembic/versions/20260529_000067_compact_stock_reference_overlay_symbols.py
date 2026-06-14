"""Compact stock reference overlay symbols

Revision ID: 20260529_000067
Revises: 20260529_000066
Create Date: 2026-05-29 22:50:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260529_000067"
down_revision = "20260529_000066"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    for old_symbol, new_symbol in {
        "BON-2USDT": "BON2USDT",
        "CREG-2USDT": "CREG2USDT",
        "IMAA-2USDT": "IMAA2USDT",
    }.items():
        existing = conn.execute(
            sa.text("SELECT id FROM reference_overlays WHERE symbol = :new_symbol LIMIT 1"),
            {"new_symbol": new_symbol},
        ).scalar()
        if existing:
            conn.execute(
                sa.text("DELETE FROM reference_overlays WHERE symbol = :old_symbol"),
                {"old_symbol": old_symbol},
            )
            continue
        conn.execute(
            sa.text(
                """
                UPDATE reference_overlays
                SET symbol = :new_symbol,
                    updated_at = UTC_TIMESTAMP()
                WHERE symbol = :old_symbol
                """
            ),
            {"old_symbol": old_symbol, "new_symbol": new_symbol},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for old_symbol, new_symbol in {
        "BON-2USDT": "BON2USDT",
        "CREG-2USDT": "CREG2USDT",
        "IMAA-2USDT": "IMAA2USDT",
    }.items():
        existing = conn.execute(
            sa.text("SELECT id FROM reference_overlays WHERE symbol = :old_symbol LIMIT 1"),
            {"old_symbol": old_symbol},
        ).scalar()
        if existing:
            conn.execute(
                sa.text("DELETE FROM reference_overlays WHERE symbol = :new_symbol"),
                {"new_symbol": new_symbol},
            )
            continue
        conn.execute(
            sa.text(
                """
                UPDATE reference_overlays
                SET symbol = :old_symbol,
                    updated_at = UTC_TIMESTAMP()
                WHERE symbol = :new_symbol
                """
            ),
            {"old_symbol": old_symbol, "new_symbol": new_symbol},
        )
