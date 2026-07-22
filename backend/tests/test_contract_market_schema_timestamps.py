from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.schemas.contract_market import (
    ContractDepthResponse,
    ContractMarketViewDetail,
    ContractQuoteResponse,
    ContractTickerItem,
)


UTC_NAIVE = datetime(2026, 7, 21, 12, 23, 20, 825893)


def _assert_utc(value: datetime | None) -> None:
    assert value is not None
    assert value.utcoffset() == timedelta(0)
    assert value.replace(tzinfo=None) == UTC_NAIVE


@pytest.mark.parametrize(
    ("symbol", "provider", "depth_mode"),
    [
        ("BTCUSDT_PERP", "OKX_SWAP", "FULL_DEPTH"),
        ("AAPLUSDT_PERP", "ITICK", "BBO_ONLY"),
        ("EURUSDT_PERP", "ITICK", "BBO_ONLY"),
    ],
)
def test_depth_schema_normalizes_crypto_stock_and_cfd_timestamps_to_utc(
    symbol: str,
    provider: str,
    depth_mode: str,
) -> None:
    response = ContractDepthResponse(
        symbol=symbol,
        provider=provider,
        provider_symbol=symbol.removesuffix("USDT_PERP"),
        depth_mode=depth_mode,
        bids=[["100", "1"]],
        asks=[["101", "1"]],
        source="LIVE",
        ts=UTC_NAIVE,
    )

    _assert_utc(response.ts)


def test_contract_market_api_models_normalize_naive_instants_to_utc() -> None:
    quote = ContractQuoteResponse(
        symbol="BTCUSDT_PERP",
        provider="OKX_SWAP",
        provider_symbol="BTC-USDT-SWAP",
        bid="100",
        ask="101",
        bid_price="100",
        ask_price="101",
        best_bid="100",
        best_ask="101",
        last_price="100.5",
        mark_price="100.5",
        source="LIVE",
        ts=UTC_NAIVE,
        last_good_at=UTC_NAIVE,
    )
    ticker = ContractTickerItem(symbol="AAPLUSDT_PERP", ts=UTC_NAIVE)
    market_view = ContractMarketViewDetail(
        symbol="EURUSDT_PERP",
        display_symbol="EUR/USD",
        last_trade_time=UTC_NAIVE,
        quote_time=UTC_NAIVE,
        last_good_at=UTC_NAIVE,
    )

    _assert_utc(quote.ts)
    _assert_utc(quote.last_good_at)
    _assert_utc(ticker.ts)
    _assert_utc(market_view.last_trade_time)
    _assert_utc(market_view.quote_time)
    _assert_utc(market_view.last_good_at)


def test_contract_market_api_models_preserve_explicit_instants() -> None:
    offset_value = UTC_NAIVE.replace(tzinfo=timezone(timedelta(hours=8)))
    response = ContractTickerItem(symbol="XAUUSDT_PERP", ts=offset_value)

    assert response.ts == offset_value.astimezone(timezone.utc)
    assert response.ts is not None
    assert response.ts.utcoffset() == timedelta(0)
