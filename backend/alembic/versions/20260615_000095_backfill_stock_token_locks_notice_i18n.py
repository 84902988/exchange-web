"""backfill stock token locks notice i18n

Revision ID: 20260615_000095
Revises: 20260614_000094
Create Date: 2026-06-15
"""

from __future__ import annotations

import json
from typing import Any, Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260615_000095"
down_revision: Union[str, None] = "20260614_000094"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TITLE_I18N = {
    "zh": "股票通证转换指南",
    "en": "Stock Token Conversion Guide",
    "zh-TW": "股票通證轉換指南",
    "ja": "株式トークン交換ガイド",
}

CONTENT_I18N = {
    "zh": "\n".join(
        [
            "1. 请在凯恩斯券商平台完成注册（手机应用市场搜索：Keynes Securities）",
            "2. 请与交易所官方客服联系，联系方式请以官方公告或客服页面为准",
            "3. 沟通相关股票配发事项",
        ]
    ),
    "en": "\n".join(
        [
            "1. Complete registration on the Keynes Securities platform (search for Keynes Securities in your mobile app store)",
            "2. Contact the exchange's official customer support. Please use the official announcements or support page as the source of contact details",
            "3. Confirm the related stock allocation arrangements",
        ]
    ),
    "zh-TW": "\n".join(
        [
            "1. 請在凱恩斯券商平台完成註冊（手機應用市場搜尋：Keynes Securities）",
            "2. 請與交易所官方客服聯繫，聯繫方式請以官方公告或客服頁面為準",
            "3. 溝通相關股票配發事項",
        ]
    ),
    "ja": "\n".join(
        [
            "1. Keynes Securities プラットフォームで登録を完了してください（スマートフォンのアプリストアで Keynes Securities を検索）",
            "2. 取引所の公式カスタマーサポートへお問い合わせください。連絡先は公式公告またはサポートページを基準とします",
            "3. 関連する株式配分事項について確認してください",
        ]
    ),
}


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_columns(table_name: str, column_names: set[str]) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {column.get("name") for column in inspector.get_columns(table_name)}
    return column_names.issubset(existing)


def _read_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _merge_missing(current: Any, defaults: dict[str, str]) -> dict[str, str]:
    data = _read_json(current)
    for locale, text in defaults.items():
        if str(data.get(locale) or "").strip() == "":
            data[locale] = text
    return data


def upgrade() -> None:
    if not _has_table("site_settings"):
        return
    required_columns = {
        "id",
        "stock_token_locks_notice_title_i18n",
        "stock_token_locks_notice_content_i18n",
    }
    if not _has_columns("site_settings", required_columns):
        return

    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT id, stock_token_locks_notice_title_i18n, stock_token_locks_notice_content_i18n
            FROM site_settings
            """
        )
    ).mappings()
    for row in rows:
        bind.execute(
            sa.text(
                """
                UPDATE site_settings
                SET stock_token_locks_notice_title_i18n = :title_i18n,
                    stock_token_locks_notice_content_i18n = :content_i18n
                WHERE id = :id
                """
            ),
            {
                "id": row["id"],
                "title_i18n": json.dumps(
                    _merge_missing(row["stock_token_locks_notice_title_i18n"], TITLE_I18N),
                    ensure_ascii=False,
                ),
                "content_i18n": json.dumps(
                    _merge_missing(row["stock_token_locks_notice_content_i18n"], CONTENT_I18N),
                    ensure_ascii=False,
                ),
            },
        )


def downgrade() -> None:
    pass
