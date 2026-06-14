"""igc gold reference overlay auto

Revision ID: 20260529_000064
Revises: 20260529_000063
Create Date: 2026-05-29
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260529_000064"
down_revision = "20260529_000063"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    payload = {
        "symbol": "IGCUSDT",
        "enabled": 1,
        "reference_type": "GOLD",
        "kind": "GOLD",
        "title": "黄金参考价",
        "source_label": "XAU/USD",
        "description": "",
        "line_title": "黄金参考价",
        "line_color": "#f0b90b",
        "badge_color": "#f0b90b",
        "display_value_label": "待同步",
        "display_price": "1",
        "display_unit": "USDT",
        "data_source": "MANUAL",
        "price_source": "AUTO",
        "auto_source": "XAUUSD",
        "source_symbol": "XAUUSD",
        "refresh_interval_sec": 60,
        "sync_status": "PENDING",
        "market_status": "UNKNOWN",
        "market_status_text": "状态未知",
        "is_realtime": 0,
        "sort_order": 1,
    }

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
                    price_source = :price_source,
                    auto_source = :auto_source,
                    source_symbol = :source_symbol,
                    refresh_interval_sec = :refresh_interval_sec,
                    sync_status = :sync_status,
                    market_status = :market_status,
                    market_status_text = :market_status_text,
                    is_realtime = :is_realtime,
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
                price_source, auto_source, source_symbol, refresh_interval_sec,
                sync_status, market_status, market_status_text, is_realtime,
                sort_order, created_at, updated_at
            ) VALUES (
                :symbol, :enabled, :reference_type, :kind, :title, :source_label,
                :description, :line_title, :line_color, :badge_color,
                :display_value_label, :display_price, :display_unit, :data_source,
                :price_source, :auto_source, :source_symbol, :refresh_interval_sec,
                :sync_status, :market_status, :market_status_text, :is_realtime,
                :sort_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            """
        ),
        payload,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "reference_overlays"):
        return

    bind.execute(
        sa.text(
            """
            UPDATE reference_overlays
            SET enabled = 0,
                price_source = 'MANUAL',
                auto_source = NULL,
                refresh_interval_sec = 300,
                display_value_label = '待配置',
                display_price = '1',
                sync_status = 'PENDING',
                market_status = 'UNKNOWN',
                market_status_text = '状态未知',
                is_realtime = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE symbol = 'IGCUSDT'
            """
        )
    )
