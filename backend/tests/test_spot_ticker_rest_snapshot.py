from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import Any

from app.schemas.market import TickerItem
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainFreshness,
    DomainSource,
    DomainTransport,
)
from app.services import market
from app.services.market_domain_snapshot import MarketDomainSnapshot
from app.services.market_ticker_cache import (
    SPOT_TICKER_SHARED_CACHE_TTL_MS,
    get_spot_ticker_with_shared_cache,
    spot_ticker_shared_cache_key,
)
from app.services.shared_market_cache import (
    SharedMarketCacheAdapter,
    make_market_cache_envelope,
)
from app.services.spot_market_gateway import SpotMarketGateway


class _Clock:
    def __init__(self, value: int) -> None:
        self.value = value

    def __call__(self) -> int:
        return self.value


class _FakeRedis:
    def __init__(self, initial: dict[str, Any] | None = None) -> None:
        self.store = dict(initial or {})

    def get(self, key: str) -> Any:
        return self.store.get(key)

    def set(self, key: str, value: Any, *, px: int | None = None, **_kwargs: Any) -> bool:
        self.store[key] = value
        return True


def _gateway() -> SpotMarketGateway:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
    return SpotMarketGateway(
        ensure_depth=lambda _symbol: None,
        ensure_kline=lambda _symbol, _interval: None,
        release_depth=lambda _symbol: None,
        get_depth=lambda _symbol, **_kwargs: None,
        get_ticker=lambda _symbol, **_kwargs: None,
        get_trades=lambda _symbol, **_kwargs: None,
        get_klines=lambda _symbol, _interval, **_kwargs: None,
        provider_symbol_allowed=lambda _symbol: True,
        precision_resolver=lambda _symbol: (2, 6),
    )


def _pair():
    return SimpleNamespace(
        id=1,
        symbol="BTCUSDT",
        data_source="BINANCE",
        price_precision=2,
        amount_precision=6,
    )


def _ticker(*, now_ms: int, provider: str = "OKX_SPOT") -> TickerItem:
    return TickerItem(
        symbol="BTCUSDT",
        last_price="100",
        open_24h="99",
        price_change_24h="1",
        price_change_percent="1.01",
        volume_24h="10",
        base_volume_24h="10",
        high_24h="101",
        low_24h="98",
        quote_volume_24h="1000",
        price_precision=2,
        amount_precision=6,
        source="external",
        provider=provider,
        stale=False,
        updated_at="2026-07-12T00:00:00",
        quote_freshness="LIVE",
        ts="2026-07-12T00:00:00",
        event_time_ms=now_ms - 100,
        received_at_ms=now_ms - 50,
    )


def _ticker_payload(*, now_ms: int) -> dict[str, Any]:
    return _ticker(now_ms=now_ms).model_dump()


def _install_gateway(monkeypatch, gateway: SpotMarketGateway) -> None:
    monkeypatch.setattr(market, "_spot_market_gateway_service", lambda: gateway)


def _capture_market_snapshots(monkeypatch, gateway: SpotMarketGateway):
    captured: list[MarketDomainSnapshot] = []
    original = gateway.record_ticker_market_domain_snapshot

    def record(**kwargs):
        captured.append(kwargs["snapshot"])
        return original(**kwargs)

    monkeypatch.setattr(gateway, "record_ticker_market_domain_snapshot", record)
    return captured


def test_provider_ws_memory_records_market_snapshot_without_changing_ticker(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    pair = _pair()
    provider = SimpleNamespace(provider_code="OKX_SPOT", cooldown_seconds=0)
    ticker = _ticker(now_ms=now_ms)
    legacy_before = ticker.model_dump()
    _install_gateway(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    monkeypatch.setattr(
        market,
        "_enabled_spot_market_providers_for_pair",
        lambda *_args, **_kwargs: [provider],
    )
    monkeypatch.setattr(
        market,
        "spot_provider_ws_supports_provider",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        market,
        "get_spot_provider_ws_ticker",
        lambda *_args, **_kwargs: {
            "provider": "OKX_SPOT",
            "provider_symbol": "BTC-USDT",
        },
    )
    monkeypatch.setattr(
        market,
        "_spot_provider_ws_ticker_to_item",
        lambda *_args, **_kwargs: ticker,
    )
    monkeypatch.setattr(
        market,
        "_spot_provider_price_precision_metadata",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        market,
        "request_contract_market_provider_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fresh provider WS ticker must skip REST")
        ),
    )

    result = market._get_external_spot_ticker(object(), pair)

    assert result is not None
    assert result.model_dump() == legacy_before
    assert len(market_snapshots) == 1
    assert market_snapshots[0].source == "LIVE_WS"
    assert market_snapshots[0].provider == "OKX_SPOT"
    snapshot = gateway.get_ticker_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_WS
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert snapshot.metadata.source == DomainSource.LIVE_WS
    assert snapshot.metadata.freshness == DomainFreshness.LIVE


def test_provider_rest_success_records_snapshot_without_changing_legacy(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    pair = _pair()
    provider = SimpleNamespace(provider_code="OKX_SPOT", cooldown_seconds=0)
    ticker = _ticker(now_ms=now_ms)
    legacy_before = ticker.model_dump()
    _install_gateway(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    monkeypatch.setattr(market, "_enabled_spot_market_providers_for_pair", lambda *_args, **_kwargs: [provider])
    monkeypatch.setattr(market, "spot_provider_ws_supports_provider", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(market, "get_spot_provider_ws_ticker", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(market, "_spot_provider_symbol", lambda *_args, **_kwargs: "BTC-USDT")
    monkeypatch.setattr(market, "_spot_provider_request_config", lambda value, **_kwargs: value)
    monkeypatch.setattr(market, "request_contract_market_provider_json", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(market, "_spot_ticker_from_provider", lambda **_kwargs: ticker)
    monkeypatch.setattr(market, "_spot_provider_price_precision_metadata", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(market, "mark_contract_market_provider_success", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(market, "mark_contract_market_provider_failure", lambda *_args, **_kwargs: None)

    result = market._get_external_spot_ticker(object(), pair)

    assert result is ticker or result.model_dump() == legacy_before
    assert result.model_dump() == legacy_before
    assert len(market_snapshots) == 1
    assert market_snapshots[0].domain == "ticker"
    assert market_snapshots[0].data == legacy_before
    assert market_snapshots[0].source == "REST_SNAPSHOT"
    assert market_snapshots[0].provider == "OKX_SPOT"
    assert market_snapshots[0].fallback_reason == "WS_MISS"
    snapshot = gateway.get_ticker_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.NONE
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.provider_symbol == "BTC-USDT"
    assert snapshot.metadata.freshness == DomainFreshness.RECENT


def _install_cache_adapter(monkeypatch, adapter: SharedMarketCacheAdapter) -> None:
    def cached_getter(**kwargs):
        return get_spot_ticker_with_shared_cache(
            **kwargs,
            cache_adapter=adapter,
        )

    monkeypatch.setattr(market, "get_spot_ticker_with_shared_cache", cached_getter)
    monkeypatch.setattr(
        market,
        "_get_external_spot_ticker",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("cache hit must skip loader")
        ),
    )


def test_l1_cache_hit_records_cache_read_snapshot(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    redis = _FakeRedis()
    adapter = SharedMarketCacheAdapter(
        redis_client=redis,
        l1_ttl_ms=1_000,
        clock_ms=_Clock(now_ms),
    )
    key = spot_ticker_shared_cache_key("BTCUSDT")
    adapter.set(
        key,
        _ticker_payload(now_ms=now_ms),
        ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
        source="external",
        provider="OKX_SPOT",
        updated_at_ms=now_ms - 25,
    )
    _install_gateway(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    _install_cache_adapter(monkeypatch, adapter)

    result = market._get_external_spot_ticker_cached(object(), _pair())

    assert result is not None
    assert result.provider == "OKX_SPOT"
    assert len(market_snapshots) == 1
    assert market_snapshots[0].domain == "ticker"
    assert market_snapshots[0].data == _ticker_payload(now_ms=now_ms)
    assert market_snapshots[0].provider == "OKX_SPOT"
    snapshot = gateway.get_ticker_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.L1_MEMORY
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.freshness == DomainFreshness.RECENT


def test_redis_cache_hit_records_cache_read_snapshot(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    key = spot_ticker_shared_cache_key("BTCUSDT")
    envelope = make_market_cache_envelope(
        _ticker_payload(now_ms=now_ms),
        source="external",
        provider="OKX_SPOT",
        ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
        updated_at_ms=now_ms - 25,
        now_ms_value=now_ms - 25,
    )
    redis = _FakeRedis({key: json.dumps(envelope.to_dict())})
    adapter = SharedMarketCacheAdapter(
        redis_client=redis,
        l1_ttl_ms=1_000,
        clock_ms=_Clock(now_ms),
    )
    _install_gateway(monkeypatch, gateway)
    _install_cache_adapter(monkeypatch, adapter)

    result = market._get_external_spot_ticker_cached(object(), _pair())

    assert result is not None
    snapshot = gateway.get_ticker_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.REDIS
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.freshness == DomainFreshness.RECENT


def test_last_good_keeps_original_provider_in_snapshot(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    pair = _pair()
    original = _ticker(now_ms=now_ms, provider="OKX_SPOT")
    monkeypatch.setitem(market._SPOT_LAST_GOOD_TICKERS, pair.symbol, original)
    _install_gateway(monkeypatch, gateway)
    monkeypatch.setattr(market, "_enabled_spot_market_providers_for_pair", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(market, "contract_market_last_good_enabled", lambda *_args, **_kwargs: True)

    result = market._get_external_spot_ticker(object(), pair)

    assert result is not None
    assert result.provider == "LAST_GOOD"
    assert result.source == "external"
    assert result.quote_freshness == "LAST_VALID"
    snapshot = gateway.get_ticker_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.data["provider"] == "LAST_GOOD"
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.LAST_GOOD_MEMORY
    assert snapshot.metadata.source == DomainSource.LAST_GOOD
    assert snapshot.metadata.freshness == DomainFreshness.LAST_GOOD


def test_missing_ticker_records_missing_snapshot(monkeypatch):
    gateway = _gateway()
    pair = _pair()
    market._SPOT_LAST_GOOD_TICKERS.pop(pair.symbol, None)
    _install_gateway(monkeypatch, gateway)
    monkeypatch.setattr(market, "_enabled_spot_market_providers_for_pair", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(market, "contract_market_last_good_enabled", lambda *_args, **_kwargs: False)

    result = market._get_external_spot_ticker(object(), pair)

    assert result is None
    snapshot = gateway.get_ticker_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.data is None
    assert snapshot.metadata.provider is None
    assert snapshot.metadata.transport == DomainTransport.NONE
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.stale is True
