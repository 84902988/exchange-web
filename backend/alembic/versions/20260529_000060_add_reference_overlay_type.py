"""add reference overlay type

Revision ID: 20260529_000060
Revises: 20260529_000059
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000060"
down_revision = "20260529_000059"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def _upsert_reference_overlay(bind, payload: dict[str, object]) -> None:
    existing = bind.execute(
        sa.text("SELECT id FROM reference_overlays WHERE symbol = :symbol LIMIT 1"),
        {"symbol": payload["symbol"]},
    ).first()

    if existing:
        bind.execute(
            sa.text(
                """
                UPDATE reference_overlays
                SET enabled = :enabled,
                    reference_type = :reference_type,
                    kind = :kind,
                    title = :title,
                    source_label = :source_label,
                    description = :description,
                    line_title = :line_title,
                    line_color = :line_color,
                    badge_color = :badge_color,
                    display_value_label = :display_value_label,
                    display_price = :display_price,
                    display_unit = :display_unit,
                    data_source = :data_source,
                    source_symbol = :source_symbol,
                    sort_order = :sort_order,
                    updated_at = CURRENT_TIMESTAMP
                WHERE symbol = :symbol
                """
            ),
            payload,
        )
        return

    bind.execute(
        sa.text(
            """
            INSERT INTO reference_overlays (
                symbol, enabled, reference_type, kind, title, source_label,
                description, line_title, line_color, badge_color,
                display_value_label, display_price, display_unit, data_source,
                source_symbol, sort_order, created_at, updated_at
            ) VALUES (
                :symbol, :enabled, :reference_type, :kind, :title, :source_label,
                :description, :line_title, :line_color, :badge_color,
                :display_value_label, :display_price, :display_unit, :data_source,
                :source_symbol, :sort_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            """
        ),
        payload,
    )


def _seed_reference_overlays(bind) -> None:
    rows = [
        {
            "symbol": "MFCUSDT",
            "enabled": 1,
            "reference_type": "IRON",
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
            "sort_order": 0,
        },
        {
            "symbol": "IGCUSDT",
            "enabled": 0,
            "reference_type": "GOLD",
            "kind": "GOLD",
            "title": "黄金参考价",
            "source_label": "XAU/USD",
            "description": "",
            "line_title": "黄金参考价",
            "line_color": "#f0b90b",
            "badge_color": "#f0b90b",
            "display_value_label": "待配置",
            "display_price": "1",
            "display_unit": "USDT",
            "data_source": "MANUAL",
            "source_symbol": "XAUUSD",
            "sort_order": 1,
        },
        {
            "symbol": "BON-2USDT",
            "enabled": 0,
            "reference_type": "STOCK",
            "kind": "STOCK",
            "title": "BON股票参考价",
            "source_label": "BON Stock Reference",
            "description": "",
            "line_title": "BON股票参考价",
            "line_color": "#f0b90b",
            "badge_color": "#f0b90b",
            "display_value_label": "待配置",
            "display_price": "1",
            "display_unit": "USDT",
            "data_source": "MANUAL",
            "source_symbol": "BON",
            "sort_order": 2,
        },
        {
            "symbol": "CREG-2USDT",
            "enabled": 0,
            "reference_type": "STOCK",
            "kind": "STOCK",
            "title": "CREG股票参考价",
            "source_label": "CREG Stock Reference",
            "description": "",
            "line_title": "CREG股票参考价",
            "line_color": "#f0b90b",
            "badge_color": "#f0b90b",
            "display_value_label": "待配置",
            "display_price": "1",
            "display_unit": "USDT",
            "data_source": "MANUAL",
            "source_symbol": "CREG",
            "sort_order": 3,
        },
        {
            "symbol": "IMAA-2USDT",
            "enabled": 0,
            "reference_type": "STOCK",
            "kind": "STOCK",
            "title": "IMAA股票参考价",
            "source_label": "IMAA Stock Reference",
            "description": "",
            "line_title": "IMAA股票参考价",
            "line_color": "#f0b90b",
            "badge_color": "#f0b90b",
            "display_value_label": "待配置",
            "display_price": "1",
            "display_unit": "USDT",
            "data_source": "MANUAL",
            "source_symbol": "IMAA",
            "sort_order": 4,
        },
    ]
    for row in rows:
        _upsert_reference_overlay(bind, row)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    if not _has_column(bind, "reference_overlays", "reference_type"):
        op.add_column(
            "reference_overlays",
            sa.Column("reference_type", sa.String(length=20), nullable=False, server_default=sa.text("'STOCK'")),
        )

    bind.execute(sa.text("UPDATE reference_overlays SET reference_type = 'IRON' WHERE symbol = 'MFCUSDT'"))
    _seed_reference_overlays(bind)


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "reference_overlays", "reference_type"):
        op.drop_column("reference_overlays", "reference_type")
