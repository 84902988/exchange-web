"""add stock token daily release snapshot

Revision ID: 20260517_000035
Revises: 20260517_000034
Create Date: 2026-05-17 16:30:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260517_000035"
down_revision = "20260517_000034"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "user_stock_token_locks") and not _has_column(
        bind,
        "user_stock_token_locks",
        "daily_release_rate_snapshot",
    ):
        op.add_column(
            "user_stock_token_locks",
            sa.Column(
                "daily_release_rate_snapshot",
                sa.Numeric(18, 8),
                nullable=False,
                server_default="0.05000000",
            ),
        )

    if _has_table(bind, "user_stock_token_locks") and _has_table(bind, "stock_token_lock_configs"):
        op.execute(
            sa.text(
                """
                UPDATE user_stock_token_locks AS l
                JOIN stock_token_lock_configs AS c ON c.id = l.config_id
                SET l.daily_release_rate_snapshot = c.daily_release_rate
                """
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "user_stock_token_locks") and _has_column(
        bind,
        "user_stock_token_locks",
        "daily_release_rate_snapshot",
    ):
        op.drop_column("user_stock_token_locks", "daily_release_rate_snapshot")
