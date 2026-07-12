from app.schemas.market import TickerItem
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainCompletenessStatus,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainSource,
    DomainTransport,
)
from app.services.spot_ticker_domain_snapshot import map_ticker_domain_snapshot


def _ticker_payload(**overrides):
    payload = {
        "symbol": "BTCUSDT",
        "last_price": "60750.1",
        "price_change_percent": "1.25",
        "volume_24h": "123.4",
        "source": "LIVE_WS",
        "provider": "BITGET_SPOT",
        "provider_symbol": "BTCUSDT",
        "quote_freshness": "LIVE",
        "stale": False,
        "event_time_ms": 1_720_000_000_100,
        "received_at_ms": 1_720_000_000_150,
    }
    payload.update(overrides)
    return payload


def test_ticker_snapshot_wraps_data_without_changing_legacy_response():
    ticker = TickerItem(
        symbol="BTCUSDT",
        last_price="60750.1",
        price_change_percent="1.25",
        volume_24h="123.4",
        source="LIVE_WS",
        provider="BITGET_SPOT",
        quote_freshness="LIVE",
        stale=False,
        event_time_ms=1_720_000_000_100,
        received_at_ms=1_720_000_000_150,
    )
    legacy_response = ticker.model_dump()

    snapshot = map_ticker_domain_snapshot(
        symbol="BTCUSDT",
        ticker=ticker,
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        provider_symbol="BTCUSDT",
        cache_updated_at_ms=1_720_000_000_175,
        age_ms=25,
        ttl_ms=1_500,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
        snapshot_id="ticker-live-1",
    )

    assert ticker.model_dump() == legacy_response
    assert snapshot.data == legacy_response
    assert snapshot.metadata.domain.value == "ticker"
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.COMPLETE


def test_ticker_snapshot_maps_live_ws_metadata_from_real_fields():
    snapshot = map_ticker_domain_snapshot(
        symbol="BTCUSDT",
        ticker=_ticker_payload(),
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        cache_updated_at_ms=1_720_000_000_175,
        age_ms=25,
        ttl_ms=1_500,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        provider_generation=7,
        emitted_at_ms=1_720_000_000_200,
    )

    metadata = snapshot.metadata
    assert metadata.provider == "BITGET_SPOT"
    assert metadata.provider_symbol == "BTCUSDT"
    assert metadata.transport == DomainTransport.PROVIDER_WS
    assert metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert metadata.source == DomainSource.LIVE_WS
    assert metadata.freshness == DomainFreshness.LIVE
    assert metadata.fallback_reason is None
    assert metadata.provider_event_time_ms == 1_720_000_000_100
    assert metadata.received_at_ms == 1_720_000_000_150
    assert metadata.cache_updated_at_ms == 1_720_000_000_175
    assert metadata.age_ms == 25
    assert metadata.ttl_ms == 1_500
    assert metadata.stale is False
    assert metadata.provider_generation == 7


def test_ticker_snapshot_maps_rest_fallback_without_inventing_freshness():
    snapshot = map_ticker_domain_snapshot(
        symbol="BTCUSDT",
        ticker=_ticker_payload(
            source="external",
            provider="BITGET_SPOT",
            quote_freshness="LIVE",
        ),
        transport=DomainTransport.PROVIDER_REST,
        cache_origin=DomainCacheOrigin.NONE,
        fallback_reason=DomainFallbackReason.WS_MISS,
        ttl_ms=2_000,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == DomainFreshness.LIVE
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS


def test_ticker_snapshot_maps_last_good_from_legacy_fields():
    snapshot = map_ticker_domain_snapshot(
        symbol="BTCUSDT",
        ticker=_ticker_payload(
            source="external",
            provider="LAST_GOOD",
            quote_freshness="LAST_VALID",
            stale=True,
        ),
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
        source=DomainSource.LAST_GOOD,
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
    assert snapshot.metadata.age_ms == 10_200


def test_ticker_snapshot_missing_keeps_unknown_metadata_missing():
    snapshot = map_ticker_domain_snapshot(
        symbol="BTCUSDT",
        ticker=None,
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
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.EMPTY
    assert snapshot.metadata.completeness.has_data is False


def test_ticker_snapshot_does_not_infer_missing_provider_source_or_freshness():
    snapshot = map_ticker_domain_snapshot(
        symbol="BTCUSDT",
        ticker={
            "symbol": "BTCUSDT",
            "last_price": "60750.1",
            "price_change_percent": "1.25",
            "volume_24h": "123.4",
            "stale": False,
            "ts": "2026-07-12T12:00:00Z",
            "updated_at_ms": 1_720_000_000_150,
        },
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.provider is None
    assert snapshot.metadata.provider_symbol is None
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.provider_event_time_ms is None
    assert snapshot.metadata.received_at_ms is None
    assert snapshot.metadata.cache_updated_at_ms is None
    assert snapshot.metadata.age_ms is None
    assert snapshot.metadata.ttl_ms is None
