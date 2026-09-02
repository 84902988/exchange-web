from __future__ import annotations

from copy import deepcopy

from app.schemas.contract_market_domain_snapshot import ContractMarketDomainName
from app.services.contract_market_gateway import (
    CONTRACT_MARKET_CACHE_DEPTH,
    ContractMarketGateway,
    _execution_authority_renewal_evidence,
)


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


def test_fresh_execution_authority_changes_renewal_evidence() -> None:
    gateway = ContractMarketGateway()
    first_authority = {
        "source": "LIVE_WS",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "provider_generation": 7,
        "revision_epoch": 7,
        "revision_sequence": 10,
        "received_at_ms": 1_720_000_000_000,
    }
    renewed_authority = {
        **first_authority,
        "revision_sequence": 11,
        "received_at_ms": 1_720_000_000_200,
    }

    assert _execution_authority_renewal_evidence(
        first_authority
    ) != _execution_authority_renewal_evidence(renewed_authority)
    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_DEPTH,
        "BTCUSDT_PERP",
        {"bids": [["100", "1"]], "asks": [["101", "1"]]},
        authority_payload=first_authority,
    )
    assert not gateway._execution_authority_changed(
        ContractMarketDomainName.DEPTH,
        "BTCUSDT_PERP",
        first_authority,
    )
    assert gateway._execution_authority_changed(
        ContractMarketDomainName.DEPTH,
        "BTCUSDT_PERP",
        renewed_authority,
    )


def test_state_signature_renews_execution_without_waking_display_only_state() -> None:
    gateway = ContractMarketGateway()
    state = {
        "display_price": "100.5",
        "best_bid": "100",
        "best_ask": "101",
        "execution_bid": "100",
        "execution_ask": "101",
        "executable": True,
        "quote_time": "2026-09-02T00:00:00+00:00",
        "snapshot_metadata": {
            "depth": {
                "provider_generation": 7,
                "revision": {"epoch": 7, "sequence": 10},
                "received_at_ms": 1_000,
            }
        },
    }
    renewed = deepcopy(state)
    renewed["snapshot_metadata"]["depth"].update(
        revision={"epoch": 7, "sequence": 11},
        received_at_ms=1_200,
    )

    assert gateway._state_signature(state) != gateway._state_signature(renewed)

    display_only = deepcopy(state)
    display_only.update(
        executable=False,
        execution_bid=None,
        execution_ask=None,
    )
    renewed_display_only = deepcopy(renewed)
    renewed_display_only.update(
        executable=False,
        execution_bid=None,
        execution_ask=None,
    )

    assert gateway._state_signature(display_only) == gateway._state_signature(
        renewed_display_only
    )
