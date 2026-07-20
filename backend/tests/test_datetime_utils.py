from datetime import datetime, timedelta, timezone

from app.core.datetime_utils import (
    spot_trade_utc_isoformat,
    spot_trade_utc_timestamp_ms,
    utc_isoformat,
)


def test_utc_isoformat_marks_naive_utc_values_explicitly() -> None:
    assert utc_isoformat(datetime(2026, 7, 20, 19, 7, 10)) == "2026-07-20T19:07:10Z"


def test_utc_isoformat_converts_aware_values_to_utc() -> None:
    value = datetime(2026, 7, 21, 3, 7, 10, tzinfo=timezone(timedelta(hours=8)))
    assert utc_isoformat(value) == "2026-07-20T19:07:10Z"


def test_spot_trade_utc_isoformat_normalizes_legacy_mysql_local_time() -> None:
    value = datetime(2026, 7, 21, 0, 29, 55, 690235)
    assert spot_trade_utc_isoformat(value) == "2026-07-20T16:29:55.690235Z"
    assert spot_trade_utc_timestamp_ms(value) == 1_784_564_995_690


def test_datetime_serializers_preserve_missing_values() -> None:
    assert utc_isoformat(None) is None
    assert spot_trade_utc_isoformat(None) is None
