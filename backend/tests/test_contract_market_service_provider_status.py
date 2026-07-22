from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.services import contract_market_service as service


def _symbol(category: str = "INDEX") -> SimpleNamespace:
    return SimpleNamespace(
        symbol="TESTUSDT_PERP",
        category=category,
        provider="ITICK",
        provider_symbol="TEST",
        price_precision=2,
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


@pytest.mark.parametrize("category", ["CFD", "INDEX", "FOREX", "METAL", "COMMODITY"])
def test_itick_cfd_ws_quote_preserves_native_bbo_for_every_cfd_category(category):
    contract_symbol = _symbol(category)
    price_field = "p" if category == "CFD" else service.CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION
    quote = service._quote_from_itick_provider_ws_ticker(
        contract_symbol,
        {
            "provider": "ITICK",
            "provider_symbol": "TEST",
            "last_price": "100.00",
            "bid_price": "99.99",
            "ask_price": "100.02",
            "price_field": price_field,
            "provider_trading_status": 0,
            "provider_market_status": "OPEN",
            "price_change_percent_24h": "0.5",
            "ts": datetime.utcnow(),
            "received_at_ms": 1_720_000_000_000,
        },
    )

    assert quote is not None
    assert quote["source"] == service.CONTRACT_PROVIDER_WS_SOURCE
    assert quote["depth_mode"] == service.DEPTH_MODE_BBO_ONLY
    assert quote["bid_price"] == Decimal("99.99")
    assert quote["ask_price"] == Decimal("100.02")
    assert quote["bbo_authority"] == "ITICK_NATIVE_QUOTE"
    assert quote["provider_market_status"] == "OPEN"


def test_itick_index_ws_latest_price_without_native_bbo_is_not_executable_quote():
    quote = service._quote_from_itick_provider_ws_ticker(
        _symbol("INDEX"),
        {
            "provider": "ITICK",
            "last_price": "52196.23",
            "price_field": "ld",
            "ts": datetime.utcnow(),
        },
    )

    assert quote is None


def test_itick_cfd_depth_fails_closed_without_native_provider_levels(monkeypatch):
    monkeypatch.setattr(
        service.itick_market_service,
        "get_market_depth",
        lambda *args, **kwargs: {"data": []},
    )

    with pytest.raises(service.ItickQuoteUnavailable, match="ITICK_DEPTH_UNAVAILABLE"):
        service._get_itick_cfd_depth(_symbol("FOREX"))


def test_contract_depth_cache_fallback_warning_is_throttled_per_symbol(monkeypatch):
    warning_calls = []
    debug_calls = []
    monotonic_values = iter((100.0, 101.0, 161.0))
    service._contract_market_warning_last_at.clear()
    monkeypatch.setattr(service.time, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(service.logger, "warning", lambda message, *args: warning_calls.append((message, args)))
    monkeypatch.setattr(service.logger, "debug", lambda message, *args: debug_calls.append((message, args)))

    def emit(reason: str) -> None:
        service._log_contract_market_warning(
            log_context="contract_depth",
            event="contract_depth_cache_fallback",
            symbol="BTCUSDT_PERP",
            reason=reason,
            message="contract_depth_cache_fallback symbol=%s reason=%s",
            args=("BTCUSDT_PERP", reason),
        )

    emit("provider unavailable")
    emit("provider is in cooldown")
    emit("provider unavailable")

    assert len(warning_calls) == 2
    assert len(debug_calls) == 1


def test_stock_contract_ticker_batch_covers_complete_catalog_without_n_plus_one(monkeypatch):
    symbol_to_code = {
        f"STOCK{index}USDT_PERP": f"US.STOCK{index}"
        for index in range(45)
    }
    batch_calls = []
    single_calls = []

    def get_stock_quotes(region, codes, timeout=None):
        batch_calls.append((region, list(codes), timeout))
        return {
            code: {"p": str(100 + index), "t": datetime.utcnow().timestamp()}
            for index, code in enumerate(codes)
        }

    monkeypatch.setattr(service.itick_market_service, "get_stock_quotes", get_stock_quotes)
    monkeypatch.setattr(
        service.itick_market_service,
        "get_stock_quote",
        lambda *args, **kwargs: single_calls.append((args, kwargs)),
    )
    monkeypatch.setattr(
        service,
        "_contract_ticker_from_stock_contract",
        lambda symbol, provider_symbol, quote_item: {
            "symbol": symbol,
            "last_price": quote_item["p"],
            "source": "ITICK_QUOTE",
            "ts": datetime.utcnow(),
        },
    )

    rows = service._stock_contract_tickers_from_symbols(object(), symbol_to_code)

    assert len(rows) == len(symbol_to_code)
    assert {row["symbol"] for row in rows} == set(symbol_to_code)
    assert len(batch_calls) == 1
    assert batch_calls[0][1] == list(symbol_to_code.values())
    assert single_calls == []


def test_stock_contract_ticker_batch_returns_bounded_fallback_for_every_missing_symbol(monkeypatch):
    symbol_to_code = {
        f"MISS{index}USDT_PERP": f"US.MISS{index}"
        for index in range(25)
    }
    single_calls = []

    monkeypatch.setattr(service.itick_market_service, "get_stock_quotes", lambda *args, **kwargs: {})
    monkeypatch.setattr(
        service.itick_market_service,
        "get_stock_quote",
        lambda *args, **kwargs: single_calls.append((args, kwargs)),
    )
    monkeypatch.setattr(service, "_ticker_from_cached_tradfi_quote", lambda *args, **kwargs: None)
    monkeypatch.setattr(service, "get_last_valid_contract_quote", lambda *args, **kwargs: None)

    rows = service._stock_contract_tickers_from_symbols(object(), symbol_to_code)

    assert len(rows) == len(symbol_to_code)
    assert {row["symbol"] for row in rows} == set(symbol_to_code)
    assert all(row["source"] == "CFD_FALLBACK" for row in rows)
    assert single_calls == []
