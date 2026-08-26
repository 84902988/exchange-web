"""add mobile home configuration

Revision ID: 20260802_000129
Revises: 20260801_000128
Create Date: 2026-08-02
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260802_000129"
down_revision: Union[str, None] = "20260801_000128"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mobile_content_settings",
        sa.Column("home_config", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("mobile_content_settings", "home_config")
