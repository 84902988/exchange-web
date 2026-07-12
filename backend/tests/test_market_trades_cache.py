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

from app.services.market_trades_cache import (  # noqa: E402
    SPOT_TRADES_SHARED_CACHE_TTL_MS,
    get_spot_trades_with_shared_cache,
    spot_trades_shared_cache_key,
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


def _trades(*, price: str, latest_id: str | None = "trade-2") -> dict[str, Any]:
    return {
        "symbol": "BTCUSDT",
        "trades": [
            {
                "id": latest_id,
                "trade_id": latest_id,
                "provider_trade_id": latest_id,
                "price": price,
                "amount": "0.2",
                "side": "SELL",
                "ts": 2_000,
            },
            {
                "id": "trade-1",
                "trade_id": "trade-1",
                "provider_trade_id": "trade-1",
                "price": str(int(price) - 1),
                "amount": "0.1",
                "side": "BUY",
                "ts": 1_000,
            },
        ],
        "provider": "OKX_SPOT",
        "source": "external",
        "stale": False,
    }


def _adapter(redis: FakeRedis, now_ms: int) -> SharedMarketCacheAdapter:
    return SharedMarketCacheAdapter(
        redis_client=redis,
        l1_ttl_ms=250,
        clock_ms=lambda: now_ms,
    )


def test_trades_cache_writes_canonical_metadata_without_changing_batch() -> None:
    now_ms = int(time.time() * 1000)
    redis = FakeRedis()
    adapter = _adapter(redis, now_ms)
    expected = _trades(price="101")

    result = get_spot_trades_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: expected,
        cache_adapter=adapter,
    )

    assert result == expected
    assert [item["provider_trade_id"] for item in result["trades"]] == [
        "trade-2",
        "trade-1",
    ]
    stored = json.loads(redis.store[spot_trades_shared_cache_key("BTCUSDT")])
    metadata = stored["data"]
    assert set(metadata) == {
        "data",
        "source",
        "provider",
        "updated_at",
        "version",
        "last_trade_id",
    }
    assert metadata["data"] == expected
    assert metadata["source"] == "external"
    assert metadata["provider"] == "OKX_SPOT"
    assert metadata["last_trade_id"] == "trade-2"


def test_trades_cache_treats_stale_inner_metadata_as_cache_miss() -> None:
    now_ms = int(time.time() * 1000)
    key = spot_trades_shared_cache_key("BTCUSDT")
    stale_metadata = {
        "data": _trades(price="101"),
        "source": "external",
        "provider": "OKX_SPOT",
        "updated_at": now_ms - 2_000,
        "version": "v1",
        "last_trade_id": "trade-2",
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

    result = get_spot_trades_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: _trades(price="102", latest_id="trade-3"),
        cache_adapter=adapter,
        ttl_ms=1_000,
    )

    assert result == _trades(price="102", latest_id="trade-3")
    assert redis.set_calls and redis.set_calls[-1][0] == key


def test_trades_cache_reads_legacy_raw_payload_without_reordering() -> None:
    now_ms = int(time.time() * 1000)
    key = spot_trades_shared_cache_key("BTCUSDT")
    legacy_payload = _trades(price="103")
    legacy = make_market_cache_envelope(
        legacy_payload,
        source="external",
        provider="OKX_SPOT",
        ttl_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
        updated_at_ms=now_ms - 25,
        now_ms_value=now_ms - 25,
    )
    redis = FakeRedis({key: json.dumps(legacy.to_dict())})
    adapter = _adapter(redis, now_ms)

    result = get_spot_trades_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: (_ for _ in ()).throw(AssertionError("loader should not run")),
        cache_adapter=adapter,
    )

    assert result == legacy_payload
    assert [item["provider_trade_id"] for item in result["trades"]] == [
        "trade-2",
        "trade-1",
    ]
    assert redis.set_calls == []


def test_trades_cache_does_not_fabricate_missing_last_trade_identity() -> None:
    now_ms = int(time.time() * 1000)
    redis = FakeRedis()
    adapter = _adapter(redis, now_ms)
    payload = _trades(price="104", latest_id=None)

    result = get_spot_trades_with_shared_cache(
        symbol="BTCUSDT",
        data_source="BINANCE",
        loader=lambda: payload,
        cache_adapter=adapter,
    )

    assert result == payload
    stored = json.loads(redis.store[spot_trades_shared_cache_key("BTCUSDT")])
    assert stored["data"]["last_trade_id"] is None
