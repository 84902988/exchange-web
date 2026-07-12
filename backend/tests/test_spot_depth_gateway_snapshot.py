import asyncio

from app.schemas.market import DepthItem, DepthResponse
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainCompletenessStatus,
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


def _depth(*, provider="OKX_SPOT", source="LIVE_WS", freshness="LIVE", stale=False):
    return DepthResponse(
        symbol="BTCUSDT",
        price_precision=2,
        amount_precision=6,
        bids=[DepthItem(price="60750.1", amount="1.25")],
        asks=[DepthItem(price="60750.2", amount="2.50")],
        ts=1_720_000_000_100,
        event_time_ms=1_720_000_000_100,
        received_at_ms=1_720_000_000_150,
        fetched_at=1_720_000_000_150,
        provider=provider,
        source=source,
        freshness=freshness,
        stale=stale,
    )


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
        precision_resolver=lambda _symbol: (2, 6),
    )


def _commit(
    gateway,
    depth,
    *,
    provider="OKX_SPOT",
    provider_symbol="BTC-USDT",
    source="LIVE_WS",
    freshness="LIVE",
    allow_switch=False,
    expected_provider=None,
    fallback_reason=None,
    sequence=None,
):
    return gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider=provider,
        provider_symbol=provider_symbol,
        depth=depth,
        event_time_ms=1_720_000_000_100,
        received_at_ms=1_720_000_000_150,
        freshness=freshness,
        source=source,
        allow_switch=allow_switch,
        expected_provider=expected_provider,
        snapshot_fallback_reason=fallback_reason,
        snapshot_sequence=sequence,
    )


def test_gateway_records_live_ws_depth_snapshot_without_changing_authority_or_legacy():
    gateway = _gateway()
    depth = _depth()
    legacy_before = depth.model_dump()

    state = _commit(gateway, depth)
    snapshot = gateway.get_depth_domain_snapshot("btcusdt")

    assert state is not None
    assert state.provider == "OKX_SPOT"
    assert state.provider_generation == 1
    assert depth.model_dump() == legacy_before
    assert state.depth.model_dump() == legacy_before
    assert snapshot is not None
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.provider_symbol == "BTC-USDT"
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_WS
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert snapshot.metadata.source == DomainSource.LIVE_WS
    assert snapshot.metadata.freshness == DomainFreshness.LIVE
    assert snapshot.metadata.provider_generation == 1
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.COMPLETE
    assert snapshot.data == legacy_before
    assert "metadata" not in state.depth.model_dump()
    assert "schema_version" not in state.depth.model_dump()


def test_gateway_consumes_market_domain_snapshot_without_changing_depth_authority():
    gateway = _gateway()
    payload = {
        **_depth().model_dump(),
        "provider_symbol": "BTC-USDT",
        "sequence": 100,
        "checksum": 12345,
    }
    market_snapshot = build_market_domain_snapshot(
        symbol="BTCUSDT",
        domain="depth",
        data=payload,
        source="LIVE_WS",
        provider="OKX_SPOT",
        updated_at=1_720_000_000_150,
        version="v1",
        max_age_ms=1_500,
        now_ms=1_720_000_000_200,
    )

    snapshot = gateway.record_depth_market_domain_snapshot(
        snapshot=market_snapshot,
        context=DomainSnapshotContext(
            domain=DomainName.DEPTH,
            symbol="BTCUSDT",
            transport=DomainTransport.PROVIDER_WS,
            cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
            source=DomainSource.LIVE_WS,
            provider="LEGACY_PROVIDER",
            provider_symbol="BTC-USDT",
            received_at_ms=1_720_000_000_150,
            ttl_ms=1_500,
            provider_generation=5,
        ),
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data == payload
    assert snapshot.data["bids"] == payload["bids"]
    assert snapshot.data["asks"] == payload["asks"]
    assert snapshot.data["checksum"] == 12345
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.provider_generation == 5
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.sequence == 100
    assert gateway.get_authoritative_depth("BTCUSDT") is None


def test_gateway_records_rest_fallback_snapshot_and_preserves_generation_switch():
    gateway = _gateway()
    initial = _commit(gateway, _depth())
    assert initial is not None

    rest_depth = _depth(provider="BITGET_SPOT", source="REST", freshness="RECENT")
    switched = _commit(
        gateway,
        rest_depth,
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        source="REST",
        freshness="RECENT",
        allow_switch=True,
        expected_provider="OKX_SPOT",
        fallback_reason=DomainFallbackReason.WS_MISS,
    )
    snapshot = gateway.get_depth_domain_snapshot("BTCUSDT")

    assert switched is not None
    assert switched.provider == "BITGET_SPOT"
    assert switched.provider_generation == 2
    assert snapshot is not None
    assert snapshot.metadata.provider == "BITGET_SPOT"
    assert snapshot.metadata.provider_symbol == "BTCUSDT"
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.NONE
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS
    assert snapshot.metadata.provider_generation == 2
    assert switched.depth.model_dump() == rest_depth.model_dump()


def test_gateway_records_last_good_depth_snapshot_without_rewriting_legacy_fields():
    gateway = _gateway()
    depth = _depth(provider="LAST_GOOD", source="external", freshness="RECENT", stale=True)
    legacy = depth.model_dump()
    snapshot = gateway._record_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=depth,
        provider="LAST_GOOD",
        provider_symbol="BTC-USDT",
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
        source=DomainSource.LAST_GOOD,
        freshness=DomainFreshness.LAST_GOOD,
        fallback_reason=DomainFallbackReason.PROVIDER_TIMEOUT,
        cache_updated_at_ms=1_719_999_990_000,
        age_ms=10_200,
        ttl_ms=2_000,
        stale=True,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.source == DomainSource.LAST_GOOD
    assert snapshot.metadata.freshness == DomainFreshness.LAST_GOOD
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.LAST_GOOD_MEMORY
    assert snapshot.metadata.stale is True
    assert snapshot.data == legacy
    assert depth.model_dump() == legacy


def test_gateway_records_stale_depth_snapshot():
    gateway = _gateway()
    depth = _depth(source="STALE_CACHE", freshness="STALE", stale=True)
    snapshot = gateway._record_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=depth,
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.REDIS,
        source=DomainSource.DB_CACHE,
        freshness=DomainFreshness.STALE,
        fallback_reason=DomainFallbackReason.CACHE_STALE,
        cache_updated_at_ms=1_719_999_995_000,
        age_ms=5_200,
        ttl_ms=2_000,
        stale=True,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.source == DomainSource.DB_CACHE
    assert snapshot.metadata.freshness == DomainFreshness.STALE
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.CACHE_STALE
    assert snapshot.metadata.stale is True


def test_gateway_depth_snapshot_tracks_authority_generation_changes():
    gateway = _gateway()
    first = _commit(gateway, _depth())
    first_snapshot = gateway.get_depth_domain_snapshot("BTCUSDT")
    second = _commit(
        gateway,
        _depth(provider="BITGET_SPOT", source="REST", freshness="RECENT"),
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        source="REST",
        freshness="RECENT",
        allow_switch=True,
        expected_provider="OKX_SPOT",
    )
    second_snapshot = gateway.get_depth_domain_snapshot("BTCUSDT")

    assert first is not None and second is not None
    assert first.provider_generation == 1
    assert second.provider_generation == 2
    assert first_snapshot is not None and second_snapshot is not None
    assert first_snapshot.metadata.provider_generation == 1
    assert second_snapshot.metadata.provider_generation == 2
    assert gateway.get_active_depth_provider("BTCUSDT") == ("BITGET_SPOT", 2)


def test_gateway_depth_snapshot_preserves_sequence_checksum_and_order_without_authority_changes():
    gateway = _gateway()
    first_payload = {
        "symbol": "BTCUSDT",
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "bids": [{"price": "60750.1", "amount": "1.25"}],
        "asks": [{"price": "60750.2", "amount": "2.50"}],
        "generation": 3,
        "sequence": 100,
        "checksum": 111,
    }
    second_payload = {
        **first_payload,
        "sequence": 101,
        "checksum": 222,
    }

    first = gateway._record_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=first_payload,
        emitted_at_ms=1_720_000_000_200,
    )
    second = gateway._record_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=second_payload,
        emitted_at_ms=1_720_000_000_250,
    )

    assert first.metadata.provider_generation == 3
    assert first.metadata.revision is not None
    assert first.metadata.revision.sequence == 100
    assert second.metadata.revision is not None
    assert second.metadata.revision.sequence == 101
    assert first.data["checksum"] == 111
    assert second.data["checksum"] == 222
    assert first.data["bids"] == first_payload["bids"]
    assert second.data["asks"] == second_payload["asks"]
    assert gateway.get_authoritative_depth("BTCUSDT") is None


def test_gateway_missing_depth_snapshot_is_not_broadcast():
    class OneCycleWsManager:
        def __init__(self):
            self.subscriber_calls = 0
            self.depth_broadcasts = []

        async def subscriber_count(self, _symbol):
            self.subscriber_calls += 1
            return 1 if self.subscriber_calls == 1 else 0

        async def broadcast_depth_update(self, symbol, depth):
            self.depth_broadcasts.append((symbol, depth))

        async def kline_intervals(self, _symbol):
            return []

    async def run():
        ws_manager = OneCycleWsManager()
        gateway = SpotMarketGateway(
            ensure_depth=lambda _symbol: None,
            ensure_kline=lambda _symbol, _interval: None,
            release_depth=lambda _symbol: None,
            get_depth=lambda _symbol, **_kwargs: None,
            get_ticker=lambda _symbol, **_kwargs: None,
            get_trades=lambda _symbol, **_kwargs: None,
            get_klines=lambda _symbol, _interval, **_kwargs: None,
            provider_symbol_allowed=lambda _symbol: True,
            precision_resolver=lambda _symbol: (2, 6),
            ws_manager=ws_manager,
        )
        gateway._symbol_providers["BTCUSDT"] = "OKX_SPOT"
        gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
        gateway._loop_interval_seconds = lambda: 0

        async def no_release(_symbol, **_kwargs):
            return None

        gateway.release_symbol_if_idle = no_release
        await gateway._refresh_loop("BTCUSDT")

        snapshot = gateway.get_depth_domain_snapshot("BTCUSDT")
        assert snapshot is not None
        assert snapshot.data is None
        assert snapshot.metadata.source == DomainSource.MISSING
        assert snapshot.metadata.freshness == DomainFreshness.MISSING
        assert snapshot.metadata.fallback_reason == DomainFallbackReason.CACHE_MISS
        assert ws_manager.depth_broadcasts == []

    asyncio.run(run())
