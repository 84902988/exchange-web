"""Explicit per-network opt-in for EVM native deposits; no existing asset is enabled."""
from alembic import op
import sqlalchemy as sa

revision = "20260924_000137"
down_revision = "20260824_000136"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("asset_chains", sa.Column("native_deposit_enabled", sa.Boolean(),
                                          nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column("asset_chains", "native_deposit_enabled")
