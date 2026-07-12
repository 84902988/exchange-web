import pytest

from app.schemas.market import DepthItem, DepthResponse
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainCompletenessStatus,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainSource,
    DomainTransport,
)
from app.services.spot_depth_domain_snapshot import map_depth_domain_snapshot


def _depth_payload(**overrides):
    payload = {
        "symbol": "BTCUSDT",
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "bids": [{"price": "60750.1", "amount": "1.25"}],
        "asks": [{"price": "60750.2", "amount": "2.50"}],
        "event_time_ms": 1_720_000_000_100,
        "received_at_ms": 1_720_000_000_150,
        "generation": 3,
        "sequence": 88,
        "checksum": 123456,
    }
    payload.update(overrides)
    return payload


def test_depth_snapshot_maps_live_ws_metadata_and_preserves_authority():
    depth = _depth_payload()
    snapshot = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=depth,
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        cache_updated_at_ms=1_720_000_000_175,
        age_ms=25,
        ttl_ms=1_500,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
        snapshot_id="depth-live-1",
    )

    metadata = snapshot.metadata
    assert snapshot.data == depth
    assert snapshot.data["generation"] == 3
    assert snapshot.data["sequence"] == 88
    assert snapshot.data["checksum"] == 123456
    assert metadata.domain.value == "depth"
    assert metadata.provider == "OKX_SPOT"
    assert metadata.provider_symbol == "BTC-USDT"
    assert metadata.transport == DomainTransport.PROVIDER_WS
    assert metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert metadata.source == DomainSource.LIVE_WS
    assert metadata.freshness == DomainFreshness.LIVE
    assert metadata.provider_event_time_ms == 1_720_000_000_100
    assert metadata.received_at_ms == 1_720_000_000_150
    assert metadata.cache_updated_at_ms == 1_720_000_000_175
    assert metadata.age_ms == 25
    assert metadata.ttl_ms == 1_500
    assert metadata.stale is False
    assert metadata.provider_generation == 3
    assert metadata.revision is not None
    assert metadata.revision.epoch == 3
    assert metadata.revision.sequence == 88
    assert metadata.completeness.status == DomainCompletenessStatus.COMPLETE


def test_depth_snapshot_maps_rest_fallback_without_changing_depth_response():
    depth = DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="60750.1", amount="1.25")],
        asks=[DepthItem(price="60750.2", amount="2.50")],
        ts=1_720_000_000_100,
        event_time_ms=1_720_000_000_100,
        received_at_ms=1_720_000_000_150,
        provider="BITGET_SPOT",
        stale=False,
        source="external",
        freshness="RECENT",
    )
    legacy_response = depth.model_dump()

    snapshot = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=depth,
        provider_symbol="BTCUSDT",
        transport=DomainTransport.PROVIDER_REST,
        cache_origin=DomainCacheOrigin.NONE,
        fallback_reason=DomainFallbackReason.WS_MISS,
        ttl_ms=2_000,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert depth.model_dump() == legacy_response
    assert snapshot.data == legacy_response
    assert snapshot.metadata.provider == "BITGET_SPOT"
    assert snapshot.metadata.provider_symbol == "BTCUSDT"
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS


def test_depth_snapshot_maps_explicit_last_good_context():
    snapshot = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=_depth_payload(provider="LAST_GOOD", stale=True),
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


def test_depth_snapshot_maps_stale_cache_metadata():
    snapshot = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=_depth_payload(freshness="STALE", stale=True),
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.REDIS,
        fallback_reason=DomainFallbackReason.CACHE_STALE,
        cache_updated_at_ms=1_719_999_995_000,
        age_ms=5_200,
        ttl_ms=2_000,
        freshness_basis=DomainFreshnessBasis.CACHE_UPDATED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.freshness == DomainFreshness.STALE
    assert snapshot.metadata.stale is True
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.CACHE_STALE
    assert snapshot.metadata.age_ms == 5_200


def test_depth_snapshot_missing_keeps_metadata_missing():
    snapshot = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=None,
        transport=DomainTransport.NONE,
        cache_origin=DomainCacheOrigin.NONE,
        fallback_reason=DomainFallbackReason.CACHE_MISS,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data is None
    assert snapshot.metadata.provider is None
    assert snapshot.metadata.provider_symbol is None
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.provider_event_time_ms is None
    assert snapshot.metadata.received_at_ms is None
    assert snapshot.metadata.cache_updated_at_ms is None
    assert snapshot.metadata.age_ms is None
    assert snapshot.metadata.ttl_ms is None
    assert snapshot.metadata.stale is True
    assert snapshot.metadata.provider_generation is None
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.EMPTY


def test_depth_snapshot_tracks_provider_generation_change():
    first_depth = _depth_payload(generation=4, sequence=90, checksum=111)
    second_depth = _depth_payload(generation=5, sequence=1, checksum=222)

    first = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=first_depth,
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        emitted_at_ms=1_720_000_000_200,
    )
    second = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=second_depth,
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        emitted_at_ms=1_720_000_000_250,
    )

    assert first.metadata.provider_generation == 4
    assert second.metadata.provider_generation == 5
    assert first.metadata.revision is not None
    assert second.metadata.revision is not None
    assert first.metadata.revision.epoch == 4
    assert second.metadata.revision.epoch == 5
    assert second.metadata.revision.sequence == 1
    assert first.data["checksum"] == 111
    assert second.data["checksum"] == 222


@pytest.mark.parametrize(
    ("bids", "asks", "expected"),
    [
        ([{"price": "1", "amount": "2"}], [], DomainCompletenessStatus.PARTIAL),
        ([], [], DomainCompletenessStatus.EMPTY),
        ("invalid", [], DomainCompletenessStatus.INVALID),
        ([{"price": "bad", "amount": "2"}], [], DomainCompletenessStatus.INVALID),
    ],
)
def test_depth_snapshot_completeness_rules(bids, asks, expected):
    snapshot = map_depth_domain_snapshot(
        symbol="BTCUSDT",
        depth=_depth_payload(bids=bids, asks=asks),
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.completeness.status == expected
