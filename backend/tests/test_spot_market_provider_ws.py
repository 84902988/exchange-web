from __future__ import annotations

from app.services import spot_market_provider_ws as provider_ws


def test_normalize_spot_ws_symbol() -> None:
    assert provider_ws.normalize_spot_ws_symbol("BTC/USDT") == "BTCUSDT"
    assert provider_ws.normalize_spot_ws_symbol("btcusdt") == "BTCUSDT"


def test_bitget_depth_message_normalize() -> None:
    record = provider_ws.normalize_bitget_depth_message(
        {
            "arg": {"instType": "SP", "channel": "books15", "instId": "BTCUSDT"},
            "action": "snapshot",
            "data": [
                {
                    "bids": [["2", "1.5"], ["1", "3"], ["0.5", "9"]],
                    "asks": [["3", "2"], ["2.5", "4"], ["4", "1"]],
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
        depth_limit=2,
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["bids"] == [
        {"price": "2", "amount": "1.5"},
        {"price": "1", "amount": "3"},
    ]
    assert record["asks"] == [
        {"price": "2.5", "amount": "4"},
        {"price": "3", "amount": "2"},
    ]


def test_bitget_ticker_message_normalize() -> None:
    record = provider_ws.normalize_bitget_ticker_message(
        {
            "arg": {"instType": "SP", "channel": "ticker", "instId": "BTCUSDT"},
            "data": [
                {
                    "lastPr": "102",
                    "open24h": "100",
                    "high24h": "105",
                    "low24h": "95",
                    "baseVolume": "10",
                    "quoteVolume": "1000",
                    "ts": "1000",
                }
            ],
        },
        local_symbol="btc/usdt",
        provider_symbol="BTCUSDT",
    )

    assert record is not None
    assert record["symbol"] == "BTCUSDT"
    assert record["provider"] == provider_ws.PROVIDER_BITGET_SPOT
    assert record["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE
    assert record["last_price"] == "102"
    assert record["price_change_24h"] == "2"
    assert record["price_change_percent"] == "2"
    assert record["quote_freshness"] == "LIVE"


def test_depth_cache_fresh_and_stale() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    now_ms = provider_ws._now_ms()
    service.set_depth_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "bids": [{"price": "2", "amount": "1"}],
            "asks": [{"price": "3", "amount": "1"}],
            "updated_at_ms": now_ms,
            "ts": now_ms,
        }
    )

    fresh = service.get_fresh_depth("BTC/USDT", max_age_ms=1000)
    assert fresh is not None
    assert fresh.symbol == "BTCUSDT"
    assert fresh.provider == provider_ws.PROVIDER_BITGET_SPOT
    assert fresh.source == provider_ws.SPOT_PROVIDER_WS_SOURCE

    service.set_depth_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "bids": [{"price": "2", "amount": "1"}],
            "asks": [{"price": "3", "amount": "1"}],
            "updated_at_ms": now_ms - 5000,
            "ts": now_ms - 5000,
        }
    )
    assert service.get_fresh_depth("btcusdt", max_age_ms=1000) is None


def test_ticker_cache_fresh_and_stale() -> None:
    service = provider_ws.SpotMarketProviderWsService()
    now_ms = provider_ws._now_ms()
    service.set_ticker_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "last_price": "102",
            "open_24h": "100",
            "updated_at_ms": now_ms,
            "ts": now_ms,
        }
    )

    fresh = service.get_fresh_ticker("BTC/USDT", max_age_ms=1000)
    assert fresh is not None
    assert fresh["symbol"] == "BTCUSDT"
    assert fresh["source"] == provider_ws.SPOT_PROVIDER_WS_SOURCE

    service.set_ticker_cache_for_tests(
        {
            "symbol": "BTCUSDT",
            "provider": provider_ws.PROVIDER_BITGET_SPOT,
            "source": provider_ws.SPOT_PROVIDER_WS_SOURCE,
            "last_price": "102",
            "open_24h": "100",
            "updated_at_ms": now_ms - 5000,
            "ts": now_ms - 5000,
        }
    )
    assert service.get_fresh_ticker("btcusdt", max_age_ms=1000) is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_market_provider_ws tests passed")
