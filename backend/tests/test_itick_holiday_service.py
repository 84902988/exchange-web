from __future__ import annotations

import time
from datetime import datetime, timezone

from app.services.itick_holiday_service import (
    HOLIDAY_DAY_EARLY_CLOSE,
    HOLIDAY_DAY_HOLIDAY,
    HOLIDAY_DAY_NORMAL,
    ItickHolidayService,
)


US_ROWS = [
    {
        "c": "US",
        "r": "United States",
        "d": "2026-07-03",
        "t": "04:00-09:30,09:30-16:00,16:00-20:00",
        "z": "America/New_York",
        "v": "Independence Day",
    },
    {
        "c": "US",
        "r": "United States",
        "d": "2026-11-27",
        "t": "04:00-09:30,09:30-16:00,16:00-20:00",
        "z": "America/New_York",
        "v": "Thanksgiving Day - Early close at 13:00",
    },
    {
        "c": "US",
        "r": "United States",
        "d": "2026-12-24",
        "t": "04:00-09:30|09:30-16:00|16:00-20:00",
        "z": "America/New_York",
        "v": "Christmas - Early close at 13:00",
    },
]


def _service_with_us_rows() -> ItickHolidayService:
    service = ItickHolidayService()
    service._redis_initialized = True
    service._redis = None
    service._cache["US"] = (time.monotonic(), [dict(row) for row in US_ROWS])
    return service


def test_holiday_day_distinguishes_full_holiday_early_close_and_normal_day() -> None:
    service = _service_with_us_rows()

    full_holiday = service.get_holiday_day("US", datetime(2026, 7, 3).date())
    early_close = service.get_holiday_day("US", datetime(2026, 11, 27).date())
    normal_day = service.get_holiday_day("US", datetime(2026, 7, 23).date())

    assert full_holiday.state == HOLIDAY_DAY_HOLIDAY
    assert early_close.state == HOLIDAY_DAY_EARLY_CLOSE
    assert early_close.regular_close_time is not None
    assert early_close.regular_close_time.isoformat() == "13:00:00"
    assert normal_day.state == HOLIDAY_DAY_NORMAL


def test_us_regular_status_honors_early_close_without_treating_whole_day_as_holiday() -> None:
    service = _service_with_us_rows()

    before_close = service.get_us_stock_regular_status(
        now=datetime(2026, 11, 27, 17, 59, tzinfo=timezone.utc),
    )
    at_close = service.get_us_stock_regular_status(
        now=datetime(2026, 11, 27, 18, 0, tzinfo=timezone.utc),
    )

    assert before_close.market_status == "OPEN"
    assert before_close.market_session_type == "REGULAR_OPEN"
    assert at_close.market_status == "CLOSED"
    assert at_close.market_session_type == "AFTER_HOURS"


def test_us_full_holiday_is_reported_explicitly() -> None:
    service = _service_with_us_rows()

    status = service.get_us_stock_regular_status(
        now=datetime(2026, 7, 3, 14, 0, tzinfo=timezone.utc),
    )

    assert status.market_status == "HOLIDAY"
    assert status.market_session_type == "HOLIDAY"


def test_forex_24x5_uses_sunday_open_and_friday_close_in_new_york() -> None:
    service = _service_with_us_rows()

    sunday_before = service.forex_24x5_status(
        now=datetime(2026, 7, 19, 20, 59, tzinfo=timezone.utc),
    )
    sunday_after = service.forex_24x5_status(
        now=datetime(2026, 7, 19, 21, 1, tzinfo=timezone.utc),
    )
    friday_after = service.forex_24x5_status(
        now=datetime(2026, 7, 24, 21, 1, tzinfo=timezone.utc),
    )

    assert sunday_before.market_status == "CLOSED"
    assert sunday_after.market_status == "OPEN"
    assert friday_after.market_status == "CLOSED"


def test_stale_process_cache_remains_last_known_good_when_refresh_fails(monkeypatch) -> None:
    service = _service_with_us_rows()
    service._cache["US"] = (time.monotonic() - service.CACHE_TTL_SECONDS - 1, [dict(row) for row in US_ROWS])
    monkeypatch.setattr(service, "_request_holidays", lambda code: None)

    rows = service._get_holidays("US")

    assert rows == US_ROWS
