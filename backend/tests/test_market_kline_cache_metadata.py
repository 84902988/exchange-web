from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services import market_kline_cache  # noqa: E402


def _bar(
    open_time: int,
    *,
    revision_epoch: int | None = None,
    revision_seq: int | None = None,
) -> dict:
    item = {
        "open_time": open_time,
        "close_time": open_time + 60_000,
        "open": "100",
        "high": "110",
        "low": "90",
        "close": "105",
        "volume": "1",
        "quote_volume": "105",
    }
    if revision_epoch is not None:
        item.update(
            {
                "revision_epoch": revision_epoch,
                "revision_seq": revision_seq,
                "is_closed": False,
                "close_state_source": "PROVIDER_CONFIRMED",
            }
        )
    return item


def _call_with_result(monkeypatch, result, *, end_time_ms=None):
    monkeypatch.setattr(
        market_kline_cache,
        "_get_klines_cache_first",
        lambda *_args, **_kwargs: result,
    )
    return market_kline_cache.get_klines_cache_first(
        object(),
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        limit=2,
        source="EXTERNAL_SPOT",
        fetch_external=lambda *_args: [],
        end_time_ms=end_time_ms,
    )


def test_kline_cache_metadata_preserves_data_order_and_latest_revision(monkeypatch) -> None:
    later = _bar(120_000, revision_epoch=4, revision_seq=12)
    earlier = _bar(60_000, revision_epoch=4, revision_seq=11)
    result = market_kline_cache.KlineCacheResult(
        [later, earlier],
        origin=market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH,
        cache_status=market_kline_cache.KLINE_CACHE_STATUS_MISS,
    )

    actual = _call_with_result(monkeypatch, result)

    assert actual == [later, earlier]
    assert actual.metadata is not None
    metadata = actual.metadata.to_dict()
    assert set(metadata) == {
        "data",
        "source",
        "provider",
        "updated_at",
        "version",
        "interval",
        "last_open_time",
        "revision",
    }
    assert metadata["data"] == [later, earlier]
    assert metadata["source"] == "REST_SNAPSHOT"
    assert metadata["provider"] is None
    assert metadata["interval"] == "1m"
    assert metadata["last_open_time"] == 120_000
    assert metadata["revision"] == {
        "epoch": 4,
        "sequence": 12,
        "is_closed": False,
        "close_state_source": "PROVIDER_CONFIRMED",
    }


def test_history_rest_metadata_is_distinct_from_current_snapshot(monkeypatch) -> None:
    result = market_kline_cache.KlineCacheResult(
        [_bar(60_000)],
        origin=market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH,
        cache_status=market_kline_cache.KLINE_CACHE_STATUS_MISS,
    )

    actual = _call_with_result(monkeypatch, result, end_time_ms=120_000)

    assert actual.metadata is not None
    assert actual.metadata.source == "REST_HISTORY"
    assert actual.metadata.revision is None


def test_contract_monthly_provider_boundary_cache_supports_contract_interval(monkeypatch) -> None:
    stored: dict[str, dict] = {}

    monkeypatch.setattr(
        market_kline_cache,
        "cache_set_json",
        lambda key, payload, *_args, **_kwargs: stored.__setitem__(key, dict(payload)),
    )
    monkeypatch.setattr(
        market_kline_cache,
        "cache_get_json",
        lambda key: stored.get(key),
    )

    earliest_available_time = 1_561_910_400_000
    written = market_kline_cache._write_kline_history_boundary_cache(
        market_type="contract",
        symbol="BTCUSDT_PERP",
        interval="1M",
        earliest_available_time=earliest_available_time,
        terminal_reason=market_kline_cache.KLINE_TERMINAL_REASON_PROVIDER_HISTORY_BOUNDARY,
    )
    cached = market_kline_cache._read_kline_history_boundary_cache(
        market_type="contract",
        symbol="BTCUSDT_PERP",
        interval="1M",
    )

    assert written is not None
    assert cached == {
        "symbol": "BTCUSDT_PERP",
        "interval": "1M",
        "earliest_available_time": earliest_available_time,
        "terminal_reason": market_kline_cache.KLINE_TERMINAL_REASON_PROVIDER_HISTORY_BOUNDARY,
        "boundary_scope": market_kline_cache.KLINE_HISTORY_BOUNDARY_SCOPE_PROVIDER,
    }


def test_contract_monthly_provider_boundary_returns_terminal_result(monkeypatch) -> None:
    stored: dict[str, dict] = {}
    boundary_cursor = 1_561_910_400_000
    provider_calls = []

    monkeypatch.setattr(
        market_kline_cache,
        "cache_set_json",
        lambda key, payload, *_args, **_kwargs: stored.__setitem__(key, dict(payload)),
    )
    monkeypatch.setattr(
        market_kline_cache,
        "cache_get_json",
        lambda key: stored.get(key),
    )
    monkeypatch.setattr(
        market_kline_cache,
        "_read_cached_klines",
        lambda *_args, **_kwargs: [],
    )
    monkeypatch.setattr(
        market_kline_cache,
        "_read_continuous_monthly_history_start_ms",
        lambda *_args, **_kwargs: None,
    )

    def provider_boundary(_limit: int, _end_time_ms: int | None):
        provider_calls.append((_limit, _end_time_ms))
        raise market_kline_cache.KlineProviderHistoryBoundary(
            "contract provider monthly history boundary",
            provider_error_provider="OKX_SWAP",
        )

    def request_boundary():
        return market_kline_cache.get_klines_cache_first(
            object(),
            market_type="contract",
            symbol="BTCUSDT_PERP",
            interval="1M",
            limit=300,
            source="CONFIGURED",
            fetch_external=provider_boundary,
            end_time_ms=boundary_cursor,
        )

    first = request_boundary()
    second = request_boundary()

    assert first == second == []
    assert first.cache_status == second.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HISTORY_BOUNDARY
    assert first.history_terminal is second.history_terminal is True
    assert first.terminal_reason == market_kline_cache.KLINE_TERMINAL_REASON_PROVIDER_HISTORY_BOUNDARY
    assert second.terminal_reason == market_kline_cache.KLINE_TERMINAL_REASON_CACHE_HISTORY_BOUNDARY
    assert first.earliest_available_time is second.earliest_available_time is None
    assert first.history_incomplete is second.history_incomplete is False
    assert first.provider_error_code is second.provider_error_code is None
    assert provider_calls == [(300, boundary_cursor)]
    cached = market_kline_cache._read_kline_history_boundary_cache(
        market_type="contract",
        symbol="BTCUSDT_PERP",
        interval="1M",
    )
    assert cached is not None
    assert cached.get("earliest_available_time") is None
    assert cached["boundary_cursor"] == boundary_cursor


def test_db_cache_metadata_does_not_invent_provider_or_updated_at(monkeypatch) -> None:
    result = market_kline_cache.KlineCacheResult(
        [_bar(60_000)],
        origin=market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE,
        cache_status=market_kline_cache.KLINE_CACHE_STATUS_HIT,
    )

    actual = _call_with_result(monkeypatch, result)

    assert actual.metadata is not None
    assert actual.metadata.source == "DB_CACHE"
    assert actual.metadata.provider is None
    assert actual.metadata.updated_at is None


def test_latest_db_freshness_uses_phase_b_resolver() -> None:
    class Query:
        def __init__(self, updated_at: datetime) -> None:
            self.latest = SimpleNamespace(updated_at=updated_at)

        def filter(self, *_args):
            return self

        def order_by(self, *_args):
            return self

        def first(self):
            return self.latest

    class Db:
        def __init__(self, updated_at: datetime) -> None:
            self.query_value = Query(updated_at)

        def query(self, *_args):
            return self.query_value

    recent = Db(datetime.utcnow() - timedelta(seconds=1))
    stale = Db(datetime.utcnow() - timedelta(seconds=20))

    assert market_kline_cache._latest_cache_is_fresh(
        recent,
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
    ) is True
    assert market_kline_cache._latest_cache_is_fresh(
        stale,
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
    ) is False


def test_history_db_cache_bypasses_current_candle_freshness(monkeypatch) -> None:
    history = [_bar(60_000)]
    monkeypatch.setattr(
        market_kline_cache,
        "_read_cached_klines",
        lambda *_args, **_kwargs: history,
    )
    monkeypatch.setattr(
        market_kline_cache,
        "_latest_cache_is_fresh",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("history must not use current-candle freshness")
        ),
    )

    result = market_kline_cache.get_klines_cache_first(
        object(),
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        limit=1,
        source="EXTERNAL_SPOT",
        fetch_external=lambda *_args: (_ for _ in ()).throw(
            AssertionError("covered history must not fetch provider")
        ),
        end_time_ms=120_000,
    )

    assert result == history
    assert result.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert result.metadata is not None
    assert result.metadata.source == "DB_CACHE"
