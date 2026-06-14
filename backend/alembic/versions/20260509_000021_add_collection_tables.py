"""add collection task tables

Revision ID: 20260509_000021
Revises: 20260506_000020
Create Date: 2026-05-09 00:00:21
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260509_000021"
down_revision = "20260506_000020"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    indexes = inspector.get_indexes(table_name)
    unique_constraints = inspector.get_unique_constraints(table_name)
    return any(index["name"] == index_name for index in indexes) or any(
        constraint["name"] == index_name for constraint in unique_constraints
    )


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str], unique: bool = False) -> None:
    if _has_table(bind, table_name) and not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=unique)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "collection_batches"):
        op.create_table(
            "collection_batches",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("batch_no", sa.String(length=64), nullable=False),
            sa.Column("trigger_type", sa.String(length=32), nullable=False),
            sa.Column("target_address", sa.String(length=128), nullable=False),
            sa.Column("chain_key", sa.String(length=32), nullable=True),
            sa.Column("coin_symbol", sa.String(length=32), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="PENDING"),
            sa.Column("total_tasks", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("success_tasks", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("failed_tasks", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("skipped_tasks", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("success_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_by", sa.BigInteger(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("batch_no", name="uk_collection_batches_batch_no"),
        )

    for index_name, columns in (
        ("idx_collection_batches_status", ["status"]),
        ("idx_collection_batches_chain_coin", ["chain_key", "coin_symbol"]),
        ("idx_collection_batches_created_at", ["created_at"]),
    ):
        _create_index_if_missing(bind, index_name, "collection_batches", columns)

    if not _has_table(bind, "collection_tasks"):
        op.create_table(
            "collection_tasks",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("task_no", sa.String(length=64), nullable=False),
            sa.Column("batch_id", sa.BigInteger(), nullable=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("chain_key", sa.String(length=32), nullable=False),
            sa.Column("coin_symbol", sa.String(length=32), nullable=False),
            sa.Column("asset_chain_id", sa.BigInteger(), nullable=True),
            sa.Column("from_address", sa.String(length=128), nullable=False),
            sa.Column("to_address", sa.String(length=128), nullable=False),
            sa.Column("amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="PENDING"),
            sa.Column("reason", sa.String(length=255), nullable=True),
            sa.Column("tx_hash", sa.String(length=128), nullable=True),
            sa.Column("block_number", sa.BigInteger(), nullable=True),
            sa.Column("gas_task_id", sa.BigInteger(), nullable=True),
            sa.Column("idempotency_key", sa.String(length=128), nullable=True),
            sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("max_retry", sa.Integer(), nullable=False, server_default="3"),
            sa.Column("next_retry_at", sa.DateTime(), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("locked_at", sa.DateTime(), nullable=True),
            sa.Column("sent_at", sa.DateTime(), nullable=True),
            sa.Column("confirmed_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("task_no", name="uk_collection_tasks_task_no"),
            sa.UniqueConstraint("idempotency_key", name="uk_collection_tasks_idempotency_key"),
        )

    for index_name, columns in (
        ("idx_collection_tasks_batch", ["batch_id"]),
        ("idx_collection_tasks_user", ["user_id"]),
        ("idx_collection_tasks_chain_coin_status", ["chain_key", "coin_symbol", "status"]),
        ("idx_collection_tasks_tx_hash", ["tx_hash"]),
        ("idx_collection_tasks_status_next_retry", ["status", "next_retry_at"]),
        ("idx_collection_tasks_created_at", ["created_at"]),
    ):
        _create_index_if_missing(bind, index_name, "collection_tasks", columns)

    if not _has_table(bind, "gas_tasks"):
        op.create_table(
            "gas_tasks",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("task_no", sa.String(length=64), nullable=False),
            sa.Column("collection_task_id", sa.BigInteger(), nullable=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("chain_key", sa.String(length=32), nullable=False),
            sa.Column("gas_coin_symbol", sa.String(length=32), nullable=False),
            sa.Column("from_address", sa.String(length=128), nullable=False),
            sa.Column("to_address", sa.String(length=128), nullable=False),
            sa.Column("target_balance", sa.Numeric(36, 18), nullable=True),
            sa.Column("topup_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="PENDING"),
            sa.Column("tx_hash", sa.String(length=128), nullable=True),
            sa.Column("block_number", sa.BigInteger(), nullable=True),
            sa.Column("idempotency_key", sa.String(length=128), nullable=True),
            sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("max_retry", sa.Integer(), nullable=False, server_default="3"),
            sa.Column("next_retry_at", sa.DateTime(), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("locked_at", sa.DateTime(), nullable=True),
            sa.Column("sent_at", sa.DateTime(), nullable=True),
            sa.Column("confirmed_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("task_no", name="uk_gas_tasks_task_no"),
            sa.UniqueConstraint("idempotency_key", name="uk_gas_tasks_idempotency_key"),
        )

    for index_name, columns in (
        ("idx_gas_tasks_collection_task", ["collection_task_id"]),
        ("idx_gas_tasks_user", ["user_id"]),
        ("idx_gas_tasks_chain_status", ["chain_key", "status"]),
        ("idx_gas_tasks_tx_hash", ["tx_hash"]),
        ("idx_gas_tasks_status_next_retry", ["status", "next_retry_at"]),
        ("idx_gas_tasks_created_at", ["created_at"]),
    ):
        _create_index_if_missing(bind, index_name, "gas_tasks", columns)


def downgrade() -> None:
    bind = op.get_bind()

    for table_name in (
        "gas_tasks",
        "collection_tasks",
        "collection_batches",
    ):
        if _has_table(bind, table_name):
            op.drop_table(table_name)
