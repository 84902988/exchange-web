from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.schemas.contract_market import ContractQuoteResponse
from app.services import contract_market_service as service
from app.services.contract_market_gateway import ContractMarketGateway
from app.services.contract_ticker_evidence import resolve_contract_ticker_24h_evidence


def _open_status() -> service.ItickMarketStatus:
    return service.ItickMarketStatus(
        market_status="OPEN",
        market_status_text="open",
        market_session_code="US",
        market_timezone="America/New_York",
        market_trading_hours="09:30-16:00",
        market_session_type="REGULAR",
    )


def _contract() -> SimpleNamespace:
    return SimpleNamespace(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        provider_symbol="AAPL",
        category="STOCK",
        price_precision=2,
        closed_market_execution_mode="DISABLED",
    )


def test_ticker_change_is_derived_from_one_last_open_evidence_pair() -> None:
    evidence = resolve_contract_ticker_24h_evidence(
        last_price="95",
        open_24h="100",
        price_change_24h="999",
        price_change_percent_24h="999",
    )

    assert evidence.open_24h == Decimal("100")
    assert evidence.price_change_24h == Decimal("-5")
    assert evidence.price_change_percent_24h == Decimal("-5.00")


def test_missing_ticker_change_remains_unavailable_instead_of_becoming_zero() -> None:
    evidence = resolve_contract_ticker_24h_evidence(last_price="100")

    assert evidence.open_24h is None
    assert evidence.price_change_24h is None
    assert evidence.price_change_percent_24h is None


def test_genuine_zero_ticker_change_is_preserved() -> None:
    evidence = resolve_contract_ticker_24h_evidence(last_price="100", open_24h="100")

    assert evidence.price_change_24h == Decimal("0")
    assert evidence.price_change_percent_24h == Decimal("0")


def test_okx_ticker_normalization_uses_open24h_not_nonexistent_change_field() -> None:
    fields = service._provider_ticker_24h_fields(
        "OKX_SWAP",
        {
            "data": [
                {
                    "last": "105",
                    "open24h": "100",
                    "high24h": "110",
                    "low24h": "90",
                    "vol24h": "12",
                    "volCcy24h": "1260",
                }
            ]
        },
        last_price=Decimal("105"),
    )

    assert fields == {
        "open_24h": "100",
        "price_change_24h": "5",
        "price_change_percent_24h": "5.00",
        "high_24h": "110",
        "low_24h": "90",
        "base_volume_24h": "12",
        "quote_volume_24h": "1260",
    }


def test_itick_ticker_normalization_keeps_negative_signed_evidence() -> None:
    fields = service._extract_itick_24h_ticker_fields(
        {
            "ld": "95",
            "p": "100",
            "change": "-5",
            "rate": "-5",
            "h": "102",
            "l": "94",
            "v": "50",
            "tu": "4800",
        },
        last_price=Decimal("95"),
    )

    assert fields["open_24h"] == "100"
    assert fields["price_change_24h"] == "-5"
    assert fields["price_change_percent_24h"] == "-5.00"


def test_open_market_depth_replacement_preserves_ticker_evidence(monkeypatch) -> None:
    now = datetime.now(timezone.utc)
    quote = {
        "symbol": "AAPLUSDT_PERP",
        "provider": "ITICK",
        "provider_symbol": "AAPL",
        "bid_price": Decimal("94.9"),
        "ask_price": Decimal("95.1"),
        "last_price": Decimal("95"),
        "mark_price": Decimal("95"),
        "source": "ITICK_QUOTE",
        "ts": now,
        "open_24h": "100",
        "price_change_24h": "-5",
        "price_change_percent_24h": "-5",
        "high_24h": "102",
        "low_24h": "94",
        "base_volume_24h": "50",
        "quote_volume_24h": "4800",
    }
    depth = service._depth_payload(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        provider_symbol="AAPL",
        bids=[[Decimal("94.8"), Decimal("2")]],
        asks=[[Decimal("95.2"), Decimal("3")]],
        source="ITICK_DEPTH",
        ts=now,
    )
    monkeypatch.setattr(service, "_get_itick_depth_for_contract", lambda *_args, **_kwargs: depth)
    monkeypatch.setattr(service, "_cache_depth", lambda _depth: None)
    monkeypatch.setattr(service, "_cache_tradfi_quote", lambda _quote: None)

    resolved = service._quote_from_open_market_depth_if_live(
        _contract(),
        quote,
        market_status=_open_status(),
        log_context="test",
    )

    assert resolved["bid_price"] == Decimal("94.8")
    assert resolved["ask_price"] == Decimal("95.2")
    assert resolved["price_change_24h"] == "-5"
    assert resolved["price_change_percent_24h"] == "-5"


def test_cfd_native_depth_is_enriched_without_replacing_native_bbo(monkeypatch) -> None:
    now = datetime.now(timezone.utc)
    contract = SimpleNamespace(
        symbol="EURUSD_PERP",
        provider="ITICK",
        provider_symbol="EURUSD",
        category="FOREX",
        price_precision=5,
    )
    monkeypatch.setattr(
        service.itick_market_service,
        "get_market_depth",
        lambda **_kwargs: {"data": {}},
    )
    monkeypatch.setattr(
        service,
        "_extract_itick_stock_depth_levels",
        lambda _payload: (
            [[Decimal("1.14210"), Decimal("1")]],
            [[Decimal("1.14225"), Decimal("1")]],
            now,
        ),
    )
    monkeypatch.setattr(service, "_get_cached_tradfi_quote_for_contract", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(service.itick_market_service, "is_quote_depth_cooldown_active", lambda: False)
    monkeypatch.setattr(
        service,
        "_get_itick_cfd_reference_price",
        lambda _contract: (
            Decimal("1.14219"),
            "ITICK",
            "latest_price",
            now,
            {
                "open_24h": "1.14144",
                "price_change_24h": "0.00075",
                "price_change_percent_24h": "0.065704",
                "high_24h": "1.14278",
                "low_24h": "1.14088",
                "base_volume_24h": "259978.6",
                "quote_volume_24h": "296805.11612",
            },
        ),
    )

    depth = service._get_itick_cfd_depth(contract, require_ticker_evidence=True)

    assert depth["best_bid"] == Decimal("1.14210")
    assert depth["best_ask"] == Decimal("1.14225")
    assert depth["source"] == "ITICK_DEPTH"
    assert depth["price_change_24h"] == "0.00075"
    assert depth["high_24h"] == "1.14278"
    assert depth["quote_volume_24h"] == "296805.11612"


def test_cfd_depth_only_path_does_not_request_ticker_evidence(monkeypatch) -> None:
    now = datetime.now(timezone.utc)
    contract = SimpleNamespace(
        symbol="XAGUSDT_PERP",
        provider="ITICK",
        provider_symbol="XAGUSD",
        category="METAL",
        price_precision=3,
    )
    monkeypatch.setattr(
        service.itick_market_service,
        "get_market_depth",
        lambda **_kwargs: {"data": {}},
    )
    monkeypatch.setattr(
        service,
        "_extract_itick_stock_depth_levels",
        lambda _payload: (
            [[Decimal("58.957"), Decimal("1")]],
            [[Decimal("58.993"), Decimal("1")]],
            now,
        ),
    )
    monkeypatch.setattr(
        service,
        "_get_itick_cfd_reference_price",
        lambda _contract: (_ for _ in ()).throw(AssertionError("ticker REST must not run")),
    )

    depth = service._get_itick_cfd_depth(contract, require_ticker_evidence=False)

    assert depth["best_bid"] == Decimal("58.957")
    assert depth["best_ask"] == Decimal("58.993")
    assert "price_change_24h" not in depth


def test_closed_market_ticker_enrichment_does_not_replace_last_good_bbo(monkeypatch) -> None:
    quote = {
        "symbol": "AAPLUSDT_PERP",
        "bid_price": Decimal("94.8"),
        "ask_price": Decimal("95.2"),
        "last_price": Decimal("95"),
        "source": "LAST_GOOD_BBO",
    }
    monkeypatch.setattr(service, "_get_cached_tradfi_quote_for_contract", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        service,
        "_contract_ticker_from_stock_contract",
        lambda *_args, **_kwargs: {
            "price_change_24h": "-5",
            "price_change_percent_24h": "-5",
            "high_24h": "102",
            "low_24h": "94",
        },
    )

    resolved = service._ensure_closed_itick_ticker_evidence(_contract(), quote)

    assert resolved["bid_price"] == Decimal("94.8")
    assert resolved["ask_price"] == Decimal("95.2")
    assert resolved["source"] == "LAST_GOOD_BBO"
    assert resolved["price_change_24h"] == "-5"


def test_quote_response_schema_preserves_complete_ticker_evidence() -> None:
    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    payload = service.contract_quote_to_response(
        {
            "symbol": "BTCUSDT_PERP",
            "provider": "OKX_SWAP",
            "provider_symbol": "BTC-USDT-SWAP",
            "price_precision": 1,
            "bid_price": Decimal("99"),
            "ask_price": Decimal("101"),
            "last_price": Decimal("100"),
            "mark_price": Decimal("100"),
            "open_24h": Decimal("98"),
            "price_change_24h": Decimal("2"),
            "price_change_percent_24h": Decimal("2.040816"),
            "high_24h": Decimal("105"),
            "low_24h": Decimal("96"),
            "base_volume_24h": Decimal("12"),
            "quote_volume_24h": Decimal("1200"),
            "source": "LIVE",
            "ts": now,
        }
    )
    response = ContractQuoteResponse(**payload)

    assert response.open_24h == "98"
    assert response.price_change_24h == "2"
    assert response.price_change_percent_24h == "2.040816"
    assert response.quote_volume_24h == "1200"


def test_gateway_broadcast_signatures_include_ticker_only_changes() -> None:
    gateway = object.__new__(ContractMarketGateway)
    quote = {
        "bid_price": "99",
        "ask_price": "101",
        "last_price": "100",
        "mark_price": "100",
        "price_change_24h": "1",
        "price_change_percent_24h": "1",
        "source": "LIVE_WS",
    }
    updated_quote = {**quote, "price_change_24h": "2", "price_change_percent_24h": "2"}
    state = {"display_price": "100", "ticker": quote}
    updated_state = {"display_price": "100", "ticker": updated_quote}

    assert gateway._quote_signature(quote) != gateway._quote_signature(updated_quote)
    assert gateway._state_signature(state) != gateway._state_signature(updated_state)
