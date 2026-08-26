from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models.reference_overlay import ReferenceOverlay
from app.db.models.rwa_reference_price import RwaReferencePrice
from app.jobs import rwa_reference_job
from app.services import reference_overlay_sync_service, rwa_reference_service
from app.services.reference_overlay_service import (
    get_reference_overlay_for_symbol,
    serialize_reference_overlay,
)


class _FakeHttpResponse:
    status_code = 401
    text = '{"error":"Unauthorized","message":"API key is invalid or has expired."}'

    def json(self):
        return {
            "error": "Unauthorized",
            "message": "API key is invalid or has expired.",
        }


def _db_session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    ReferenceOverlay.__table__.create(engine)
    RwaReferencePrice.__table__.create(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)()


def _overlay(**overrides):
    values = {
        "id": 1,
        "symbol": "MFCUSDT",
        "enabled": 1,
        "reference_type": "IRON",
        "kind": "IRON",
        "title": "铁粉参考价",
        "price_source": "AUTO",
        "auto_source": "IRON62",
        "last_ref_price": Decimal("0.108"),
        "last_ref_label": "108 USD/吨",
        "display_price": Decimal("0.108"),
        "display_value_label": "0.108 USD/公斤",
        "last_sync_at": datetime.utcnow() - timedelta(days=10),
        "price_time": datetime.utcnow() - timedelta(days=10),
        "sync_status": "SUCCESS",
        "market_status": "OPEN",
        "market_status_text": "实时",
        "is_realtime": True,
        "sort_order": 0,
    }
    values.update(overrides)
    return ReferenceOverlay(**values)


def test_live_reference_accepts_data_wrapped_provider_payload(monkeypatch):
    monkeypatch.setattr(
        rwa_reference_service,
        "_commodities_api_config",
        lambda: ("https://example.test/api", "test-key"),
    )
    monkeypatch.setattr(
        rwa_reference_service,
        "_request_latest_payload",
        lambda *_args, **_kwargs: {
            "data": {
                "success": True,
                "timestamp": 1_786_617_720,
                "rates": {"IRON62": 0.010516352928804},
            }
        },
    )

    result = rwa_reference_service._get_iron62_reference_price_live()

    assert result["iron62_usd_per_ton"] == "95.09"
    assert result["mfc_usdt_price"] == "0.09509"


def test_timeseries_accepts_data_wrapped_provider_payload():
    items = rwa_reference_service._parse_timeseries_items(
        {
            "data": {
                "success": True,
                "rates": {"2026-08-13": {"IRON62": 0.010516352928804}},
            }
        }
    )

    assert items == [{"time": 1786579200, "price": "95.09"}]


def test_unauthorized_latest_response_reports_expired_key(monkeypatch):
    monkeypatch.setattr(rwa_reference_service._session, "get", lambda *_args, **_kwargs: _FakeHttpResponse())

    try:
        rwa_reference_service._request_latest_payload("https://example.test/api", "expired-key", "IRON62")
    except rwa_reference_service.RwaReferenceAuthenticationError as exc:
        assert str(exc) == "commodities-api key is invalid or expired"
    else:
        raise AssertionError("401 response must not be reported as a missing IRON62 rate")


def test_failed_daily_record_retries_after_five_minutes(monkeypatch):
    db = _db_session()
    try:
        target_date = date(2026, 8, 13)
        db.add(
            RwaReferencePrice(
                id=1,
                source="COMMODITIES_API",
                symbol="IRON62",
                trade_date=target_date,
                fetched_at=datetime.utcnow() - timedelta(minutes=6),
                status="FAILED",
                error_message="rates.IRON62 is missing",
            )
        )
        db.commit()
        monkeypatch.setattr(
            rwa_reference_service,
            "_get_iron62_reference_price_live",
            lambda: {
                "iron62_usd_per_ton": "95.09",
                "mfc_usdt_price": "0.09509",
                "source_status": "live",
            },
        )

        result = rwa_reference_service.refresh_iron62_reference_price(db, trade_date=target_date)
        db.commit()
        refreshed = db.query(RwaReferencePrice).filter_by(id=1).one()

        assert result["success"] is True
        assert result["skipped"] is False
        assert refreshed.status == "SUCCESS"
        assert abs(refreshed.price_usd_per_ton - Decimal("95.09")) < Decimal("0.00000000000001")
        assert refreshed.error_message is None
    finally:
        rwa_reference_service._clear_daily_memory_cache()
        db.close()


def test_recent_failed_daily_record_waits_before_retry(monkeypatch):
    db = _db_session()
    try:
        target_date = date(2026, 8, 13)
        db.add(
            RwaReferencePrice(
                id=1,
                source="COMMODITIES_API",
                symbol="IRON62",
                trade_date=target_date,
                fetched_at=datetime.utcnow() - timedelta(minutes=4),
                status="FAILED",
                error_message="temporary upstream failure",
            )
        )
        db.commit()

        def _unexpected_fetch():
            raise AssertionError("recent failed record must not retry before the cooldown")

        monkeypatch.setattr(rwa_reference_service, "_get_iron62_reference_price_live", _unexpected_fetch)
        result = rwa_reference_service.refresh_iron62_reference_price(db, trade_date=target_date)

        assert result["success"] is False
        assert result["skipped"] is True
        assert result["reason"] == "already_fetched_today"
        assert result["error_message"] == "temporary upstream failure"
    finally:
        rwa_reference_service._clear_daily_memory_cache()
        db.close()


def test_public_reference_read_retries_an_expired_failure(monkeypatch):
    db = _db_session()
    try:
        target_date = rwa_reference_service._utc_today()
        db.add(
            RwaReferencePrice(
                id=1,
                source="COMMODITIES_API",
                symbol="IRON62",
                trade_date=target_date,
                fetched_at=datetime.utcnow() - timedelta(minutes=6),
                status="FAILED",
                error_message="rates.IRON62 is missing",
            )
        )
        db.commit()
        rwa_reference_service._clear_daily_memory_cache()
        monkeypatch.setattr(
            rwa_reference_service,
            "_get_iron62_reference_price_live",
            lambda: {
                "iron62_usd_per_ton": "95.09",
                "mfc_usdt_price": "0.09509",
                "source_status": "live",
            },
        )

        result = rwa_reference_service.get_iron62_reference_price(db)
        refreshed = db.query(RwaReferencePrice).filter_by(id=1).one()

        assert result["iron62_usd_per_ton"] == "95.09"
        assert result["mfc_usdt_price"] == "0.09509"
        assert result["source_status"] == "cached_today"
        assert refreshed.status == "SUCCESS"
        assert refreshed.error_message is None
    finally:
        rwa_reference_service._clear_daily_memory_cache()
        db.close()


def test_iron_overlay_sync_updates_the_server_authoritative_display(monkeypatch):
    db = _db_session()
    try:
        db.add(_overlay())
        db.commit()
        monkeypatch.setattr(
            reference_overlay_sync_service,
            "get_iron62_reference_price",
            lambda _db: {
                "iron62_usd_per_ton": "95.09",
                "mfc_usdt_price": "0.09509",
            },
        )

        result = reference_overlay_sync_service.sync_reference_overlay_once(db, "MFCUSDT")
        refreshed = db.query(ReferenceOverlay).filter_by(symbol="MFCUSDT").one()

        assert result["status"] == "success"
        assert abs(refreshed.last_ref_price - Decimal("0.09509")) < Decimal("0.000000000000001")
        assert refreshed.last_ref_label == "95.09 USD/吨"
        assert refreshed.sync_status == "SUCCESS"
        assert refreshed.market_status_text == "每日更新"
        assert refreshed.is_realtime is False
        assert refreshed.data_source == "COMMODITIES_API"
    finally:
        db.close()


def test_failed_refresh_keeps_last_price_but_marks_it_delayed():
    db = _db_session()
    try:
        db.add(_overlay())
        db.commit()
        pending_marker = ReferenceOverlay(
            id=2,
            symbol="MFC-PENDING",
            enabled=0,
            reference_type="IRON",
            kind="IRON",
            title="pending marker",
            price_source="MANUAL",
            sync_status="PENDING",
            market_status="UNKNOWN",
            is_realtime=False,
            sort_order=1,
        )
        db.add(pending_marker)

        result = reference_overlay_sync_service.mark_reference_overlay_sync_failed(
            db,
            "MFCUSDT",
            "rates.IRON62 is missing",
        )
        refreshed = db.query(ReferenceOverlay).filter_by(symbol="MFCUSDT").one()
        preserved_pending_write = db.query(ReferenceOverlay).filter_by(symbol="MFC-PENDING").one_or_none()
        payload = serialize_reference_overlay(refreshed)

        assert result["status"] == "failed"
        assert preserved_pending_write is not None
        assert abs(refreshed.last_ref_price - Decimal("0.108")) < Decimal("0.000000000000001")
        assert payload["stale"] is True
        assert payload["market_status"] == "UNKNOWN"
        assert payload["market_status_text"] == "数据延迟"
        assert payload["is_realtime"] is False
    finally:
        db.close()


def test_old_success_is_serialized_as_stale_instead_of_realtime():
    payload = serialize_reference_overlay(_overlay())

    assert payload["display_price"] == "0.108"
    assert payload["stale"] is True
    assert payload["market_status"] == "UNKNOWN"
    assert payload["is_realtime"] is False


def test_old_iron_overlay_self_refreshes_on_first_read(monkeypatch):
    db = _db_session()
    try:
        db.add(_overlay())
        db.commit()
        monkeypatch.setattr(
            reference_overlay_sync_service,
            "get_iron62_reference_price",
            lambda _db: {
                "iron62_usd_per_ton": "95.09",
                "mfc_usdt_price": "0.09509",
                "source_status": "cached_today",
            },
        )

        payload = get_reference_overlay_for_symbol(db, "MFCUSDT")

        assert payload["display_price"] == "0.09509"
        assert payload["stale"] is False
        assert payload["market_status_text"] == "每日更新"
        assert payload["is_realtime"] is False
    finally:
        db.close()


def test_iron_overlay_rejects_manual_fallback_as_a_success(monkeypatch):
    db = _db_session()
    try:
        db.add(_overlay(last_sync_at=None, sync_status="PENDING"))
        db.commit()
        monkeypatch.setattr(
            reference_overlay_sync_service,
            "get_iron62_reference_price",
            lambda _db: {
                "iron62_usd_per_ton": "108",
                "mfc_usdt_price": "0.108",
                "source_status": "manual_fallback",
            },
        )

        payload = get_reference_overlay_for_symbol(db, "MFCUSDT")

        assert payload["sync_status"] == "FAILED"
        assert payload["stale"] is True
        assert payload["is_realtime"] is False
        assert "manual_fallback" in str(payload["sync_error"])
    finally:
        db.close()


class _JobDb:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class _StopAfterFirstWait:
    def __init__(self):
        self.stopped = False

    def is_set(self):
        return self.stopped

    def wait(self, _timeout):
        self.stopped = True
        return True


def test_daily_worker_runs_one_catch_up_immediately(monkeypatch):
    calls = []
    monkeypatch.setattr(
        rwa_reference_job,
        "process_rwa_reference_job_once",
        lambda: calls.append("run") or {"success": True},
    )

    rwa_reference_job._run_worker(_StopAfterFirstWait())

    assert calls == ["run"]


def test_daily_job_syncs_overlay_after_a_successful_source_refresh(monkeypatch):
    db = _JobDb()
    monkeypatch.setattr(rwa_reference_job, "SessionLocal", lambda: db)
    monkeypatch.setattr(
        rwa_reference_job,
        "refresh_iron62_reference_price",
        lambda _db: {"success": True, "status": "SUCCESS"},
    )
    monkeypatch.setattr(
        rwa_reference_job,
        "sync_reference_overlay_once",
        lambda _db, symbol: {"status": "success", "symbol": symbol},
    )

    result = rwa_reference_job.process_rwa_reference_job_once()

    assert result["overlay_sync"] == {"status": "success", "symbol": "MFCUSDT"}
    assert db.commits == 1
    assert db.rollbacks == 0
    assert db.closed is True


def test_daily_job_marks_overlay_delayed_after_a_failed_source_refresh(monkeypatch):
    db = _JobDb()
    monkeypatch.setattr(rwa_reference_job, "SessionLocal", lambda: db)
    monkeypatch.setattr(
        rwa_reference_job,
        "refresh_iron62_reference_price",
        lambda _db: {
            "success": False,
            "status": "FAILED",
            "error_message": "rates.IRON62 is missing",
        },
    )
    monkeypatch.setattr(
        rwa_reference_job,
        "mark_reference_overlay_sync_failed",
        lambda _db, symbol, error: {
            "status": "failed",
            "symbol": symbol,
            "error": error,
        },
    )

    result = rwa_reference_job.process_rwa_reference_job_once()

    assert result["overlay_sync"] == {
        "status": "failed",
        "symbol": "MFCUSDT",
        "error": "rates.IRON62 is missing",
    }
    assert db.commits == 1
    assert db.rollbacks == 0
    assert db.closed is True
