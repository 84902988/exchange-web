import pytest

from app.schemas.market import KlineItem, KlineResponse
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainCompletenessStatus,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainSource,
    DomainTransport,
)
from app.services.spot_kline_domain_snapshot import map_kline_domain_snapshot


def _bar(open_time=1_720_000_000_000, **overrides):
    item = {
        "open_time": open_time,
        "close_time": open_time + 60_000,
        "open": "60750.1",
        "high": "60800.0",
        "low": "60700.0",
        "close": "60780.0",
        "volume": "12.5",
        "quote_volume": "759750",
    }
    item.update(overrides)
    return item


def _kline_payload(items=None, **overrides):
    payload = {
        "symbol": "BTCUSDT",
        "interval": "1m",
        "items": [_bar()] if items is None else items,
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "updated_at_ms": 1_720_000_000_150,
        "history_terminal": None,
        "history_incomplete": False,
        "terminal_reason": None,
        "earliest_available_time": None,
    }
    payload.update(overrides)
    return payload


def test_kline_snapshot_maps_live_ws_metadata():
    payload = _kline_payload(provider_event_time_ms=1_720_000_000_120)
    snapshot = map_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1m",
        kline=payload,
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        cache_updated_at_ms=1_720_000_000_175,
        age_ms=25,
        ttl_ms=1_500,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
        snapshot_id="kline-live-1",
    )

    metadata = snapshot.metadata
    assert snapshot.data == payload
    assert metadata.domain.value == "kline"
    assert metadata.symbol == "BTCUSDT"
    assert metadata.interval == "1m"
    assert metadata.provider == "OKX_SPOT"
    assert metadata.provider_symbol == "BTC-USDT"
    assert metadata.transport == DomainTransport.PROVIDER_WS
    assert metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert metadata.source == DomainSource.LIVE_WS
    assert metadata.freshness == DomainFreshness.LIVE
    assert metadata.provider_event_time_ms == 1_720_000_000_120
    assert metadata.received_at_ms == 1_720_000_000_150
    assert metadata.cache_updated_at_ms == 1_720_000_000_175
    assert metadata.age_ms == 25
    assert metadata.ttl_ms == 1_500
    assert metadata.stale is False
    assert metadata.completeness.status == DomainCompletenessStatus.COMPLETE
    assert metadata.coverage_complete is None
    assert metadata.continuity_valid is None


def test_kline_snapshot_maps_rest_history_metadata_without_terminal_inference():
    payload = _kline_payload(
        source="REST_HISTORY",
        freshness="RECENT",
        history_terminal=False,
        history_incomplete=True,
        coverage_complete=False,
        continuity_valid=True,
    )
    snapshot = map_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1m",
        kline=payload,
        transport=DomainTransport.PROVIDER_REST,
        cache_origin=DomainCacheOrigin.NONE,
        fallback_reason=DomainFallbackReason.WS_MISS,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.source == DomainSource.REST_HISTORY
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.history_terminal is False
    assert snapshot.metadata.history_incomplete is True
    assert snapshot.metadata.coverage_complete is False
    assert snapshot.metadata.continuity_valid is True


def test_kline_snapshot_maps_db_cache_metadata():
    response = KlineResponse(
        symbol="BTCUSDT",
        interval="1Dutc",
        items=[KlineItem(**_bar())],
        provider="OKX_SPOT",
        stale=False,
        source="DB_CACHE",
        freshness="CACHED",
        history_incomplete=False,
    )
    legacy_response = response.model_dump()

    snapshot = map_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1Dutc",
        kline=response,
        provider_symbol="BTC-USDT",
        transport=DomainTransport.DB_READ,
        cache_origin=DomainCacheOrigin.DATABASE,
        cache_updated_at_ms=1_720_000_000_000,
        age_ms=200,
        ttl_ms=60_000,
        coverage_complete=True,
        continuity_valid=True,
        freshness_basis=DomainFreshnessBasis.DB_UPDATED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert response.model_dump() == legacy_response
    assert snapshot.data == legacy_response
    assert snapshot.metadata.source == DomainSource.DB_CACHE
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.DATABASE
    assert snapshot.metadata.coverage_complete is True
    assert snapshot.metadata.continuity_valid is True


def test_kline_snapshot_preserves_history_boundary_semantics():
    boundary = _kline_payload(
        items=[],
        interval="1Mutc",
        source="EMPTY",
        freshness="MISSING",
        history_terminal=True,
        history_incomplete=False,
        terminal_reason="PROVIDER_HISTORY_BOUNDARY",
        earliest_available_time=1_514_764_800_000,
        coverage_complete=True,
        continuity_valid=True,
    )
    snapshot = map_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1Mutc",
        kline=boundary,
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.HISTORY_BOUNDARY,
        fallback_reason=DomainFallbackReason.HISTORY_BOUNDARY,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data == boundary
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.history_terminal is True
    assert snapshot.metadata.history_incomplete is False
    assert snapshot.metadata.terminal_reason == "PROVIDER_HISTORY_BOUNDARY"
    assert snapshot.metadata.earliest_available_time == 1_514_764_800_000
    assert snapshot.metadata.coverage_complete is True
    assert snapshot.metadata.continuity_valid is True
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.EMPTY
    serialized_metadata = snapshot.model_dump()["metadata"]
    assert serialized_metadata["history_terminal"] is True
    assert serialized_metadata["terminal_reason"] == "PROVIDER_HISTORY_BOUNDARY"
    assert serialized_metadata["coverage_complete"] is True


@pytest.mark.parametrize(
    ("source", "freshness", "cache_origin", "expected_source", "expected_freshness"),
    [
        (
            "LAST_GOOD",
            "LAST_GOOD",
            DomainCacheOrigin.LAST_GOOD_MEMORY,
            DomainSource.LAST_GOOD,
            DomainFreshness.LAST_GOOD,
        ),
        (
            "STALE_CACHE",
            "STALE",
            DomainCacheOrigin.DATABASE,
            DomainSource.DB_CACHE,
            DomainFreshness.STALE,
        ),
    ],
)
def test_kline_snapshot_maps_last_good_and_stale(
    source,
    freshness,
    cache_origin,
    expected_source,
    expected_freshness,
):
    snapshot = map_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1m",
        kline=_kline_payload(source=source, freshness=freshness, stale=True),
        transport=DomainTransport.CACHE_READ,
        cache_origin=cache_origin,
        fallback_reason=DomainFallbackReason.CACHE_STALE,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.source == expected_source
    assert snapshot.metadata.freshness == expected_freshness
    assert snapshot.metadata.stale is True


def test_kline_snapshot_preserves_bar_order_ohlc_and_explicit_revision():
    later = _bar(
        open_time=1_720_000_060_000,
        open="61000.0",
        high="61100.0",
        low="60900.0",
        close="61050.0",
        revision_epoch=7,
        revision_seq=12,
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
    )
    earlier = _bar(
        open_time=1_720_000_000_000,
        open="60750.1",
        high="60800.0",
        low="60700.0",
        close="60780.0",
        revision_epoch=7,
        revision_seq=11,
        is_closed=True,
        close_state_source="PROVIDER_CONFIRMED",
    )
    payload = _kline_payload(
        items=[later, earlier],
        revision_epoch=7,
        revision_seq=12,
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
    )

    snapshot = map_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1m",
        kline=payload,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data["items"] == [later, earlier]
    assert snapshot.data["items"][0]["open"] == "61000.0"
    assert snapshot.data["items"][1]["close"] == "60780.0"
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.epoch == 7
    assert snapshot.metadata.revision.sequence == 12
    assert snapshot.metadata.revision.is_closed is False
    assert snapshot.metadata.revision.close_state_source == "PROVIDER_CONFIRMED"


@pytest.mark.parametrize("interval", ["1Dutc", "1Wutc", "1Mutc"])
def test_kline_snapshot_daily_weekly_monthly_metadata_regression(interval):
    payload = _kline_payload(
        interval=interval,
        source="REST_HISTORY",
        freshness="RECENT",
        history_terminal=False,
        history_incomplete=True,
        terminal_reason=None,
        earliest_available_time=None,
    )
    snapshot = map_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval=interval,
        kline=payload,
        transport=DomainTransport.PROVIDER_REST,
        cache_origin=DomainCacheOrigin.NONE,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.interval == interval
    assert snapshot.metadata.history_terminal is False
    assert snapshot.metadata.history_incomplete is True
    assert snapshot.metadata.terminal_reason is None
    assert snapshot.metadata.earliest_available_time is None
