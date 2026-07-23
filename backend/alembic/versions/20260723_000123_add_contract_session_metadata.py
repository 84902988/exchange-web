"""add contract session metadata

Revision ID: 20260723_000123
Revises: 20260721_000122
Create Date: 2026-07-23
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260723_000123"
down_revision = "20260721_000122"
branch_labels = None
depends_on = None


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    return sa.inspect(op.get_bind()).has_table(table_name)


def _has_column(table_name: str, column_name: str) -> bool:
    if not _has_table(table_name):
        return False
    return any(
        column.get("name") == column_name
        for column in sa.inspect(op.get_bind()).get_columns(table_name)
    )


def _has_check_constraint(table_name: str, constraint_name: str) -> bool:
    if not _has_table(table_name):
        return False
    return any(
        constraint.get("name") == constraint_name
        for constraint in sa.inspect(op.get_bind()).get_check_constraints(table_name)
    )


def upgrade() -> None:
    if not _has_table("contract_symbols"):
        return

    columns = (
        ("holiday_calendar_code", sa.Column("holiday_calendar_code", sa.String(length=8), nullable=True)),
        (
            "session_profile_code",
            sa.Column(
                "session_profile_code",
                sa.String(length=32),
                nullable=False,
                server_default="UNKNOWN",
            ),
        ),
        ("session_timezone_override", sa.Column("session_timezone_override", sa.String(length=64), nullable=True)),
        (
            "extended_hours_execution_mode",
            sa.Column(
                "extended_hours_execution_mode",
                sa.String(length=16),
                nullable=False,
                server_default="DISPLAY_ONLY",
            ),
        ),
    )
    for column_name, column in columns:
        if not _has_column("contract_symbols", column_name):
            op.add_column("contract_symbols", column)

    if not _has_check_constraint("contract_symbols", "ck_contract_symbols_session_profile_code"):
        op.create_check_constraint(
            "ck_contract_symbols_session_profile_code",
            "contract_symbols",
            "session_profile_code IN ('UNKNOWN', 'CRYPTO_24_7', 'US_EQUITY', 'US_INDEX_EXTENDED', "
            "'FOREX_24X5', 'METAL_23X5', 'ENERGY_CFD')",
        )
    if not _has_check_constraint("contract_symbols", "ck_contract_symbols_extended_hours_execution_mode"):
        op.create_check_constraint(
            "ck_contract_symbols_extended_hours_execution_mode",
            "contract_symbols",
            "extended_hours_execution_mode IN ('DISPLAY_ONLY', 'BLOCKED')",
        )

    op.execute(
        """
        UPDATE contract_symbols
        SET session_profile_code = 'CRYPTO_24_7',
            holiday_calendar_code = NULL
        WHERE UPPER(COALESCE(category, '')) = 'CRYPTO'
           OR UPPER(COALESCE(provider, '')) = 'BINANCE'
        """
    )
    op.execute(
        """
        UPDATE contract_symbols
        SET session_profile_code = 'US_EQUITY',
            holiday_calendar_code = 'US'
        WHERE UPPER(COALESCE(category, '')) = 'STOCK'
          AND UPPER(COALESCE(provider, '')) = 'ITICK'
        """
    )
    op.execute(
        """
        UPDATE contract_symbols
        SET session_profile_code = 'US_INDEX_EXTENDED',
            holiday_calendar_code = 'US'
        WHERE UPPER(COALESCE(provider, '')) = 'ITICK'
          AND (
            UPPER(COALESCE(provider_symbol, '')) IN ('DJI', 'DJI$GB', 'NAS100', 'NAS100$GB', 'SPX', 'SPX$GB')
            OR UPPER(COALESCE(symbol, '')) IN ('DJIUSDT_PERP', 'NAS100USDT_PERP', 'SPXUSDT_PERP')
          )
        """
    )
    op.execute(
        """
        UPDATE contract_symbols
        SET session_profile_code = 'FOREX_24X5',
            holiday_calendar_code = NULL
        WHERE UPPER(COALESCE(category, '')) = 'FOREX'
          AND UPPER(COALESCE(provider, '')) = 'ITICK'
        """
    )
    op.execute(
        """
        UPDATE contract_symbols
        SET session_profile_code = 'METAL_23X5',
            holiday_calendar_code = NULL
        WHERE UPPER(COALESCE(category, '')) IN ('METAL', 'GOLD')
          AND UPPER(COALESCE(provider, '')) = 'ITICK'
        """
    )
    op.execute(
        """
        UPDATE contract_symbols
        SET session_profile_code = 'ENERGY_CFD',
            holiday_calendar_code = NULL
        WHERE UPPER(COALESCE(category, '')) IN ('COMMODITY', 'FUTURES')
          AND UPPER(COALESCE(provider, '')) = 'ITICK'
        """
    )


def downgrade() -> None:
    if not _has_table("contract_symbols"):
        return
    if _has_check_constraint("contract_symbols", "ck_contract_symbols_extended_hours_execution_mode"):
        op.drop_constraint(
            "ck_contract_symbols_extended_hours_execution_mode",
            "contract_symbols",
            type_="check",
        )
    if _has_check_constraint("contract_symbols", "ck_contract_symbols_session_profile_code"):
        op.drop_constraint(
            "ck_contract_symbols_session_profile_code",
            "contract_symbols",
            type_="check",
        )
    for column_name in (
        "extended_hours_execution_mode",
        "session_timezone_override",
        "session_profile_code",
        "holiday_calendar_code",
    ):
        if _has_column("contract_symbols", column_name):
            op.drop_column("contract_symbols", column_name)
