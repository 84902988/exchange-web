from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import patch

from app.services import market
from app.services import spot_market_provider_ws as provider_ws


def _pair() -> SimpleNamespace:
    return SimpleNamespace(
        symbol="BTCUSDT",
        price_precision=2,
        amount_precision=4,
    )


def _okx_payload(*, ts: object = "1000") -> dict[str, object]:
    row: dict[str, object] = {
        "last": "102",
        "open24h": "100",
        "high24h": "105",
        "low24h": "95",
        "vol24h": "10",
        "volCcy24h": "1000",
    }
    if ts is not None:
        row["ts"] = ts
    return {"data": [row]}


def _bitget_payload(*, ts: object = "2000") -> dict[str, object]:
    row: dict[str, object] = {
        "lastPr": "202",
        "open24h": "200",
        "high24h": "205",
        "low24h": "195",
        "baseVolume": "20",
        "quoteVolume": "4000",
    }
    if ts is not None:
        row["ts"] = ts
    return {"data": [row]}


def _assert_public_time_contract(ticker, *, event_time_ms: int | None, received_at_ms: int) -> None:
    assert ticker.event_time_ms == event_time_ms
    assert ticker.received_at_ms == received_at_ms
    assert ticker.source == "external"
    assert ticker.stale is False
    assert ticker.last_price


def test_okx_rest_ticker_preserves_provider_event_time() -> None:
    with patch.object(market, "_now_ms", return_value=5_000):
        ticker = market._spot_ticker_from_provider(
            pair=_pair(),
            provider_code="OKX_SPOT",
            payload=_okx_payload(),
        )

    _assert_public_time_contract(ticker, event_time_ms=1_000, received_at_ms=5_000)


def test_bitget_rest_ticker_preserves_provider_event_time() -> None:
    with patch.object(market, "_now_ms", return_value=6_000):
        ticker = market._spot_ticker_from_provider(
            pair=_pair(),
            provider_code="BITGET_SPOT",
            payload=_bitget_payload(),
        )

    _assert_public_time_contract(ticker, event_time_ms=2_000, received_at_ms=6_000)


def test_rest_ticker_without_provider_time_is_untimed_and_captures_receive_time_once() -> None:
    clock_calls: list[int] = []

    def clock() -> int:
        clock_calls.append(7_000)
        return 7_000

    with patch.object(market, "_now_ms", side_effect=clock):
        ticker = market._spot_ticker_from_provider(
            pair=_pair(),
            provider_code="OKX_SPOT",
            payload=_okx_payload(ts=None),
        )

    assert clock_calls == [7_000]
    _assert_public_time_contract(ticker, event_time_ms=None, received_at_ms=7_000)


def test_ws_cache_to_public_ticker_preserves_provider_and_receive_times() -> None:
    with patch.object(provider_ws, "_now_ms", return_value=9_000):
        record = provider_ws.normalize_okx_ticker_message(
            {
                "arg": {"channel": "tickers", "instId": "BTC-USDT"},
                **_okx_payload(ts="3000"),
            },
            local_symbol="BTCUSDT",
            provider_symbol="BTC-USDT",
        )

    assert record is not None
    ticker = market._spot_provider_ws_ticker_to_item(_pair(), record)
    assert ticker is not None
    assert ticker.event_time_ms == 3_000
    assert ticker.received_at_ms == 9_000
    assert ticker.provider == provider_ws.PROVIDER_OKX_SPOT
    assert ticker.source == provider_ws.SPOT_PROVIDER_WS_SOURCE


def test_get_market_tickers_keeps_explicit_time_fields() -> None:
    pair = _pair()
    pair.data_source = "BINANCE"

    class Query:
        def filter(self, *args, **kwargs):
            return self

        def order_by(self, *args, **kwargs):
            return self

        def all(self):
            return [pair]

    class Db:
        def query(self, *args, **kwargs):
            return Query()

    with patch.object(market, "_now_ms", return_value=10_000):
        ticker = market._spot_ticker_from_provider(
            pair=pair,
            provider_code="OKX_SPOT",
            payload=_okx_payload(ts="4000"),
        )

    with (
        patch.object(market, "_build_internal_ticker_stats", return_value={}),
        patch.object(market, "_get_external_spot_ticker_cached", return_value=ticker),
        patch.object(market, "_ticker_metadata", return_value={}),
        patch.object(market, "_market_status_payload_for_pair", return_value={"market_status": "OPEN"}),
    ):
        items = market.get_market_tickers(Db(), symbol="BTCUSDT")

    assert len(items) == 1
    assert items[0]["event_time_ms"] == 4_000
    assert items[0]["received_at_ms"] == 10_000


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not inspect.signature(fn).parameters:
            fn()
    print("spot public ticker event-time tests passed")
