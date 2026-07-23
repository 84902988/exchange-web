from __future__ import annotations

import time
from datetime import datetime, timezone
from types import SimpleNamespace

from app.services.contract_session_authority import ContractSessionAuthority
from app.services.itick_holiday_service import ItickHolidayService

from tests.test_itick_holiday_service import US_ROWS


def _holiday_service(rows=US_ROWS) -> ItickHolidayService:
    service = ItickHolidayService()
    service._redis_initialized = True
    service._redis = None
    if rows is not None:
        service._cache["US"] = (time.monotonic(), [dict(row) for row in rows])
    return service


def _symbol(
    *,
    profile: str,
    calendar: str | None = None,
    provider: str = "ITICK",
    extended_hours_mode: str = "DISPLAY_ONLY",
) -> SimpleNamespace:
    return SimpleNamespace(
        session_profile_code=profile,
        holiday_calendar_code=calendar,
        session_timezone_override=None,
        extended_hours_execution_mode=extended_hours_mode,
        provider=provider,
    )


def test_us_index_after_hours_can_stay_live_but_is_display_only() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(profile="US_INDEX_EXTENDED", calendar="US"),
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 7, 23, 20, 8, tzinfo=timezone.utc),
    )

    assert decision.session_state == "AFTER_HOURS"
    assert decision.feed_state == "LIVE"
    assert decision.instrument_state == "NORMAL"
    assert decision.execution_state == "DISPLAY_ONLY"
    assert decision.trading_allowed is False


def test_us_holiday_blocks_execution_even_when_feed_is_live() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(profile="US_INDEX_EXTENDED", calendar="US"),
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 7, 3, 14, 0, tzinfo=timezone.utc),
    )

    assert decision.session_state == "HOLIDAY"
    assert decision.execution_state == "DISPLAY_ONLY"
    assert decision.trading_allowed is False


def test_operator_can_block_extended_hours_display_state() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(
            profile="US_INDEX_EXTENDED",
            calendar="US",
            extended_hours_mode="BLOCKED",
        ),
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 7, 23, 20, 8, tzinfo=timezone.utc),
    )

    assert decision.session_state == "AFTER_HOURS"
    assert decision.execution_state == "BLOCKED"
    assert decision.reason_code == "AFTER_HOURS_BLOCKED"


def test_early_close_switches_from_tradable_to_display_only_at_1300_new_york() -> None:
    authority = ContractSessionAuthority(_holiday_service())
    symbol = _symbol(profile="US_EQUITY", calendar="US")

    before_close = authority.resolve(
        contract_symbol=symbol,
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 11, 27, 17, 59, tzinfo=timezone.utc),
    )
    at_close = authority.resolve(
        contract_symbol=symbol,
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 11, 27, 18, 0, tzinfo=timezone.utc),
    )

    assert before_close.execution_state == "TRADABLE"
    assert before_close.trading_allowed is True
    assert at_close.session_state == "AFTER_HOURS"
    assert at_close.execution_state == "DISPLAY_ONLY"


def test_missing_calendar_cache_fails_closed_without_network_request(monkeypatch) -> None:
    service = _holiday_service(rows=None)
    monkeypatch.setattr(service, "_request_holidays", lambda code: (_ for _ in ()).throw(AssertionError("network")))
    authority = ContractSessionAuthority(service)

    decision = authority.resolve(
        contract_symbol=_symbol(profile="US_EQUITY", calendar="US"),
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 7, 23, 14, 0, tzinfo=timezone.utc),
    )

    assert decision.session_state == "UNKNOWN"
    assert decision.execution_state == "BLOCKED"
    assert decision.reason_code == "HOLIDAY_CALENDAR_UNAVAILABLE"


def test_forex_sunday_session_is_tradable_after_1700_new_york() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(profile="FOREX_24X5"),
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 7, 19, 21, 1, tzinfo=timezone.utc),
    )

    assert decision.session_state == "REGULAR_OPEN"
    assert decision.execution_state == "TRADABLE"


def test_metal_daily_break_is_closed_even_with_live_feed() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(profile="METAL_23X5"),
        quote={"quote_freshness": "LIVE", "ts": 0},
        now=datetime(2026, 7, 23, 21, 30, tzinfo=timezone.utc),
    )

    assert decision.session_state == "CLOSED"
    assert decision.execution_state == "DISPLAY_ONLY"


def test_provider_suspension_blocks_regular_session() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(profile="US_EQUITY", calendar="US"),
        quote={"quote_freshness": "LIVE", "ts": 1},
        now=datetime(2026, 7, 23, 14, 0, tzinfo=timezone.utc),
    )

    assert decision.session_state == "REGULAR_OPEN"
    assert decision.instrument_state == "SUSPENDED"
    assert decision.execution_state == "BLOCKED"


def test_live_itick_frame_without_optional_provider_status_is_normal() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(profile="FOREX_24X5"),
        quote={"quote_freshness": "LIVE", "source": "ITICK_DEPTH"},
        now=datetime(2026, 7, 23, 14, 0, tzinfo=timezone.utc),
    )

    assert decision.session_state == "REGULAR_OPEN"
    assert decision.instrument_state == "NORMAL"
    assert decision.execution_state == "TRADABLE"
    assert decision.trading_allowed is True


def test_after_hours_reason_wins_over_missing_optional_instrument_status() -> None:
    authority = ContractSessionAuthority(_holiday_service())

    decision = authority.resolve(
        contract_symbol=_symbol(profile="US_INDEX_EXTENDED", calendar="US"),
        quote={"quote_freshness": "LAST_VALID", "source": "LAST_GOOD_BBO"},
        now=datetime(2026, 7, 23, 20, 8, tzinfo=timezone.utc),
    )

    assert decision.session_state == "AFTER_HOURS"
    assert decision.instrument_state == "UNKNOWN"
    assert decision.execution_state == "DISPLAY_ONLY"
    assert decision.reason_code == "AFTER_HOURS"


def test_crypto_24x7_needs_no_holiday_calendar() -> None:
    authority = ContractSessionAuthority(_holiday_service(rows=None))

    decision = authority.resolve(
        contract_symbol=_symbol(profile="CRYPTO_24_7", provider="BINANCE"),
        quote={"quote_freshness": "LIVE"},
        now=datetime(2026, 7, 23, 14, 0, tzinfo=timezone.utc),
    )

    assert decision.session_state == "REGULAR_OPEN"
    assert decision.execution_state == "TRADABLE"
