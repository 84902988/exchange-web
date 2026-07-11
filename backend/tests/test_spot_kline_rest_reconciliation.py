from __future__ import annotations

from app.services import market, market_kline_cache
from app.services.spot_kline_revision import KlineRestWatermark, KlineRevisionCandidate


def _item(open_time: int, close: str) -> dict[str, object]:
    return {
        "open_time": open_time,
        "close_time": open_time + 60_000,
        "open": "100",
        "high": "102",
        "low": "99",
        "close": close,
        "volume": "10",
        "quote_volume": "1010",
    }


def _prepare_cache_mocks(monkeypatch) -> list[list[dict[str, object]]]:
    writes: list[list[dict[str, object]]] = []
    monkeypatch.setattr(market_kline_cache, "_read_cached_klines", lambda *args, **kwargs: [])
    monkeypatch.setattr(market_kline_cache, "record_kline_external_fetch", lambda **kwargs: None)

    def capture_upsert(*args, **kwargs) -> int:
        writes.append([dict(item) for item in kwargs["items"]])
        return len(writes[-1])

    monkeypatch.setattr(market_kline_cache, "upsert_klines", capture_upsert)
    return writes


def test_rejected_rest_candidates_never_reach_db_upsert(monkeypatch) -> None:
    writes = _prepare_cache_mocks(monkeypatch)

    result = market_kline_cache.get_klines_cache_first(
        object(),
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        limit=1,
        source="EXTERNAL_SPOT",
        fetch_external=lambda limit, end_time_ms: [_item(120_000, "100")],
        reconcile_external_items=lambda items: [],
    )

    assert list(result) == []
    assert result.origin == market_kline_cache.KLINE_CACHE_ORIGIN_EMPTY
    assert result.cache_status == market_kline_cache.KLINE_CACHE_STATUS_RECONCILIATION_REJECTED
    assert writes == []


def test_only_accepted_rest_candidates_reach_db_upsert(monkeypatch) -> None:
    writes = _prepare_cache_mocks(monkeypatch)
    historical = _item(120_000, "100")
    rejected_current = _item(180_000, "99")

    result = market_kline_cache.get_klines_cache_first(
        object(),
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        limit=2,
        source="EXTERNAL_SPOT",
        fetch_external=lambda limit, end_time_ms: [historical, rejected_current],
        reconcile_external_items=lambda items: [items[0]],
    )

    assert [item["open_time"] for item in result] == [120_000]
    assert len(writes) == 1
    assert [item["open_time"] for item in writes[0]] == [120_000]


def _ws_winner(*, revision_seq: int, close: str) -> KlineRevisionCandidate:
    return KlineRevisionCandidate(
        symbol="BTCUSDT",
        interval="1m",
        open_time=180_000,
        open="100",
        high="102",
        low="99",
        close=close,
        volume="10",
        quote_volume="1010",
        provider="OKX_SPOT",
        source="LIVE_WS",
        transport="WS",
        provider_generation=0,
        revision_epoch=1,
        revision_seq=revision_seq,
        received_at_ms=1_000 + revision_seq,
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
    )


def test_rejected_rest_batch_does_not_update_last_good(monkeypatch) -> None:
    class Pair:
        symbol = "BTCUSDT"

    class Provider:
        provider_code = "OKX_SPOT"

    request_winner = _ws_winner(revision_seq=1, close="100")
    current_winner = _ws_winner(revision_seq=2, close="101")
    watermarks = iter(
        [
            KlineRestWatermark("OKX_SPOT", 1, 1, request_winner),
            KlineRestWatermark("OKX_SPOT", 1, 2, current_winner),
        ]
    )
    rest_item = {
        **_item(180_000, "100"),
        "_provider": "OKX_SPOT",
        "_received_at_ms": 999_999,
        "_is_closed": False,
        "_close_state_source": "PROVIDER_CONFIRMED",
    }

    monkeypatch.setattr(market, "_get_active_pair", lambda db, symbol: Pair())
    monkeypatch.setattr(market, "_normalize_data_source", lambda pair: market.DATA_SOURCE_BINANCE)
    monkeypatch.setattr(
        market,
        "_enabled_spot_market_providers_for_pair",
        lambda db, pair, **kwargs: [Provider()],
    )
    monkeypatch.setattr(
        market,
        "_capture_spot_kline_rest_watermark",
        lambda **kwargs: next(watermarks),
    )

    def fake_fetch(*args, **kwargs):
        kwargs["before_provider_fetch"]("OKX_SPOT")
        kwargs["fetch_metadata"].update(provider="OKX_SPOT", from_last_good=False)
        assert kwargs["update_last_good"] is False
        return [rest_item]

    def fake_cache_first(*args, **kwargs):
        raw_items = list(kwargs["fetch_external"](1, None))
        accepted = list(kwargs["reconcile_external_items"](raw_items))
        return market_kline_cache.KlineCacheResult(
            accepted,
            origin=(
                market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
                if accepted
                else market_kline_cache.KLINE_CACHE_ORIGIN_EMPTY
            ),
            cache_status=(
                market_kline_cache.KLINE_CACHE_STATUS_MISS
                if accepted
                else market_kline_cache.KLINE_CACHE_STATUS_RECONCILIATION_REJECTED
            ),
        )

    monkeypatch.setattr(market, "_fetch_external_spot_klines", fake_fetch)
    monkeypatch.setattr(market, "get_klines_cache_first", fake_cache_first)
    cache_key = (Pair.symbol, "1m")
    original = market._SPOT_LAST_GOOD_KLINES.pop(cache_key, None)
    try:
        result = market.get_klines(None, Pair.symbol, "1m", limit=1, force_rest=True)

        assert result["items"] == []
        assert cache_key not in market._SPOT_LAST_GOOD_KLINES
    finally:
        market._SPOT_LAST_GOOD_KLINES.pop(cache_key, None)
        if original is not None:
            market._SPOT_LAST_GOOD_KLINES[cache_key] = original


def test_rest_adapter_captures_received_time_once_for_the_batch(monkeypatch) -> None:
    calls = 0

    def fake_now_ms() -> int:
        nonlocal calls
        calls += 1
        return 999_999

    monkeypatch.setattr(market, "_now_ms", fake_now_ms)
    rows = market._spot_klines_from_provider(
        provider_code="OKX_SPOT",
        payload={
            "data": [
                ["120000", "100", "102", "99", "101", "10", "0", "1010", "1"],
                ["180000", "101", "103", "100", "102", "11", "0", "1122", "0"],
            ]
        },
        interval="1m",
        limit=2,
    )

    assert calls == 1
    assert [item["_received_at_ms"] for item in rows] == [999_999, 999_999]
    assert [item["_is_closed"] for item in rows] == [True, False]
    assert {item["_close_state_source"] for item in rows} == {"PROVIDER_CONFIRMED"}


def test_accepted_cold_start_batch_updates_last_good_after_reconciliation(monkeypatch) -> None:
    class Pair:
        symbol = "ETHUSDT"

    class Provider:
        provider_code = "OKX_SPOT"

    rest_item = {
        **_item(180_000, "100"),
        "_provider": "OKX_SPOT",
        "_received_at_ms": 999_999,
        "_is_closed": True,
        "_close_state_source": "PROVIDER_CONFIRMED",
    }
    cold = KlineRestWatermark("OKX_SPOT", 0, 0)

    monkeypatch.setattr(market, "_get_active_pair", lambda db, symbol: Pair())
    monkeypatch.setattr(market, "_normalize_data_source", lambda pair: market.DATA_SOURCE_BINANCE)
    monkeypatch.setattr(
        market,
        "_enabled_spot_market_providers_for_pair",
        lambda db, pair, **kwargs: [Provider()],
    )
    monkeypatch.setattr(market, "_capture_spot_kline_rest_watermark", lambda **kwargs: cold)

    def fake_fetch(*args, **kwargs):
        kwargs["before_provider_fetch"]("OKX_SPOT")
        kwargs["fetch_metadata"].update(provider="OKX_SPOT", from_last_good=False)
        assert kwargs["update_last_good"] is False
        return [rest_item]

    def fake_cache_first(*args, **kwargs):
        raw_items = list(kwargs["fetch_external"](1, None))
        accepted = list(kwargs["reconcile_external_items"](raw_items))
        return market_kline_cache.KlineCacheResult(
            accepted,
            origin=market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status=market_kline_cache.KLINE_CACHE_STATUS_MISS,
        )

    monkeypatch.setattr(market, "_fetch_external_spot_klines", fake_fetch)
    monkeypatch.setattr(market, "get_klines_cache_first", fake_cache_first)
    cache_key = (Pair.symbol, "1m")
    original = market._SPOT_LAST_GOOD_KLINES.pop(cache_key, None)
    try:
        result = market.get_klines(None, Pair.symbol, "1m", limit=1, force_rest=True)

        assert [item["open_time"] for item in result["items"]] == [180_000]
        cached = market._SPOT_LAST_GOOD_KLINES[cache_key]
        assert [item["open_time"] for item in cached["items"]] == [180_000]
        assert all(not key.startswith("_") for key in cached["items"][0])
    finally:
        market._SPOT_LAST_GOOD_KLINES.pop(cache_key, None)
        if original is not None:
            market._SPOT_LAST_GOOD_KLINES[cache_key] = original
