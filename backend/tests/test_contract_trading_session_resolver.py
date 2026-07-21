from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

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
