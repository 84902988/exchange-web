from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from app.services.market import _ticker_metadata


def test_spot_ticker_metadata_exposes_authoritative_order_minimums() -> None:
    pair = SimpleNamespace(
        symbol="BTCUSDT",
        display_symbol="BTC/USDT",
        base_asset=SimpleNamespace(symbol="BTC", icon_url=None),
        quote_asset=SimpleNamespace(symbol="USDT"),
        price_precision=2,
        amount_precision=6,
        min_amount=Decimal("0.001"),
        min_notional=Decimal("5"),
        asset_type="CRYPTO",
        data_source="BINANCE",
        market_mode="MATCHING",
        external_symbol="BTCUSDT",
        external_region=None,
        market_category="CRYPTO",
        market_sub_category=None,
        display_category="CRYPTO",
        display_group=None,
        sort_order=0,
        is_hot=True,
        show_spot_logo=False,
        spot_logo_url=None,
        spot_logo_alt=None,
    )

    payload = _ticker_metadata(pair)

    assert payload["min_amount"] == "0.001"
    assert payload["min_notional"] == "5"
