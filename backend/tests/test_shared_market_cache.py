from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.shared_market_cache import (  # noqa: E402
    CACHE_VERSION,
    DOMAIN_DEPTH,
    DOMAIN_KLINE,
    DOMAIN_TICKER,
    DOMAIN_TRADES,
    FALLBACK_REASON_EMPTY,
    FALLBACK_REASON_FRESH,
    FALLBACK_REASON_MISSING,
    FALLBACK_REASON_REDIS_DOWN,
    FALLBACK_REASON_STALE,
    FRESHNESS_FRESH,
    FRESHNESS_MISSING,
    FRESHNESS_STALE,
    SharedMarketCacheAdapter,
    build_market_cache_key,
    make_market_cache_envelope,
    resolve_market_freshness,
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


def test_shared_market_cache_key_shape() -> None:
    assert (
        build_market_cache_key(market_type="SPOT", symbol="btc/usdt", domain="DEPTH")
        == "market:v1:spot:BTCUSDT:depth"
    )
    assert (
        build_market_cache_key(
            market_type="contract",
            symbol="BTCUSDT_PERP",
            domain=DOMAIN_KLINE,
            interval="1M",
        )
        == "market:v1:contract:BTCUSDT_PERP:kline:1m"
    )


def test_redis_hit_returns_envelope_without_loader() -> None:
    key = build_market_cache_key(market_type="spot", symbol="BTCUSDT", domain=DOMAIN_TICKER)
    cached = make_market_cache_envelope(
        {"last_price": "101"},
        source="LIVE_WS",
        provider="OKX_SPOT",
        ttl_ms=1000,
        updated_at_ms=9500,
        now_ms_value=9500,
    )
    redis = FakeRedis({key: json.dumps(cached.to_dict())})
    clock = Clock(10_000)
    adapter = SharedMarketCacheAdapter(redis_client=redis, l1_ttl_ms=100, clock_ms=clock)

    def loader() -> dict[str, str]:
        raise AssertionError("loader should not run on redis hit")

    envelope = adapter.get_or_load(
        key,
        loader,
        ttl_ms=1000,
        source="REST",
        provider="BINANCE",
    )

    assert envelope.data == {"last_price": "101"}
    assert envelope.freshness == FRESHNESS_FRESH
    assert envelope.age_ms == 500
    assert envelope.fallback_reason == FALLBACK_REASON_FRESH
    assert redis.get_calls == 1
    assert redis.set_calls == []


def test_redis_miss_loads_and_stores_unified_envelope() -> None:
    key = build_market_cache_key(market_type="spot", symbol="BTCUSDT", domain=DOMAIN_DEPTH)
    redis = FakeRedis()
    clock = Clock(10_000)
    adapter = SharedMarketCacheAdapter(redis_client=redis, l1_ttl_ms=100, clock_ms=clock)
    loader_calls = 0

    def loader() -> dict[str, Any]:
        nonlocal loader_calls
        loader_calls += 1
        return {"bids": [["100", "1"]], "asks": [["101", "2"]]}

    envelope = adapter.get_or_load(
        key,
        loader,
        ttl_ms=2000,
        source="REST",
        provider="BINANCE",
    )

    assert loader_calls == 1
    assert envelope.to_dict() == {
        "data": {"bids": [["100", "1"]], "asks": [["101", "2"]]},
        "source": "REST",
        "provider": "BINANCE",
        "freshness": FRESHNESS_FRESH,
        "updated_at_ms": 10_000,
        "age_ms": 0,
        "is_stale": False,
        "ttl_ms": 2000,
        "fallback_reason": FALLBACK_REASON_FRESH,
        "version": CACHE_VERSION,
    }
    assert redis.set_calls and redis.set_calls[0][0] == key
    stored_payload = json.loads(redis.store[key])
    assert set(stored_payload) == {
        "data",
        "source",
        "provider",
        "freshness",
        "updated_at_ms",
        "age_ms",
        "is_stale",
        "ttl_ms",
        "fallback_reason",
        "version",
    }


def test_l1_hit_short_circuits_redis_and_loader() -> None:
    key = build_market_cache_key(market_type="spot", symbol="BTCUSDT", domain=DOMAIN_TICKER)
    redis = FakeRedis()
    clock = Clock(10_000)
    adapter = SharedMarketCacheAdapter(redis_client=redis, l1_ttl_ms=500, clock_ms=clock)

    first = adapter.get_or_load(
        key,
        lambda: {"last_price": "100"},
        ttl_ms=2000,
        source="REST",
        provider="BINANCE",
    )
    assert first.data == {"last_price": "100"}

    redis.get_calls = 0
    redis.store[key] = json.dumps(
        make_market_cache_envelope(
            {"last_price": "999"},
            source="LIVE_WS",
            provider="OKX_SPOT",
            ttl_ms=2000,
            updated_at_ms=clock(),
            now_ms_value=clock(),
        ).to_dict()
    )

    second = adapter.get_or_load(
        key,
        lambda: {"last_price": "loader-should-not-run"},
        ttl_ms=2000,
        source="REST",
        provider="BINANCE",
    )

    assert second.data == {"last_price": "100"}
    assert redis.get_calls == 0


def test_redis_down_falls_back_to_loader_without_raising() -> None:
    key = build_market_cache_key(market_type="contract", symbol="BTCUSDT_PERP", domain=DOMAIN_TRADES)
    redis = FakeRedis(down=True)
    clock = Clock(10_000)
    adapter = SharedMarketCacheAdapter(redis_client=redis, l1_ttl_ms=100, clock_ms=clock)

    envelope = adapter.get_or_load(
        key,
        lambda: {"trades": [{"price": "100", "amount": "1"}]},
        ttl_ms=1000,
        source="REST",
        provider="OKX_SWAP",
    )

    assert envelope.data == {"trades": [{"price": "100", "amount": "1"}]}
    assert envelope.freshness == FRESHNESS_FRESH
    assert envelope.fallback_reason == FALLBACK_REASON_REDIS_DOWN
    assert redis.get_calls == 1


def test_domain_freshness_helper_handles_fresh_stale_missing_and_empty() -> None:
    now = 10_000
    samples = {
        DOMAIN_DEPTH: {"bids": [["100", "1"]], "asks": [["101", "1"]]},
        DOMAIN_TICKER: {"last_price": "100"},
        DOMAIN_TRADES: {"trades": [{"price": "100"}]},
        DOMAIN_KLINE: {"items": [{"open_time": 9000, "close": "100"}]},
    }
    empty_samples = {
        DOMAIN_DEPTH: {"bids": [], "asks": []},
        DOMAIN_TICKER: {"last_price": ""},
        DOMAIN_TRADES: {"trades": []},
        DOMAIN_KLINE: {"items": []},
    }

    for domain, payload in samples.items():
        fresh = resolve_market_freshness(
            {"data": payload, "updated_at_ms": now - 100},
            domain=domain,
            ttl_ms=1000,
            now_ms_value=now,
        )
        assert fresh.freshness == FRESHNESS_FRESH
        assert fresh.fallback_reason == FALLBACK_REASON_FRESH
        assert fresh.age_ms == 100

        stale = resolve_market_freshness(
            {"data": payload, "updated_at_ms": now - 2000},
            domain=domain,
            ttl_ms=1000,
            now_ms_value=now,
        )
        assert stale.freshness == FRESHNESS_STALE
        assert stale.fallback_reason == FALLBACK_REASON_STALE
        assert stale.is_stale is True

        empty = resolve_market_freshness(
            {"data": empty_samples[domain], "updated_at_ms": now},
            domain=domain,
            ttl_ms=1000,
            now_ms_value=now,
        )
        assert empty.freshness == FRESHNESS_MISSING
        assert empty.fallback_reason == FALLBACK_REASON_EMPTY

    missing = resolve_market_freshness(None, domain=DOMAIN_TICKER, ttl_ms=1000, now_ms_value=now)
    assert missing.freshness == FRESHNESS_MISSING
    assert missing.fallback_reason == FALLBACK_REASON_MISSING


def test_shared_cache_module_does_not_import_trading_order_or_kline_side_effect_paths() -> None:
    import app.services.shared_market_cache as shared_market_cache

    side_effect_modules = {
        "app.services.contract_order_service",
        "app.services.market_kline_cache",
        "app.services.matching",
        "app.services.order_service",
        "app.services.spot_kline_realtime",
        "app.services.spot_market_view",
        "app.services.contract_market_view",
    }
    source = Path(shared_market_cache.__file__).read_text(encoding="utf-8")
    for module_name in side_effect_modules:
        assert module_name.rsplit(".", 1)[-1] not in source

    before = set(sys.modules)
    importlib.reload(shared_market_cache)
    newly_loaded = set(sys.modules) - before

    assert side_effect_modules.isdisjoint(newly_loaded)
    assert {"app.core.redis", "app.core.config"}.isdisjoint(newly_loaded)
