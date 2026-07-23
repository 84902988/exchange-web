from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from app.services.contract_session_profiles import SESSION_REGULAR_OPEN
from app.services.contract_session_authority import ContractSessionDecision
from app.services import contract_trading_session_resolver as resolver
from app.services.contract_trading_session_resolver import resolve_contract_trading_session


def _symbol(category: str) -> SimpleNamespace:
    return SimpleNamespace(category=category, provider="ITICK")


def test_index_uses_provider_session_instead_of_us_equity_clock():
    session = resolve_contract_trading_session(
        contract_symbol=_symbol("INDEX"),
        quote={"market_status": "CLOSED"},
        now=datetime(2026, 7, 21, 9, 0, tzinfo=timezone.utc),
    )

    assert session.session_type == "CLOSED"
    assert session.trading_allowed is False


def test_index_live_provider_status_allows_trading_for_any_configured_symbol():
    session = resolve_contract_trading_session(
        contract_symbol=_symbol("INDEX"),
        quote={"market_status": "OPEN", "market_session_type": "REGULAR"},
    )

    assert session.session_type == "REGULAR_OPEN"
    assert session.trading_allowed is True


def test_stock_keeps_exchange_calendar_session_semantics():
    session = resolve_contract_trading_session(
        contract_symbol=_symbol("STOCK"),
        quote={"market_status": "CLOSED"},
        now=datetime(2026, 7, 21, 9, 0, tzinfo=timezone.utc),
    )

    assert session.session_type == "PRE_MARKET"
    assert session.trading_allowed is False


def test_provider_session_unknown_is_not_tradable():
    session = resolve_contract_trading_session(
        contract_symbol=_symbol("FOREX"),
        quote={"market_status": "UNKNOWN"},
    )

    assert session.session_type == "UNKNOWN"
    assert session.trading_allowed is False


def test_configured_session_uses_live_depth_bbo_over_stale_ticker(monkeypatch):
    contract = SimpleNamespace(
        category="INDEX",
        provider="ITICK",
        session_profile_code="US_INDEX_EXTENDED",
    )
    quote = {
        "market_status": "OPEN",
        "quote_freshness": "STALE",
        "feed_state": "STALE",
        "execution_state": "BLOCKED",
        "bid_price": "51668.33",
        "ask_price": "51720.03",
    }
    depth = {
        "market_status": "OPEN",
        "quote_freshness": "LIVE",
        "feed_state": "LIVE",
        "instrument_state": "NORMAL",
        "execution_state": "TRADABLE",
        "best_bid": "51668.33",
        "best_ask": "51720.03",
    }
    captured = {}

    def resolve(**kwargs):
        captured["quote"] = kwargs["quote"]
        return ContractSessionDecision(
            session_state=SESSION_REGULAR_OPEN,
            feed_state="LIVE",
            instrument_state="NORMAL",
            execution_state="TRADABLE",
            trading_allowed=True,
            reason_code="REGULAR_OPEN",
            session_profile_code="US_INDEX_EXTENDED",
            holiday_calendar_code="US",
            timezone_name="America/New_York",
        )

    monkeypatch.setattr(resolver.contract_session_authority, "resolve", resolve)

    session = resolve_contract_trading_session(
        contract_symbol=contract,
        quote=quote,
        depth=depth,
    )

    assert captured["quote"] is depth
    assert session.session_type == "REGULAR_OPEN"
    assert session.trading_allowed is True
    assert session.reason_code == "REGULAR_OPEN"


def test_explicit_suspension_still_overrides_live_depth_bbo(monkeypatch):
    contract = SimpleNamespace(
        category="INDEX",
        provider="ITICK",
        session_profile_code="US_INDEX_EXTENDED",
    )
    quote = {
        "market_status": "CLOSED",
        "provider_trading_status": 1,
        "provider_market_status": "SUSPENDED",
        "instrument_state": "SUSPENDED",
        "bid_price": "51668.33",
        "ask_price": "51720.03",
    }
    depth = {
        "market_status": "OPEN",
        "quote_freshness": "LIVE",
        "feed_state": "LIVE",
        "instrument_state": "NORMAL",
        "execution_state": "TRADABLE",
        "best_bid": "51668.33",
        "best_ask": "51720.03",
    }
    captured = {}

    def resolve(**kwargs):
        captured["quote"] = kwargs["quote"]
        return ContractSessionDecision(
            session_state=SESSION_REGULAR_OPEN,
            feed_state="LIVE",
            instrument_state="SUSPENDED",
            execution_state="BLOCKED",
            trading_allowed=False,
            reason_code="INSTRUMENT_SUSPENDED",
            session_profile_code="US_INDEX_EXTENDED",
            holiday_calendar_code="US",
            timezone_name="America/New_York",
        )

    monkeypatch.setattr(resolver.contract_session_authority, "resolve", resolve)

    session = resolve_contract_trading_session(
        contract_symbol=contract,
        quote=quote,
        depth=depth,
    )

    assert captured["quote"] is quote
    assert session.trading_allowed is False
    assert session.reason_code == "INSTRUMENT_SUSPENDED"
