from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.services import contract_market_service as service


def _symbol(category: str = "INDEX") -> SimpleNamespace:
    return SimpleNamespace(
        symbol="TESTUSDT_PERP",
        category=category,
        provider="ITICK",
        provider_symbol="TEST",
    )


def _live_payload(**overrides):
    return {
        "source": "LIVE_WS",
        "quote_source": "LIVE_WS",
        "ts": datetime.utcnow(),
        **overrides,
    }


@pytest.mark.parametrize("category", ["CFD", "INDEX", "FOREX", "METAL", "COMMODITY"])
def test_itick_cfd_live_provider_evidence_opens_category_without_symbol_special_case(category):
    status = service._market_status_for_contract_symbol(
        _symbol(category),
        _live_payload(provider_trading_status=0, provider_market_status="OPEN"),
    )

    assert status.market_status == "OPEN"
    assert status.market_session_type == "REGULAR"
    assert status.market_trading_hours == "PROVIDER_NATIVE"


def test_itick_cfd_non_normal_provider_status_closes_category():
    status = service._market_status_for_contract_symbol(
        _symbol("METAL"),
        _live_payload(provider_trading_status=3, provider_market_status="CLOSED"),
    )

    assert status.market_status == "CLOSED"
    assert status.market_session_type == "CLOSED"


def test_itick_cfd_stale_or_fallback_evidence_fails_closed_as_unknown():
    stale_status = service._market_status_for_contract_symbol(
        _symbol("FOREX"),
        {
            "source": "ITICK_QUOTE",
            "ts": datetime.utcnow() - timedelta(minutes=2),
            "provider_trading_status": 0,
            "provider_market_status": "OPEN",
        },
    )
    fallback_status = service._market_status_for_contract_symbol(
        _symbol("COMMODITY"),
        _live_payload(source="CFD_FALLBACK"),
    )

    assert stale_status.market_status == "UNKNOWN"
    assert fallback_status.market_status == "UNKNOWN"


def test_unknown_itick_category_never_inherits_crypto_24x7_permission():
    status = service._market_status_for_contract_symbol(
        _symbol("UNCONFIGURED"),
        _live_payload(),
    )

    assert status.market_status == "UNKNOWN"
