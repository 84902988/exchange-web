from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.shared_market_cache import (  # noqa: E402
    SharedMarketCacheAdapter,
    make_market_cache_envelope,
)
from app.services.spot_ticker_shared_cache import (  # noqa: E402
    SPOT_TICKER_SHARED_CACHE_TTL_MS,
    get_spot_ticker_with_shared_cache,
    spot_ticker_shared_cache_key,
)


class Clock:
    def __init__(self, value: int = 10_000) -> None:
        self.value = value

    def __call__(self) -> int:
        return self.value

    def advance(self, value: int) -> None:
        self.value += value


class FakeRedis:
    def __init__(self, initial: dict[str, Any] | None = None, *, down: bool = False) -> None:
        self.store = dict(initial or {})
        self.down = down
        self.get_calls = 0
        self.set_calls: list[tuple[str, Any, int | None]] = []

    def get(self, key: str) -> Any:
        self.get_calls += 1
        if self.down:
            raise OSError("redis unavailable")
        return self.store.get(key)

    def set(self, key: str, value: Any, *, px: int | None = None, **_kwargs: Any) -> bool:
        if self.down:
            raise OSError("redis unavailable")
        self.store[key] = value
        self.set_calls.append((key, value, px))
        return True


def _ticker(symbol: str = "BTCUSDT", price: str = "100", *, source: str = "external") -> dict[str, Any]:
    return {
        "symbol": symbol,
        "last_price": price,
        "open_24h": price,
        "price_change_24h": "0",
        "price_change_percent": "0",
        "volume_24h": "10",
        "base_volume_24h": "10",
        "high_24h": price,
        "low_24h": price,
        "quote_volume_24h": "1000",
        "price_precision": 2,
        "amount_precision": 6,
        "source": source,
        "provider": "OKX_SPOT" if source != "internal" else None,
        "stale": False,
        "updated_at": "2026-07-06T00:00:00",
        "quote_freshness": "LIVE",
        "ts": "2026-07-06T00:00:00",
    }


def _adapter(redis: FakeRedis, clock: Clock, *, l1_ttl_ms: int = 250) -> SharedMarketCacheAdapter:
    return SharedMarketCacheAdapter(
        redis_client=redis,
        l1_ttl_ms=l1_ttl_ms,
        clock_ms=clock,
    )


def test_spot_ticker_redis_hit_skips_loader() -> None:
    key = spot_ticker_shared_cache_key("BTCUSDT")
    clock = Clock(10_000)
    cached = make_market_cache_envelope(
        _ticker(price="101"),
        source="external",
        provider="OKX_SPOT",
        ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
        updated_at_ms=9500,
        now_ms_value=9500,
    )
    redis = FakeRedis({key: json.dumps(cached.to_dict())})
    adapter = _adapter(redis, clock)

    result = get_spot_ticker_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: (_ for _ in ()).throw(AssertionError("loader should not run")),
        cache_adapter=adapter,
    )

    assert result is not None
    assert result["last_price"] == "101"
    assert redis.get_calls == 1
    assert redis.set_calls == []


def test_spot_ticker_l1_hit_skips_redis_and_loader() -> None:
    clock = Clock(10_000)
    redis = FakeRedis()
    adapter = _adapter(redis, clock, l1_ttl_ms=1000)

    first = get_spot_ticker_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: _ticker(price="102"),
        cache_adapter=adapter,
    )
    assert first is not None
    assert first["last_price"] == "102"

    redis.get_calls = 0
    redis.store[spot_ticker_shared_cache_key("BTCUSDT")] = json.dumps(
        make_market_cache_envelope(
            _ticker(price="999"),
            source="external",
            provider="OKX_SPOT",
            ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
            updated_at_ms=clock(),
            now_ms_value=clock(),
        ).to_dict()
    )

    second = get_spot_ticker_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: (_ for _ in ()).throw(AssertionError("loader should not run")),
        cache_adapter=adapter,
    )

    assert second is not None
    assert second["last_price"] == "102"
    assert redis.get_calls == 0


def test_spot_ticker_miss_loads_and_writes_cache() -> None:
    key = spot_ticker_shared_cache_key("BTCUSDT")
    clock = Clock(10_000)
    redis = FakeRedis()
    adapter = _adapter(redis, clock)

    result = get_spot_ticker_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: _ticker(price="103"),
        cache_adapter=adapter,
    )

    assert result is not None
    assert result["last_price"] == "103"
    assert redis.set_calls and redis.set_calls[0][0] == key
    stored = json.loads(redis.store[key])
    assert stored["data"]["last_price"] == "103"
    assert stored["source"] == "external"
    assert stored["provider"] == "OKX_SPOT"
    assert stored["ttl_ms"] == SPOT_TICKER_SHARED_CACHE_TTL_MS


def test_spot_ticker_redis_down_falls_back_to_loader() -> None:
    clock = Clock(10_000)
    redis = FakeRedis(down=True)
    adapter = _adapter(redis, clock)

    result = get_spot_ticker_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: _ticker(price="104"),
        cache_adapter=adapter,
    )

    assert result is not None
    assert result["last_price"] == "104"
    assert redis.get_calls == 1


def test_spot_ticker_stale_cache_calls_loader_and_refreshes() -> None:
    key = spot_ticker_shared_cache_key("BTCUSDT")
    clock = Clock(10_000)
    cached = make_market_cache_envelope(
        _ticker(price="105"),
        source="external",
        provider="OKX_SPOT",
        ttl_ms=1000,
        updated_at_ms=8000,
        now_ms_value=8000,
    )
    redis = FakeRedis({key: json.dumps(cached.to_dict())})
    adapter = _adapter(redis, clock)

    result = get_spot_ticker_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: _ticker(price="106"),
        cache_adapter=adapter,
        ttl_ms=1000,
    )

    assert result is not None
    assert result["last_price"] == "106"
    assert redis.set_calls and redis.set_calls[-1][0] == key
    stored = json.loads(redis.store[key])
    assert stored["data"]["last_price"] == "106"


def test_internal_symbol_does_not_read_external_ticker_cache() -> None:
    key = spot_ticker_shared_cache_key("MFCUSDT")
    clock = Clock(10_000)
    cached = make_market_cache_envelope(
        _ticker("MFCUSDT", price="999"),
        source="external",
        provider="OKX_SPOT",
        ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
        updated_at_ms=clock(),
        now_ms_value=clock(),
    )
    redis = FakeRedis({key: json.dumps(cached.to_dict())})
    adapter = _adapter(redis, clock)

    result = get_spot_ticker_with_shared_cache(
        symbol="MFCUSDT",
        data_source="INTERNAL",
        loader=lambda: _ticker("MFCUSDT", price="10", source="internal"),
        cache_adapter=adapter,
    )

    assert result is not None
    assert result["last_price"] == "10"
    assert result["source"] == "internal"
    assert redis.get_calls == 0
    assert redis.set_calls == []


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASSED {name}")
