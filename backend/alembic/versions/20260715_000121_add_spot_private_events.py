"""add spot private event bridge tables

Revision ID: 20260715_000121
Revises: 20260711_000120
Create Date: 2026-07-15
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260715_000121"
down_revision = "20260711_000120"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "spot_private_event_sequences"):
        op.create_table(
            "spot_private_event_sequences",
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("last_sequence", sa.BigInteger(), nullable=False, server_default="0"),
            sa.PrimaryKeyConstraint("user_id", name="pk_spot_private_event_sequences"),
        )

    if not _has_table(bind, "spot_private_events"):
        op.create_table(
            "spot_private_events",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("event_id", sa.String(length=96), nullable=False),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("sequence", sa.BigInteger(), nullable=False),
            sa.Column("event_type", sa.String(length=64), nullable=False),
            sa.Column("payload_json", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="PENDING"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("published_at", sa.DateTime(), nullable=True),
            sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
            sa.PrimaryKeyConstraint("id", name="pk_spot_private_events"),
            sa.UniqueConstraint("event_id", name="uq_spot_private_events_event_id"),
            sa.UniqueConstraint(
                "user_id",
                "sequence",
                name="uq_spot_private_events_user_sequence",
            ),
        )
        op.create_index(
            "ix_spot_private_events_user_id",
            "spot_private_events",
            ["user_id"],
            unique=False,
        )
        op.create_index(
            "ix_spot_private_events_status",
            "spot_private_events",
            ["status"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "spot_private_events"):
        op.drop_index("ix_spot_private_events_status", table_name="spot_private_events")
        op.drop_index("ix_spot_private_events_user_id", table_name="spot_private_events")
        op.drop_table("spot_private_events")
    if _has_table(bind, "spot_private_event_sequences"):
        op.drop_table("spot_private_event_sequences")
