from __future__ import annotations

import inspect
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services import market_kline_cache  # noqa: E402
from app.services.contract_kline_response import build_contract_kline_metadata  # noqa: E402


def _ms(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp() * 1000)


def _row(open_time: int, interval: str = "1h") -> dict[str, Any]:
    return {
        "open_time": open_time,
        "close_time": open_time + market_kline_cache.interval_ms(interval),
        "open": "100",
        "high": "110",
        "low": "90",
        "close": "105",
        "volume": "5",
        "quote_volume": "525",
    }


class _InMemoryKlineDb:
    def __init__(self, rows: Optional[list[dict[str, Any]]] = None) -> None:
        self.rows = [dict(row) for row in (rows or [])]
        self.upsert_calls = 0
        self._originals: dict[str, Any] = {}

    def __enter__(self) -> "_InMemoryKlineDb":
        for name in (
            "_read_cached_klines",
            "_latest_cache_is_fresh",
            "upsert_klines",
            "record_error",
            "record_kline_db_hit",
            "record_kline_external_fetch",
        ):
            self._originals[name] = getattr(market_kline_cache, name)

        def read_cached(_db, **kwargs):
            end_time_ms = kwargs.get("end_time_ms")
            limit = int(kwargs["limit"])
            rows = sorted(self.rows, key=lambda item: int(item["open_time"]))
            if end_time_ms is not None:
                rows = [row for row in rows if int(row["open_time"]) < int(end_time_ms)]
            return [dict(row) for row in rows[-limit:]]

        def upsert(_db, **kwargs):
            self.upsert_calls += 1
            by_open_time = {int(row["open_time"]): dict(row) for row in self.rows}
            for item in kwargs["items"]:
                normalized = market_kline_cache.serialize_kline_item(item, kwargs["interval"])
                by_open_time[int(normalized["open_time"])] = normalized
            self.rows = [by_open_time[key] for key in sorted(by_open_time)]
            return len(list(kwargs["items"]))

        market_kline_cache._read_cached_klines = read_cached
        market_kline_cache._latest_cache_is_fresh = lambda *_args, **_kwargs: True
        market_kline_cache.upsert_klines = upsert
        market_kline_cache.record_error = lambda *_args, **_kwargs: None
        market_kline_cache.record_kline_db_hit = lambda *_args, **_kwargs: None
        market_kline_cache.record_kline_external_fetch = lambda *_args, **_kwargs: None
        return self

    def __exit__(self, *_args) -> None:
        for name, value in self._originals.items():
            setattr(market_kline_cache, name, value)


def _index_cache_first(
    *,
    limit: int,
    fetch_external,
    end_time_ms: Optional[int] = None,
):
    return market_kline_cache.get_klines_cache_first(
        object(),
        market_type="contract",
        symbol="US30_PERP",
        interval="1h",
        limit=limit,
        source="ITICK",
        fetch_external=fetch_external,
        end_time_ms=end_time_ms,
        cache_policy=market_kline_cache.KLINE_CACHE_POLICY_GAP_TOLERANT,
    )


def test_index_current_provider_upsert_then_db_hit_without_second_provider_call() -> None:
    provider_rows = [
        _row(_ms(2026, 7, 3, 14)),
        _row(_ms(2026, 7, 3, 15)),
        _row(_ms(2026, 7, 6, 14)),
        _row(_ms(2026, 7, 6, 15)),
    ]
    provider_calls: list[tuple[int, Optional[int]]] = []

    def fetch(limit: int, end_time_ms: Optional[int]):
        provider_calls.append((limit, end_time_ms))
        return provider_rows

    with _InMemoryKlineDb() as cache:
        fresh = _index_cache_first(limit=4, fetch_external=fetch)
        cached = _index_cache_first(limit=4, fetch_external=fetch)

    assert provider_calls == [(4, None)]
    assert cache.upsert_calls == 1
    assert fresh.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert fresh.cache_status == market_kline_cache.KLINE_CACHE_STATUS_MISS
    assert cached.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert cached.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT
    fresh_metadata = build_contract_kline_metadata(fresh, end_time_ms=None)
    cached_metadata = build_contract_kline_metadata(cached, end_time_ms=None)
    assert fresh_metadata["cache_status"] == market_kline_cache.KLINE_CACHE_STATUS_MISS
    assert fresh_metadata["freshness"] == "RECENT"
    assert fresh_metadata["stale"] is False
    assert cached_metadata["cache_status"] == market_kline_cache.KLINE_CACHE_STATUS_HIT
    assert cached_metadata["freshness"] == "CACHED"
    assert cached_metadata["stale"] is False
    assert fresh_metadata["history_complete"] is None
    assert fresh_metadata["has_more_before"] is None
    assert cached_metadata["history_complete"] is None
    assert cached_metadata["has_more_before"] is None


def test_index_history_provider_upsert_then_larger_cache_covers_smaller_request() -> None:
    end_time_ms = _ms(2026, 7, 7, 0)
    provider_rows = [
        _row(_ms(2026, 7, 2, 14)),
        _row(_ms(2026, 7, 3, 14)),
        _row(_ms(2026, 7, 3, 15)),
        _row(_ms(2026, 7, 6, 14)),
    ]
    provider_calls: list[tuple[int, Optional[int]]] = []

    def fetch(limit: int, cursor: Optional[int]):
        provider_calls.append((limit, cursor))
        return provider_rows

    with _InMemoryKlineDb() as cache:
        fresh = _index_cache_first(limit=4, fetch_external=fetch, end_time_ms=end_time_ms)
        cached = _index_cache_first(limit=2, fetch_external=fetch, end_time_ms=end_time_ms)

    assert provider_calls == [(4, end_time_ms)]
    assert cache.upsert_calls == 1
    assert len(fresh) == 4
    assert len(cached) == 2
    assert fresh.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert fresh.cache_status == market_kline_cache.KLINE_CACHE_STATUS_MISS
    assert cached.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert cached.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT
    metadata = build_contract_kline_metadata(cached, end_time_ms=end_time_ms)
    assert metadata["cache_status"] == market_kline_cache.KLINE_CACHE_STATUS_HIT
    assert metadata["freshness"] == "CACHED"
    assert metadata["stale"] is False
    assert metadata["history_complete"] is False
    assert metadata["has_more_before"] is None
    assert metadata["history_incomplete"] is False


def test_index_identical_history_request_reuses_db_with_identical_normalized_rows() -> None:
    end_time_ms = _ms(2026, 7, 7, 0)
    provider_rows = [
        _row(_ms(2026, 7, 2, 14)),
        _row(_ms(2026, 7, 3, 14)),
        _row(_ms(2026, 7, 3, 15)),
        _row(_ms(2026, 7, 6, 14)),
    ]
    provider_calls: list[tuple[int, Optional[int]]] = []

    def fetch(limit: int, cursor: Optional[int]):
        provider_calls.append((limit, cursor))
        return provider_rows

    with _InMemoryKlineDb() as cache:
        fresh = _index_cache_first(limit=4, fetch_external=fetch, end_time_ms=end_time_ms)
        cached = _index_cache_first(limit=4, fetch_external=fetch, end_time_ms=end_time_ms)

    assert provider_calls == [(4, end_time_ms)]
    assert cache.upsert_calls == 1
    assert fresh.origin == market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH
    assert fresh.cache_status == market_kline_cache.KLINE_CACHE_STATUS_MISS
    assert cached.origin == market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE
    assert cached.cache_status == market_kline_cache.KLINE_CACHE_STATUS_HIT
    assert list(cached) == list(fresh)
    fresh_metadata = build_contract_kline_metadata(fresh, end_time_ms=end_time_ms)
    metadata = build_contract_kline_metadata(cached, end_time_ms=end_time_ms)
    assert fresh_metadata["cache_status"] == market_kline_cache.KLINE_CACHE_STATUS_MISS
    assert fresh_metadata["freshness"] == "RECENT"
    assert fresh_metadata["stale"] is False
    assert fresh_metadata["history_complete"] is False
    assert fresh_metadata["has_more_before"] is None
    assert metadata["cache_status"] == market_kline_cache.KLINE_CACHE_STATUS_HIT
    assert metadata["freshness"] == "CACHED"
    assert metadata["stale"] is False
    assert metadata["history_complete"] is False
    assert metadata["has_more_before"] is None


def test_gap_tolerant_policy_accepts_session_gaps_but_strict_default_does_not() -> None:
    rows = [
        _row(_ms(2026, 7, 3, 14)),
        _row(_ms(2026, 7, 3, 15)),
        _row(_ms(2026, 7, 6, 14)),
        _row(_ms(2026, 7, 6, 15)),
    ]
    end_time_ms = _ms(2026, 7, 7, 0)

    assert market_kline_cache._validate_cached_klines_continuity_for_policy(
        rows,
        "1h",
        market_kline_cache.KLINE_CACHE_POLICY_GAP_TOLERANT,
    )
    assert market_kline_cache._validate_cached_klines_history_coverage_for_policy(
        rows,
        "1h",
        end_time_ms,
        market_kline_cache.KLINE_CACHE_POLICY_GAP_TOLERANT,
    )
    assert not market_kline_cache._validate_cached_klines_continuity(rows, "1h")
    assert not market_kline_cache._validate_cached_klines_history_coverage(rows, "1h", end_time_ms)
    assert inspect.signature(market_kline_cache.get_klines_cache_first).parameters[
        "cache_policy"
    ].default == market_kline_cache.KLINE_CACHE_POLICY_STRICT_24X7


def test_gap_tolerant_policy_rejects_duplicate_order_and_interval_alignment_errors() -> None:
    first = _ms(2026, 7, 6, 14)
    valid = [_row(first), _row(first + 60 * 60 * 1000)]
    duplicate = [_row(first), _row(first)]
    out_of_order = list(reversed(valid))
    wrong_phase = [_row(first), _row(first + 61 * 60 * 1000)]
    off_minute = [_row(first + 1_000), _row(first + 60 * 60 * 1000 + 1_000)]

    validate = market_kline_cache._validate_gap_tolerant_klines_continuity
    assert validate(valid, "1h")
    assert not validate(duplicate, "1h")
    assert not validate(out_of_order, "1h")
    assert not validate(wrong_phase, "1h")
    assert not validate(off_minute, "1h")


def test_gap_tolerant_provider_rows_are_validated_before_db_upsert_or_return() -> None:
    first = _ms(2026, 7, 6, 14)
    invalid_sets = [
        [_row(first), _row(first)],
        [_row(first + 60 * 60 * 1000), _row(first)],
        [_row(first), _row(first + 61 * 60 * 1000)],
    ]

    for invalid_rows in invalid_sets:
        with _InMemoryKlineDb() as cache:
            result = _index_cache_first(
                limit=2,
                fetch_external=lambda *_args, rows=invalid_rows: rows,
            )

        assert result == []
        assert result.origin == market_kline_cache.KLINE_CACHE_ORIGIN_EMPTY
        assert result.cache_status == market_kline_cache.KLINE_CACHE_STATUS_CONTINUITY_INVALID
        assert result.provider_error_code == market_kline_cache.KLINE_PROVIDER_ERROR_UNKNOWN
        assert cache.upsert_calls == 0


def test_index_provider_empty_is_not_negative_cached_or_terminal() -> None:
    history_end = _ms(2026, 7, 7, 0)
    provider_calls: list[tuple[int, Optional[int]]] = []

    def empty(limit: int, end_time_ms: Optional[int]):
        provider_calls.append((limit, end_time_ms))
        return []

    with _InMemoryKlineDb() as cache:
        first = _index_cache_first(limit=4, fetch_external=empty, end_time_ms=history_end)
        second = _index_cache_first(limit=4, fetch_external=empty, end_time_ms=history_end)
        current = _index_cache_first(limit=4, fetch_external=empty)

    assert provider_calls == [(4, history_end), (4, history_end), (4, None)]
    assert cache.upsert_calls == 0
    for result in (first, second):
        metadata = build_contract_kline_metadata(result, end_time_ms=history_end)
        assert metadata["provider_error_code"] == "EMPTY"
        assert metadata["retryable"] is True
        assert metadata["history_complete"] is False
        assert metadata["has_more_before"] is None
        assert metadata["history_incomplete"] is True
    current_metadata = build_contract_kline_metadata(current, end_time_ms=None)
    assert current_metadata["history_complete"] is None
    assert current_metadata["has_more_before"] is None
    assert current_metadata["retryable"] is True


def test_index_transient_provider_errors_remain_retryable_and_non_terminal() -> None:
    history_end = _ms(2026, 7, 7, 0)
    for code in (
        market_kline_cache.KLINE_PROVIDER_ERROR_TIMEOUT,
        market_kline_cache.KLINE_PROVIDER_ERROR_COOLDOWN,
        market_kline_cache.KLINE_PROVIDER_ERROR_HTTP,
        market_kline_cache.KLINE_PROVIDER_ERROR_UNKNOWN,
    ):
        def fail(_limit: int, _end_time_ms: Optional[int], error_code: str = code):
            raise market_kline_cache.KlineProviderFetchError(
                f"provider {error_code}",
                provider_error_code=error_code,
                provider_error_provider="ITICK",
            )

        with _InMemoryKlineDb() as cache:
            result = _index_cache_first(limit=4, fetch_external=fail, end_time_ms=history_end)

        assert cache.upsert_calls == 0
        metadata = build_contract_kline_metadata(result, end_time_ms=history_end)
        assert metadata["provider_error_code"] == code
        assert metadata["retryable"] is True
        assert metadata["history_complete"] is False
        assert metadata["has_more_before"] is None
        assert metadata["history_incomplete"] is True


def test_index_transient_error_returns_valid_stale_partial_rows_with_metadata() -> None:
    history_end = _ms(2026, 7, 7, 0)
    stale_rows = [_row(_ms(2026, 7, 3, 14)), _row(_ms(2026, 7, 6, 14))]

    def timeout(_limit: int, _end_time_ms: Optional[int]):
        raise market_kline_cache.KlineProviderFetchError(
            "provider timeout",
            provider_error_code=market_kline_cache.KLINE_PROVIDER_ERROR_TIMEOUT,
            provider_error_provider="ITICK",
        )

    with _InMemoryKlineDb(stale_rows):
        result = _index_cache_first(limit=4, fetch_external=timeout, end_time_ms=history_end)

    metadata = build_contract_kline_metadata(result, end_time_ms=history_end)
    assert len(result) == 2
    assert result.origin == market_kline_cache.KLINE_CACHE_ORIGIN_STALE_CACHE
    assert metadata["freshness"] == "STALE"
    assert metadata["stale"] is True
    assert metadata["history_incomplete"] is True
    assert metadata["history_complete"] is False
    assert metadata["has_more_before"] is None
    assert metadata["provider_error_code"] == "TIMEOUT"
    assert metadata["retryable"] is True


def test_index_provider_empty_returns_valid_stale_partial_rows_with_metadata() -> None:
    history_end = _ms(2026, 7, 7, 0)
    stale_rows = [_row(_ms(2026, 7, 3, 14)), _row(_ms(2026, 7, 6, 14))]

    with _InMemoryKlineDb(stale_rows) as cache:
        result = _index_cache_first(
            limit=4,
            fetch_external=lambda *_args: [],
            end_time_ms=history_end,
        )

    metadata = build_contract_kline_metadata(result, end_time_ms=history_end)
    assert cache.upsert_calls == 0
    assert list(result) == stale_rows
    assert result.origin == market_kline_cache.KLINE_CACHE_ORIGIN_STALE_CACHE
    assert metadata["cache_status"] == market_kline_cache.KLINE_CACHE_STATUS_PROVIDER_EMPTY
    assert metadata["freshness"] == "STALE"
    assert metadata["stale"] is True
    assert metadata["history_incomplete"] is True
    assert metadata["history_complete"] is False
    assert metadata["has_more_before"] is None
    assert metadata["provider_error_code"] == "EMPTY"
    assert metadata["retryable"] is True


if __name__ == "__main__":
    tests = [
        value
        for name, value in sorted(globals().items())
        if name.startswith("test_") and callable(value)
    ]
    for test in tests:
        test()
    print(f"{len(tests)} tests passed")
