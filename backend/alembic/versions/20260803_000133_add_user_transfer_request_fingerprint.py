"""add user transfer request fingerprint

Revision ID: 20260803_000133
Revises: 20260728_000126
Create Date: 2026-08-03
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260803_000133"
down_revision: Union[str, None] = "20260728_000126"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_transfers",
        sa.Column("request_fingerprint", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user_transfers", "request_fingerprint")
