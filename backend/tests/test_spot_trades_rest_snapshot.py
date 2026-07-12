from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import Any

import pytest

from app.schemas.market import TradeItem, TradesResponse
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainFreshness,
    DomainSource,
    DomainTransport,
)
from app.services import market
from app.services.market_domain_snapshot import MarketDomainSnapshot
from app.services.shared_market_cache import (
    SharedMarketCacheAdapter,
    make_market_cache_envelope,
)
from app.services.spot_market_gateway import SpotMarketGateway
from app.services.market_trades_cache import (
    SPOT_TRADES_SHARED_CACHE_TTL_MS,
    get_spot_trades_with_shared_cache,
    spot_trades_shared_cache_key,
)


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


def _trades(*, now_ms: int, provider: str = "OKX_SPOT") -> TradesResponse:
    return TradesResponse(
        symbol="BTCUSDT",
        trades=[
            TradeItem(
                id="trade-2",
                trade_id="trade-2",
                provider_trade_id="trade-2",
                price="101",
                amount="0.2",
                side="SELL",
                ts=now_ms - 100,
                event_time_ms=now_ms - 100,
                received_at_ms=now_ms - 50,
                provider=provider,
                provider_symbol="BTC-USDT",
                source="external",
                freshness="RECENT",
                updated_at_ms=now_ms - 50,
            ),
            TradeItem(
                id="trade-1",
                trade_id="trade-1",
                provider_trade_id="trade-1",
                price="100",
                amount="0.1",
                side="BUY",
                ts=now_ms - 200,
                event_time_ms=now_ms - 200,
                received_at_ms=now_ms - 50,
                provider=provider,
                provider_symbol="BTC-USDT",
                source="external",
                freshness="RECENT",
                updated_at_ms=now_ms - 50,
            ),
        ],
        provider=provider,
        provider_symbol="BTC-USDT",
        stale=False,
        updated_at_ms=now_ms - 50,
        received_at_ms=now_ms - 50,
    )


def _trade_ids(value: TradesResponse | dict[str, Any]) -> list[str | None]:
    if isinstance(value, dict):
        return [item.get("provider_trade_id") for item in value["trades"]]
    return [item.provider_trade_id for item in value.trades]


def _install_gateway(monkeypatch, gateway: SpotMarketGateway) -> None:
    monkeypatch.setattr(market, "_spot_market_gateway_service", lambda: gateway)


def _capture_market_snapshots(monkeypatch, gateway: SpotMarketGateway):
    captured: list[MarketDomainSnapshot] = []
    original = gateway.record_trades_market_domain_snapshot

    def record(**kwargs):
        captured.append(kwargs["snapshot"])
        return original(**kwargs)

    monkeypatch.setattr(gateway, "record_trades_market_domain_snapshot", record)
    return captured


def test_provider_ws_memory_trades_consumes_market_snapshot_without_reordering(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    pair = _pair()
    provider = SimpleNamespace(provider_code="OKX_SPOT")
    trades = _trades(now_ms=now_ms)
    legacy_before = trades.model_dump()
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
        "get_spot_provider_ws_trades",
        lambda *_args, **_kwargs: trades,
    )
    monkeypatch.setattr(
        market,
        "_format_trades_for_pair",
        lambda *_args, **_kwargs: trades,
    )
    monkeypatch.setattr(
        market,
        "request_contract_market_provider_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("fresh provider WS trades must skip REST")
        ),
    )

    result = market._get_external_spot_trades(object(), pair)

    assert result.model_dump() == legacy_before
    assert _trade_ids(result) == ["trade-2", "trade-1"]
    assert len(market_snapshots) == 1
    assert market_snapshots[0].domain == "trades"
    assert market_snapshots[0].source == "LIVE_WS"
    assert market_snapshots[0].provider == "OKX_SPOT"
    assert _trade_ids(market_snapshots[0].data) == ["trade-2", "trade-1"]
    snapshot = gateway.get_trades_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_WS
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert snapshot.metadata.source == DomainSource.LIVE_WS
    assert snapshot.metadata.freshness == DomainFreshness.LIVE


def test_provider_rest_trades_records_snapshot_without_changing_batch(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    pair = _pair()
    provider = SimpleNamespace(provider_code="OKX_SPOT", cooldown_seconds=0)
    trades = _trades(now_ms=now_ms)
    legacy_before = trades.model_dump()
    _install_gateway(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    monkeypatch.setattr(market, "_enabled_spot_market_providers_for_pair", lambda *_args, **_kwargs: [provider])
    monkeypatch.setattr(market, "spot_provider_ws_supports_provider", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(market, "get_spot_provider_ws_trades", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(market, "_spot_provider_symbol", lambda *_args, **_kwargs: "BTC-USDT")
    monkeypatch.setattr(market, "_spot_provider_request_config", lambda value, **_kwargs: value)
    monkeypatch.setattr(market, "request_contract_market_provider_json", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(market, "_spot_trades_from_provider", lambda **_kwargs: trades)
    monkeypatch.setattr(market, "mark_contract_market_provider_success", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(market, "mark_contract_market_provider_failure", lambda *_args, **_kwargs: None)

    result = market._get_external_spot_trades(object(), pair)

    assert result.model_dump() == legacy_before
    assert _trade_ids(result) == ["trade-2", "trade-1"]
    assert len(market_snapshots) == 1
    assert market_snapshots[0].domain == "trades"
    assert market_snapshots[0].data == legacy_before
    assert market_snapshots[0].source == "REST_SNAPSHOT"
    assert market_snapshots[0].provider == "OKX_SPOT"
    snapshot = gateway.get_trades_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert _trade_ids(snapshot.data) == ["trade-2", "trade-1"]
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.NONE
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.provider_symbol == "BTC-USDT"
    assert snapshot.metadata.freshness == DomainFreshness.RECENT


def _install_cache_adapter(monkeypatch, adapter: SharedMarketCacheAdapter) -> None:
    def cached_getter(**kwargs):
        return get_spot_trades_with_shared_cache(
            **kwargs,
            cache_adapter=adapter,
        )

    monkeypatch.setattr(market, "get_spot_trades_with_shared_cache", cached_getter)
    monkeypatch.setattr(
        market,
        "_get_external_spot_trades",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("cache hit must skip loader")
        ),
    )


def test_l1_trades_cache_hit_records_cache_read_snapshot(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    payload = _trades(now_ms=now_ms).model_dump()
    redis = _FakeRedis()
    adapter = SharedMarketCacheAdapter(
        redis_client=redis,
        l1_ttl_ms=1_000,
        clock_ms=_Clock(now_ms),
    )
    adapter.set(
        spot_trades_shared_cache_key("BTCUSDT"),
        payload,
        ttl_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
        source="external",
        provider="OKX_SPOT",
        updated_at_ms=now_ms - 25,
    )
    _install_gateway(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    _install_cache_adapter(monkeypatch, adapter)

    result = market._get_external_spot_trades_cached(object(), _pair())

    assert _trade_ids(result) == ["trade-2", "trade-1"]
    assert len(market_snapshots) == 1
    assert _trade_ids(market_snapshots[0].data) == ["trade-2", "trade-1"]
    snapshot = gateway.get_trades_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.L1_MEMORY
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.freshness == DomainFreshness.RECENT


def test_redis_trades_cache_hit_records_cache_read_snapshot(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    key = spot_trades_shared_cache_key("BTCUSDT")
    payload = _trades(now_ms=now_ms).model_dump()
    envelope = make_market_cache_envelope(
        payload,
        source="external",
        provider="OKX_SPOT",
        ttl_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
        updated_at_ms=now_ms - 25,
        now_ms_value=now_ms - 25,
    )
    adapter = SharedMarketCacheAdapter(
        redis_client=_FakeRedis({key: json.dumps(envelope.to_dict())}),
        l1_ttl_ms=1_000,
        clock_ms=_Clock(now_ms),
    )
    _install_gateway(monkeypatch, gateway)
    _install_cache_adapter(monkeypatch, adapter)

    result = market._get_external_spot_trades_cached(object(), _pair())

    assert _trade_ids(result) == ["trade-2", "trade-1"]
    snapshot = gateway.get_trades_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.REDIS
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.provider == "OKX_SPOT"


def test_last_good_trades_keeps_original_provider_and_order(monkeypatch):
    now_ms = int(time.time() * 1000)
    gateway = _gateway()
    pair = _pair()
    original = _trades(now_ms=now_ms, provider="OKX_SPOT")
    monkeypatch.setitem(market._SPOT_LAST_GOOD_TRADES, pair.symbol, original)
    _install_gateway(monkeypatch, gateway)
    monkeypatch.setattr(market, "_enabled_spot_market_providers_for_pair", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(market, "contract_market_last_good_enabled", lambda *_args, **_kwargs: True)

    result = market._get_external_spot_trades(object(), pair)

    assert result.provider == "LAST_GOOD"
    assert _trade_ids(result) == ["trade-2", "trade-1"]
    snapshot = gateway.get_trades_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.data["provider"] == "LAST_GOOD"
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.LAST_GOOD_MEMORY
    assert snapshot.metadata.source == DomainSource.LAST_GOOD
    assert snapshot.metadata.freshness == DomainFreshness.LAST_GOOD


def test_missing_trades_records_missing_snapshot(monkeypatch):
    gateway = _gateway()
    pair = _pair()
    market._SPOT_LAST_GOOD_TRADES.pop(pair.symbol, None)
    _install_gateway(monkeypatch, gateway)
    monkeypatch.setattr(market, "_enabled_spot_market_providers_for_pair", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(market, "contract_market_last_good_enabled", lambda *_args, **_kwargs: False)

    with pytest.raises(ValueError, match="spot external trades unavailable"):
        market._get_external_spot_trades(object(), pair)

    snapshot = gateway.get_trades_domain_snapshot("BTCUSDT")
    assert snapshot is not None
    assert snapshot.data is None
    assert snapshot.metadata.provider is None
    assert snapshot.metadata.transport == DomainTransport.NONE
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.stale is True
