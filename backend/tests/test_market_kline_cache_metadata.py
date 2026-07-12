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
