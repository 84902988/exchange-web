"""Add dividend pool source

Revision ID: 20260613_000090
Revises: 20260613_000089
Create Date: 2026-06-13 23:20:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260613_000090"
down_revision = "20260613_000089"
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
    if _has_table(bind, "dividend_pools") and not _has_column(bind, "dividend_pools", "source"):
        op.add_column(
            "dividend_pools",
            sa.Column("source", sa.String(length=20), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "dividend_pools") and _has_column(bind, "dividend_pools", "source"):
        op.drop_column("dividend_pools", "source")
