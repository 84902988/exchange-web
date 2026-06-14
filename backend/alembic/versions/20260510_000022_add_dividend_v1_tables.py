"""add dividend v1 tables

Revision ID: 20260510_000022
Revises: 20260509_000021
Create Date: 2026-05-10
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260510_000022"
down_revision = "20260509_000021"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str]) -> None:
    if not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "system_configs"):
        op.create_table(
            "system_configs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("config_key", sa.String(length=100), nullable=False),
            sa.Column("config_value", sa.Text(), nullable=False),
            sa.Column("description", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("config_key", name="uq_system_configs_key"),
        )

    if not _has_table(bind, "dividend_pools"):
        op.create_table(
            "dividend_pools",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("dividend_date", sa.Date(), nullable=False),
            sa.Column("total_fee_usdt", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("rcb_price_used", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("total_dividend_usdt", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("total_dividend_rcb", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="PENDING"),
            sa.Column("run_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("dividend_date", name="uq_dividend_pools_date"),
        )
    _create_index_if_missing(bind, "idx_dividend_pools_status", "dividend_pools", ["status"])

    if not _has_table(bind, "dividend_pool_items"):
        op.create_table(
            "dividend_pool_items",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("pool_id", sa.BigInteger(), nullable=False),
            sa.Column("level_code", sa.String(length=30), nullable=False),
            sa.Column("level_dividend_rate", sa.Numeric(18, 8), nullable=False, server_default="0.05"),
            sa.Column("level_fee_usdt", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("eligible_user_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("per_user_usdt", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("per_user_rcb", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.ForeignKeyConstraint(["pool_id"], ["dividend_pools.id"], name="fk_dividend_pool_items_pool"),
        )
    _create_index_if_missing(bind, "idx_dividend_pool_items_pool_id", "dividend_pool_items", ["pool_id"])

    if not _has_table(bind, "user_dividend_records"):
        op.create_table(
            "user_dividend_records",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("pool_id", sa.BigInteger(), nullable=False),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("level_code", sa.String(length=30), nullable=False),
            sa.Column("dividend_usdt", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("rcb_price_used", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("dividend_rcb", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="PENDING"),
            sa.Column("paid_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.ForeignKeyConstraint(["pool_id"], ["dividend_pools.id"], name="fk_user_dividend_records_pool"),
            sa.UniqueConstraint("pool_id", "user_id", name="uq_user_dividend_records_pool_user"),
        )
    _create_index_if_missing(bind, "idx_user_dividend_records_user_id", "user_dividend_records", ["user_id"])
    _create_index_if_missing(bind, "idx_user_dividend_records_status", "user_dividend_records", ["status"])

    if not _has_table(bind, "dividend_job_logs"):
        op.create_table(
            "dividend_job_logs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("dividend_date", sa.Date(), nullable=True),
            sa.Column("run_time", sa.DateTime(), nullable=False),
            sa.Column("trigger_type", sa.String(length=20), nullable=False, server_default="AUTO"),
            sa.Column("status", sa.String(length=50), nullable=False),
            sa.Column("step", sa.String(length=50), nullable=False),
            sa.Column("pool_id", sa.BigInteger(), nullable=True),
            sa.Column("message", sa.String(length=500), nullable=False, server_default=""),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
    _create_index_if_missing(bind, "idx_dividend_job_logs_date", "dividend_job_logs", ["dividend_date"])
    _create_index_if_missing(bind, "idx_dividend_job_logs_status", "dividend_job_logs", ["status"])
    _create_index_if_missing(bind, "idx_dividend_job_logs_run_time", "dividend_job_logs", ["run_time"])

    op.execute(
        """
        INSERT INTO system_configs (config_key, config_value, description, created_at, updated_at)
        VALUES (
            'dividend_run_time_utc',
            '00:10',
            'Daily dividend run time in UTC/GMT, HH:MM',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        ON DUPLICATE KEY UPDATE
            description = VALUES(description),
            updated_at = CURRENT_TIMESTAMP
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    for table_name, indexes in (
        ("dividend_job_logs", [
            "idx_dividend_job_logs_date",
            "idx_dividend_job_logs_status",
            "idx_dividend_job_logs_run_time",
        ]),
        ("user_dividend_records", [
            "idx_user_dividend_records_user_id",
            "idx_user_dividend_records_status",
        ]),
        ("dividend_pool_items", ["idx_dividend_pool_items_pool_id"]),
        ("dividend_pools", ["idx_dividend_pools_status"]),
    ):
        if _has_table(bind, table_name):
            for index_name in indexes:
                if _has_index(bind, table_name, index_name):
                    op.drop_index(index_name, table_name=table_name)

    for table_name in (
        "dividend_job_logs",
        "user_dividend_records",
        "dividend_pool_items",
        "dividend_pools",
    ):
        if _has_table(bind, table_name):
            op.drop_table(table_name)
