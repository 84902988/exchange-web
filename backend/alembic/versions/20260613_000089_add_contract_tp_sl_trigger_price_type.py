"""Add contract TP/SL trigger price type

Revision ID: 20260613_000089
Revises: 20260611_000088
Create Date: 2026-06-13 22:30:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260613_000089"
down_revision = "20260611_000088"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column["name"] == column_name for column in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "contract_symbols") and not _has_column(bind, "contract_symbols", "tp_sl_trigger_price_type"):
        op.add_column(
            "contract_symbols",
            sa.Column("tp_sl_trigger_price_type", sa.String(length=20), nullable=False, server_default="MARK_PRICE"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "contract_symbols") and _has_column(bind, "contract_symbols", "tp_sl_trigger_price_type"):
        op.drop_column("contract_symbols", "tp_sl_trigger_price_type")
