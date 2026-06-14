"""add kyc submissions

Revision ID: 20260517_000033
Revises: 20260517_000032
Create Date: 2026-05-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "20260517_000033"
down_revision = "20260517_000032"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str]) -> None:
    if not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "users"):
        if not _has_column(bind, "users", "kyc_status"):
            op.add_column("users", sa.Column("kyc_status", sa.String(length=16), nullable=False, server_default="NONE"))
        if not _has_column(bind, "users", "kyc_level"):
            op.add_column("users", sa.Column("kyc_level", sa.Integer(), nullable=False, server_default="0"))

    if _has_table(bind, "user_profiles") and not _has_column(bind, "user_profiles", "kyc_status"):
        op.add_column("user_profiles", sa.Column("kyc_status", sa.String(length=16), nullable=False, server_default="NONE"))

    if not _has_table(bind, "kyc_submissions"):
        op.create_table(
            "kyc_submissions",
            sa.Column("id", mysql.BIGINT(unsigned=True), primary_key=True, autoincrement=True),
            sa.Column("user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("kyc_level", sa.String(length=16), nullable=False),
            sa.Column("full_name", sa.String(length=128), nullable=False),
            sa.Column("country_code", sa.String(length=16), nullable=False),
            sa.Column("id_type", sa.String(length=32), nullable=False),
            sa.Column("id_number", sa.String(length=128), nullable=False),
            sa.Column("front_image_url", sa.String(length=512), nullable=False),
            sa.Column("back_image_url", sa.String(length=512), nullable=True),
            sa.Column("selfie_image_url", sa.String(length=512), nullable=True),
            sa.Column("review_status", sa.String(length=16), nullable=False, server_default="PENDING"),
            sa.Column("review_note", sa.String(length=500), nullable=True),
            sa.Column("reviewed_by", sa.String(length=64), nullable=True),
            sa.Column("reviewed_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_kyc_submissions_user_id", ondelete="CASCADE"),
        )

    _create_index_if_missing(bind, "idx_kyc_submissions_user_status", "kyc_submissions", ["user_id", "review_status"])
    _create_index_if_missing(bind, "idx_kyc_submissions_status_time", "kyc_submissions", ["review_status", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "kyc_submissions"):
        op.drop_table("kyc_submissions")
    if _has_table(bind, "user_profiles") and _has_column(bind, "user_profiles", "kyc_status"):
        op.drop_column("user_profiles", "kyc_status")
    if _has_table(bind, "users") and _has_column(bind, "users", "kyc_level"):
        op.drop_column("users", "kyc_level")
    if _has_table(bind, "users") and _has_column(bind, "users", "kyc_status"):
        op.drop_column("users", "kyc_status")
