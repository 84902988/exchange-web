"""add stock token locks notice settings

Revision ID: 20260530_000072
Revises: 20260530_000071
Create Date: 2026-05-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260530_000072"
down_revision = "20260530_000071"
branch_labels = None
depends_on = None


DEFAULT_TITLE = "股票代币兑换股票说明"
DEFAULT_CONTENT = "\n".join(
    [
        "1. 请在凯恩斯券商平台完成注册（手机应用市场搜索：Keynes Securities）",
        "2. 请与英交易所官方客服取得联系，联系方式请以官方公告或客服页面为准",
        "3. 沟通相关股票配发事项",
    ]
)


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _has_column(bind, table_name: str, column_name: str) -> bool:
    if not _has_table(bind, table_name):
        return False
    return any(column.get("name") == column_name for column in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "site_settings"):
        return

    if not _has_column(bind, "site_settings", "stock_token_locks_notice_title"):
        op.add_column(
            "site_settings",
            sa.Column("stock_token_locks_notice_title", sa.String(length=255), nullable=True),
        )
    if not _has_column(bind, "site_settings", "stock_token_locks_notice_content"):
        op.add_column(
            "site_settings",
            sa.Column("stock_token_locks_notice_content", sa.Text(), nullable=True),
        )

    bind.execute(
        sa.text(
            """
            UPDATE site_settings
            SET stock_token_locks_notice_title = COALESCE(NULLIF(stock_token_locks_notice_title, ''), :title),
                stock_token_locks_notice_content = COALESCE(NULLIF(stock_token_locks_notice_content, ''), :content)
            """
        ),
        {"title": DEFAULT_TITLE, "content": DEFAULT_CONTENT},
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "site_settings"):
        return
    if _has_column(bind, "site_settings", "stock_token_locks_notice_content"):
        op.drop_column("site_settings", "stock_token_locks_notice_content")
    if _has_column(bind, "site_settings", "stock_token_locks_notice_title"):
        op.drop_column("site_settings", "stock_token_locks_notice_title")
