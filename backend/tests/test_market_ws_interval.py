from __future__ import annotations

from app.services import market_ws


def test_market_ws_normalize_interval_preserves_utc_provider_periods() -> None:
    assert market_ws._normalize_interval("1Dutc") == "1Dutc"
    assert market_ws._normalize_interval("1dutc") == "1Dutc"
    assert market_ws._normalize_interval("1Wutc") == "1Wutc"
    assert market_ws._normalize_interval("1wutc") == "1Wutc"
    assert market_ws._normalize_interval("1Mutc") == "1Mutc"
    assert market_ws._normalize_interval("1mutc") == "1Mutc"


def test_market_ws_normalize_interval_keeps_existing_policy() -> None:
    assert market_ws._normalize_interval("1M") == "1M"
    assert market_ws._normalize_interval("1H") == "1h"
    assert market_ws._normalize_interval("bad") == "1m"
