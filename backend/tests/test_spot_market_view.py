from __future__ import annotations

from typing import Any, Callable

from app.schemas.market import DepthItem, DepthResponse, TradeItem, TradesResponse
from app.services import spot_market_view


def _depth(
    source: str = "LIVE_WS",
    provider: str | None = "OKX_SPOT",
    *,
    price_precision: int = 2,
) -> DepthResponse:
    return DepthResponse(
        symbol="BTCUSDT",
        price_precision=price_precision,
        bids=[DepthItem(price="2", amount="1")],
        asks=[DepthItem(price="3", amount="1")],
        ts=1000,
        provider=provider,
        source=source,
        freshness="LIVE" if source == "LIVE_WS" else "RECENT",
    )


def _trades(
    symbol: str = "BTCUSDT",
    *,
    source: str | None = "REST",
    freshness: str | None = "RECENT",
    provider: str | None = "OKX_SPOT",
) -> TradesResponse:
    return TradesResponse(
        symbol=symbol,
        provider=provider,
        source=source,
        freshness=freshness,
        trades=[
            TradeItem(
                id=f"{symbol}-trade-1",
                price="2.5",
                amount="1",
                side="BUY",
                ts=1000,
                provider=provider,
                source=source,
                freshness=freshness,
            )
        ],
    )


def _ticker(
    symbol: str = "BTCUSDT",
    *,
    source: str = "LIVE_WS",
    provider: str | None = "OKX_SPOT",
    price_precision: int | None = 2,
    price_tick_size: str | None = None,
    display_price_precision: int | None = None,
    price_precision_source: str | None = None,
    price_precision_provider: str | None = None,
) -> list[dict[str, Any]]:
    return [
        {
            "symbol": symbol,
            "last_price": "2.5",
            "price_change_24h": "0",
            "price_change_percent": "0",
            "price_change_percent_24h": "0",
            "high_24h": "3",
            "low_24h": "2",
            "base_volume_24h": "10",
            "quote_volume_24h": "25",
            "price_precision": price_precision,
            "price_tick_size": price_tick_size,
            "display_price_precision": display_price_precision,
            "price_precision_source": price_precision_source,
            "price_precision_provider": price_precision_provider,
            "amount_precision": 3,
            "source": source,
            "provider": provider,
            "quote_freshness": "LIVE" if source == "LIVE_WS" else "RECENT",
            "market_status": "OPEN",
        }
    ]


def _kline(
    symbol: str = "BTCUSDT",
    *,
    source: str,
    freshness: str,
    provider: str | None = "OKX_SPOT",
) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "interval": "1m",
        "provider": provider,
        "source": source,
        "freshness": freshness,
        "items": [
            {
                "open_time": 1000,
                "close_time": 61000,
                "open": "2",
                "high": "3",
                "low": "1",
                "close": "2.5",
                "volume": "10",
                "quote_volume": "25",
            }
        ],
    }


def _run_view(
    *,
    symbol: str = "BTCUSDT",
    depth: DepthResponse | None = None,
    trades: TradesResponse | None = None,
    tickers: list[dict[str, Any]] | None = None,
    kline: dict[str, Any] | None = None,
    get_klines_hook: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    original_get_depth = spot_market_view.get_depth
    original_get_trades = spot_market_view.get_trades
    original_get_market_tickers = spot_market_view.get_market_tickers
    original_get_klines = spot_market_view.get_klines
    try:
        spot_market_view.get_depth = lambda **kwargs: depth if depth is not None else _depth()
        spot_market_view.get_trades = lambda **kwargs: trades if trades is not None else _trades(symbol)
        spot_market_view.get_market_tickers = lambda **kwargs: tickers if tickers is not None else _ticker(symbol)
        spot_market_view.get_klines = get_klines_hook or (
            lambda **kwargs: kline
            if kline is not None
            else _kline(symbol, source="REST_SNAPSHOT", freshness="RECENT")
        )
        return spot_market_view.get_spot_market_view(db=None, symbol=symbol)
    finally:
        spot_market_view.get_depth = original_get_depth
        spot_market_view.get_trades = original_get_trades
        spot_market_view.get_market_tickers = original_get_market_tickers
        spot_market_view.get_klines = original_get_klines


def test_spot_market_view_kline_uses_live_ws_metadata() -> None:
    view = _run_view(kline=_kline(source="LIVE_WS", freshness="LIVE"))

    assert view["kline_source"] == "LIVE_WS"
    assert view["kline_freshness"] == "LIVE"
    assert view["kline_status"] == "ok"
    assert view["raw_source_summary"]["kline_provider"] == "OKX_SPOT"


def test_spot_market_view_kline_uses_rest_snapshot_metadata_when_live_missing() -> None:
    view = _run_view(kline=_kline(source="REST_SNAPSHOT", freshness="RECENT"))

    assert view["kline_source"] == "REST_SNAPSHOT"
    assert view["kline_freshness"] == "RECENT"
    assert view["kline_source"] != "UNKNOWN"
    assert view["kline_freshness"] != "UNKNOWN"


def test_spot_market_view_internal_symbol_uses_internal_kline_metadata() -> None:
    view = _run_view(
        symbol="MFCUSDT",
        depth=_depth(source="INTERNAL", provider=None),
        trades=_trades("MFCUSDT", source=None, freshness=None, provider=None),
        tickers=_ticker("MFCUSDT", source="INTERNAL", provider=None),
        kline=_kline("MFCUSDT", source="INTERNAL", freshness="RECENT", provider=None),
    )

    assert view["symbol"] == "MFCUSDT"
    assert view["kline_source"] == "INTERNAL"
    assert view["kline_freshness"] == "RECENT"
    assert view["raw_source_summary"]["kline_provider"] is None


def test_spot_market_view_trades_fresh_ws_stays_live_ws() -> None:
    view = _run_view(
        trades=_trades(source="LIVE_WS", freshness="LIVE", provider="OKX_SPOT"),
        kline=_kline(source="REST_SNAPSHOT", freshness="RECENT"),
    )

    assert view["trades_source"] == "LIVE_WS"
    assert view["trades_freshness"] == "LIVE"
    assert view["raw_source_summary"]["trades_source"] == "LIVE_WS"


def test_spot_market_view_exposes_okx_price_tick_size_metadata() -> None:
    view = _run_view(
        tickers=_ticker(
            price_tick_size="0.1",
            display_price_precision=1,
            price_precision_source="PROVIDER_TICK_SIZE",
            price_precision_provider="OKX_SPOT",
        )
    )

    assert view["price_tick_size"] == "0.1"
    assert view["display_price_precision"] == 1
    assert view["price_precision_source"] == "PROVIDER_TICK_SIZE"
    assert view["price_precision_provider"] == "OKX_SPOT"
    assert view["raw_source_summary"]["display_price_precision"] == 1


def test_spot_market_view_exposes_bitget_price_precision_metadata() -> None:
    view = _run_view(
        tickers=_ticker(
            provider="BITGET_SPOT",
            price_tick_size="0.01",
            display_price_precision=2,
            price_precision_source="PROVIDER_TICK_SIZE",
            price_precision_provider="BITGET_SPOT",
        )
    )

    assert view["price_tick_size"] == "0.01"
    assert view["display_price_precision"] == 2
    assert view["price_precision_source"] == "PROVIDER_TICK_SIZE"
    assert view["price_precision_provider"] == "BITGET_SPOT"


def test_spot_market_view_internal_price_precision_uses_trading_pair_metadata() -> None:
    view = _run_view(
        symbol="MFCUSDT",
        depth=_depth(source="INTERNAL", provider=None),
        trades=_trades("MFCUSDT", source=None, freshness=None, provider=None),
        tickers=_ticker(
            "MFCUSDT",
            source="INTERNAL",
            provider=None,
            price_precision=3,
            price_tick_size="0.001",
            display_price_precision=3,
            price_precision_source="TRADING_PAIR",
            price_precision_provider="INTERNAL",
        ),
        kline=_kline("MFCUSDT", source="INTERNAL", freshness="RECENT", provider=None),
    )

    assert view["display_price_precision"] == 3
    assert view["price_tick_size"] == "0.001"
    assert view["price_precision_source"] == "TRADING_PAIR"
    assert view["price_precision_provider"] == "INTERNAL"


def test_spot_market_view_precision_missing_falls_back_to_price_precision() -> None:
    view = _run_view(depth=_depth(price_precision=4), tickers=_ticker(price_precision=4))

    assert view["display_price_precision"] == 4
    assert view["price_tick_size"] == "0.0001"
    assert view["price_precision_source"] == "TRADING_PAIR"


def test_spot_market_view_requests_default_kline_interval_without_cursor() -> None:
    calls: list[dict[str, Any]] = []

    def get_klines_hook(**kwargs):
        calls.append(kwargs)
        return _kline(source="REST_SNAPSHOT", freshness="RECENT")

    view = _run_view(get_klines_hook=get_klines_hook)

    assert view["kline_source"] == "REST_SNAPSHOT"
    assert calls == [
        {
            "db": None,
            "symbol": "BTCUSDT",
            "interval": "1m",
            "limit": 1,
        }
    ]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_market_view tests passed")
