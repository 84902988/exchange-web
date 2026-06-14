"""add vip system tables

Revision ID: 20260420_000001
Revises:
Create Date: 2026-04-20 00:00:01
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260420_000001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "vip_fee_levels",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("vip_type", sa.String(length=20), nullable=False),
        sa.Column("level_code", sa.String(length=30), nullable=False),
        sa.Column("level_name", sa.String(length=50), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("spot_maker_fee", sa.Numeric(18, 10), nullable=False, server_default=sa.text("0")),
        sa.Column("spot_taker_fee", sa.Numeric(18, 10), nullable=False, server_default=sa.text("0")),
        sa.Column("contract_maker_fee", sa.Numeric(18, 10), nullable=True),
        sa.Column("contract_taker_fee", sa.Numeric(18, 10), nullable=True),
        sa.Column("rcb_discount_rate", sa.Numeric(18, 10), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("vip_type IN ('VIP', 'SVIP')", name="ck_vip_fee_levels_vip_type"),
        sa.UniqueConstraint("vip_type", "level_code", name="uq_vip_fee_levels_type_code"),
    )
    op.create_index("idx_vip_fee_levels_type_enabled", "vip_fee_levels", ["vip_type", "is_enabled"], unique=False)
    op.create_index("idx_vip_fee_levels_sort_order", "vip_fee_levels", ["sort_order"], unique=False)

    op.create_table(
        "vip_fee_level_conditions",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("vip_fee_level_id", sa.BigInteger(), nullable=False),
        sa.Column("min_30d_volume", sa.Numeric(36, 18), nullable=True),
        sa.Column("min_rcb_hold", sa.Numeric(36, 18), nullable=True),
        sa.Column("min_lock_amount", sa.Numeric(36, 18), nullable=True),
        sa.Column("lock_period_days", sa.Integer(), nullable=True),
        sa.Column("user_limit", sa.Integer(), nullable=True),
        sa.Column("dividend_rate", sa.Numeric(18, 10), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["vip_fee_level_id"],
            ["vip_fee_levels.id"],
            name="fk_vip_fee_level_conditions_level",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("vip_fee_level_id", name="uq_vip_fee_level_conditions_level_id"),
    )

    op.create_table(
        "user_vip_snapshots",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("vip_level_code", sa.String(length=30), nullable=True),
        sa.Column("svip_level_code", sa.String(length=30), nullable=True),
        sa.Column("effective_spot_maker_fee", sa.Numeric(18, 10), nullable=True),
        sa.Column("effective_spot_taker_fee", sa.Numeric(18, 10), nullable=True),
        sa.Column("effective_contract_maker_fee", sa.Numeric(18, 10), nullable=True),
        sa.Column("effective_contract_taker_fee", sa.Numeric(18, 10), nullable=True),
        sa.Column("effective_level_code", sa.String(length=30), nullable=True),
        sa.Column("effective_fee_source", sa.String(length=20), nullable=True),
        sa.Column("vip_updated_at", sa.DateTime(), nullable=True),
        sa.Column("svip_updated_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("idx_user_vip_snapshots_user_id", "user_vip_snapshots", ["user_id"], unique=True)

    op.create_table(
        "user_rcb_locks",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("asset_symbol", sa.String(length=20), nullable=False, server_default=sa.text("'RCB'")),
        sa.Column("lock_amount", sa.Numeric(36, 18), nullable=False),
        sa.Column("lock_period_days", sa.Integer(), nullable=False),
        sa.Column("start_time", sa.DateTime(), nullable=False),
        sa.Column("end_time", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("source", sa.String(length=30), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "status IN ('LOCKED', 'UNLOCKED', 'EXPIRED', 'CANCELED')",
            name="ck_user_rcb_locks_status",
        ),
    )
    op.create_index("idx_user_rcb_locks_user_status", "user_rcb_locks", ["user_id", "status"], unique=False)
    op.create_index("idx_user_rcb_locks_asset_status", "user_rcb_locks", ["asset_symbol", "status"], unique=False)
    op.create_index("idx_user_rcb_locks_end_time", "user_rcb_locks", ["end_time"], unique=False)
    op.create_index("idx_user_rcb_locks_user_end", "user_rcb_locks", ["user_id", "end_time"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_user_rcb_locks_end_time", table_name="user_rcb_locks")
    op.drop_index("idx_user_rcb_locks_user_end", table_name="user_rcb_locks")
    op.drop_index("idx_user_rcb_locks_asset_status", table_name="user_rcb_locks")
    op.drop_index("idx_user_rcb_locks_user_status", table_name="user_rcb_locks")
    op.drop_table("user_rcb_locks")

    op.drop_index("idx_user_vip_snapshots_user_id", table_name="user_vip_snapshots")
    op.drop_table("user_vip_snapshots")

    op.drop_table("vip_fee_level_conditions")

    op.drop_index("idx_vip_fee_levels_sort_order", table_name="vip_fee_levels")
    op.drop_index("idx_vip_fee_levels_type_enabled", table_name="vip_fee_levels")
    op.drop_table("vip_fee_levels")
