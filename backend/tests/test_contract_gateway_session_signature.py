from __future__ import annotations

from copy import deepcopy

from app.services.contract_market_gateway import ContractMarketGateway


def test_quote_signature_changes_when_only_session_state_changes() -> None:
    gateway = ContractMarketGateway()
    quote = {
        "provider": "ITICK",
        "provider_symbol": "NAS100",
        "bid_price": "29000",
        "ask_price": "29001",
        "last_price": "29000.5",
        "source": "LIVE_WS",
        "market_status": "OPEN",
        "market_session_type": "REGULAR_OPEN",
        "execution_state": "TRADABLE",
        "session_reason_code": "REGULAR_OPEN",
    }
    after_hours = deepcopy(quote)
    after_hours.update(
        market_status="CLOSED",
        market_session_type="AFTER_HOURS",
        execution_state="DISPLAY_ONLY",
        session_reason_code="AFTER_HOURS",
    )

    assert gateway._quote_signature(quote) != gateway._quote_signature(after_hours)


def test_state_signature_changes_when_only_session_state_changes() -> None:
    gateway = ContractMarketGateway()
    state = {
        "display_price": "29000.5",
        "display_price_source": "TICKER_LAST",
        "current_price_source": "TICKER_LAST",
        "best_bid": "29000",
        "best_ask": "29001",
        "execution_bid": "29000",
        "execution_ask": "29001",
        "display_state": "LIVE",
        "executable": True,
        "market_status": "OPEN",
        "market_session_type": "REGULAR_OPEN",
        "session_reason_code": "REGULAR_OPEN",
    }
    after_hours = deepcopy(state)
    after_hours.update(
        market_status="CLOSED",
        market_session_type="AFTER_HOURS",
        session_reason_code="AFTER_HOURS",
        executable=False,
    )

    assert gateway._state_signature(state) != gateway._state_signature(after_hours)
