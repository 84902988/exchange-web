from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.bd_commission_record import BdCommissionRecord
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.bd_commission_service import (
    InsufficientPlatformBalanceError,
    get_platform_bd_commission_available_balances,
    pay_bd_commission_record,
)
from app.services.fee_service import PLATFORM_USER_ID


def _money(value: Decimal) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def _build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE assets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol VARCHAR(32) NOT NULL UNIQUE,
                    name VARCHAR(64) NOT NULL,
                    asset_type VARCHAR(16) NOT NULL,
                    display_precision INTEGER NOT NULL,
                    enabled INTEGER NOT NULL,
                    icon_url VARCHAR(255),
                    sort_order INTEGER NOT NULL,
                    deposit_sort_order INTEGER NOT NULL,
                    deposit_quick_enabled BOOLEAN NOT NULL,
                    deposit_default_enabled BOOLEAN NOT NULL,
                    withdraw_sort_order INTEGER NOT NULL,
                    withdraw_quick_enabled BOOLEAN NOT NULL,
                    withdraw_default_enabled BOOLEAN NOT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE user_balances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id BIGINT NOT NULL,
                    asset_id BIGINT,
                    coin_symbol VARCHAR(32) NOT NULL,
                    chain_key VARCHAR(32) NOT NULL,
                    available_amount NUMERIC(36, 18) NOT NULL,
                    frozen_amount NUMERIC(36, 18) NOT NULL,
                    version BIGINT NOT NULL,
                    updated_at DATETIME NOT NULL,
                    created_at DATETIME NOT NULL,
                    UNIQUE (user_id, coin_symbol, chain_key)
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE balance_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id BIGINT NOT NULL,
                    asset_id BIGINT,
                    coin_symbol VARCHAR(32) NOT NULL,
                    chain_key VARCHAR(32) NOT NULL,
                    change_type VARCHAR(64) NOT NULL,
                    direction INTEGER NOT NULL,
                    change_amount NUMERIC(36, 18) NOT NULL,
                    before_available NUMERIC(36, 18) NOT NULL,
                    after_available NUMERIC(36, 18) NOT NULL,
                    before_frozen NUMERIC(36, 18) NOT NULL,
                    after_frozen NUMERIC(36, 18) NOT NULL,
                    biz_type VARCHAR(32) NOT NULL,
                    biz_id VARCHAR(128) NOT NULL,
                    trade_id BIGINT,
                    request_id VARCHAR(64),
                    remark VARCHAR(255),
                    created_at DATETIME NOT NULL,
                    UNIQUE (user_id, coin_symbol, chain_key, biz_type, biz_id)
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE bd_commission_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    bd_user_id BIGINT NOT NULL,
                    user_id BIGINT NOT NULL,
                    order_id BIGINT,
                    trade_id BIGINT,
                    source_balance_log_id BIGINT,
                    fee_asset_id BIGINT NOT NULL,
                    fee_coin_symbol VARCHAR(20) NOT NULL,
                    original_fee_amount NUMERIC(36, 18) NOT NULL,
                    commission_rate NUMERIC(10, 6) NOT NULL,
                    commission_amount NUMERIC(36, 18) NOT NULL,
                    commission_asset_symbol VARCHAR(20),
                    pool_amount NUMERIC(36, 18) NOT NULL,
                    status VARCHAR(20) NOT NULL,
                    paid_balance_log_id BIGINT,
                    paid_at DATETIME,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    UNIQUE (trade_id, bd_user_id)
                )
                """
            )
        )
        connection.execute(
            text(
                """
                INSERT INTO assets (
                    id, symbol, name, asset_type, display_precision, enabled, sort_order,
                    deposit_sort_order, deposit_quick_enabled, deposit_default_enabled,
                    withdraw_sort_order, withdraw_quick_enabled, withdraw_default_enabled,
                    created_at, updated_at
                ) VALUES (
                    1, 'USDT', 'USDT', 'token', 6, 1, 0,
                    100, 1, 0, 100, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """
            )
        )
        connection.execute(
            text(
                """
                INSERT INTO user_balances (
                    user_id, coin_symbol, chain_key, available_amount, frozen_amount,
                    version, created_at, updated_at
                ) VALUES (
                    :platform_user_id, 'USDT', :chain_key, 9.84, 0, 0,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """
            ),
            {"platform_user_id": PLATFORM_USER_ID, "chain_key": FUNDING_BALANCE_CHAIN_KEY},
        )
        connection.execute(
            text(
                """
                INSERT INTO bd_commission_records (
                    id, bd_user_id, user_id, order_id, trade_id, fee_asset_id,
                    fee_coin_symbol, original_fee_amount, commission_rate,
                    commission_amount, commission_asset_symbol, pool_amount, status,
                    created_at, updated_at
                ) VALUES (
                    121, 100000029, 992000026, 141266, 141207, 1,
                    'USDT', 36, 0.30, 10.80, 'USDT', 25.20, 'PENDING',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """
            )
        )
    return sessionmaker(bind=engine, future=True)()


def test_payout_reports_required_available_and_shortage_without_mutating_record():
    db = _build_session()
    try:
        balances = get_platform_bd_commission_available_balances(db, ["USDT", "RCB"])
        assert _money(balances["USDT"]) == Decimal("9.84")
        assert balances["RCB"] == Decimal("0")

        with pytest.raises(InsufficientPlatformBalanceError) as captured:
            pay_bd_commission_record(db, 121)

        error = captured.value
        assert error.asset_symbol == "USDT"
        assert _money(error.required_amount) == Decimal("10.80")
        assert _money(error.available_amount) == Decimal("9.84")
        assert _money(error.shortage_amount) == Decimal("0.96")
        db.rollback()

        record = db.query(BdCommissionRecord).filter(BdCommissionRecord.id == 121).one()
        assert record.status == "PENDING"
        assert db.query(BalanceLog).count() == 0
    finally:
        db.close()


def test_payout_credits_bd_funding_balance_when_platform_funds_are_sufficient():
    db = _build_session()
    try:
        platform_balance = (
            db.query(UserBalance)
            .filter(
                UserBalance.user_id == PLATFORM_USER_ID,
                UserBalance.coin_symbol == "USDT",
                UserBalance.chain_key == FUNDING_BALANCE_CHAIN_KEY,
            )
            .one()
        )
        platform_balance.available_amount = Decimal("50")
        db.commit()

        record = pay_bd_commission_record(db, 121)
        db.commit()

        assert record.status == "PAID"
        bd_balance = (
            db.query(UserBalance)
            .filter(
                UserBalance.user_id == 100000029,
                UserBalance.coin_symbol == "USDT",
                UserBalance.chain_key == FUNDING_BALANCE_CHAIN_KEY,
            )
            .one()
        )
        assert _money(bd_balance.available_amount) == Decimal("10.80")
        credit_log = (
            db.query(BalanceLog)
            .filter(BalanceLog.biz_type == "BD_COMMISSION_CREDIT", BalanceLog.biz_id == "121")
            .one()
        )
        assert credit_log.user_id == 100000029
        assert _money(credit_log.change_amount) == Decimal("10.80")
    finally:
        db.close()


def test_admin_and_user_surfaces_expose_funding_failure_and_live_refresh_controls():
    from pathlib import Path

    project_root = Path(__file__).resolve().parents[2]
    admin_router = (project_root / "backend/app/routers/admin_pages.py").read_text(encoding="utf-8")
    admin_template = (project_root / "backend/templates/admin/bd_commissions.html").read_text(encoding="utf-8")
    user_page = (project_root / "web/app/user/bd-team/page.tsx").read_text(encoding="utf-8")

    assert "get_platform_bd_commission_available_balances" in admin_router
    assert "blocked_records" in admin_router
    assert "平台 {{ funding.asset_symbol }} 发放资金" in admin_template
    assert "余额不足" in admin_template
    assert "BD_OVERVIEW_REFRESH_INTERVAL_MS" in user_page
    assert 'document.addEventListener("visibilitychange", refreshWhenVisible)' in user_page
