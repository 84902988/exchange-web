"""add collection candidates

Revision ID: 20260606_000083
Revises: 20260603_000082
Create Date: 2026-06-06
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260606_000083"
down_revision = "20260603_000082"
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
    return any(index.get("name") == index_name for index in indexes) or any(
        constraint.get("name") == index_name for constraint in unique_constraints
    )


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str], unique: bool = False) -> None:
    if _has_table(bind, table_name) and not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=unique)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "collection_candidates"):
        op.create_table(
            "collection_candidates",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("chain_key", sa.String(length=32), nullable=False),
            sa.Column("asset_symbol", sa.String(length=32), nullable=False),
            sa.Column("asset_id", sa.BigInteger(), nullable=True),
            sa.Column("asset_chain_id", sa.BigInteger(), nullable=True),
            sa.Column("token_contract", sa.String(length=255), nullable=False),
            sa.Column("address", sa.String(length=256), nullable=False),
            sa.Column("total_detected_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("latest_deposit_amount", sa.Numeric(36, 18), nullable=False, server_default="0"),
            sa.Column("latest_tx_hash", sa.String(length=256), nullable=True),
            sa.Column("source", sa.String(length=32), nullable=False, server_default="DEPOSIT"),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="PENDING"),
            sa.Column("detected_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("latest_deposit_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("last_scan_at", sa.DateTime(), nullable=True),
            sa.Column("last_balance_amount", sa.Numeric(36, 18), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("chain_key", "token_contract", "address", name="uk_collection_candidates_chain_token_address"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_0900_ai_ci",
        )

    for index_name, columns in (
        ("idx_collection_candidates_chain_symbol_status", ["chain_key", "asset_symbol", "status"]),
        ("idx_collection_candidates_user", ["user_id"]),
        ("idx_collection_candidates_latest_deposit", ["latest_deposit_at"]),
    ):
        _create_index_if_missing(bind, index_name, "collection_candidates", columns)


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "collection_candidates"):
        op.drop_table("collection_candidates")
