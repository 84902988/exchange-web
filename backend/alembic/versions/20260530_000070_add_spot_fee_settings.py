"""add spot fee settings

Revision ID: 20260530_000070
Revises: 20260529_000069
Create Date: 2026-05-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260530_000070"
down_revision = "20260529_000069"
branch_labels = None
depends_on = None


TABLE_NAME = "spot_fee_settings"


def _has_table(bind) -> bool:
    return sa.inspect(bind).has_table(TABLE_NAME)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind):
        op.create_table(
            TABLE_NAME,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("spot_rcb_fee_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("rcb_fee_discount_rate", sa.Numeric(10, 6), nullable=False, server_default="0.750000"),
            sa.Column("min_rcb_fee_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("updated_by_admin_id", sa.BigInteger(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
        )

    conn = op.get_bind()
    existing_count = conn.execute(sa.text(f"SELECT COUNT(*) FROM {TABLE_NAME}")).scalar() or 0
    if int(existing_count) == 0:
        conn.execute(
            sa.text(
                f"""
                INSERT INTO {TABLE_NAME}
                    (spot_rcb_fee_enabled, rcb_fee_discount_rate, min_rcb_fee_amount, created_at, updated_at)
                VALUES
                    (1, 0.750000, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind):
        op.drop_table(TABLE_NAME)
