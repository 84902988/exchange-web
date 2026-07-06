from __future__ import annotations

import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine
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
) -> MarketKline:
    return MarketKline(
        id=row_id,
        market_type="spot",
        symbol="BTCUSDT",
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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_kline_anchor tests passed")
