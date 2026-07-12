import asyncio

from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainName,
    DomainSource,
    DomainTransport,
)
from app.services.market_domain_snapshot import build_market_domain_snapshot
from app.services.spot_domain_snapshot_freshness import DomainSnapshotContext
from app.services.spot_market_gateway import SpotMarketGateway


def _ticker(**overrides):
    payload = {
        "symbol": "BTCUSDT",
        "last_price": "60750.1",
        "open_24h": "60000",
        "price_change_24h": "750.1",
        "price_change_percent": "1.25",
        "high_24h": "61000",
        "low_24h": "59500",
        "base_volume_24h": "123.4",
        "quote_volume_24h": "7500000",
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "quote_freshness": "LIVE",
        "stale": False,
        "event_time_ms": 1_720_000_000_100,
        "received_at_ms": 1_720_000_000_150,
        "updated_at_ms": 1_720_000_000_150,
        "ts": 1_720_000_000_100,
    }
    payload.update(overrides)
    return payload


def _gateway() -> SpotMarketGateway:
    return SpotMarketGateway(
        ensure_depth=lambda _symbol: None,
        ensure_kline=lambda _symbol, _interval: None,
        release_depth=lambda _symbol: None,
        get_depth=lambda _symbol, **_kwargs: None,
        get_ticker=lambda _symbol, **_kwargs: None,
        get_trades=lambda _symbol, **_kwargs: None,
        get_klines=lambda _symbol, _interval, **_kwargs: None,
        provider_symbol_allowed=lambda _symbol: True,
        precision_resolver=lambda _symbol: (2, 3),
    )


def test_gateway_records_live_ws_ticker_snapshot_and_keeps_legacy_output():
    gateway = _gateway()
    ticker = _ticker()
    snapshot = gateway._record_ticker_domain_snapshot(
        "BTC/USDT",
        ticker,
        emitted_at_ms=1_720_000_000_200,
    )

    metadata = snapshot.metadata
    assert metadata.provider == "OKX_SPOT"
    assert metadata.provider_symbol == "BTC-USDT"
    assert metadata.transport == DomainTransport.PROVIDER_WS
    assert metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert metadata.source == DomainSource.LIVE_WS
    assert metadata.freshness == DomainFreshness.LIVE
    assert metadata.provider_event_time_ms == 1_720_000_000_100
    assert metadata.received_at_ms == 1_720_000_000_150
    assert metadata.cache_updated_at_ms == 1_720_000_000_150
    assert metadata.age_ms == 50
    assert metadata.ttl_ms == 1_500
    assert metadata.stale is False
    assert gateway.get_ticker_domain_snapshot("btcusdt") is snapshot

    legacy = gateway._format_ticker_for_broadcast("BTCUSDT", snapshot.data)
    assert legacy == {
        **ticker,
        "symbol": "BTCUSDT",
        "price_precision": 2,
        "amount_precision": 3,
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "quote_freshness": "LIVE",
        "stale": False,
    }
    assert "metadata" not in legacy
    assert "schema_version" not in legacy


def test_gateway_consumes_market_domain_snapshot_without_rewriting_legacy_ticker():
    gateway = _gateway()
    ticker = _ticker(source="external", quote_freshness="LIVE")
    market_snapshot = build_market_domain_snapshot(
        symbol="BTCUSDT",
        domain="ticker",
        data=ticker,
        source="REST_SNAPSHOT",
        provider="OKX_SPOT",
        updated_at=1_720_000_000_150,
        version="v1",
        max_age_ms=1_500,
        fallback_reason="WS_MISS",
        now_ms=1_720_000_000_200,
    )

    snapshot = gateway.record_ticker_market_domain_snapshot(
        snapshot=market_snapshot,
        context=DomainSnapshotContext(
            domain=DomainName.TICKER,
            symbol="BTCUSDT",
            transport=DomainTransport.PROVIDER_REST,
            cache_origin=DomainCacheOrigin.NONE,
            source=DomainSource.REST_SNAPSHOT,
            provider="LEGACY_PROVIDER",
            provider_symbol="BTC-USDT",
            fallback_reason=DomainFallbackReason.WS_MISS,
            received_at_ms=1_720_000_000_150,
            ttl_ms=1_500,
        ),
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data == ticker
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS
    legacy = gateway._format_ticker_for_broadcast("BTCUSDT", snapshot.data)
    assert legacy["source"] == "external"
    assert legacy["quote_freshness"] == "LIVE"
    assert legacy["stale"] is False
    assert "metadata" not in legacy


def test_gateway_uses_snapshot_provider_for_internal_ticker_domain_key():
    gateway = _gateway()
    ticker = _ticker(provider="LEGACY_PROVIDER")
    snapshot = gateway._record_ticker_domain_snapshot(
        "BTCUSDT",
        ticker,
        emitted_at_ms=1_720_000_000_200,
    )
    snapshot.metadata.provider = "SNAPSHOT_PROVIDER"

    assert gateway._should_broadcast_ticker("BTCUSDT", ticker, snapshot=snapshot) is True
    ticker_keys = [key for key in gateway._broadcast_state._last_signatures if key.domain == "ticker"]
    assert len(ticker_keys) == 1
    assert ticker_keys[0].provider == "SNAPSHOT_PROVIDER"
    assert ticker["provider"] == "LEGACY_PROVIDER"


def test_gateway_records_rest_fallback_snapshot_without_rewriting_legacy_source():
    gateway = _gateway()
    ticker = _ticker(
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        source="external",
        quote_freshness="LIVE",
    )
    snapshot = gateway._record_ticker_domain_snapshot(
        "BTCUSDT",
        ticker,
        transport=DomainTransport.PROVIDER_REST,
        cache_origin=DomainCacheOrigin.NONE,
        fallback_reason=DomainFallbackReason.WS_MISS,
        ttl_ms=2_000,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.provider == "BITGET_SPOT"
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == DomainFreshness.LIVE
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS
    legacy = gateway._format_ticker_for_broadcast("BTCUSDT", snapshot.data)
    assert legacy["source"] == "external"
    assert legacy["provider"] == "BITGET_SPOT"


def test_gateway_records_last_good_snapshot_without_rewriting_legacy_fields():
    gateway = _gateway()
    ticker = _ticker(
        provider="LAST_GOOD",
        source="external",
        quote_freshness="LAST_VALID",
        stale=True,
    )
    snapshot = gateway._record_ticker_domain_snapshot(
        "BTCUSDT",
        ticker,
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
        source=DomainSource.LAST_GOOD,
        freshness=DomainFreshness.LAST_GOOD,
        fallback_reason=DomainFallbackReason.PROVIDER_TIMEOUT,
        cache_updated_at_ms=1_719_999_990_000,
        age_ms=10_200,
        ttl_ms=2_000,
        freshness_basis=DomainFreshnessBasis.CACHE_UPDATED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.provider == "LAST_GOOD"
    assert snapshot.metadata.source == DomainSource.LAST_GOOD
    assert snapshot.metadata.freshness == DomainFreshness.LAST_GOOD
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.LAST_GOOD_MEMORY
    assert snapshot.metadata.stale is True
    legacy = gateway._format_ticker_for_broadcast("BTCUSDT", snapshot.data)
    assert legacy["provider"] == "LAST_GOOD"
    assert legacy["source"] == "external"
    assert legacy["quote_freshness"] == "LAST_VALID"
    assert legacy["stale"] is True


def test_gateway_records_missing_ticker_snapshot_without_legacy_payload():
    gateway = _gateway()
    snapshot = gateway._record_ticker_domain_snapshot(
        "BTCUSDT",
        None,
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        fallback_reason=DomainFallbackReason.CACHE_MISS,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data is None
    assert snapshot.metadata.provider is None
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.CACHE_MISS
    assert snapshot.metadata.stale is True


def test_gateway_refresh_loop_stores_snapshot_but_broadcasts_legacy_ticker_only():
    class OneCycleWsManager:
        def __init__(self):
            self.subscriber_calls = 0
            self.ticker_broadcasts = []

        async def subscriber_count(self, _symbol):
            self.subscriber_calls += 1
            return 1 if self.subscriber_calls == 1 else 0

        async def broadcast_ticker_update(self, symbol, ticker):
            self.ticker_broadcasts.append((symbol, ticker))

        async def kline_intervals(self, _symbol):
            return []

    async def run():
        ws_manager = OneCycleWsManager()
        ticker = _ticker()
        gateway = SpotMarketGateway(
            ensure_depth=lambda _symbol: None,
            ensure_kline=lambda _symbol, _interval: None,
            release_depth=lambda _symbol: None,
            get_depth=lambda _symbol, **_kwargs: None,
            get_ticker=lambda _symbol, **_kwargs: ticker,
            get_trades=lambda _symbol, **_kwargs: None,
            get_klines=lambda _symbol, _interval, **_kwargs: None,
            provider_symbol_allowed=lambda _symbol: True,
            precision_resolver=lambda _symbol: (2, 3),
            ws_manager=ws_manager,
        )
        gateway._symbol_providers["BTCUSDT"] = "OKX_SPOT"
        gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
        gateway._loop_interval_seconds = lambda: 0

        async def no_release(_symbol, **_kwargs):
            return None

        gateway.release_symbol_if_idle = no_release
        await gateway._refresh_loop("BTCUSDT")

        snapshot = gateway.get_ticker_domain_snapshot("BTCUSDT")
        assert snapshot is not None
        assert snapshot.metadata.source == DomainSource.LIVE_WS
        assert len(ws_manager.ticker_broadcasts) == 1
        _symbol, legacy = ws_manager.ticker_broadcasts[0]
        assert legacy["last_price"] == ticker["last_price"]
        assert legacy["provider"] == ticker["provider"]
        assert "metadata" not in legacy
        assert "schema_version" not in legacy

    asyncio.run(run())
