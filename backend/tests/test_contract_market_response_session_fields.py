from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from app.services.contract_market_service import (
    contract_depth_to_response,
    contract_quote_to_response,
)


SESSION_FIELDS = {
    "feed_state": "LIVE",
    "instrument_state": "NORMAL",
    "execution_state": "DISPLAY_ONLY",
    "session_reason_code": "AFTER_HOURS",
}


def test_contract_quote_response_preserves_session_authority_fields() -> None:
    payload = contract_quote_to_response(
        {
            "symbol": "NAS100USDT_PERP",
            "provider": "ITICK",
            "provider_symbol": "NAS100$GB",
            "bid_price": Decimal("29000"),
            "ask_price": Decimal("29001"),
            "last_price": Decimal("29000.5"),
            "mark_price": Decimal("29000.5"),
            "source": "ITICK_WS",
            "ts": datetime.utcnow(),
            "market_session_type": "AFTER_HOURS",
            **SESSION_FIELDS,
        }
    )

    for key, expected in SESSION_FIELDS.items():
        assert payload[key] == expected


def test_contract_depth_response_preserves_session_authority_fields() -> None:
    payload = contract_depth_to_response(
        {
            "symbol": "NAS100USDT_PERP",
            "provider": "ITICK",
            "provider_symbol": "NAS100$GB",
            "bids": [[Decimal("29000"), Decimal("1")]],
            "asks": [[Decimal("29001"), Decimal("1")]],
            "best_bid": Decimal("29000"),
            "best_ask": Decimal("29001"),
            "source": "ITICK_WS",
            "ts": datetime.utcnow(),
            "market_session_type": "AFTER_HOURS",
            **SESSION_FIELDS,
        }
    )

    for key, expected in SESSION_FIELDS.items():
        assert payload[key] == expected


def test_display_only_session_cannot_be_overwritten_by_legacy_executable_flag() -> None:
    payload = contract_quote_to_response(
        {
            "symbol": "NAS100USDT_PERP",
            "provider": "ITICK",
            "provider_symbol": "NAS100$GB",
            "bid_price": Decimal("29000"),
            "ask_price": Decimal("29001"),
            "last_price": Decimal("29000.5"),
            "mark_price": Decimal("29000.5"),
            "source": "ITICK_WS",
            "ts": datetime.utcnow(),
            "market_status": "CLOSED",
            "market_session_type": "AFTER_HOURS",
            "quote_freshness": "LIVE",
            "execution_state": "DISPLAY_ONLY",
            "session_reason_code": "AFTER_HOURS",
        }
    )

    assert payload["execution_state"] == "DISPLAY_ONLY"
    assert payload["executable"] is False
