from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import BigInteger, create_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.user_rcb_lock import UserRcbLock
from app.db.models.vip_fee_level import VipFeeLevel
from app.db.models.vip_fee_level_condition import VipFeeLevelCondition
from app.services import rcb_lock_service
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.rcb_lock_service import (
    RcbLockError,
    create_user_rcb_lock,
    release_matured_user_rcb_locks,
)


@compiles(BigInteger, "sqlite")
def _compile_bigint_for_sqlite(_type, _compiler, **_kwargs):
    return "INTEGER"


def _build_session_factory():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(
        engine,
        tables=[
            VipFeeLevel.__table__,
            VipFeeLevelCondition.__table__,
            UserRcbLock.__table__,
            UserBalance.__table__,
            BalanceLog.__table__,
        ],
    )
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def _seed_svip1(db) -> None:
    level = VipFeeLevel(
        vip_type="SVIP",
        level_code="SVIP1",
        level_name="SVIP1",
        sort_order=1,
        is_enabled=True,
        spot_maker_fee=Decimal("0.001"),
        spot_taker_fee=Decimal("0.001"),
    )
    db.add(level)
    db.flush()
    db.add(
        VipFeeLevelCondition(
            vip_fee_level_id=int(level.id),
            min_lock_amount=Decimal("1000"),
            lock_period_days=365,
        )
    )
    db.flush()


def _seed_balance(db, *, user_id: int, amount: str) -> UserBalance:
    balance = UserBalance(
        user_id=user_id,
        coin_symbol="RCB",
        chain_key=FUNDING_BALANCE_CHAIN_KEY,
        available_amount=Decimal(amount),
        frozen_amount=Decimal("0"),
        version=0,
    )
    db.add(balance)
    db.flush()
    return balance


def _stub_snapshot(*_args, **_kwargs):
    return SimpleNamespace(
        svip_level_code="SVIP1",
        effective_level_code="SVIP1",
        effective_fee_source="SVIP",
        effective_spot_maker_fee=Decimal("0.001"),
        effective_spot_taker_fee=Decimal("0.001"),
        rcb_locked=Decimal("1500"),
    )


def test_create_rcb_lock_deducts_funding_and_writes_ledger(monkeypatch) -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        _seed_svip1(db)
        balance = _seed_balance(db, user_id=7, amount="2000")
        monkeypatch.setattr(rcb_lock_service, "calculate_user_vip_snapshot", _stub_snapshot)

        result = create_user_rcb_lock(
            db,
            user_id=7,
            amount="1500",
            lock_period_days=365,
        )
        db.commit()

        assert result["lock"]["status"] == "LOCKED"
        assert Decimal(str(balance.available_amount)) == Decimal("500")
        ledger = db.query(BalanceLog).one()
        assert ledger.biz_type == "RCB_LOCK"
        assert ledger.direction == -1
        assert Decimal(str(ledger.change_amount)) == Decimal("1500")
    finally:
        db.close()


def test_create_rcb_lock_rejects_wrong_period_without_balance_change(monkeypatch) -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        _seed_svip1(db)
        balance = _seed_balance(db, user_id=8, amount="2000")
        monkeypatch.setattr(rcb_lock_service, "calculate_user_vip_snapshot", _stub_snapshot)

        with pytest.raises(RcbLockError):
            create_user_rcb_lock(
                db,
                user_id=8,
                amount="1500",
                lock_period_days=720,
            )
        db.rollback()

        assert Decimal(str(balance.available_amount)) == Decimal("2000")
        assert db.query(UserRcbLock).count() == 0
        assert db.query(BalanceLog).count() == 0
    finally:
        db.close()


def test_release_matured_rcb_locks_is_due_only_and_idempotent(monkeypatch) -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    now = datetime.utcnow()
    try:
        balance = _seed_balance(db, user_id=9, amount="100")
        matured = UserRcbLock(
            user_id=9,
            asset_symbol="RCB",
            lock_amount=Decimal("50"),
            lock_period_days=365,
            start_time=now - timedelta(days=366),
            end_time=now - timedelta(days=1),
            status="LOCKED",
            source="TEST",
            created_at=now - timedelta(days=366),
            updated_at=now - timedelta(days=366),
        )
        future = UserRcbLock(
            user_id=9,
            asset_symbol="RCB",
            lock_amount=Decimal("80"),
            lock_period_days=365,
            start_time=now,
            end_time=now + timedelta(days=365),
            status="LOCKED",
            source="TEST",
            created_at=now,
            updated_at=now,
        )
        db.add_all([matured, future])
        db.flush()
        monkeypatch.setattr(rcb_lock_service, "calculate_user_vip_snapshot", _stub_snapshot)

        first = release_matured_user_rcb_locks(db, user_id=9, now=now)
        db.commit()
        second = release_matured_user_rcb_locks(db, user_id=9, now=now)
        db.commit()

        assert first["released_count"] == 1
        assert Decimal(first["released_amount"]) == Decimal("50")
        assert second["released_count"] == 0
        assert Decimal(str(balance.available_amount)) == Decimal("150")
        assert matured.status == "UNLOCKED"
        assert future.status == "LOCKED"
        ledger = db.query(BalanceLog).filter(BalanceLog.biz_type == "RCB_UNLOCK").one()
        assert ledger.biz_id == str(matured.id)
        assert ledger.direction == 1
    finally:
        db.close()


def test_release_existing_unlock_ledger_never_double_credits(monkeypatch) -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    now = datetime.utcnow()
    try:
        balance = _seed_balance(db, user_id=10, amount="150")
        matured = UserRcbLock(
            user_id=10,
            asset_symbol="RCB",
            lock_amount=Decimal("50"),
            lock_period_days=365,
            start_time=now - timedelta(days=366),
            end_time=now - timedelta(days=1),
            status="LOCKED",
            source="TEST",
            created_at=now - timedelta(days=366),
            updated_at=now - timedelta(days=366),
        )
        db.add(matured)
        db.flush()
        db.add(
            BalanceLog(
                user_id=10,
                coin_symbol="RCB",
                chain_key=FUNDING_BALANCE_CHAIN_KEY,
                change_type="RCB_UNLOCK",
                direction=1,
                change_amount=Decimal("50"),
                before_available=Decimal("100"),
                after_available=Decimal("150"),
                before_frozen=Decimal("0"),
                after_frozen=Decimal("0"),
                biz_type="RCB_UNLOCK",
                biz_id=str(matured.id),
                created_at=now - timedelta(minutes=1),
            )
        )
        db.commit()
        monkeypatch.setattr(rcb_lock_service, "calculate_user_vip_snapshot", _stub_snapshot)

        result = release_matured_user_rcb_locks(db, user_id=10, now=now)
        db.commit()

        assert result["released_count"] == 0
        assert Decimal(str(balance.available_amount)) == Decimal("150")
        assert matured.status == "UNLOCKED"
        assert db.query(BalanceLog).count() == 1
    finally:
        db.close()
