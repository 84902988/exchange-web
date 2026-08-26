"""merge user transfer hotfix with the pending feature migration chain

Revision ID: 20260803_000134
Revises: 20260802_000132, 20260803_000133
Create Date: 2026-08-03
"""

from __future__ import annotations

from typing import Sequence, Union


revision: str = "20260803_000134"
down_revision: Union[str, Sequence[str], None] = (
    "20260802_000132",
    "20260803_000133",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
