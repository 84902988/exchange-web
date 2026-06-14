from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, time as dt_time, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests


logger = logging.getLogger(__name__)


MARKET_STATUS_OPEN = "OPEN"
MARKET_STATUS_CLOSED = "CLOSED"
MARKET_STATUS_UNKNOWN = "UNKNOWN"
MARKET_STATUS_TEXT_OPEN = "\u4ea4\u6613\u4e2d"
MARKET_STATUS_TEXT_CLOSED = "\u4f11\u5e02\u4e2d \u00b7 \u5e73\u53f0\u62a5\u4ef7"
MARKET_STATUS_TEXT_UNKNOWN = "\u4ea4\u6613\u65f6\u6bb5\u672a\u77e5"


@dataclass(frozen=True)
class ItickMarketStatus:
    market_status: str
    market_status_text: str
    market_session_code: Optional[str]
    market_timezone: Optional[str]
    market_trading_hours: Optional[str]
    market_session_type: Optional[str] = None

    def to_payload(self) -> dict[str, Optional[str]]:
        return {
            "market_status": self.market_status,
            "market_status_text": self.market_status_text,
            "market_session_code": self.market_session_code,
            "market_timezone": self.market_timezone,
            "market_trading_hours": self.market_trading_hours,
            "market_session_type": self.market_session_type,
        }


class ItickHolidayService:
    DEFAULT_BASE_URL = "https://api0.itick.org"
    HOLIDAYS_PATH = "/symbol/v2/holidays"
    REQUEST_TIMEOUT_SECONDS = 4
    CACHE_TTL_SECONDS = 6 * 60 * 60
    SESSION_TIMEZONE_FALLBACKS = {
        "US": "America/New_York",
        "CA": "America/Toronto",
        "HK": "Asia/Hong_Kong",
        "CN": "Asia/Shanghai",
        "JP": "Asia/Tokyo",
        "SG": "Asia/Singapore",
        "GB": "Europe/London",
        "DE": "Europe/Berlin",
        "AU": "Australia/Sydney",
    }
    TIMEZONE_ALIASES = {
        "EST": "America/New_York",
        "EDT": "America/New_York",
        "HKT": "Asia/Hong_Kong",
        "CST": "Asia/Shanghai",
        "JST": "Asia/Tokyo",
        "SGT": "Asia/Singapore",
        "GMT": "Europe/London",
        "BST": "Europe/London",
        "CET": "Europe/Berlin",
        "CEST": "Europe/Berlin",
        "AEST": "Australia/Sydney",
        "AEDT": "Australia/Sydney",
    }

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.trust_env = False
        self._cache: Dict[str, tuple[float, List[Dict[str, Any]]]] = {}
        self._warning_last_at: Dict[tuple[str, str, str], float] = {}

    def get_market_status(self, code: str, *, now: Optional[datetime] = None) -> ItickMarketStatus:
        normalized_code = self._normalize_code(code)
        if not normalized_code:
            return self.unknown(None, None, None)

        rows = self._get_holidays(normalized_code)
        if rows is None:
            return self.unknown(normalized_code, None, None)

        row = self._pick_session_row(rows, normalized_code)
        if row is None:
            return self.unknown(normalized_code, None, None)

        timezone_name = self._normalize_text(row.get("z")) or None
        trading_hours = self._normalize_text(row.get("t")) or None
        runtime_timezone = self._runtime_timezone(timezone_name, normalized_code)
        current = self._now_in_timezone(runtime_timezone, now)
        today = current.date().isoformat()

        if any(self._date_matches(item.get("d"), today) for item in rows):
            return ItickMarketStatus(
                market_status=MARKET_STATUS_CLOSED,
                market_status_text=MARKET_STATUS_TEXT_CLOSED,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
            )

        if trading_hours and self._is_time_in_trading_hours(current.time(), trading_hours):
            return ItickMarketStatus(
                market_status=MARKET_STATUS_OPEN,
                market_status_text=MARKET_STATUS_TEXT_OPEN,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
            )

        return ItickMarketStatus(
            market_status=MARKET_STATUS_CLOSED,
            market_status_text=MARKET_STATUS_TEXT_CLOSED,
            market_session_code=normalized_code,
            market_timezone=timezone_name,
            market_trading_hours=trading_hours,
            market_session_type="CLOSED",
        )

    def get_us_stock_regular_status(self, *, now: Optional[datetime] = None) -> ItickMarketStatus:
        normalized_code = "US"
        rows = self._get_holidays(normalized_code)
        row = self._pick_session_row(rows, normalized_code) if rows else None
        timezone_name = self._normalize_text(row.get("z")) if row else None
        timezone_name = timezone_name or self.SESSION_TIMEZONE_FALLBACKS["US"]
        trading_hours = self._normalize_text(row.get("t")) if row else None
        trading_hours = trading_hours or "04:00-09:30,09:30-16:00,16:00-20:00"
        runtime_timezone = self._runtime_timezone(timezone_name, normalized_code)
        current = self._now_in_timezone(runtime_timezone, now)
        today = current.date().isoformat()

        if rows and any(self._date_matches(item.get("d"), today) for item in rows):
            return ItickMarketStatus(
                market_status=MARKET_STATUS_CLOSED,
                market_status_text=MARKET_STATUS_TEXT_CLOSED,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
                market_session_type="CLOSED",
            )

        session_type = self._us_stock_session_type(current.time())
        return ItickMarketStatus(
            market_status=MARKET_STATUS_OPEN if session_type == "REGULAR" else MARKET_STATUS_CLOSED,
            market_status_text=MARKET_STATUS_TEXT_OPEN if session_type == "REGULAR" else MARKET_STATUS_TEXT_CLOSED,
            market_session_code=normalized_code,
            market_timezone=timezone_name,
            market_trading_hours=trading_hours,
            market_session_type=session_type,
        )

    def crypto_open(self) -> ItickMarketStatus:
        return ItickMarketStatus(
            market_status=MARKET_STATUS_OPEN,
            market_status_text=MARKET_STATUS_TEXT_OPEN,
            market_session_code=None,
            market_timezone=None,
            market_trading_hours="24/7",
        )

    def forex_24x5_status(self, *, now: Optional[datetime] = None) -> ItickMarketStatus:
        current = now.astimezone(timezone.utc) if now else datetime.now(timezone.utc)
        is_open = current.weekday() < 5
        return ItickMarketStatus(
            market_status=MARKET_STATUS_OPEN if is_open else MARKET_STATUS_CLOSED,
            market_status_text=MARKET_STATUS_TEXT_OPEN if is_open else MARKET_STATUS_TEXT_CLOSED,
            market_session_code=None,
            market_timezone="UTC",
            market_trading_hours="24x5",
        )

    def unknown(
        self,
        session_code: Optional[str],
        timezone_name: Optional[str],
        trading_hours: Optional[str],
    ) -> ItickMarketStatus:
        return ItickMarketStatus(
            market_status=MARKET_STATUS_UNKNOWN,
            market_status_text=MARKET_STATUS_TEXT_UNKNOWN,
            market_session_code=session_code,
            market_timezone=timezone_name,
            market_trading_hours=trading_hours,
        )

    def _get_holidays(self, code: str) -> Optional[List[Dict[str, Any]]]:
        now = time.monotonic()
        cached = self._cache.get(code)
        if cached is not None:
            cached_at, rows = cached
            if now - cached_at <= self.CACHE_TTL_SECONDS:
                return [dict(row) for row in rows]

        token = (os.getenv("ITICK_API_TOKEN") or "").strip()
        if not token:
            self._log_warning_with_cooldown(
                "token_missing",
                "*",
                "ITICK_API_TOKEN missing",
                "itick holidays token missing code=%s",
                code,
            )
            return [dict(row) for row in cached[1]] if cached is not None else None

        url = f"{self._base_url()}{self.HOLIDAYS_PATH}"
        try:
            response = self._session.get(
                url,
                params={"code": code},
                headers={"token": token, "accept": "application/json"},
                timeout=self.REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            self._log_warning_with_cooldown(
                "request_failed",
                code,
                exc,
                "itick holidays request failed code=%s reason=%s",
                code,
                exc,
            )
            return [dict(row) for row in cached[1]] if cached is not None else None

        if not isinstance(payload, dict) or str(payload.get("code")) != "0":
            self._log_warning_with_cooldown(
                "bad_payload",
                code,
                str(payload)[:120],
                "itick holidays bad payload code=%s payload=%s",
                code,
                str(payload)[:240],
            )
            return [dict(row) for row in cached[1]] if cached is not None else None

        rows = payload.get("data")
        if not isinstance(rows, list) or not rows:
            self._log_warning_with_cooldown(
                "empty_data",
                code,
                "",
                "itick holidays empty data code=%s",
                code,
            )
            return [dict(row) for row in cached[1]] if cached is not None else None

        normalized_rows = [dict(row) for row in rows if isinstance(row, dict)]
        self._cache[code] = (now, normalized_rows)
        return [dict(row) for row in normalized_rows]

    def _base_url(self) -> str:
        return (os.getenv("ITICK_HOLIDAYS_BASE_URL") or self.DEFAULT_BASE_URL).strip().rstrip("/")

    def _log_warning_with_cooldown(
        self,
        event: str,
        code: str,
        reason: Any,
        message: str,
        *args: Any,
        cooldown_seconds: int = 300,
    ) -> None:
        key = (str(event or ""), str(code or ""), str(reason or "")[:160])
        now = time.monotonic()
        last_at = self._warning_last_at.get(key)
        if last_at is None or now - last_at >= cooldown_seconds:
            self._warning_last_at[key] = now
            logger.warning(message, *args)
            return
        logger.debug(message, *args)

    def _pick_session_row(self, rows: List[Dict[str, Any]], code: str) -> Optional[Dict[str, Any]]:
        for row in rows:
            if self._normalize_code(row.get("c")) == code and self._normalize_text(row.get("t")):
                return row
        for row in rows:
            if self._normalize_text(row.get("t")):
                return row
        return rows[0] if rows else None

    def _now_in_timezone(self, timezone_name: Optional[str], now: Optional[datetime]) -> datetime:
        base = now or datetime.now(timezone.utc)
        if base.tzinfo is None:
            base = base.replace(tzinfo=timezone.utc)
        if not timezone_name:
            return base.astimezone(timezone.utc)
        try:
            return base.astimezone(ZoneInfo(timezone_name))
        except ZoneInfoNotFoundError:
            self._log_warning_with_cooldown(
                "timezone_unknown",
                str(timezone_name or ""),
                "",
                "itick holidays timezone unknown timezone=%s",
                timezone_name,
            )
            return base.astimezone(timezone.utc)

    def _runtime_timezone(self, timezone_name: Optional[str], code: str) -> Optional[str]:
        normalized_timezone = self._normalize_text(timezone_name)
        alias = self.TIMEZONE_ALIASES.get(normalized_timezone.upper())
        if alias:
            return alias
        return normalized_timezone or self.SESSION_TIMEZONE_FALLBACKS.get(code)

    def _is_time_in_trading_hours(self, current_time: dt_time, trading_hours: str) -> bool:
        for raw_segment in trading_hours.replace("|", ",").split(","):
            segment = raw_segment.strip()
            if "-" not in segment:
                continue
            start_raw, end_raw = [item.strip() for item in segment.split("-", 1)]
            start = self._parse_clock_time(start_raw)
            end = self._parse_clock_time(end_raw)
            if start is None or end is None:
                continue
            if start <= end:
                if start <= current_time <= end:
                    return True
            elif current_time >= start or current_time <= end:
                return True
        return False

    def _us_stock_session_type(self, current_time: dt_time) -> str:
        pre_start = dt_time(4, 0)
        regular_start = dt_time(9, 30)
        regular_end = dt_time(16, 0)
        after_end = dt_time(20, 0)
        if pre_start <= current_time < regular_start:
            return "PRE_MARKET"
        if regular_start <= current_time < regular_end:
            return "REGULAR"
        if regular_end <= current_time < after_end:
            return "AFTER_HOURS"
        return "CLOSED"

    def _parse_clock_time(self, value: str) -> Optional[dt_time]:
        parts = value.strip().split(":")
        if len(parts) < 2:
            return None
        try:
            hour = int(parts[0])
            minute = int(parts[1])
            second = int(parts[2]) if len(parts) > 2 else 0
            return dt_time(hour=hour, minute=minute, second=second)
        except ValueError:
            return None

    def _date_matches(self, value: Any, today: str) -> bool:
        raw = self._normalize_text(value)
        if not raw:
            return False
        return today in {item.strip() for item in raw.replace("|", ",").split(",") if item.strip()}

    def _normalize_code(self, value: Any) -> str:
        return str(value or "").strip().upper()

    def _normalize_text(self, value: Any) -> str:
        return str(value or "").strip()


itick_holiday_service = ItickHolidayService()
