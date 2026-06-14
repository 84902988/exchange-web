"""create reference overlays

Revision ID: 20260529_000059
Revises: 20260529_000058
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000059"
down_revision = "20260529_000058"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_index(bind, table_name: str, index_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(bind).get_indexes(table_name))


def _create_index_if_missing(bind, index_name: str, table_name: str, columns: list[str], unique: bool = False) -> None:
    if _has_table(bind, table_name) and not _has_index(bind, table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=unique)


def _seed_mfc_reference_overlay(bind) -> None:
    existing = bind.execute(
        sa.text("SELECT id FROM reference_overlays WHERE symbol = :symbol LIMIT 1"),
        {"symbol": "MFCUSDT"},
    ).first()
    if existing:
        return

    bind.execute(
        sa.text(
            """
            INSERT INTO reference_overlays (
                symbol, enabled, kind, title, source_label, description,
                line_title, line_color, badge_color, display_value_label,
                display_price, display_unit, data_source, source_symbol,
                sort_order, created_at, updated_at
            ) VALUES (
                :symbol, 1, :kind, :title, :source_label, :description,
                :line_title, :line_color, :badge_color, :display_value_label,
                :display_price, :display_unit, :data_source, :source_symbol,
                0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            """
        ),
        {
            "symbol": "MFCUSDT",
            "kind": "IRON",
            "title": "铁粉参考价",
            "source_label": "IRON62/USD",
            "description": "1 MFC ≈ 1KG 铁粉",
            "line_title": "铁粉参考价",
            "line_color": "#f0b90b",
            "badge_color": "#f0b90b",
            "display_value_label": "108 USD/吨",
            "display_price": "0.108",
            "display_unit": "USDT",
            "data_source": "MANUAL",
            "source_symbol": "IRON62",
        },
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "reference_overlays"):
        op.create_table(
            "reference_overlays",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("symbol", sa.String(length=32), nullable=False),
            sa.Column("enabled", sa.Integer(), nullable=False, server_default=sa.text("1")),
            sa.Column("kind", sa.String(length=32), nullable=False),
            sa.Column("title", sa.String(length=64), nullable=False),
            sa.Column("source_label", sa.String(length=64), nullable=True),
            sa.Column("description", sa.String(length=128), nullable=True),
            sa.Column("line_title", sa.String(length=64), nullable=True),
            sa.Column("line_color", sa.String(length=32), nullable=True),
            sa.Column("badge_color", sa.String(length=32), nullable=True),
            sa.Column("display_value_label", sa.String(length=64), nullable=True),
            sa.Column("display_price", sa.Numeric(36, 18), nullable=True),
            sa.Column("display_unit", sa.String(length=32), nullable=True),
            sa.Column("data_source", sa.String(length=32), nullable=True),
            sa.Column("source_symbol", sa.String(length=64), nullable=True),
            sa.Column("source_region", sa.String(length=32), nullable=True),
            sa.Column("conversion_type", sa.String(length=32), nullable=True),
            sa.Column("conversion_factor", sa.Numeric(36, 18), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP"),
                server_onupdate=sa.text("CURRENT_TIMESTAMP"),
            ),
        )

    _create_index_if_missing(bind, "uq_reference_overlays_symbol", "reference_overlays", ["symbol"], unique=True)
    _create_index_if_missing(
        bind,
        "idx_reference_overlays_enabled_sort",
        "reference_overlays",
        ["enabled", "sort_order"],
    )
    _seed_mfc_reference_overlay(bind)


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "reference_overlays"):
        if _has_index(bind, "reference_overlays", "idx_reference_overlays_enabled_sort"):
            op.drop_index("idx_reference_overlays_enabled_sort", table_name="reference_overlays")
        if _has_index(bind, "reference_overlays", "uq_reference_overlays_symbol"):
            op.drop_index("uq_reference_overlays_symbol", table_name="reference_overlays")
        op.drop_table("reference_overlays")
