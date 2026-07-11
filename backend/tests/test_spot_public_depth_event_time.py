from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import patch

from app.services import market


def _pair() -> SimpleNamespace:
    return SimpleNamespace(
        symbol="BTCUSDT",
        price_precision=2,
        amount_precision=4,
    )


def _book(*, event_time_field: tuple[str, object] | None = None) -> dict[str, object]:
    payload: dict[str, object] = {
        "bids": [["100", "1.5"]],
        "asks": [["101", "2"]],
    }
    if event_time_field is not None:
        key, value = event_time_field
        payload[key] = value
    return payload


def _assert_unchanged_book_contract(depth, *, provider: str) -> None:
    assert [(item.price, item.amount) for item in depth.bids] == [("100.00", "1.5000")]
    assert [(item.price, item.amount) for item in depth.asks] == [("101.00", "2.0000")]
    assert depth.provider == provider
    assert depth.source == "external"
    assert depth.freshness is None
    assert depth.stale is False


def test_okx_rest_depth_preserves_provider_event_time() -> None:
    with patch.object(market, "_now_ms", return_value=5_000):
        depth = market._spot_depth_from_provider(
            pair=_pair(),
            provider_code="OKX_SPOT",
            payload={"data": [_book(event_time_field=("ts", "1000"))]},
            limit=20,
        )

    assert depth.event_time_ms == 1_000
    assert depth.received_at_ms == 5_000
    assert depth.ts == 1_000
    assert depth.fetched_at == 5_000
    _assert_unchanged_book_contract(depth, provider="OKX_SPOT")


def test_bitget_rest_depth_preserves_provider_event_time() -> None:
    with patch.object(market, "_now_ms", return_value=6_000):
        depth = market._spot_depth_from_provider(
            pair=_pair(),
            provider_code="BITGET_SPOT",
            payload={"data": _book(event_time_field=("ts", "2000"))},
            limit=20,
        )

    assert depth.event_time_ms == 2_000
    assert depth.received_at_ms == 6_000
    assert depth.ts == 2_000
    assert depth.fetched_at == 6_000
    _assert_unchanged_book_contract(depth, provider="BITGET_SPOT")


def test_rest_depth_without_provider_time_marks_event_untimed_and_captures_receive_time_once() -> None:
    clock_calls: list[int] = []

    def clock() -> int:
        clock_calls.append(7_000)
        return 7_000

    with patch.object(market, "_now_ms", side_effect=clock):
        depth = market._spot_depth_from_provider(
            pair=_pair(),
            provider_code="BINANCE_SPOT",
            payload=_book(),
            limit=20,
        )

    assert clock_calls == [7_000]
    assert depth.event_time_ms is None
    assert depth.received_at_ms == 7_000
    assert depth.ts == 7_000
    assert depth.fetched_at == 7_000
    _assert_unchanged_book_contract(depth, provider="BINANCE_SPOT")


def test_other_rest_depth_uses_only_explicit_event_time_ms() -> None:
    with patch.object(market, "_now_ms", return_value=8_000):
        depth = market._spot_depth_from_provider(
            pair=_pair(),
            provider_code="OTHER_SPOT",
            payload=_book(event_time_field=("event_time_ms", "3000")),
            limit=20,
        )

    assert depth.event_time_ms == 3_000
    assert depth.received_at_ms == 8_000
    assert depth.ts == 3_000
    assert depth.fetched_at == 8_000
    _assert_unchanged_book_contract(depth, provider="OTHER_SPOT")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not inspect.signature(fn).parameters:
            fn()
    print("spot public depth event-time tests passed")
