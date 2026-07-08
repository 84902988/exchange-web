from __future__ import annotations

from types import SimpleNamespace

from app.schemas.market import DepthResponse
from app.services import market
from app.services.market_ws import MarketWsManager


def _asset(symbol: str) -> SimpleNamespace:
    return SimpleNamespace(symbol=symbol)


def _pair(
    *,
    symbol: str = "MFCUSDT",
    base: str = "MFC",
    quote: str = "USDT",
    asset_type: str = "RWA",
    market_category: str = "CRYPTO",
    display_category: str = "RWA",
    data_source: str = "INTERNAL",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        symbol=symbol,
        base_asset=_asset(base),
        quote_asset=_asset(quote),
        asset_type=asset_type,
        market_category=market_category,
        market_sub_category=None,
        display_category=display_category,
        display_group=None,
        external_symbol=None,
        data_source=data_source,
        market_mode="INTERNAL",
        sort_order=0,
        is_hot=False,
        status=1,
    )


def test_selector_spot_category_includes_enabled_internal_spot_pair() -> None:
    pair = _pair()
    pair_without_display_category = _pair(display_category=None)

    assert market._pair_matches_category(pair, "spot") is True
    assert market._pair_matches_category(pair, "rwa") is True
    assert market._pair_matches_category(pair_without_display_category, "spot") is True
    assert market._pair_matches_category(pair_without_display_category, "rwa") is True
    assert market._pair_matches_keyword(pair, "MFCUSDT") is True
    assert market._pair_matches_keyword(pair, "MFC/USDT") is True
    assert market._pair_matches_keyword(pair, "mfc") is True
    assert market._pair_matches_keyword(pair, "usdt") is True


def test_selector_spot_category_does_not_include_contract_pair() -> None:
    pair = _pair(
        symbol="BTCUSDT-PERP",
        base="BTC",
        asset_type="CONTRACT",
        market_category="CONTRACT",
        display_category="MAINSTREAM",
    )

    assert market._pair_matches_category(pair, "spot") is False


def test_spot_ws_depth_payload_marks_empty_book_missing() -> None:
    manager = MarketWsManager()
    depth = DepthResponse(
        symbol="MFCUSDT",
        price_precision=3,
        amount_precision=3,
        bids=[],
        asks=[],
        ts=1000,
        source="INTERNAL",
        freshness="RECENT",
    )

    payload = manager._depth_update_payload("MFCUSDT", depth)

    assert payload["type"] == "spot_depth_update"
    assert payload["symbol"] == "MFCUSDT"
    assert payload["depth"]["bids"] == []
    assert payload["depth"]["asks"] == []
    assert payload["depth"]["source"] == "MISSING"
    assert payload["depth"]["freshness"] == "MISSING"
    assert payload["depth"]["stale"] is False


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASSED {name}")
