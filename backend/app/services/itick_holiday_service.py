from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import date as date_cls, datetime, time as dt_time, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

from app.services.contract_session_profiles import (
    PROFILE_FOREX_24X5,
    PROFILE_US_EQUITY,
    SESSION_AFTER_HOURS,
    SESSION_CLOSED,
    SESSION_HOLIDAY,
    SESSION_REGULAR_OPEN,
    get_contract_session_profile,
    session_state_for_profile,
)


logger = logging.getLogger(__name__)


MARKET_STATUS_OPEN = "OPEN"
MARKET_STATUS_CLOSED = "CLOSED"
MARKET_STATUS_HOLIDAY = "HOLIDAY"
MARKET_STATUS_UNKNOWN = "UNKNOWN"
MARKET_STATUS_TEXT_OPEN = "\u4ea4\u6613\u4e2d"
MARKET_STATUS_TEXT_CLOSED = "\u4f11\u5e02\u4e2d \u00b7 \u5e73\u53f0\u62a5\u4ef7"
MARKET_STATUS_TEXT_UNKNOWN = "\u4ea4\u6613\u65f6\u6bb5\u672a\u77e5"

HOLIDAY_DAY_NORMAL = "NORMAL"
HOLIDAY_DAY_HOLIDAY = "HOLIDAY"
HOLIDAY_DAY_EARLY_CLOSE = "EARLY_CLOSE"
HOLIDAY_DAY_UNKNOWN = "UNKNOWN"

_EARLY_CLOSE_RE = re.compile(
    r"\bearly\s+close(?:d)?(?:\s+at)?\s+(?P<hour>\d{1,2}):(?P<minute>\d{2})\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ItickMarketStatus:
    market_status: str
    market_status_text: str
    market_session_code: Optional[str]
    market_timezone: Optional[str]
    market_trading_hours: Optional[str]
    market_session_type: Optional[str] = None
    feed_state: Optional[str] = None
    instrument_state: Optional[str] = None
    execution_state: Optional[str] = None
    session_reason_code: Optional[str] = None

    def to_payload(self) -> dict[str, Optional[str]]:
        return {
            "market_status": self.market_status,
            "market_status_text": self.market_status_text,
            "market_session_code": self.market_session_code,
            "market_timezone": self.market_timezone,
            "market_trading_hours": self.market_trading_hours,
            "market_session_type": self.market_session_type,
            "feed_state": self.feed_state,
            "instrument_state": self.instrument_state,
            "execution_state": self.execution_state,
            "session_reason_code": self.session_reason_code,
        }


@dataclass(frozen=True)
class ItickHolidayDay:
    state: str
    session_code: str
    timezone_name: Optional[str]
    trading_hours: Optional[str]
    holiday_name: Optional[str] = None
    regular_close_time: Optional[dt_time] = None

    @property
    def calendar_available(self) -> bool:
        return self.state != HOLIDAY_DAY_UNKNOWN


class ItickHolidayService:
    DEFAULT_BASE_URL = "https://api0.itick.org"
    HOLIDAYS_PATH = "/symbol/v2/holidays"
    REQUEST_TIMEOUT_SECONDS = 4
    CACHE_TTL_SECONDS = 6 * 60 * 60
    LAST_GOOD_TTL_SECONDS = 7 * 24 * 60 * 60
    REFRESH_LOCK_TTL_SECONDS = 10
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
        self._refresh_locks: Dict[str, threading.Lock] = {}
        self._refresh_locks_guard = threading.Lock()
        self._warning_last_at: Dict[tuple[str, str, str], float] = {}
        self._redis: Any = None
        self._redis_initialized = False

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
        holiday_day = self._holiday_day_from_rows(normalized_code, current.date(), rows)
        if holiday_day.state == HOLIDAY_DAY_UNKNOWN:
            return self.unknown(normalized_code, timezone_name, trading_hours)
        if holiday_day.state == HOLIDAY_DAY_HOLIDAY:
            return ItickMarketStatus(
                market_status=MARKET_STATUS_HOLIDAY,
                market_status_text=MARKET_STATUS_TEXT_CLOSED,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
                market_session_type=SESSION_HOLIDAY,
            )

        if (
            holiday_day.state == HOLIDAY_DAY_EARLY_CLOSE
            and holiday_day.regular_close_time is not None
            and current.time().replace(tzinfo=None) >= holiday_day.regular_close_time
        ):
            return ItickMarketStatus(
                market_status=MARKET_STATUS_CLOSED,
                market_status_text=MARKET_STATUS_TEXT_CLOSED,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
                market_session_type=SESSION_AFTER_HOURS,
            )

        if trading_hours and self._is_time_in_trading_hours(current.time(), trading_hours):
            return ItickMarketStatus(
                market_status=MARKET_STATUS_OPEN,
                market_status_text=MARKET_STATUS_TEXT_OPEN,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
                market_session_type=SESSION_REGULAR_OPEN,
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

        if current.weekday() >= 5:
            return ItickMarketStatus(
                market_status=MARKET_STATUS_CLOSED,
                market_status_text=MARKET_STATUS_TEXT_CLOSED,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
                market_session_type="CLOSED",
            )

        if not rows:
            return self.unknown(normalized_code, timezone_name, trading_hours)

        holiday_day = self._holiday_day_from_rows(normalized_code, current.date(), rows)
        if holiday_day.state == HOLIDAY_DAY_UNKNOWN:
            return self.unknown(normalized_code, timezone_name, trading_hours)
        if holiday_day.state == HOLIDAY_DAY_HOLIDAY:
            return ItickMarketStatus(
                market_status=MARKET_STATUS_HOLIDAY,
                market_status_text=MARKET_STATUS_TEXT_CLOSED,
                market_session_code=normalized_code,
                market_timezone=timezone_name,
                market_trading_hours=trading_hours,
                market_session_type=SESSION_HOLIDAY,
            )

        profile = get_contract_session_profile(PROFILE_US_EQUITY)
        session_type = (
            session_state_for_profile(
                profile,
                current,
                regular_close_override=holiday_day.regular_close_time,
            )
            if profile is not None
            else SESSION_CLOSED
        )
        return ItickMarketStatus(
            market_status=MARKET_STATUS_OPEN if session_type == SESSION_REGULAR_OPEN else MARKET_STATUS_CLOSED,
            market_status_text=MARKET_STATUS_TEXT_OPEN if session_type == SESSION_REGULAR_OPEN else MARKET_STATUS_TEXT_CLOSED,
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
            market_session_type=SESSION_REGULAR_OPEN,
        )

    def forex_24x5_status(self, *, now: Optional[datetime] = None) -> ItickMarketStatus:
        profile = get_contract_session_profile(PROFILE_FOREX_24X5)
        if profile is None:
            return self.unknown(None, "America/New_York", "24x5")
        current = self._now_in_timezone(profile.timezone_name, now)
        session_type = session_state_for_profile(profile, current)
        is_open = session_type == SESSION_REGULAR_OPEN
        return ItickMarketStatus(
            market_status=MARKET_STATUS_OPEN if is_open else MARKET_STATUS_CLOSED,
            market_status_text=MARKET_STATUS_TEXT_OPEN if is_open else MARKET_STATUS_TEXT_CLOSED,
            market_session_code=None,
            market_timezone=profile.timezone_name,
            market_trading_hours="24x5",
            market_session_type=session_type,
        )

    def get_holiday_day(
        self,
        code: str,
        on_date: date_cls,
        *,
        allow_network: bool = False,
    ) -> ItickHolidayDay:
        normalized_code = self._normalize_code(code)
        if not normalized_code:
            return ItickHolidayDay(
                state=HOLIDAY_DAY_UNKNOWN,
                session_code="",
                timezone_name=None,
                trading_hours=None,
            )
        rows = self._get_holidays(normalized_code) if allow_network else self._get_cached_holidays(normalized_code)
        if not rows:
            return ItickHolidayDay(
                state=HOLIDAY_DAY_UNKNOWN,
                session_code=normalized_code,
                timezone_name=self.SESSION_TIMEZONE_FALLBACKS.get(normalized_code),
                trading_hours=None,
            )
        return self._holiday_day_from_rows(normalized_code, on_date, rows)

    def prewarm(self, codes: List[str]) -> Dict[str, bool]:
        results: Dict[str, bool] = {}
        for raw_code in codes:
            code = self._normalize_code(raw_code)
            if code and code not in results:
                results[code] = self._get_holidays(code) is not None
        return results

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

        redis_rows = self._redis_get_rows(self._redis_active_key(code))
        if redis_rows:
            self._cache[code] = (now, redis_rows)
            return [dict(row) for row in redis_rows]

        lock = self._refresh_lock(code)
        with lock:
            now = time.monotonic()
            refreshed = self._cache.get(code)
            if refreshed is not None and now - refreshed[0] <= self.CACHE_TTL_SECONDS:
                return [dict(row) for row in refreshed[1]]

            fallback_rows = [dict(row) for row in (refreshed or cached)[1]] if (refreshed or cached) else None
            if fallback_rows is None:
                fallback_rows = self._redis_get_rows(self._redis_last_good_key(code))

            refresh_token = self._try_acquire_redis_refresh_lock(code)
            if refresh_token is False:
                return [dict(row) for row in fallback_rows] if fallback_rows else None

            try:
                normalized_rows = self._request_holidays(code)
                if not normalized_rows:
                    return [dict(row) for row in fallback_rows] if fallback_rows else None
                self._cache[code] = (time.monotonic(), normalized_rows)
                self._redis_set_rows(
                    self._redis_active_key(code),
                    normalized_rows,
                    self.CACHE_TTL_SECONDS,
                )
                self._redis_set_rows(
                    self._redis_last_good_key(code),
                    normalized_rows,
                    self.LAST_GOOD_TTL_SECONDS,
                )
                return [dict(row) for row in normalized_rows]
            finally:
                if isinstance(refresh_token, str):
                    self._release_redis_refresh_lock(code, refresh_token)

    def _get_cached_holidays(self, code: str) -> Optional[List[Dict[str, Any]]]:
        cached = self._cache.get(code)
        if cached is not None:
            return [dict(row) for row in cached[1]]
        rows = self._redis_get_rows(self._redis_active_key(code))
        if not rows:
            rows = self._redis_get_rows(self._redis_last_good_key(code))
        if rows:
            self._cache[code] = (time.monotonic(), rows)
            return [dict(row) for row in rows]
        return None

    def _request_holidays(self, code: str) -> Optional[List[Dict[str, Any]]]:
        token = self._token()
        if not token:
            self._log_warning_with_cooldown(
                "token_missing",
                "*",
                "ITICK_API_TOKEN missing",
                "itick holidays token missing code=%s",
                code,
            )
            return None

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
            return None

        if not isinstance(payload, dict) or str(payload.get("code")) != "0":
            self._log_warning_with_cooldown(
                "bad_payload",
                code,
                str(payload)[:120],
                "itick holidays bad payload code=%s payload=%s",
                code,
                str(payload)[:240],
            )
            return None

        rows = payload.get("data")
        if not isinstance(rows, list) or not rows:
            self._log_warning_with_cooldown(
                "empty_data",
                code,
                "",
                "itick holidays empty data code=%s",
                code,
            )
            return None
        normalized_rows = [dict(row) for row in rows if isinstance(row, dict)]
        return normalized_rows or None

    def _refresh_lock(self, code: str) -> threading.Lock:
        with self._refresh_locks_guard:
            lock = self._refresh_locks.get(code)
            if lock is None:
                lock = threading.Lock()
                self._refresh_locks[code] = lock
            return lock

    def _base_url(self) -> str:
        explicit = (os.getenv("ITICK_HOLIDAYS_BASE_URL") or "").strip()
        if explicit:
            return explicit.rstrip("/")
        try:
            from app.core.config import settings

            configured = str(getattr(settings, "ITICK_BASE_URL", "") or "").strip()
        except Exception:
            configured = ""
        return (configured or self.DEFAULT_BASE_URL).rstrip("/")

    def _token(self) -> str:
        explicit = (os.getenv("ITICK_API_TOKEN") or "").strip()
        if explicit:
            return explicit
        try:
            from app.core.config import settings

            return str(
                getattr(settings, "ITICK_API_TOKEN", None)
                or getattr(settings, "ITICK_API_KEY", None)
                or ""
            ).strip()
        except Exception:
            return ""

    def _redis_client(self) -> Any:
        if self._redis_initialized:
            return self._redis
        self._redis_initialized = True
        try:
            import redis as redis_lib
            from app.core.config import settings

            self._redis = redis_lib.Redis(
                host=getattr(settings, "REDIS_HOST", "127.0.0.1"),
                port=int(getattr(settings, "REDIS_PORT", 6379)),
                db=int(getattr(settings, "REDIS_DB", 0)),
                password=getattr(settings, "REDIS_PASSWORD", None) or None,
                decode_responses=False,
                socket_connect_timeout=0.25,
                socket_timeout=0.25,
            )
        except Exception as exc:
            self._redis = None
            logger.debug("itick holidays redis unavailable reason=%s", exc)
        return self._redis

    def _redis_key(self, suffix: str) -> str:
        try:
            from app.core.config import settings

            prefix = str(getattr(settings, "REDIS_KEY_PREFIX", "exchange") or "exchange")
        except Exception:
            prefix = "exchange"
        return f"{prefix}:contract_calendar:{suffix}"

    def _redis_active_key(self, code: str) -> str:
        return self._redis_key(f"itick:v2:{code}:active")

    def _redis_last_good_key(self, code: str) -> str:
        return self._redis_key(f"itick:v2:{code}:last_good")

    def _redis_lock_key(self, code: str) -> str:
        return self._redis_key(f"itick:v2:{code}:refresh_lock")

    def _redis_get_rows(self, key: str) -> Optional[List[Dict[str, Any]]]:
        client = self._redis_client()
        if client is None:
            return None
        try:
            raw = client.get(key)
            if not raw:
                return None
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8")
            payload = json.loads(str(raw))
            rows = payload.get("rows") if isinstance(payload, dict) else None
            if not isinstance(rows, list):
                return None
            normalized = [dict(row) for row in rows if isinstance(row, dict)]
            return normalized or None
        except Exception as exc:
            logger.debug("itick holidays redis read failed key=%s reason=%s", key, exc)
            return None

    def _redis_set_rows(self, key: str, rows: List[Dict[str, Any]], ttl_seconds: int) -> None:
        client = self._redis_client()
        if client is None:
            return
        payload = {
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "rows": rows,
        }
        try:
            client.set(
                key,
                json.dumps(payload, ensure_ascii=False),
                ex=max(1, int(ttl_seconds)),
            )
        except Exception as exc:
            logger.debug("itick holidays redis write failed key=%s reason=%s", key, exc)

    def _try_acquire_redis_refresh_lock(self, code: str) -> str | bool | None:
        client = self._redis_client()
        if client is None:
            return None
        token = f"{os.getpid()}:{threading.get_ident()}:{time.time_ns()}"
        try:
            acquired = client.set(
                self._redis_lock_key(code),
                token,
                nx=True,
                ex=self.REFRESH_LOCK_TTL_SECONDS,
            )
            return token if acquired else False
        except Exception as exc:
            logger.debug("itick holidays redis lock failed code=%s reason=%s", code, exc)
            return None

    def _release_redis_refresh_lock(self, code: str, token: str) -> None:
        client = self._redis_client()
        if client is None:
            return
        script = """
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        end
        return 0
        """
        try:
            client.eval(script, 1, self._redis_lock_key(code), token)
        except Exception as exc:
            logger.debug("itick holidays redis unlock failed code=%s reason=%s", code, exc)

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

    def _holiday_day_from_rows(
        self,
        code: str,
        on_date: date_cls,
        rows: List[Dict[str, Any]],
    ) -> ItickHolidayDay:
        session_row = self._pick_session_row(rows, code)
        timezone_name = self._normalize_text((session_row or {}).get("z")) or self.SESSION_TIMEZONE_FALLBACKS.get(code)
        trading_hours = self._normalize_text((session_row or {}).get("t")) or None
        matching_row: Optional[Dict[str, Any]] = None
        covered_years: set[int] = set()
        for row in rows:
            for value in self._dates_from_value(row.get("d")):
                covered_years.add(value.year)
                if value == on_date and matching_row is None:
                    matching_row = row

        if matching_row is None:
            return ItickHolidayDay(
                state=HOLIDAY_DAY_NORMAL if on_date.year in covered_years else HOLIDAY_DAY_UNKNOWN,
                session_code=code,
                timezone_name=timezone_name,
                trading_hours=trading_hours,
            )

        row_timezone = self._normalize_text(matching_row.get("z")) or timezone_name
        row_hours = self._normalize_text(matching_row.get("t")) or trading_hours
        holiday_name = self._normalize_text(matching_row.get("v")) or None
        early_close = self._early_close_time(holiday_name)
        if early_close is not None:
            return ItickHolidayDay(
                state=HOLIDAY_DAY_EARLY_CLOSE,
                session_code=code,
                timezone_name=row_timezone,
                trading_hours=row_hours,
                holiday_name=holiday_name,
                regular_close_time=early_close,
            )
        if holiday_name and "EARLY CLOSE" in holiday_name.upper():
            return ItickHolidayDay(
                state=HOLIDAY_DAY_UNKNOWN,
                session_code=code,
                timezone_name=row_timezone,
                trading_hours=row_hours,
                holiday_name=holiday_name,
            )
        return ItickHolidayDay(
            state=HOLIDAY_DAY_HOLIDAY,
            session_code=code,
            timezone_name=row_timezone,
            trading_hours=row_hours,
            holiday_name=holiday_name,
        )

    def _early_close_time(self, value: Optional[str]) -> Optional[dt_time]:
        match = _EARLY_CLOSE_RE.search(str(value or ""))
        if match is None:
            return None
        return self._parse_clock_time(f"{match.group('hour')}:{match.group('minute')}")

    def _dates_from_value(self, value: Any) -> List[date_cls]:
        parsed: List[date_cls] = []
        raw = self._normalize_text(value)
        for item in raw.replace("|", ",").split(","):
            candidate = item.strip()
            if not candidate:
                continue
            try:
                parsed.append(date_cls.fromisoformat(candidate))
            except ValueError:
                continue
        return parsed

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
