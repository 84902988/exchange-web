from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.contract_market_guard import executable_contract_quote_rejection_reason, is_executable_contract_quote


def _quote(**overrides):
    payload = {
        "symbol": "ABBVUSDT_PERP",
        "category": "STOCK",
        "market_status": "CLOSED",
        "quote_source": "LAST_GOOD_BBO",
        "source": "LAST_GOOD_BBO",
        "quote_freshness": "LAST_VALID",
        "closed_market_execution_mode": "LAST_GOOD_BBO",
        "bid_price": "221.95",
        "ask_price": "222.02",
        "mark_price": "221.985",
        "last_good_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
    }
    payload.update(overrides)
    return payload


def test_closed_last_good_bbo_last_valid_recent_is_not_executable():
    assert is_executable_contract_quote(_quote(market_session_type="CLOSED")) is False


def test_closed_last_good_bbo_last_valid_expired_is_not_executable():
    quote = _quote(
        market_session_type="CLOSED",
        last_good_at=(datetime.now(timezone.utc) - timedelta(days=4)).isoformat(),
    )
    assert is_executable_contract_quote(quote) is False


def test_closed_last_good_bbo_calendar_validity_does_not_override_session():
    expired_quote = _quote(
        market_session_type="CLOSED",
        last_good_at=(datetime.now(timezone.utc) - timedelta(days=4)).isoformat(),
    )
    assert is_executable_contract_quote({**expired_quote, "last_good_bbo_valid": True}) is False
    assert is_executable_contract_quote({**expired_quote, "last_good_bbo_valid": False}) is False


def test_closed_last_good_bbo_stale_remains_not_executable():
    stale_quote = _quote(market_session_type="CLOSED", quote_freshness="STALE")
    assert is_executable_contract_quote(stale_quote) is False
    assert is_executable_contract_quote({**stale_quote, "last_good_bbo_valid": True}) is False


def test_stock_premarket_last_good_bbo_is_not_executable():
    quote = _quote(market_session_type="PRE_MARKET")
    assert is_executable_contract_quote(quote) is False
    assert executable_contract_quote_rejection_reason(quote) == "pre_market"


def test_stock_after_hours_last_good_bbo_is_not_executable():
    quote = _quote(symbol="AAPLUSDT_PERP", market_session_type="AFTER_HOURS")
    assert is_executable_contract_quote(quote) is False
    assert executable_contract_quote_rejection_reason(quote) == "after_hours"


def test_stock_holiday_last_good_bbo_is_not_executable():
    quote = _quote(symbol="AAPLUSDT_PERP", market_status="HOLIDAY", market_session_type="HOLIDAY")
    assert is_executable_contract_quote(quote) is False
    assert executable_contract_quote_rejection_reason(quote) == "holiday"


def test_stock_regular_open_live_bbo_is_executable():
    quote = _quote(
        market_status="OPEN",
        market_session_type="REGULAR_OPEN",
        quote_source="LIVE",
        source="LIVE",
        quote_freshness="LIVE",
        closed_market_execution_mode="LAST_GOOD_BBO",
    )
    assert is_executable_contract_quote(quote) is True


def test_plain_stale_quote_remains_not_executable():
    quote = _quote(
        market_status="OPEN",
        market_session_type="REGULAR_OPEN",
        quote_source="LIVE",
        source="LIVE",
        quote_freshness="STALE",
        closed_market_execution_mode="DISABLED",
    )
    assert is_executable_contract_quote(quote) is False


def test_closed_disabled_last_valid_bbo_is_not_executable():
    quote = _quote(market_session_type="CLOSED", closed_market_execution_mode="DISABLED")
    assert is_executable_contract_quote(quote) is False


def test_crypto_closed_last_good_bbo_remains_not_executable():
    quote = _quote(symbol="BTCUSDT_PERP", category="CRYPTO")
    contract_symbol = SimpleNamespace(category="CRYPTO", closed_market_execution_mode="LAST_GOOD_BBO")
    assert is_executable_contract_quote(quote, contract_symbol=contract_symbol) is False


def test_invalid_bbo_is_not_executable():
    assert is_executable_contract_quote(_quote(bid_price="0", ask_price="222.02")) is False
    assert is_executable_contract_quote(_quote(bid_price="223", ask_price="222")) is False


if __name__ == "__main__":
    test_closed_last_good_bbo_last_valid_recent_is_not_executable()
    test_closed_last_good_bbo_last_valid_expired_is_not_executable()
    test_closed_last_good_bbo_calendar_validity_does_not_override_session()
    test_closed_last_good_bbo_stale_remains_not_executable()
    test_stock_premarket_last_good_bbo_is_not_executable()
    test_stock_after_hours_last_good_bbo_is_not_executable()
    test_stock_holiday_last_good_bbo_is_not_executable()
    test_stock_regular_open_live_bbo_is_executable()
    test_plain_stale_quote_remains_not_executable()
    test_closed_disabled_last_valid_bbo_is_not_executable()
    test_crypto_closed_last_good_bbo_remains_not_executable()
    test_invalid_bbo_is_not_executable()
