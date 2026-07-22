from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.db.models.bd_account import BdAccount
from app.db.models.bd_application import BdApplication
from app.db.models.bd_commission_rate_change_log import BdCommissionRateChangeLog
from app.db.models.bd_commission_record import BdCommissionRecord
from app.db.models.bd_user_relation import BdUserRelation
from app.services.bd_application_service import (
    BdCommissionRateUpdateError,
    update_bd_commission_rate,
)
from app.services.admin_queries import admin_query_bd_applications
from app.services.fee_service import _create_bd_commission_record_if_needed


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    statements = (
        """
        CREATE TABLE bd_applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            apply_level VARCHAR(20) NOT NULL,
            deposit_coin_symbol VARCHAR(20) NOT NULL,
            deposit_amount NUMERIC(36, 18) NOT NULL,
            status VARCHAR(20) NOT NULL,
            remark VARCHAR(255),
            admin_remark VARCHAR(255),
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            reviewed_at DATETIME,
            reviewed_by INTEGER
        )
        """,
        """
        CREATE TABLE bd_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            bd_level VARCHAR(20) NOT NULL,
            commission_rate NUMERIC(10, 6) NOT NULL,
            invite_code VARCHAR(64) NOT NULL UNIQUE,
            status VARCHAR(20) NOT NULL,
            remark VARCHAR(255),
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
        """,
        """
        CREATE TABLE bd_user_relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bd_user_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL UNIQUE,
            invite_code VARCHAR(64),
            bound_at DATETIME NOT NULL,
            status VARCHAR(20) NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
        """,
        """
        CREATE TABLE bd_commission_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bd_user_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            order_id INTEGER,
            trade_id INTEGER,
            source_balance_log_id INTEGER,
            fee_asset_id INTEGER NOT NULL,
            fee_coin_symbol VARCHAR(20) NOT NULL,
            original_fee_amount NUMERIC(36, 18) NOT NULL,
            commission_rate NUMERIC(10, 6) NOT NULL,
            commission_amount NUMERIC(36, 18) NOT NULL,
            commission_asset_symbol VARCHAR(20),
            pool_amount NUMERIC(36, 18) NOT NULL,
            status VARCHAR(20) NOT NULL,
            paid_balance_log_id INTEGER,
            paid_at DATETIME,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            UNIQUE (trade_id, bd_user_id)
        )
        """,
        """
        CREATE TABLE bd_commission_rate_change_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bd_account_id INTEGER NOT NULL,
            bd_user_id INTEGER NOT NULL,
            application_id INTEGER NOT NULL,
            old_commission_rate NUMERIC(10, 6) NOT NULL,
            new_commission_rate NUMERIC(10, 6) NOT NULL,
            changed_by_admin_id INTEGER NOT NULL,
            reason VARCHAR(500) NOT NULL,
            created_at DATETIME NOT NULL
        )
        """,
    )
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
    return sessionmaker(bind=engine, expire_on_commit=False)()


def _seed_active_bd(db) -> None:
    now = datetime.utcnow()
    db.add(
        BdApplication(
            id=1,
            user_id=100,
            apply_level="BD3",
            deposit_coin_symbol="USDT",
            deposit_amount=Decimal("1000"),
            status="APPROVED",
            created_at=now,
            updated_at=now,
            reviewed_at=now,
            reviewed_by=7,
        )
    )
    db.add(
        BdAccount(
            id=11,
            user_id=100,
            bd_level="BD3",
            commission_rate=Decimal("0.300000"),
            invite_code="BD100",
            status="ACTIVE",
            created_at=now,
            updated_at=now,
        )
    )
    db.add(
        BdUserRelation(
            id=21,
            bd_user_id=100,
            user_id=200,
            invite_code="BD100",
            bound_at=now,
            status="ACTIVE",
            created_at=now,
            updated_at=now,
        )
    )
    db.add(
        BdCommissionRecord(
            id=31,
            bd_user_id=100,
            user_id=200,
            order_id=300,
            trade_id=300,
            fee_asset_id=1,
            fee_coin_symbol="USDT",
            original_fee_amount=Decimal("0.100000000000000000"),
            commission_rate=Decimal("0.300000"),
            commission_amount=Decimal("0.030000000000000000"),
            commission_asset_symbol="USDT",
            pool_amount=Decimal("0.070000000000000000"),
            status="PENDING",
            created_at=now,
            updated_at=now,
        )
    )
    db.commit()


def test_rate_update_preserves_history_and_applies_to_new_records() -> None:
    db = _session()
    try:
        _seed_active_bd(db)

        result = update_bd_commission_rate(
            db,
            application_id=1,
            commission_percent="40.12",
            expected_commission_rate="0.300000",
            changed_by_admin_id=9,
            reason="季度渠道政策调整",
        )
        new_record = _create_bd_commission_record_if_needed(
            db,
            user_id=200,
            order_id=301,
            trade_id=301,
            trade=None,
            source_balance_log_id=None,
            fee_asset_id=1,
            fee_coin_symbol="USDT",
            fee_amount=Decimal("0.100000000000000000"),
        )
        db.commit()

        account = db.query(BdAccount).filter(BdAccount.user_id == 100).one()
        historical = db.query(BdCommissionRecord).filter(BdCommissionRecord.trade_id == 300).one()
        audit = db.query(BdCommissionRateChangeLog).one()

        assert result["old_commission_rate"] == Decimal("0.300000")
        assert result["new_commission_rate"] == Decimal("0.401200")
        assert account.commission_rate == Decimal("0.401200")
        assert historical.commission_rate == Decimal("0.300000")
        assert historical.commission_amount.quantize(Decimal("0.000001")) == Decimal("0.030000")
        assert new_record is not None
        assert new_record.commission_rate == Decimal("0.401200")
        assert new_record.commission_amount.quantize(Decimal("0.000001")) == Decimal("0.040120")
        assert audit.old_commission_rate == Decimal("0.300000")
        assert audit.new_commission_rate == Decimal("0.401200")
        assert audit.changed_by_admin_id == 9
        assert audit.reason == "季度渠道政策调整"
    finally:
        db.close()


def test_rate_update_rejects_stale_admin_page() -> None:
    db = _session()
    try:
        _seed_active_bd(db)
        update_bd_commission_rate(
            db,
            application_id=1,
            commission_percent="40",
            expected_commission_rate="0.300000",
            changed_by_admin_id=9,
            reason="首次调整",
        )
        db.commit()

        with pytest.raises(BdCommissionRateUpdateError, match="其他管理员修改"):
            update_bd_commission_rate(
                db,
                application_id=1,
                commission_percent="45",
                expected_commission_rate="0.300000",
                changed_by_admin_id=10,
                reason="过期页面提交",
            )
    finally:
        db.close()


def test_rate_update_requires_active_account_and_reason() -> None:
    db = _session()
    try:
        _seed_active_bd(db)
        account = db.query(BdAccount).filter(BdAccount.user_id == 100).one()
        account.status = "DISABLED"
        db.commit()

        with pytest.raises(BdCommissionRateUpdateError, match="生效中的BD账号"):
            update_bd_commission_rate(
                db,
                application_id=1,
                commission_percent="40",
                expected_commission_rate="0.300000",
                changed_by_admin_id=9,
                reason="停用账号不允许调整",
            )

        account.status = "ACTIVE"
        db.commit()
        with pytest.raises(BdCommissionRateUpdateError, match="修改原因不能为空"):
            update_bd_commission_rate(
                db,
                application_id=1,
                commission_percent="40",
                expected_commission_rate="0.300000",
                changed_by_admin_id=9,
                reason=" ",
            )
    finally:
        db.close()


def test_admin_application_list_exposes_current_rate() -> None:
    db = _session()
    try:
        _seed_active_bd(db)

        result = admin_query_bd_applications(db, {"page": 1, "page_size": 20})

        assert result["total"] == 1
        assert result["items"][0]["bd_commission_rate"] == "0.300000"
        assert result["items"][0]["bd_commission_rate_percent"] == "30.00%"
        assert result["items"][0]["bd_commission_rate_percent_input"] == "30.00"
        assert result["items"][0]["can_update_bd_rate"] is True
    finally:
        db.close()


@pytest.mark.parametrize(
    "commission_percent",
    ["", "-0.0001", "1e-1000000", "10.001", "100.0001", "NaN", "Infinity"],
)
def test_rate_update_rejects_invalid_percent(commission_percent: str) -> None:
    db = _session()
    try:
        _seed_active_bd(db)

        with pytest.raises(BdCommissionRateUpdateError):
            update_bd_commission_rate(
                db,
                application_id=1,
                commission_percent=commission_percent,
                expected_commission_rate="0.300000",
                changed_by_admin_id=9,
                reason="非法比例测试",
            )
    finally:
        db.close()
