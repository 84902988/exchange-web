"""add contract position risk flags

Revision ID: 20260501_000015
Revises: 20260501_000014
Create Date: 2026-05-01 00:00:15
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000015"
down_revision = "20260501_000014"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "contract_positions") and not _has_column(bind, "contract_positions", "is_liquidatable"):
        op.add_column(
            "contract_positions",
            sa.Column("is_liquidatable", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        )

    if _has_table(bind, "contract_positions") and not _has_column(bind, "contract_positions", "last_risk_check_at"):
        op.add_column("contract_positions", sa.Column("last_risk_check_at", sa.DateTime(), nullable=True))

    if _has_table(bind, "contract_positions") and not _has_index(
        bind, "contract_positions", "idx_contract_positions_liquidatable"
    ):
        op.create_index(
            "idx_contract_positions_liquidatable",
            "contract_positions",
            ["is_liquidatable"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "contract_positions") and _has_index(
        bind, "contract_positions", "idx_contract_positions_liquidatable"
    ):
        op.drop_index("idx_contract_positions_liquidatable", table_name="contract_positions")

    if _has_table(bind, "contract_positions") and _has_column(bind, "contract_positions", "last_risk_check_at"):
        op.drop_column("contract_positions", "last_risk_check_at")

    if _has_table(bind, "contract_positions") and _has_column(bind, "contract_positions", "is_liquidatable"):
        op.drop_column("contract_positions", "is_liquidatable")
