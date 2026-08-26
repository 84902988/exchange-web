"""add account email verification purposes and security events

Revision ID: 20260802_000131
Revises: 20260802_000130
Create Date: 2026-08-02
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "20260802_000131"
down_revision: Union[str, None] = "20260802_000130"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID_TYPE = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
ORIGINAL_PURPOSE = mysql.ENUM("register", "login", "reset_password")


def _has_table(bind, table_name: str) -> bool:
    return table_name in sa.inspect(bind).get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    offline = bool(op.get_context().as_sql)
    if (offline or _has_table(bind, "user_otps")) and bind.dialect.name == "mysql":
        op.alter_column(
            "user_otps",
            "purpose",
            existing_type=ORIGINAL_PURPOSE,
            type_=sa.String(length=32),
            existing_nullable=False,
        )

    if offline or not _has_table(bind, "user_security_events"):
        op.create_table(
            "user_security_events",
            sa.Column("id", ID_TYPE, autoincrement=True, nullable=False),
            sa.Column("user_id", mysql.BIGINT(unsigned=True), nullable=False),
            sa.Column("event_type", sa.String(length=32), nullable=False),
            sa.Column("ip", sa.String(length=45), nullable=True),
            sa.Column("user_agent", sa.String(length=255), nullable=True),
            sa.Column("details", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "idx_user_security_events_user_created",
            "user_security_events",
            ["user_id", "created_at"],
            unique=False,
        )
        op.create_index(
            "idx_user_security_events_type_created",
            "user_security_events",
            ["event_type", "created_at"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    offline = bool(op.get_context().as_sql)
    if offline or _has_table(bind, "user_security_events"):
        op.drop_index(
            "idx_user_security_events_type_created",
            table_name="user_security_events",
        )
        op.drop_index(
            "idx_user_security_events_user_created",
            table_name="user_security_events",
        )
        op.drop_table("user_security_events")

    if (offline or _has_table(bind, "user_otps")) and bind.dialect.name == "mysql":
        # OTP rows are short lived. Remove only purposes the previous schema
        # cannot represent before restoring the original enum.
        op.execute(
            sa.text(
                "DELETE FROM user_otps WHERE purpose IN ('verify_email', 'change_email')"
            )
        )
        op.alter_column(
            "user_otps",
            "purpose",
            existing_type=sa.String(length=32),
            type_=ORIGINAL_PURPOSE,
            existing_nullable=False,
        )
