from app.services.contract_itick_market_resolver import (
    resolve_contract_itick_kline_provider_evidence,
)


def test_aapl_history_provider_evidence():
    evidence = resolve_contract_itick_kline_provider_evidence(
        local_symbol="AAPLUSDT_PERP",
        provider_symbol="",
        category="STOCK",
        interval="1d",
    )

    assert evidence.provider_symbol == "AAPL"
    assert evidence.market == "stock"
    assert evidence.region == "US"
    assert evidence.k_type == 8
    assert evidence.endpoint == "/stock/kline"
    assert evidence.cursor_parameter == "et"


def test_eurusd_history_provider_evidence():
    evidence = resolve_contract_itick_kline_provider_evidence(
        local_symbol="EURUSD_PERP",
        provider_symbol="EURUSD",
        category="FOREX",
        interval="1w",
    )

    assert evidence.provider_symbol == "EURUSD"
    assert evidence.market == "forex"
    assert evidence.region == "GB"
    assert evidence.k_type == 9
    assert evidence.endpoint == "/forex/kline"
    assert evidence.cursor_parameter == "et"


def test_xau_history_provider_evidence_normalizes_contract_quote_asset():
    evidence = resolve_contract_itick_kline_provider_evidence(
        local_symbol="XAUUSDT_PERP",
        provider_symbol=None,
        category="GOLD",
        interval="1M",
    )

    assert evidence.category == "METAL"
    assert evidence.provider_symbol == "XAUUSD"
    assert evidence.market == "forex"
    assert evidence.region == "GB"
    assert evidence.k_type == 10
    assert evidence.endpoint == "/forex/kline"
    assert evidence.cursor_parameter == "et"
