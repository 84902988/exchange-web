from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.market_depth_cache import (  # noqa: E402
    SPOT_DEPTH_SHARED_CACHE_TTL_MS,
    get_spot_depth_with_shared_cache,
    spot_depth_shared_cache_key,
)
from app.services.shared_market_cache import (  # noqa: E402
    SharedMarketCacheAdapter,
    make_market_cache_envelope,
)


class FakeRedis:
    def __init__(self, initial: dict[str, Any] | None = None) -> None:
        self.store = dict(initial or {})
        self.get_calls = 0
        self.set_calls: list[tuple[str, Any, int | None]] = []

    def get(self, key: str) -> Any:
        self.get_calls += 1
        return self.store.get(key)

    def set(self, key: str, value: Any, *, px: int | None = None, **_kwargs: Any) -> bool:
        self.store[key] = value
        self.set_calls.append((key, value, px))
        return True


def _depth(*, price: str, sequence: int | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "symbol": "BTCUSDT",
        "price_precision": 2,
        "amount_precision": 6,
        "bids": [{"price": price, "amount": "1"}],
        "asks": [{"price": str(int(price) + 1), "amount": "2"}],
        "provider": "OKX_SPOT",
        "source": "external",
        "stale": False,
    }
    if sequence is not None:
        payload["sequence"] = sequence
    return payload


def _adapter(redis: FakeRedis, now_ms: int) -> SharedMarketCacheAdapter:
    return SharedMarketCacheAdapter(
        redis_client=redis,
        l1_ttl_ms=250,
        clock_ms=lambda: now_ms,
    )


def test_depth_cache_writes_canonical_metadata_without_changing_payload() -> None:
    now_ms = int(time.time() * 1000)
    redis = FakeRedis()
    adapter = _adapter(redis, now_ms)
    expected = _depth(price="100", sequence=42)

    result = get_spot_depth_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: expected,
        cache_adapter=adapter,
    )

    assert result == expected
    stored = json.loads(redis.store[spot_depth_shared_cache_key("BTCUSDT")])
    metadata = stored["data"]
    assert set(metadata) == {
        "data",
        "source",
        "provider",
        "updated_at",
        "version",
        "sequence",
    }
    assert metadata["data"] == expected
    assert metadata["source"] == "external"
    assert metadata["provider"] == "OKX_SPOT"
    assert metadata["sequence"] == 42


def test_depth_cache_treats_stale_inner_metadata_as_cache_miss() -> None:
    now_ms = int(time.time() * 1000)
    key = spot_depth_shared_cache_key("BTCUSDT")
    stale_metadata = {
        "data": _depth(price="100", sequence=10),
        "source": "external",
        "provider": "OKX_SPOT",
        "updated_at": now_ms - 2_000,
        "version": "v1",
        "sequence": 10,
    }
    outer = make_market_cache_envelope(
        stale_metadata,
        source="external",
        provider="OKX_SPOT",
        ttl_ms=1_000,
        updated_at_ms=now_ms,
        now_ms_value=now_ms,
    )
    redis = FakeRedis({key: json.dumps(outer.to_dict())})
    adapter = _adapter(redis, now_ms)

    result = get_spot_depth_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: _depth(price="101", sequence=11),
        cache_adapter=adapter,
        ttl_ms=1_000,
    )

    assert result == _depth(price="101", sequence=11)
    assert redis.set_calls and redis.set_calls[-1][0] == key


def test_depth_cache_reads_legacy_payload_and_keeps_missing_sequence_null() -> None:
    now_ms = int(time.time() * 1000)
    key = spot_depth_shared_cache_key("BTCUSDT")
    legacy_payload = _depth(price="102")
    legacy = make_market_cache_envelope(
        legacy_payload,
        source="external",
        provider="OKX_SPOT",
        ttl_ms=SPOT_DEPTH_SHARED_CACHE_TTL_MS,
        updated_at_ms=now_ms - 25,
        now_ms_value=now_ms - 25,
    )
    redis = FakeRedis({key: json.dumps(legacy.to_dict())})
    adapter = _adapter(redis, now_ms)

    result = get_spot_depth_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: (_ for _ in ()).throw(AssertionError("loader should not run")),
        cache_adapter=adapter,
    )

    assert result == legacy_payload
    assert "sequence" not in result
    assert redis.set_calls == []
