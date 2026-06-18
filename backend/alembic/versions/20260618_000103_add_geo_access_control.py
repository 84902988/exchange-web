"""add geo access control tables

Revision ID: 20260618_000103
Revises: 20260616_000102
Create Date: 2026-06-18
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260618_000103"
down_revision = "20260616_000102"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "geo_access_settings"):
        op.create_table(
            "geo_access_settings",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("monitor_mode", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("block_unknown", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("restricted_countries_json", sa.Text(), nullable=False),
            sa.Column("admin_exempt", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
        op.execute(
            sa.text(
                """
                INSERT INTO geo_access_settings (
                    id, enabled, monitor_mode, block_unknown, restricted_countries_json, admin_exempt, updated_at
                )
                VALUES (1, FALSE, TRUE, FALSE, '[]', FALSE, UTC_TIMESTAMP())
                """
            )
        )

    if not _has_table(bind, "geo_ip_rules"):
        op.create_table(
            "geo_ip_rules",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("rule_type", sa.String(length=16), nullable=False),
            sa.Column("ip_cidr", sa.String(length=64), nullable=False),
            sa.Column("note", sa.String(length=255), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
        op.create_index("idx_geo_ip_rules_type_enabled", "geo_ip_rules", ["rule_type", "enabled"])

    if not _has_table(bind, "geo_access_logs"):
        op.create_table(
            "geo_access_logs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("ip_address", sa.String(length=45), nullable=False, server_default=""),
            sa.Column("country_code", sa.String(length=8), nullable=False, server_default="UNKNOWN"),
            sa.Column("source", sa.String(length=16), nullable=False, server_default="UNKNOWN"),
            sa.Column("path", sa.String(length=512), nullable=False, server_default=""),
            sa.Column("method", sa.String(length=10), nullable=False, server_default="GET"),
            sa.Column("user_agent", sa.String(length=512), nullable=False, server_default=""),
            sa.Column("decision", sa.String(length=16), nullable=False),
            sa.Column("reason", sa.String(length=32), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
        op.create_index("idx_geo_access_logs_created", "geo_access_logs", ["created_at"])
        op.create_index("idx_geo_access_logs_decision_created", "geo_access_logs", ["decision", "created_at"])
        op.create_index("idx_geo_access_logs_country_created", "geo_access_logs", ["country_code", "created_at"])
        op.create_index("idx_geo_access_logs_ip_created", "geo_access_logs", ["ip_address", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "geo_access_logs"):
        op.drop_index("idx_geo_access_logs_ip_created", table_name="geo_access_logs")
        op.drop_index("idx_geo_access_logs_country_created", table_name="geo_access_logs")
        op.drop_index("idx_geo_access_logs_decision_created", table_name="geo_access_logs")
        op.drop_index("idx_geo_access_logs_created", table_name="geo_access_logs")
        op.drop_table("geo_access_logs")
    if _has_table(bind, "geo_ip_rules"):
        op.drop_index("idx_geo_ip_rules_type_enabled", table_name="geo_ip_rules")
        op.drop_table("geo_ip_rules")
    if _has_table(bind, "geo_access_settings"):
        op.drop_table("geo_access_settings")
