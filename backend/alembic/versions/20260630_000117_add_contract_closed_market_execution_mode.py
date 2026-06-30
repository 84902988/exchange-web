"""add contract closed market execution mode

Revision ID: 20260630_000117
Revises: 20260625_000116
Create Date: 2026-06-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260630_000117"
down_revision = "20260625_000116"
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


def _has_check_constraint(table_name: str, constraint_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(
        constraint.get("name") == constraint_name
        for constraint in inspector.get_check_constraints(table_name)
    )


def upgrade() -> None:
    if not _has_table("contract_symbols"):
        return

    if not _has_column("contract_symbols", "closed_market_execution_mode"):
        op.add_column(
            "contract_symbols",
            sa.Column(
                "closed_market_execution_mode",
                sa.String(length=32),
                nullable=False,
                server_default="DISABLED",
            ),
        )

    if not _has_check_constraint("contract_symbols", "ck_contract_symbols_closed_market_execution_mode"):
        op.create_check_constraint(
            "ck_contract_symbols_closed_market_execution_mode",
            "contract_symbols",
            "closed_market_execution_mode IN ('DISABLED', 'LAST_GOOD_BBO')",
        )


def downgrade() -> None:
    if not _has_table("contract_symbols"):
        return

    if _has_check_constraint("contract_symbols", "ck_contract_symbols_closed_market_execution_mode"):
        op.drop_constraint(
            "ck_contract_symbols_closed_market_execution_mode",
            "contract_symbols",
            type_="check",
        )
    if _has_column("contract_symbols", "closed_market_execution_mode"):
        op.drop_column("contract_symbols", "closed_market_execution_mode")
