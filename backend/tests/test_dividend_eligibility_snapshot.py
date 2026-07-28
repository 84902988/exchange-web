from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import BigInteger, create_engine, text
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.dividend import (
    DividendEligibilitySnapshot,
    DividendEligibilitySnapshotItem,
    DividendPool,
    DividendPoolItem,
    UserDividendRecord,
)
from app.db.models.dividend_job_log import DividendJobLog
from app.db.models.system_config import SystemConfig
from app.db.models.user_rcb_lock import UserRcbLock
from app.db.models.vip_fee_level import VipFeeLevel
from app.db.models.vip_fee_level_condition import VipFeeLevelCondition
from app.jobs import dividend_job
from app.services import dividend_service
from app.services.dividend_service import (
    build_dividend_recovery_preview,
    calculate_dividend_pool,
    capture_dividend_eligibility_snapshot,
    create_dividend_pool_skeleton,
    get_dividend_eligibility_snapshot_at,
    is_dividend_eligibility_snapshot_capture_window,
    list_dividend_recovery_candidates,
    require_dividend_eligibility_snapshot,
    set_dividend_run_time,
    set_dividend_schedule,
)
from app.services.rcb_price_service import get_rcb_price_snapshot_usdt


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
            DividendEligibilitySnapshot.__table__,
            DividendEligibilitySnapshotItem.__table__,
            DividendPool.__table__,
            DividendPoolItem.__table__,
            UserDividendRecord.__table__,
            UserBalance.__table__,
            BalanceLog.__table__,
            DividendJobLog.__table__,
            SystemConfig.__table__,
        ],
    )
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def _seed_rules(db) -> None:
    svip1 = VipFeeLevel(
        vip_type="SVIP",
        level_code="SVIP1",
        level_name="SVIP1",
        sort_order=1,
        is_enabled=True,
        spot_maker_fee=Decimal("0"),
        spot_taker_fee=Decimal("0"),
    )
    lp = VipFeeLevel(
        vip_type="SVIP",
        level_code="LP",
        level_name="LP",
        sort_order=9,
        is_enabled=True,
        spot_maker_fee=Decimal("0"),
        spot_taker_fee=Decimal("0"),
    )
    db.add_all([svip1, lp])
    db.flush()
    db.add_all(
        [
            VipFeeLevelCondition(
                vip_fee_level_id=int(svip1.id),
                min_lock_amount=Decimal("1000"),
                lock_period_days=365,
                user_limit=50000,
                dividend_rate=Decimal("0.05"),
            ),
            VipFeeLevelCondition(
                vip_fee_level_id=int(lp.id),
                min_lock_amount=Decimal("100000"),
                lock_period_days=1095,
                user_limit=1000,
                dividend_rate=Decimal("0.05"),
            ),
        ]
    )
    db.flush()


def _add_lock(
    db,
    *,
    user_id: int,
    amount: str,
    start_time: datetime,
    period_days: int = 1095,
) -> UserRcbLock:
    lock = UserRcbLock(
        user_id=user_id,
        asset_symbol="RCB",
        lock_amount=Decimal(amount),
        lock_period_days=period_days,
        start_time=start_time,
        end_time=start_time + timedelta(days=period_days),
        status="LOCKED",
        source="TEST",
        created_at=start_time,
        updated_at=start_time,
    )
    db.add(lock)
    db.flush()
    return lock


def test_snapshot_uses_end_of_dividend_day_and_is_immutable() -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        _seed_rules(db)
        dividend_date = datetime.utcnow().date() - timedelta(days=2)
        snapshot_at = get_dividend_eligibility_snapshot_at(dividend_date)
        included_lock = _add_lock(
            db,
            user_id=8,
            amount="100000",
            start_time=snapshot_at - timedelta(hours=12),
        )
        _add_lock(
            db,
            user_id=9,
            amount="100000",
            start_time=snapshot_at + timedelta(minutes=1),
        )

        snapshot, created = capture_dividend_eligibility_snapshot(
            db,
            dividend_date,
            now_utc=snapshot_at + timedelta(minutes=10),
        )
        assert created is True
        assert snapshot.snapshot_at == snapshot_at
        assert snapshot.eligible_user_count == 1
        first_items = db.query(DividendEligibilitySnapshotItem).all()
        assert [(item.user_id, item.level_code) for item in first_items] == [(8, "LP")]

        included_lock.status = "CANCELED"
        included_lock.updated_at = snapshot_at + timedelta(minutes=11)
        db.flush()
        same_snapshot, created_again = capture_dividend_eligibility_snapshot(
            db,
            dividend_date,
            now_utc=snapshot_at + timedelta(minutes=12),
        )
        assert created_again is False
        assert same_snapshot.id == snapshot.id
        assert [(item.user_id, item.level_code) for item in db.query(DividendEligibilitySnapshotItem).all()] == [
            (8, "LP")
        ]
    finally:
        db.close()


def test_calculation_reads_frozen_snapshot_instead_of_current_locks() -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        _seed_rules(db)
        dividend_date = datetime.utcnow().date() - timedelta(days=2)
        snapshot_at = get_dividend_eligibility_snapshot_at(dividend_date)
        original_lock = _add_lock(
            db,
            user_id=8,
            amount="100000",
            start_time=snapshot_at - timedelta(hours=12),
        )
        capture_dividend_eligibility_snapshot(
            db,
            dividend_date,
            now_utc=snapshot_at + timedelta(minutes=10),
        )

        original_lock.status = "CANCELED"
        _add_lock(
            db,
            user_id=9,
            amount="100000",
            start_time=snapshot_at - timedelta(hours=6),
        )
        pool = create_dividend_pool_skeleton(db, dividend_date, rcb_price=Decimal("2"))
        calculate_dividend_pool(db, int(pool.id))

        records = db.query(UserDividendRecord).order_by(UserDividendRecord.user_id).all()
        assert [(record.user_id, record.level_code) for record in records] == [(8, "LP")]
    finally:
        db.close()


def test_missing_historical_snapshot_blocks_pool_creation() -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        dividend_date = datetime.utcnow().date() - timedelta(days=2)
        with pytest.raises(ValueError, match="DIVIDEND_ELIGIBILITY_SNAPSHOT_MISSING"):
            create_dividend_pool_skeleton(db, dividend_date, rcb_price=Decimal("2"))
        with pytest.raises(ValueError, match="DIVIDEND_ELIGIBILITY_SNAPSHOT_MISSING"):
            require_dividend_eligibility_snapshot(db, dividend_date)
    finally:
        db.close()


def test_snapshot_capture_window_is_bounded() -> None:
    dividend_date = datetime.utcnow().date() - timedelta(days=2)
    snapshot_at = get_dividend_eligibility_snapshot_at(dividend_date)
    assert not is_dividend_eligibility_snapshot_capture_window(
        dividend_date,
        snapshot_at - timedelta(microseconds=1),
    )
    assert is_dividend_eligibility_snapshot_capture_window(dividend_date, snapshot_at)
    assert is_dividend_eligibility_snapshot_capture_window(
        dividend_date,
        snapshot_at + timedelta(minutes=14, seconds=59),
    )
    assert not is_dividend_eligibility_snapshot_capture_window(
        dividend_date,
        snapshot_at + timedelta(minutes=15),
    )


def test_dividend_run_time_keeps_a_snapshot_safety_gap() -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        with pytest.raises(ValueError, match="at least 5 minutes"):
            set_dividend_run_time(db, "00:04")
        config = set_dividend_run_time(db, "00:05")
        assert config.config_value == "00:05"
        run_config, snapshot_config = set_dividend_schedule(
            db,
            run_time_utc="01:10",
            rcb_price_snapshot_time_utc="01:00",
        )
        assert run_config.config_value == "01:10"
        assert snapshot_config.config_value == "01:00"
        run_config, snapshot_config = set_dividend_schedule(
            db,
            run_time_utc="00:10",
            rcb_price_snapshot_time_utc="00:00",
        )
        assert run_config.config_value == "00:10"
        assert snapshot_config.config_value == "00:00"
    finally:
        db.close()


def test_rcb_price_snapshot_uses_last_trade_at_or_before_boundary() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE trading_pairs (
                    id INTEGER PRIMARY KEY,
                    symbol VARCHAR(32) NOT NULL,
                    status INTEGER NOT NULL
                )
                """
            )
        )
        connection.execute(
            text(
                """
                CREATE TABLE trades (
                    id INTEGER PRIMARY KEY,
                    trading_pair_id INTEGER NOT NULL,
                    price NUMERIC(36, 18) NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )
        connection.execute(text("INSERT INTO trading_pairs VALUES (1, 'RCBUSDT', 1)"))
        connection.execute(
            text(
                """
                INSERT INTO trades (id, trading_pair_id, price, created_at) VALUES
                  (1, 1, 1.5, '2026-07-26 23:59:59'),
                  (2, 1, 2.0, '2026-07-27 00:00:00'),
                  (3, 1, 9.0, '2026-07-27 00:00:01')
                """
            )
        )

    db = sessionmaker(bind=engine, future=True)()
    try:
        price, trade_id, trade_time = get_rcb_price_snapshot_usdt(
            db,
            datetime(2026, 7, 27, 0, 0, 0),
        )
        assert price == Decimal("2.000000000000000000")
        assert trade_id == 2
        assert trade_time == datetime(2026, 7, 27, 0, 0, 0)
    finally:
        db.close()


def test_pool_persists_historical_price_snapshot_evidence(monkeypatch) -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        _seed_rules(db)
        dividend_date = datetime.utcnow().date() - timedelta(days=2)
        snapshot_at = get_dividend_eligibility_snapshot_at(dividend_date)
        _add_lock(
            db,
            user_id=8,
            amount="100000",
            start_time=snapshot_at - timedelta(hours=12),
        )
        capture_dividend_eligibility_snapshot(
            db,
            dividend_date,
            now_utc=snapshot_at + timedelta(minutes=10),
        )
        monkeypatch.setattr(
            dividend_service,
            "get_rcb_price_snapshot_usdt",
            lambda _db, requested_at: (
                Decimal("2.000000000000000000"),
                77,
                requested_at,
            ),
        )

        pool = create_dividend_pool_skeleton(db, dividend_date)
        assert pool.rcb_price_used == Decimal("2.000000000000000000")
        assert pool.rcb_price_snapshot_at == snapshot_at
        assert pool.rcb_price_source_trade_id == 77
        assert pool.rcb_price_source_trade_at == snapshot_at
    finally:
        db.close()


def test_operations_recovery_preview_is_read_only_and_fingerprinted(monkeypatch) -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        _seed_rules(db)
        dividend_date = datetime.utcnow().date() - timedelta(days=2)
        snapshot_at = get_dividend_eligibility_snapshot_at(dividend_date)
        _add_lock(
            db,
            user_id=8,
            amount="100000",
            start_time=snapshot_at - timedelta(hours=12),
        )
        monkeypatch.setattr(
            dividend_service,
            "get_rcb_price_snapshot_usdt",
            lambda _db, requested_at: (Decimal("2"), 91, requested_at),
        )
        monkeypatch.setattr(
            dividend_service,
            "calculate_total_fee_usdt",
            lambda _db, _date, _price: Decimal("100"),
        )

        preview = build_dividend_recovery_preview(db, dividend_date)

        assert preview["snapshot_source"] == "OPS_RECONSTRUCTED"
        assert preview["eligible_user_count"] == 1
        assert preview["total_credit_rcb"] == "2.500000000000000000"
        assert preview["users"] == [
            {
                "user_id": 8,
                "level_code": "LP",
                "qualified_lock_amount": "100000.000000000000000000",
                "dividend_usdt": "5.000000000000000000",
                "dividend_rcb": "2.500000000000000000",
            }
        ]
        assert len(preview["fingerprint"]) == 64
        assert db.query(DividendEligibilitySnapshot).count() == 0
        assert db.query(DividendPool).count() == 0
    finally:
        db.close()


def test_operations_can_recover_snapshot_outside_capture_window() -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        _seed_rules(db)
        dividend_date = datetime.utcnow().date() - timedelta(days=3)
        snapshot_at = get_dividend_eligibility_snapshot_at(dividend_date)
        _add_lock(
            db,
            user_id=8,
            amount="100000",
            start_time=snapshot_at - timedelta(hours=12),
        )

        snapshot, created = capture_dividend_eligibility_snapshot(
            db,
            dividend_date,
            now_utc=datetime.utcnow(),
            source="OPS_RECOVERY",
            created_by=77,
            allow_outside_window=True,
        )

        assert created is True
        assert snapshot.source == "OPS_RECOVERY"
        assert snapshot.created_by == 77
        item = db.query(DividendEligibilitySnapshotItem).one()
        assert item.user_id == 8
        assert item.level_code == "LP"
        assert item.dividend_rate == Decimal("0.05000000")
    finally:
        db.close()


def test_recovery_candidates_only_include_dates_without_pools() -> None:
    session_factory = _build_session_factory()
    db = session_factory()
    try:
        now = datetime(2026, 7, 28, 5, 0, 0)
        completed_date = now.date() - timedelta(days=2)
        db.add(
            DividendPool(
                dividend_date=completed_date,
                total_fee_usdt=Decimal("0"),
                rcb_price_used=Decimal("1"),
                total_dividend_usdt=Decimal("0"),
                total_dividend_rcb=Decimal("0"),
                status="PAID",
                source="AUTO",
                run_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        db.flush()

        candidates = list_dividend_recovery_candidates(
            db,
            now_utc=now,
            lookback_days=3,
        )

        assert [item["dividend_date"] for item in candidates] == [
            "2026-07-27",
            "2026-07-25",
        ]
    finally:
        db.close()


def test_operations_recovery_executes_20260721_preview_in_one_transaction(monkeypatch) -> None:
    session_factory = _build_session_factory()
    seed_db = session_factory()
    try:
        _seed_rules(seed_db)
        dividend_date = datetime(2026, 7, 21).date()
        snapshot_at = get_dividend_eligibility_snapshot_at(dividend_date)
        _add_lock(
            seed_db,
            user_id=8,
            amount="100000",
            start_time=snapshot_at - timedelta(hours=12),
        )
        seed_db.add_all(
            [
                UserBalance(
                    user_id=8,
                    coin_symbol="RCB",
                    chain_key="funding",
                    available_amount=Decimal("0"),
                    frozen_amount=Decimal("0"),
                    version=0,
                ),
                UserBalance(
                    user_id=99999999,
                    coin_symbol="RCB",
                    chain_key="funding",
                    available_amount=Decimal("100"),
                    frozen_amount=Decimal("0"),
                    version=0,
                ),
            ]
        )
        seed_db.commit()

        monkeypatch.setattr(
            dividend_service,
            "get_rcb_price_snapshot_usdt",
            lambda _db, requested_at: (Decimal("2"), 91, requested_at),
        )
        monkeypatch.setattr(
            dividend_service,
            "calculate_total_fee_usdt",
            lambda _db, _date, _price: Decimal("100"),
        )
        preview_db = session_factory()
        try:
            preview = build_dividend_recovery_preview(preview_db, dividend_date)
            assert preview["platform_balance_sufficient"] is True
            assert preview["can_execute"] is True
        finally:
            preview_db.close()

        monkeypatch.setattr(dividend_job, "SessionLocal", session_factory)
        monkeypatch.setattr(dividend_job, "_write_job_log", lambda **_kwargs: None)
        rejected = dividend_job.process_dividend_job_for_date(
            dividend_date,
            trigger_type="OPS_RECOVERY",
            recover_missing_snapshot=True,
            expected_preview_fingerprint="stale-preview",
            operator_id=77,
        )
        assert rejected["ok"] is False
        rejected_db = session_factory()
        try:
            assert rejected_db.query(DividendEligibilitySnapshot).count() == 0
            assert rejected_db.query(DividendPool).count() == 0
            assert rejected_db.query(UserDividendRecord).count() == 0
        finally:
            rejected_db.close()

        result = dividend_job.process_dividend_job_for_date(
            dividend_date,
            trigger_type="OPS_RECOVERY",
            recover_missing_snapshot=True,
            expected_preview_fingerprint=preview["fingerprint"],
            operator_id=77,
        )

        assert result["ok"] is True
        verify_db = session_factory()
        try:
            pool = verify_db.query(DividendPool).one()
            assert pool.status == "PAID"
            snapshot = verify_db.query(DividendEligibilitySnapshot).one()
            assert snapshot.source == "OPS_RECOVERY"
            assert snapshot.created_by == 77
            record = verify_db.query(UserDividendRecord).one()
            assert record.status == "PAID"
            assert record.dividend_rcb == Decimal("2.500000000000000000")
            user_balance = (
                verify_db.query(UserBalance)
                .filter(UserBalance.user_id == 8)
                .one()
            )
            platform_balance = (
                verify_db.query(UserBalance)
                .filter(UserBalance.user_id == 99999999)
                .one()
            )
            assert user_balance.available_amount == Decimal("2.500000000000000000")
            assert platform_balance.available_amount == Decimal("97.500000000000000000")
        finally:
            verify_db.close()
    finally:
        seed_db.close()
