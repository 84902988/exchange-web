"""add bd distribution tables

Revision ID: 20260429_000006
Revises: 20260420_000005
Create Date: 2026-04-29 00:00:06
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260429_000006"
down_revision = "20260420_000005"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def _has_unique_constraint(bind, table_name: str, constraint_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    inspector = sa.inspect(bind)
    return any(
        constraint["name"] == constraint_name
        for constraint in inspector.get_unique_constraints(table_name)
    )


def _create_bd_accounts(bind) -> None:
    table_name = "bd_accounts"
    if not _has_table(bind, table_name):
        op.create_table(
            table_name,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger(), nullable=False, unique=True),
            sa.Column("bd_level", sa.String(length=20), nullable=False, server_default="BD1"),
            sa.Column("commission_rate", sa.Numeric(10, 6), nullable=False, server_default="0.300000"),
            sa.Column("invite_code", sa.String(length=64), nullable=False, unique=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"),
            sa.Column("remark", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
        )


def _create_bd_user_relations(bind) -> None:
    table_name = "bd_user_relations"
    if not _has_table(bind, table_name):
        op.create_table(
            table_name,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("bd_user_id", sa.BigInteger(), nullable=False),
            sa.Column("user_id", sa.BigInteger(), nullable=False, unique=True),
            sa.Column("invite_code", sa.String(length=64), nullable=True),
            sa.Column("bound_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="ACTIVE"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
        )
    if not _has_index(bind, table_name, "idx_bd_user_relations_bd_user_id"):
        op.create_index("idx_bd_user_relations_bd_user_id", table_name, ["bd_user_id"], unique=False)
    if not _has_index(bind, table_name, "idx_bd_user_relations_status"):
        op.create_index("idx_bd_user_relations_status", table_name, ["status"], unique=False)


def _create_bd_commission_records(bind) -> None:
    table_name = "bd_commission_records"
    if not _has_table(bind, table_name):
        op.create_table(
            table_name,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("bd_user_id", sa.BigInteger(), nullable=False),
            sa.Column("user_id", sa.BigInteger(), nullable=False),
            sa.Column("order_id", sa.BigInteger(), nullable=True),
            sa.Column("trade_id", sa.BigInteger(), nullable=True),
            sa.Column("source_balance_log_id", sa.BigInteger(), nullable=True),
            sa.Column("fee_asset_id", sa.BigInteger(), nullable=False),
            sa.Column("fee_coin_symbol", sa.String(length=20), nullable=False),
            sa.Column("original_fee_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("commission_rate", sa.Numeric(10, 6), nullable=False),
            sa.Column("commission_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("pool_amount", sa.Numeric(36, 18), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="PENDING"),
            sa.Column("paid_balance_log_id", sa.BigInteger(), nullable=True),
            sa.Column("paid_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.UniqueConstraint("trade_id", "bd_user_id", name="uq_bd_commission_trade_bd"),
        )
    if not _has_unique_constraint(bind, table_name, "uq_bd_commission_trade_bd"):
        op.create_unique_constraint(
            "uq_bd_commission_trade_bd",
            table_name,
            ["trade_id", "bd_user_id"],
        )
    for index_name, columns in (
        ("idx_bd_commission_records_bd_user_id", ["bd_user_id"]),
        ("idx_bd_commission_records_user_id", ["user_id"]),
        ("idx_bd_commission_records_trade_id", ["trade_id"]),
        ("idx_bd_commission_records_status", ["status"]),
        ("idx_bd_commission_records_created_at", ["created_at"]),
    ):
        if not _has_index(bind, table_name, index_name):
            op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    bind = op.get_bind()
    _create_bd_accounts(bind)
    _create_bd_user_relations(bind)
    _create_bd_commission_records(bind)


def downgrade() -> None:
    bind = op.get_bind()

    for table_name, index_names in (
        ("bd_commission_records", [
            "idx_bd_commission_records_bd_user_id",
            "idx_bd_commission_records_user_id",
            "idx_bd_commission_records_trade_id",
            "idx_bd_commission_records_status",
            "idx_bd_commission_records_created_at",
        ]),
        ("bd_user_relations", [
            "idx_bd_user_relations_bd_user_id",
            "idx_bd_user_relations_status",
        ]),
    ):
        if _has_table(bind, table_name):
            if table_name == "bd_commission_records" and _has_unique_constraint(
                bind,
                table_name,
                "uq_bd_commission_trade_bd",
            ):
                op.drop_constraint("uq_bd_commission_trade_bd", table_name, type_="unique")
            for index_name in index_names:
                if _has_index(bind, table_name, index_name):
                    op.drop_index(index_name, table_name=table_name)
            op.drop_table(table_name)

    if _has_table(bind, "bd_accounts"):
        op.drop_table("bd_accounts")
