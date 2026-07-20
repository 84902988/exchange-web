from __future__ import annotations

from datetime import datetime, timezone, tzinfo
from typing import Optional
from zoneinfo import ZoneInfo


UTC = timezone.utc
SPOT_TRADE_STORAGE_TIMEZONE = ZoneInfo("Asia/Shanghai")


def utc_isoformat(value: Optional[datetime], *, naive_timezone: tzinfo = UTC) -> Optional[str]:
    if value is None:
        return None
    aware = value if value.tzinfo is not None else value.replace(tzinfo=naive_timezone)
    return aware.astimezone(UTC).isoformat().replace("+00:00", "Z")


def utc_timestamp_ms(value: datetime, *, naive_timezone: tzinfo = UTC) -> int:
    aware = value if value.tzinfo is not None else value.replace(tzinfo=naive_timezone)
    return int(aware.astimezone(UTC).timestamp() * 1000)


def spot_trade_utc_isoformat(value: Optional[datetime]) -> Optional[str]:
    """Serialize the legacy MySQL CURRENT_TIMESTAMP column as an explicit UTC instant."""

    return utc_isoformat(value, naive_timezone=SPOT_TRADE_STORAGE_TIMEZONE)


def spot_trade_utc_timestamp_ms(value: datetime) -> int:
    return utc_timestamp_ms(value, naive_timezone=SPOT_TRADE_STORAGE_TIMEZONE)
