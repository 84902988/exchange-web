from __future__ import annotations

import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.db.base import Base  # noqa: E402
from app.db.models.market_kline import MarketKline  # noqa: E402
from app.services import market_kline_cache  # noqa: E402
from app.services.spot_kline_bucket import (  # noqa: E402
    DAY_MS,
    HOUR_MS,
    is_okx_spot_1d_open_time,
    is_okx_spot_1M_open_time,
    is_okx_spot_1w_open_time,
    normalize_spot_kline_bucket_interval,
    okx_spot_open_time_validator,
    spot_kline_bucket_start_ms,
)


def _ms(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp() * 1000)


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[MarketKline.__table__])
    return sessionmaker(bind=engine)()


def _kline_row(
    row_id: int,
    open_time: int,
    *,
    updated_at: datetime,
    interval: str = "1d",
    symbol: str = "BTCUSDT",
) -> MarketKline:
    return MarketKline(
        id=row_id,
        market_type="spot",
        symbol=symbol,
        interval=interval,
        open_time=open_time,
        close_time=open_time + market_kline_cache.interval_ms(interval),
        open=Decimal("1"),
        high=Decimal("2"),
        low=Decimal("1"),
        close=Decimal("1.5"),
        volume=Decimal("5"),
        quote_volume=Decimal("7.5"),
        source="EXTERNAL_SPOT",
        is_closed=True,
        fetched_at=updated_at,
        created_at=updated_at,
        updated_at=updated_at,
    )


def _kline_payload(open_time: int, interval: str = "4h") -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + market_kline_cache.interval_ms(interval),
        "open": "1",
        "high": "2",
        "low": "1",
        "close": "1.5",
        "volume": "5",
        "quote_volume": "7.5",
    }


def _open_times(rows: list[dict]) -> list[int]:
    return [int(row["open_time"]) for row in rows]


def _install_history_boundary_cache(monkeypatch):
    stored: dict[str, dict] = {}
    writes: list[tuple[str, dict, int, int]] = []

    monkeypatch.setattr(
        market_kline_cache,
        "cache_get_json",
        lambda key: stored.get(key),
    )

    def cache_set_json(key, value, ttl_seconds, *, last_good_ttl_seconds):
        stored[key] = dict(value)
        writes.append((key, dict(value), ttl_seconds, last_good_ttl_seconds))

    monkeypatch.setattr(market_kline_cache, "cache_set_json", cache_set_json)
    return stored, writes


class _DbOrig:
    def __init__(self, *args) -> None:
        self.args = args


class _FakeUpsertDb:
    def __init__(self, execute_errors: list[Exception]) -> None:
        self.execute_errors = list(execute_errors)
        self.execute_calls = 0
        self.commit_calls = 0
        self.rollback_calls = 0

    def execute(self, stmt) -> None:
        self.execute_calls += 1
        if self.execute_errors:
            raise self.execute_errors.pop(0)

    def commit(self) -> None:
        self.commit_calls += 1

    def rollback(self) -> None:
        self.rollback_calls += 1


class _CaptureLogger:
    def __init__(self) -> None:
        self.warning_calls: list[tuple[str, tuple]] = []
        self.debug_calls: list[tuple[str, tuple]] = []

    def warning(self, message: str, *args, **kwargs) -> None:
        self.warning_calls.append((message, args))

    def debug(self, message: str, *args, **kwargs) -> None:
        self.debug_calls.append((message, args))


def _upsert_operational_error(code: int, message: str) -> OperationalError:
    return OperationalError(
        "INSERT INTO market_klines " + ("x" * 1000),
        {"rows": ["p" * 1000]},
        _DbOrig(code, message),
    )


def test_okx_spot_1d_bucket_uses_utc_plus_8_anchor() -> None:
    samples = [
        (_ms(2026, 2, 5, 0, 30), _ms(2026, 2, 4, 16)),
        (_ms(2026, 2, 5, 12, 34), _ms(2026, 2, 4, 16)),
        (_ms(2026, 2, 5, 23, 59), _ms(2026, 2, 5, 16)),
    ]

    for trade_ts_ms, expected_open_time in samples:
        open_time = spot_kline_bucket_start_ms(trade_ts_ms, "1d", provider="OKX_SPOT")
        assert open_time == expected_open_time
        assert is_okx_spot_1d_open_time(open_time)
        assert open_time % DAY_MS == 16 * HOUR_MS

    assert not is_okx_spot_1d_open_time(_ms(2026, 2, 5, 0))


def test_spot_kline_interval_normalization_preserves_month_case() -> None:
    assert normalize_spot_kline_bucket_interval("1W") == "1w"
    assert normalize_spot_kline_bucket_interval("1w") == "1w"
    assert normalize_spot_kline_bucket_interval("1M") == "1M"
    assert normalize_spot_kline_bucket_interval("1m") == "1m"

    assert market_kline_cache.normalize_kline_interval("1W") == "1w"
    assert market_kline_cache.normalize_kline_interval("1M") == "1M"
    assert market_kline_cache.normalize_kline_interval("1m") == "1m"


def test_market_kline_upsert_retries_deadlock_once_then_succeeds() -> None:
    db = _FakeUpsertDb([_upsert_operational_error(1213, "Deadlock found when trying to get lock")])
    logger = _CaptureLogger()
    sleeps: list[float] = []

    original_logger = market_kline_cache.logger
    original_record_error = market_kline_cache.record_error
    original_sleep = market_kline_cache.time.sleep
    try:
        market_kline_cache.logger = logger
        market_kline_cache.record_error = lambda *args, **kwargs: None
        market_kline_cache.time.sleep = lambda seconds: sleeps.append(seconds)

        result = market_kline_cache.upsert_klines(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
            items=[_kline_payload(_ms(2026, 2, 5, 12), "1m")],
            source="EXTERNAL_SPOT",
        )

        assert result == 1
        assert db.execute_calls == 2
        assert db.rollback_calls == 1
        assert db.commit_calls == 1
        assert sleeps == [0.05]
        assert logger.warning_calls == []
        assert len(logger.debug_calls) == 1
        assert logger.debug_calls[0][0].startswith("market_klines_upsert_retry_succeeded")
    finally:
        market_kline_cache.logger = original_logger
        market_kline_cache.record_error = original_record_error
        market_kline_cache.time.sleep = original_sleep


def test_market_kline_upsert_deadlock_exhaustion_logs_short_warning() -> None:
    db = _FakeUpsertDb([
        _upsert_operational_error(1213, "Deadlock found when trying to get lock"),
        _upsert_operational_error(1213, "Deadlock found when trying to get lock"),
        _upsert_operational_error(1213, "Deadlock found when trying to get lock"),
        _upsert_operational_error(1213, "Deadlock found when trying to get lock"),
    ])
    logger = _CaptureLogger()
    sleeps: list[float] = []

    original_logger = market_kline_cache.logger
    original_record_error = market_kline_cache.record_error
    original_sleep = market_kline_cache.time.sleep
    try:
        market_kline_cache.logger = logger
        market_kline_cache.record_error = lambda *args, **kwargs: None
        market_kline_cache.time.sleep = lambda seconds: sleeps.append(seconds)

        result = market_kline_cache.upsert_klines(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
            items=[_kline_payload(_ms(2026, 2, 5, 12), "1m")],
            source="EXTERNAL_SPOT",
        )

        assert result == 0
        assert db.execute_calls == 4
        assert db.rollback_calls == 4
        assert db.commit_calls == 0
        assert sleeps == [0.05, 0.15, 0.3]
        assert len(logger.warning_calls) == 1
        message, args = logger.warning_calls[0]
        assert message.startswith("market_klines_upsert_failed")
        assert "deadlock" in [str(arg) for arg in args]
        assert "3" in [str(arg) for arg in args]
        assert "INSERT INTO" not in (message + " " + " ".join(str(arg) for arg in args))
    finally:
        market_kline_cache.logger = original_logger
        market_kline_cache.record_error = original_record_error
        market_kline_cache.time.sleep = original_sleep


def test_market_kline_upsert_non_deadlock_error_logs_short_reason() -> None:
    db = _FakeUpsertDb([_upsert_operational_error(1205, "Lock wait timeout exceeded")])
    logger = _CaptureLogger()
    sleeps: list[float] = []

    original_logger = market_kline_cache.logger
    original_record_error = market_kline_cache.record_error
    original_sleep = market_kline_cache.time.sleep
    try:
        market_kline_cache.logger = logger
        market_kline_cache.record_error = lambda *args, **kwargs: None
        market_kline_cache.time.sleep = lambda seconds: sleeps.append(seconds)

        result = market_kline_cache.upsert_klines(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
            items=[_kline_payload(_ms(2026, 2, 5, 12), "1m")],
            source="EXTERNAL_SPOT",
        )

        assert result == 0
        assert db.execute_calls == 1
        assert db.rollback_calls == 1
        assert db.commit_calls == 0
        assert sleeps == []
        assert len(logger.warning_calls) == 1
        message, args = logger.warning_calls[0]
        rendered = message + " " + " ".join(str(arg) for arg in args)
        assert "OperationalError:1205" in rendered
        assert "INSERT INTO" not in rendered
        assert "p" * 100 not in rendered
    finally:
        market_kline_cache.logger = original_logger
        market_kline_cache.record_error = original_record_error
        market_kline_cache.time.sleep = original_sleep


def test_okx_spot_1w_bucket_uses_utc_plus_8_week_anchor() -> None:
    samples = [
        (_ms(2026, 2, 3, 12), _ms(2026, 2, 1, 16)),
        (_ms(2026, 2, 8, 15, 59), _ms(2026, 2, 1, 16)),
        (_ms(2026, 2, 8, 16), _ms(2026, 2, 8, 16)),
    ]

    for trade_ts_ms, expected_open_time in samples:
        open_time = spot_kline_bucket_start_ms(trade_ts_ms, "1w", provider="OKX_SPOT")
        assert open_time == expected_open_time
        assert is_okx_spot_1w_open_time(open_time)
        assert open_time % DAY_MS == 16 * HOUR_MS

    assert not is_okx_spot_1w_open_time(_ms(2026, 2, 2, 0))


def test_okx_spot_1M_bucket_uses_utc_plus_8_month_anchor() -> None:
    samples = [
        (_ms(2026, 2, 5, 12), _ms(2026, 1, 31, 16)),
        (_ms(2026, 2, 28, 15, 59), _ms(2026, 1, 31, 16)),
        (_ms(2026, 2, 28, 16), _ms(2026, 2, 28, 16)),
    ]

    for trade_ts_ms, expected_open_time in samples:
        open_time = spot_kline_bucket_start_ms(trade_ts_ms, "1M", provider="OKX_SPOT")
        assert open_time == expected_open_time
        assert is_okx_spot_1M_open_time(open_time)
        assert open_time % DAY_MS == 16 * HOUR_MS

    assert not is_okx_spot_1M_open_time(_ms(2026, 2, 1, 0))


def test_intraday_bucket_floor_is_unchanged_for_okx_spot() -> None:
    trade_ts_ms = _ms(2026, 2, 5, 12, 34)

    assert spot_kline_bucket_start_ms(trade_ts_ms, "1h", provider="OKX_SPOT") == (
        trade_ts_ms // HOUR_MS
    ) * HOUR_MS
    assert spot_kline_bucket_start_ms(trade_ts_ms, "4h", provider="OKX_SPOT") == (
        trade_ts_ms // (4 * HOUR_MS)
    ) * (4 * HOUR_MS)


def test_market_kline_cache_filters_mixed_okx_spot_1d_rows() -> None:
    db = _session()
    now = datetime.utcnow()
    valid_1 = _ms(2026, 2, 3, 16)
    invalid_1 = _ms(2026, 2, 4, 0)
    valid_2 = _ms(2026, 2, 4, 16)
    invalid_2 = _ms(2026, 2, 5, 0)
    db.add_all(
        [
            _kline_row(1, valid_1, updated_at=now),
            _kline_row(2, invalid_1, updated_at=now),
            _kline_row(3, valid_2, updated_at=now),
            _kline_row(4, invalid_2, updated_at=now),
        ]
    )
    db.commit()

    rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="BTCUSDT",
        interval="1d",
        limit=2,
        source="EXTERNAL_SPOT",
        fetch_external=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fresh valid cache should avoid external fetch")
        ),
        open_time_validator=is_okx_spot_1d_open_time,
    )

    assert [row["open_time"] for row in rows] == [valid_1, valid_2]
    assert all(is_okx_spot_1d_open_time(row["open_time"]) for row in rows)
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT


def test_market_kline_cache_filters_mixed_okx_spot_weekly_and_monthly_rows() -> None:
    db = _session()
    now = datetime.utcnow()
    valid_week_1 = _ms(2026, 2, 1, 16)
    valid_week_2 = _ms(2026, 2, 8, 16)
    invalid_week = _ms(2026, 2, 9, 0)
    valid_month_1 = _ms(2026, 1, 31, 16)
    valid_month_2 = _ms(2026, 2, 28, 16)
    invalid_month = _ms(2026, 2, 1, 0)
    db.add_all(
        [
            _kline_row(10, valid_week_1, updated_at=now, interval="1w"),
            _kline_row(11, invalid_week, updated_at=now, interval="1w"),
            _kline_row(12, valid_week_2, updated_at=now, interval="1w"),
            _kline_row(20, valid_month_1, updated_at=now, interval="1M"),
            _kline_row(21, invalid_month, updated_at=now, interval="1M"),
            _kline_row(22, valid_month_2, updated_at=now, interval="1M"),
        ]
    )
    db.commit()

    weekly_rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="BTCUSDT",
        interval="1w",
        limit=2,
        source="EXTERNAL_SPOT",
        fetch_external=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fresh valid weekly cache should avoid external fetch")
        ),
        open_time_validator=okx_spot_open_time_validator("1w"),
    )
    monthly_rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="BTCUSDT",
        interval="1M",
        limit=2,
        source="EXTERNAL_SPOT",
        fetch_external=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fresh valid monthly cache should avoid external fetch")
        ),
        open_time_validator=okx_spot_open_time_validator("1M"),
    )

    assert [row["open_time"] for row in weekly_rows] == [valid_week_1, valid_week_2]
    assert all(is_okx_spot_1w_open_time(row["open_time"]) for row in weekly_rows)
    assert [row["open_time"] for row in monthly_rows] == [valid_month_1, valid_month_2]
    assert all(is_okx_spot_1M_open_time(row["open_time"]) for row in monthly_rows)
    assert weekly_rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert weekly_rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT
    assert monthly_rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert monthly_rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT


def test_market_kline_cache_falls_back_when_filter_leaves_too_few_rows() -> None:
    db = _session()
    now = datetime.utcnow()
    valid_1 = _ms(2026, 2, 3, 16)
    valid_2 = _ms(2026, 2, 4, 16)
    invalid_1 = _ms(2026, 2, 4, 0)
    db.add_all(
        [
            _kline_row(1, valid_1, updated_at=now),
            _kline_row(2, invalid_1, updated_at=now),
        ]
    )
    db.commit()

    original_upsert = market_kline_cache.upsert_klines
    fetch_calls: list[tuple[int, int | None]] = []

    def fetch_external(limit: int, end_time_ms: int | None):
        fetch_calls.append((limit, end_time_ms))
        return [
            {
                "open_time": valid_1,
                "close_time": valid_1 + DAY_MS,
                "open": "1",
                "high": "2",
                "low": "1",
                "close": "1.5",
                "volume": "5",
                "quote_volume": "7.5",
            },
            {
                "open_time": valid_2,
                "close_time": valid_2 + DAY_MS,
                "open": "2",
                "high": "3",
                "low": "2",
                "close": "2.5",
                "volume": "6",
                "quote_volume": "15",
            },
        ]

    try:
        market_kline_cache.upsert_klines = lambda *args, **kwargs: 0
        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval="1d",
            limit=2,
            source="EXTERNAL_SPOT",
            fetch_external=fetch_external,
            open_time_validator=is_okx_spot_1d_open_time,
        )
    finally:
        market_kline_cache.upsert_klines = original_upsert

    assert fetch_calls == [(2, None)]
    assert [row["open_time"] for row in rows] == [valid_1, valid_2]
    assert all(is_okx_spot_1d_open_time(row["open_time"]) for row in rows)
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_SHORT
    assert rows.history_incomplete is False


def test_market_kline_cache_filters_external_rows_after_history_end_time() -> None:
    db = _session()
    end_time_ms = _ms(2020, 1, 1, 0)
    current_open_time = _ms(2026, 5, 31, 16)
    fetch_calls: list[tuple[int, int | None]] = []

    original_upsert = market_kline_cache.upsert_klines

    def fetch_external(limit: int, fetch_end_time_ms: int | None):
        fetch_calls.append((limit, fetch_end_time_ms))
        return [
            {
                "open_time": current_open_time,
                "close_time": current_open_time + market_kline_cache.interval_ms("1M"),
                "open": "60000",
                "high": "70000",
                "low": "50000",
                "close": "65000",
                "volume": "10",
                "quote_volume": "650000",
            }
        ]

    try:
        market_kline_cache.upsert_klines = lambda *args, **kwargs: 0
        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval="1M",
            limit=100,
            source="EXTERNAL_SPOT",
            fetch_external=fetch_external,
            end_time_ms=end_time_ms,
            open_time_validator=okx_spot_open_time_validator("1M"),
        )
    finally:
        market_kline_cache.upsert_klines = original_upsert

    assert fetch_calls == [(100, end_time_ms)]
    assert rows == []
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_EMPTY
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_PROVIDER_EMPTY
    assert rows.provider_error_code == market_kline_cache.KLINE_PROVIDER_ERROR_EMPTY
    assert rows.history_incomplete is True


def test_market_kline_cache_gap_falls_back_for_fixed_interval_history() -> None:
    db = _session()
    now = datetime.utcnow()
    interval = "4h"
    end_time_ms = _ms(2026, 4, 15, 0)
    cached_times = [
        _ms(2026, 2, 21, 8),
        _ms(2026, 2, 21, 12),
        _ms(2026, 4, 14, 0),
        _ms(2026, 4, 14, 4),
    ]
    provider_times = [
        _ms(2026, 4, 13, 16),
        _ms(2026, 4, 13, 20),
        _ms(2026, 4, 14, 0),
        _ms(2026, 4, 14, 4),
    ]
    db.add_all(
        [
            _kline_row(index + 1, open_time, updated_at=now, interval=interval, symbol="ETHUSDT")
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()

    original_upsert = market_kline_cache.upsert_klines
    fetch_calls: list[tuple[int, int | None]] = []

    def fetch_external(limit: int, fetch_end_time_ms: int | None):
        fetch_calls.append((limit, fetch_end_time_ms))
        return [_kline_payload(open_time, interval) for open_time in provider_times]

    try:
        market_kline_cache.upsert_klines = lambda *args, **kwargs: 0
        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="ETHUSDT",
            interval=interval,
            limit=4,
            source="EXTERNAL_SPOT",
            fetch_external=fetch_external,
            end_time_ms=end_time_ms,
        )
    finally:
        market_kline_cache.upsert_klines = original_upsert

    assert fetch_calls == [(4, end_time_ms)]
    assert _open_times(rows) == provider_times
    assert market_kline_cache._validate_cached_klines_continuity(rows, interval)
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_CONTINUITY_INVALID
    assert rows.history_incomplete is False


def test_market_kline_cache_current_gap_falls_back_for_fixed_interval() -> None:
    db = _session()
    now = datetime.utcnow()
    interval = "4h"
    cached_times = [
        _ms(2026, 6, 1, 0),
        _ms(2026, 6, 1, 4),
        _ms(2026, 6, 3, 0),
        _ms(2026, 6, 3, 4),
    ]
    provider_times = [
        _ms(2026, 6, 2, 16),
        _ms(2026, 6, 2, 20),
        _ms(2026, 6, 3, 0),
        _ms(2026, 6, 3, 4),
    ]
    db.add_all(
        [
            _kline_row(index + 20, open_time, updated_at=now, interval=interval)
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()

    original_upsert = market_kline_cache.upsert_klines
    fetch_calls: list[tuple[int, int | None]] = []

    def fetch_external(limit: int, fetch_end_time_ms: int | None):
        fetch_calls.append((limit, fetch_end_time_ms))
        return [_kline_payload(open_time, interval) for open_time in provider_times]

    try:
        market_kline_cache.upsert_klines = lambda *args, **kwargs: 0
        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval=interval,
            limit=4,
            source="EXTERNAL_SPOT",
            fetch_external=fetch_external,
        )
    finally:
        market_kline_cache.upsert_klines = original_upsert

    assert fetch_calls == [(4, None)]
    assert _open_times(rows) == provider_times
    assert market_kline_cache._validate_cached_klines_continuity(rows, interval)
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_CONTINUITY_INVALID


def test_market_kline_cache_continuous_fixed_interval_db_hit() -> None:
    db = _session()
    now = datetime.utcnow()
    interval = "4h"
    cached_times = [
        _ms(2026, 6, 1, 0),
        _ms(2026, 6, 1, 4),
        _ms(2026, 6, 1, 8),
        _ms(2026, 6, 1, 12),
    ]
    db.add_all(
        [
            _kline_row(index + 40, open_time, updated_at=now, interval=interval)
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()

    rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="BTCUSDT",
        interval=interval,
        limit=4,
        source="EXTERNAL_SPOT",
        fetch_external=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("continuous fresh cache should avoid external fetch")
        ),
    )

    assert _open_times(rows) == cached_times
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT


def test_market_kline_cache_history_cursor_coverage_invalid_falls_back() -> None:
    db = _session()
    now = datetime.utcnow()
    interval = "1h"
    end_time_ms = _ms(2026, 3, 10, 0)
    cached_times = [
        _ms(2025, 6, 2, 4),
        _ms(2025, 6, 2, 5),
        _ms(2025, 6, 2, 6),
        _ms(2025, 6, 2, 7),
    ]
    provider_times = [
        _ms(2026, 3, 9, 20),
        _ms(2026, 3, 9, 21),
        _ms(2026, 3, 9, 22),
        _ms(2026, 3, 9, 23),
    ]
    db.add_all(
        [
            _kline_row(index + 50, open_time, updated_at=now, interval=interval)
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()
    fetch_calls: list[tuple[int, int | None]] = []

    def fetch_external(limit: int, cursor_end_time_ms: int | None):
        fetch_calls.append((limit, cursor_end_time_ms))
        return [_kline_payload(open_time, interval) for open_time in provider_times]

    original_upsert = market_kline_cache.upsert_klines
    try:
        market_kline_cache.upsert_klines = lambda *args, **kwargs: 0
        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval=interval,
            limit=4,
            source="EXTERNAL_SPOT",
            fetch_external=fetch_external,
            end_time_ms=end_time_ms,
        )
    finally:
        market_kline_cache.upsert_klines = original_upsert

    assert fetch_calls == [(4, end_time_ms)]
    assert _open_times(rows) == provider_times
    assert market_kline_cache._validate_cached_klines_continuity(rows, interval)
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_COVERAGE_INVALID


def test_market_kline_cache_duplicate_open_time_falls_back() -> None:
    interval = "4h"
    duplicate_time = _ms(2026, 5, 1, 0)
    duplicate_rows = [
        _kline_payload(duplicate_time, interval),
        _kline_payload(duplicate_time, interval),
        _kline_payload(duplicate_time + 4 * HOUR_MS, interval),
    ]
    provider_times = [
        _ms(2026, 5, 1, 0),
        _ms(2026, 5, 1, 4),
        _ms(2026, 5, 1, 8),
    ]
    provider_rows = [_kline_payload(open_time, interval) for open_time in provider_times]
    fetch_calls: list[tuple[int, int | None]] = []

    original_read = market_kline_cache._read_cached_klines
    original_upsert = market_kline_cache.upsert_klines
    read_calls = 0

    def read_cached(*_args, **_kwargs):
        nonlocal read_calls
        read_calls += 1
        if read_calls == 1:
            return list(duplicate_rows)
        return list(provider_rows)

    def fetch_external(limit: int, fetch_end_time_ms: int | None):
        fetch_calls.append((limit, fetch_end_time_ms))
        return list(provider_rows)

    try:
        market_kline_cache._read_cached_klines = read_cached
        market_kline_cache.upsert_klines = lambda *args, **kwargs: 0
        rows = market_kline_cache.get_klines_cache_first(
            object(),
            market_type="spot",
            symbol="ETHUSDT",
            interval=interval,
            limit=3,
            source="EXTERNAL_SPOT",
            fetch_external=fetch_external,
            end_time_ms=_ms(2026, 5, 2, 0),
        )
    finally:
        market_kline_cache._read_cached_klines = original_read
        market_kline_cache.upsert_klines = original_upsert

    assert fetch_calls == [(3, _ms(2026, 5, 2, 0))]
    assert _open_times(rows) == provider_times
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_CONTINUITY_INVALID


def test_market_kline_cache_monthly_continuity_accepts_calendar_months_and_cross_year() -> None:
    for start_id, cached_times, end_time_ms in [
        (
            100,
            [_ms(2026, 1, 1, 0), _ms(2026, 2, 1, 0), _ms(2026, 3, 1, 0)],
            _ms(2026, 4, 1, 0),
        ),
        (
            200,
            [_ms(2026, 12, 1, 0), _ms(2027, 1, 1, 0)],
            _ms(2027, 2, 1, 0),
        ),
    ]:
        db = _session()
        now = datetime.utcnow()
        db.add_all(
            [
                _kline_row(start_id + index, open_time, updated_at=now, interval="1Mutc")
                for index, open_time in enumerate(cached_times)
            ]
        )
        db.commit()

        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval="1Mutc",
            limit=len(cached_times),
            source="EXTERNAL_SPOT",
            fetch_external=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("continuous monthly cache should avoid external fetch")
            ),
            end_time_ms=end_time_ms,
        )

        assert _open_times(rows) == cached_times
        assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
        assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT
        assert rows.history_terminal is False


def test_market_kline_cache_monthly_provider_boundary_requires_continuous_cached_history(monkeypatch) -> None:
    stored, writes = _install_history_boundary_cache(monkeypatch)
    db = _session()
    now = datetime.utcnow()
    cached_times = [
        _ms(2018, 1, 1, 0),
        _ms(2018, 2, 1, 0),
        _ms(2018, 3, 1, 0),
    ]
    db.add_all(
        [
            _kline_row(index + 250, open_time, updated_at=now, interval="1Mutc")
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()

    fetch_calls = 0

    def fetch_external(_limit: int, _fetch_end_time_ms: int | None):
        nonlocal fetch_calls
        fetch_calls += 1
        raise market_kline_cache.KlineProviderHistoryBoundary(
            "provider monthly history boundary",
            provider_error_provider="OKX_SPOT",
        )

    rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="BTCUSDT",
        interval="1Mutc",
        limit=60,
        source="EXTERNAL_SPOT",
        fetch_external=fetch_external,
        end_time_ms=cached_times[0],
    )

    assert rows == []
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_EMPTY
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HISTORY_BOUNDARY
    assert rows.history_incomplete is False
    assert rows.history_terminal is True
    assert rows.terminal_reason == market_kline_cache.KLINE_TERMINAL_REASON_PROVIDER_HISTORY_BOUNDARY
    assert rows.earliest_available_time == cached_times[0]
    assert rows.provider_error_code is None
    assert fetch_calls == 1
    assert len(stored) == 1
    assert len(writes) == 1
    _, payload, ttl_seconds, last_good_ttl_seconds = writes[0]
    assert payload == {
        "symbol": "BTCUSDT",
        "interval": "1Mutc",
        "earliest_available_time": cached_times[0],
        "terminal_reason": market_kline_cache.KLINE_TERMINAL_REASON_PROVIDER_HISTORY_BOUNDARY,
    }
    assert ttl_seconds == 24 * 60 * 60
    assert last_good_ttl_seconds == 24 * 60 * 60


def test_market_kline_cache_monthly_known_boundary_short_circuits_provider(monkeypatch) -> None:
    stored, _writes = _install_history_boundary_cache(monkeypatch)
    earliest_available_time = _ms(2018, 1, 1, 0)
    key = market_kline_cache._kline_history_boundary_cache_key(
        market_type="spot",
        symbol="BTCUSDT",
        interval="1Mutc",
    )
    stored[key] = {
        "symbol": "BTCUSDT",
        "interval": "1Mutc",
        "earliest_available_time": earliest_available_time,
        "terminal_reason": market_kline_cache.KLINE_TERMINAL_REASON_PROVIDER_HISTORY_BOUNDARY,
    }
    provider_calls = 0

    def fetch_external(_limit: int, _fetch_end_time_ms: int | None):
        nonlocal provider_calls
        provider_calls += 1
        raise AssertionError("known boundary must not call provider")

    rows = market_kline_cache.get_klines_cache_first(
        _session(),
        market_type="spot",
        symbol="BTCUSDT",
        interval="1Mutc",
        limit=227,
        source="EXTERNAL_SPOT",
        fetch_external=fetch_external,
        end_time_ms=_ms(1999, 2, 1, 0),
    )

    assert provider_calls == 0
    assert rows == []
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HISTORY_BOUNDARY
    assert rows.history_terminal is True
    assert rows.history_incomplete is False
    assert rows.terminal_reason == market_kline_cache.KLINE_TERMINAL_REASON_CACHE_HISTORY_BOUNDARY
    assert rows.earliest_available_time == earliest_available_time


def test_market_kline_cache_monthly_provider_cooldown_yields_to_concurrent_boundary(monkeypatch) -> None:
    earliest_available_time = _ms(2018, 1, 1, 0)
    boundary = {
        "symbol": "BTCUSDT",
        "interval": "1Mutc",
        "earliest_available_time": earliest_available_time,
        "terminal_reason": market_kline_cache.KLINE_TERMINAL_REASON_PROVIDER_HISTORY_BOUNDARY,
    }
    boundary_reads = 0

    def read_boundary(**_kwargs):
        nonlocal boundary_reads
        boundary_reads += 1
        return None if boundary_reads == 1 else boundary

    monkeypatch.setattr(market_kline_cache, "_read_kline_history_boundary_cache", read_boundary)
    provider_calls = 0

    def fetch_external(_limit: int, _fetch_end_time_ms: int | None):
        nonlocal provider_calls
        provider_calls += 1
        raise market_kline_cache.KlineProviderFetchError(
            "provider cooldown",
            provider_error_code=market_kline_cache.KLINE_PROVIDER_ERROR_COOLDOWN,
            provider_error_provider="OKX_SPOT",
        )

    rows = market_kline_cache.get_klines_cache_first(
        _session(),
        market_type="spot",
        symbol="BTCUSDT",
        interval="1Mutc",
        limit=227,
        source="EXTERNAL_SPOT",
        fetch_external=fetch_external,
        end_time_ms=_ms(1999, 2, 1, 0),
    )

    assert provider_calls == 1
    assert boundary_reads == 2
    assert rows == []
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HISTORY_BOUNDARY
    assert rows.history_terminal is True
    assert rows.history_incomplete is False
    assert rows.provider_error_code is None
    assert rows.terminal_reason == market_kline_cache.KLINE_TERMINAL_REASON_CACHE_HISTORY_BOUNDARY
    assert rows.earliest_available_time == earliest_available_time


def test_market_kline_cache_monthly_provider_boundary_rejects_gapped_cache_evidence(monkeypatch) -> None:
    _install_history_boundary_cache(monkeypatch)
    db = _session()
    now = datetime.utcnow()
    cached_times = [_ms(2018, 1, 1, 0), _ms(2018, 3, 1, 0)]
    db.add_all(
        [
            _kline_row(index + 275, open_time, updated_at=now, interval="1Mutc")
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()

    rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="BTCUSDT",
        interval="1Mutc",
        limit=60,
        source="EXTERNAL_SPOT",
        fetch_external=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            market_kline_cache.KlineProviderHistoryBoundary(
                "provider monthly history boundary",
                provider_error_provider="OKX_SPOT",
            )
        ),
        end_time_ms=cached_times[0],
    )

    assert rows == []
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_PROVIDER_EMPTY
    assert rows.history_incomplete is True
    assert rows.history_terminal is False
    assert rows.terminal_reason is None
    assert rows.earliest_available_time is None


def test_market_kline_cache_daily_and_weekly_empty_history_remain_non_terminal() -> None:
    for interval in ("1Dutc", "1Wutc"):
        db = _session()
        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval=interval,
            limit=60,
            source="EXTERNAL_SPOT",
            fetch_external=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                market_kline_cache.KlineProviderHistoryBoundary(
                    "provider history boundary candidate",
                    provider_error_provider="OKX_SPOT",
                )
            ),
            end_time_ms=_ms(2018, 1, 1, 0),
        )

        assert rows == []
        assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_PROVIDER_EMPTY
        assert rows.history_incomplete is True
        assert rows.history_terminal is False


def test_market_kline_cache_monthly_gap_falls_back() -> None:
    db = _session()
    now = datetime.utcnow()
    cached_times = [_ms(2026, 1, 1, 0), _ms(2026, 3, 1, 0)]
    provider_times = [_ms(2026, 2, 1, 0), _ms(2026, 3, 1, 0)]
    end_time_ms = _ms(2026, 4, 1, 0)
    db.add_all(
        [
            _kline_row(index + 300, open_time, updated_at=now, interval="1Mutc")
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()

    original_upsert = market_kline_cache.upsert_klines
    fetch_calls: list[tuple[int, int | None]] = []

    def fetch_external(limit: int, fetch_end_time_ms: int | None):
        fetch_calls.append((limit, fetch_end_time_ms))
        return [_kline_payload(open_time, "1Mutc") for open_time in provider_times]

    try:
        market_kline_cache.upsert_klines = lambda *args, **kwargs: 0
        rows = market_kline_cache.get_klines_cache_first(
            db,
            market_type="spot",
            symbol="BTCUSDT",
            interval="1Mutc",
            limit=2,
            source="EXTERNAL_SPOT",
            fetch_external=fetch_external,
            end_time_ms=end_time_ms,
        )
    finally:
        market_kline_cache.upsert_klines = original_upsert

    assert fetch_calls == [(2, end_time_ms)]
    assert _open_times(rows) == provider_times
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_CONTINUITY_INVALID


def test_market_kline_cache_provider_error_returns_stale_short_history_metadata() -> None:
    db = _session()
    now = datetime.utcnow()
    interval = "4h"
    # Keep the short cache anchored to the requested history cursor. Older
    # rows that do not reach the cursor are correctly rejected as a coverage
    # gap and therefore cannot exercise the stale-short-cache fallback.
    cached_times = [_ms(2026, 6, 1, 16), _ms(2026, 6, 1, 20)]
    end_time_ms = _ms(2026, 6, 2, 0)
    db.add_all(
        [
            _kline_row(index + 400, open_time, updated_at=now, interval=interval, symbol="ETHUSDT")
            for index, open_time in enumerate(cached_times)
        ]
    )
    db.commit()

    def fetch_external(_limit: int, _fetch_end_time_ms: int | None):
        raise market_kline_cache.KlineProviderFetchError(
            "provider timed out",
            provider_error_code=market_kline_cache.KLINE_PROVIDER_ERROR_TIMEOUT,
            provider_error_provider="OKX_SPOT",
        )

    rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="ETHUSDT",
        interval=interval,
        limit=4,
        source="EXTERNAL_SPOT",
        fetch_external=fetch_external,
        end_time_ms=end_time_ms,
    )

    assert _open_times(rows) == cached_times
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_STALE_CACHE
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_SHORT
    assert rows.provider_error_code == market_kline_cache.KLINE_PROVIDER_ERROR_TIMEOUT
    assert rows.provider_error_provider == "OKX_SPOT"
    assert rows.history_incomplete is True


def test_market_kline_cache_provider_empty_without_stale_returns_empty_metadata() -> None:
    db = _session()
    fetch_calls: list[tuple[int, int | None]] = []
    end_time_ms = _ms(2026, 6, 2, 0)

    def fetch_external(limit: int, fetch_end_time_ms: int | None):
        fetch_calls.append((limit, fetch_end_time_ms))
        return []

    rows = market_kline_cache.get_klines_cache_first(
        db,
        market_type="spot",
        symbol="ETHUSDT",
        interval="4h",
        limit=4,
        source="EXTERNAL_SPOT",
        fetch_external=fetch_external,
        end_time_ms=end_time_ms,
    )

    assert fetch_calls == [(4, end_time_ms)]
    assert rows == []
    assert rows.origin == market_kline_cache.KLINE_CACHE_ORIGIN_EMPTY
    assert rows.cache_status == market_kline_cache.KLINE_CACHE_STATUS_PROVIDER_EMPTY
    assert rows.provider_error_code == market_kline_cache.KLINE_PROVIDER_ERROR_EMPTY
    assert rows.history_incomplete is True


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_kline_anchor tests passed")
