from __future__ import annotations

import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.contract_market_service import (  # noqa: E402
    DEPTH_MODE_BBO_ONLY,
    DEPTH_MODE_FULL_DEPTH,
    DEPTH_MODE_SYNTHETIC_FROM_BBO,
    _build_stock_depth_from_prices,
    _depth_from_quote_payload,
    _extract_itick_stock_depth_levels,
)


def test_itick_stock_depth_levels_parse_as_full_depth_source():
    bids, asks, _ts = _extract_itick_stock_depth_levels(
        {
            "data": {
                "s": "AAPL",
                "b": [
                    {"po": 1, "p": 291.6, "v": 100, "o": 2},
                    {"po": 2, "p": 291.5, "v": 120, "o": 3},
                ],
                "a": [
                    {"po": 1, "p": 291.7, "v": 90, "o": 1},
                    {"po": 2, "p": 291.8, "v": 110, "o": 4},
                ],
            }
        }
    )

    assert len(bids) == 2
    assert len(asks) == 2
    assert bids[0][0] == Decimal("291.6")
    assert asks[0][0] == Decimal("291.7")


def test_synthetic_stock_depth_is_marked_from_bbo():
    depth = _build_stock_depth_from_prices(
        symbol="AAPLUSDT_PERP",
        provider_symbol="AAPL",
        best_bid=Decimal("291.6"),
        best_ask=Decimal("291.7"),
        limit=5,
        source="ITICK_DEPTH",
        ts=datetime.utcnow(),
    )

    assert depth["depth_mode"] == DEPTH_MODE_SYNTHETIC_FROM_BBO
    assert len(depth["bids"]) == 5
    assert len(depth["asks"]) == 5


def test_quote_derived_depth_is_marked_bbo_only():
    depth = _depth_from_quote_payload(
        {
            "symbol": "AAPLUSDT_PERP",
            "provider": "ITICK",
            "provider_symbol": "AAPL",
            "bid_price": "291.6",
            "ask_price": "291.7",
            "ts": datetime.utcnow(),
        },
        limit=20,
        source="ITICK_QUOTE",
    )

    assert DEPTH_MODE_FULL_DEPTH == "FULL_DEPTH"
    assert depth["depth_mode"] == DEPTH_MODE_BBO_ONLY
    assert len(depth["bids"]) == 1
    assert len(depth["asks"]) == 1
