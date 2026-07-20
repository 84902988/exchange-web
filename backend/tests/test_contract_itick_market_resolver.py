import pytest

from app.db.models.contract_symbol import ContractSymbol
from app.services.contract_itick_market_resolver import (
    ITICK_DWM_AMERICA_NEW_YORK_SESSION,
    ITICK_DWM_UTC_PASSTHROUGH,
    normalize_contract_itick_dwm_open_time,
    resolve_contract_itick_dwm_session_policy,
    resolve_contract_itick_kline_provider_evidence,
)


@pytest.mark.parametrize("provider_symbol", ["NAS100", "SPX", "DJI"])
def test_global_index_history_uses_itick_gb_namespace(provider_symbol):
    evidence = resolve_contract_itick_kline_provider_evidence(
        local_symbol=f"{provider_symbol}USDT_PERP",
        provider_symbol=provider_symbol,
        category="INDEX",
        interval="1d",
    )

    assert evidence.market == "indices"
    assert evidence.region == "GB"
    assert evidence.k_type == 8


def test_global_index_dwm_policy_preserves_provider_utc_boundary():
    contract_symbol = ContractSymbol(
        symbol="NAS100USDT_PERP",
        display_name="NAS100",
        category="INDEX",
        provider="ITICK",
        provider_symbol="NAS100",
    )
    policy = resolve_contract_itick_dwm_session_policy(contract_symbol)

    assert policy is not None
    assert policy.code == ITICK_DWM_UTC_PASSTHROUGH
    assert normalize_contract_itick_dwm_open_time(
        1_784_505_600_000,
        "1d",
        policy,
    ) == 1_784_505_600_000


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


@pytest.mark.parametrize(
    ("category", "symbol", "provider_symbol", "interval", "provider_open_time", "utc_open_time"),
    [
        ("STOCK", "AAPLUSDT_PERP", "AAPL", "1d", 1_784_174_400_000, 1_784_160_000_000),
        ("STOCK", "AAPLUSDT_PERP", "AAPL", "1w", 1_783_915_200_000, 1_783_900_800_000),
        ("STOCK", "AAPLUSDT_PERP", "AAPL", "1M", 1_782_878_400_000, 1_782_864_000_000),
        ("GOLD", "XAUUSDT_PERP", "XAUUSD", "1d", 1_784_174_400_000, 1_784_160_000_000),
        ("GOLD", "XAUUSDT_PERP", "XAUUSD", "1w", 1_783_915_200_000, 1_783_900_800_000),
        ("GOLD", "XAUUSDT_PERP", "XAUUSD", "1M", 1_782_878_400_000, 1_782_864_000_000),
        ("FOREX", "EURUSD_PERP", "EURUSD", "1d", 1_784_174_400_000, 1_784_160_000_000),
        ("FOREX", "EURUSD_PERP", "EURUSD", "1w", 1_783_915_200_000, 1_783_900_800_000),
        ("FOREX", "EURUSD_PERP", "EURUSD", "1M", 1_782_878_400_000, 1_782_864_000_000),
    ],
)
def test_production_orm_symbol_resolves_dwm_session_policy(
    category,
    symbol,
    provider_symbol,
    interval,
    provider_open_time,
    utc_open_time,
):
    contract_symbol = ContractSymbol(
        symbol=symbol,
        display_name=symbol,
        category=category,
        provider="ITICK",
        provider_symbol=provider_symbol,
    )

    policy = resolve_contract_itick_dwm_session_policy(contract_symbol)

    assert policy is not None
    assert policy.code == ITICK_DWM_AMERICA_NEW_YORK_SESSION
    assert policy.timezone_name == "America/New_York"
    assert normalize_contract_itick_dwm_open_time(
        provider_open_time,
        interval,
        policy,
    ) == utc_open_time
