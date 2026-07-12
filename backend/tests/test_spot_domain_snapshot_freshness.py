import pytest

from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainName,
    DomainSource,
    DomainTransport,
)
from app.services.spot_domain_snapshot_freshness import (
    DomainSnapshotContext,
    resolve_domain_snapshot_freshness,
)


NOW_MS = 10_000


def _context(**overrides):
    values = {
        "domain": DomainName.TICKER,
        "symbol": "BTCUSDT",
        "transport": DomainTransport.PROVIDER_WS,
        "cache_origin": DomainCacheOrigin.PROVIDER_MEMORY,
        "source": DomainSource.LIVE_WS,
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "provider_event_time_ms": 9_850,
        "received_at_ms": 9_900,
        "ttl_ms": 500,
    }
    values.update(overrides)
    return DomainSnapshotContext(**values)


def test_live_ws_uses_received_time_and_returns_live():
    result = resolve_domain_snapshot_freshness(_context(), now_ms=NOW_MS)

    assert result.freshness == DomainFreshness.LIVE
    assert result.age_ms == 100
    assert result.ttl_ms == 500
    assert result.stale is False
    assert result.freshness_basis == DomainFreshnessBasis.RECEIVED_AT


def test_rest_is_recent_only_when_local_time_is_within_ttl():
    result = resolve_domain_snapshot_freshness(
        _context(
            transport=DomainTransport.PROVIDER_REST,
            cache_origin=DomainCacheOrigin.NONE,
            source=DomainSource.REST_SNAPSHOT,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.RECENT
    assert result.age_ms == 100
    assert result.stale is False


def test_cache_prefers_cache_updated_time_over_received_time():
    result = resolve_domain_snapshot_freshness(
        _context(
            transport=DomainTransport.CACHE_READ,
            cache_origin=DomainCacheOrigin.REDIS,
            source=DomainSource.REST_SNAPSHOT,
            received_at_ms=8_000,
            cache_updated_at_ms=9_800,
            provider_event_time_ms=None,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.RECENT
    assert result.age_ms == 200
    assert result.stale is False
    assert result.freshness_basis == DomainFreshnessBasis.CACHE_UPDATED_AT


def test_db_read_prefers_database_updated_time():
    result = resolve_domain_snapshot_freshness(
        _context(
            transport=DomainTransport.DB_READ,
            cache_origin=DomainCacheOrigin.DATABASE,
            source=DomainSource.DB_CACHE,
            received_at_ms=9_950,
            cache_updated_at_ms=9_900,
            db_updated_at_ms=9_700,
            provider_event_time_ms=None,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.RECENT
    assert result.age_ms == 300
    assert result.freshness_basis == DomainFreshnessBasis.DB_UPDATED_AT


def test_local_age_over_ttl_is_stale():
    result = resolve_domain_snapshot_freshness(
        _context(
            transport=DomainTransport.PROVIDER_REST,
            cache_origin=DomainCacheOrigin.NONE,
            source=DomainSource.REST_SNAPSHOT,
            received_at_ms=9_000,
            provider_event_time_ms=8_950,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.STALE
    assert result.age_ms == 1_000
    assert result.stale is True


def test_provider_event_time_is_only_a_lag_guard():
    result = resolve_domain_snapshot_freshness(
        _context(received_at_ms=9_900, provider_event_time_ms=9_000),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.STALE
    assert result.age_ms == 100
    assert result.stale is True
    assert result.freshness_basis == DomainFreshnessBasis.RECEIVED_AT


def test_future_provider_event_time_is_ignored_for_lag():
    result = resolve_domain_snapshot_freshness(
        _context(provider_event_time_ms=10_500),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.LIVE
    assert result.age_ms == 100
    assert result.stale is False


def test_future_local_time_is_not_treated_as_fresh():
    result = resolve_domain_snapshot_freshness(
        _context(received_at_ms=10_500, provider_event_time_ms=None),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.MISSING
    assert result.age_ms is None
    assert result.stale is True
    assert result.freshness_basis == DomainFreshnessBasis.NOT_APPLICABLE


def test_missing_local_time_returns_missing():
    result = resolve_domain_snapshot_freshness(
        _context(
            received_at_ms=None,
            cache_updated_at_ms=None,
            db_updated_at_ms=None,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.MISSING
    assert result.age_ms is None
    assert result.ttl_ms == 500
    assert result.stale is True
    assert result.freshness_basis == DomainFreshnessBasis.NOT_APPLICABLE


def test_last_good_is_always_stale_but_keeps_cache_age():
    result = resolve_domain_snapshot_freshness(
        _context(
            transport=DomainTransport.CACHE_READ,
            cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
            source=DomainSource.LAST_GOOD,
            received_at_ms=None,
            cache_updated_at_ms=9_700,
            provider_event_time_ms=None,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.LAST_GOOD
    assert result.age_ms == 300
    assert result.stale is True
    assert result.freshness_basis == DomainFreshnessBasis.CACHE_UPDATED_AT


def test_missing_source_remains_missing_even_with_recent_time():
    result = resolve_domain_snapshot_freshness(
        _context(
            transport=DomainTransport.NONE,
            cache_origin=DomainCacheOrigin.NONE,
            source=DomainSource.MISSING,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.MISSING
    assert result.age_ms == 100
    assert result.stale is True


@pytest.mark.parametrize(
    "cache_origin,fallback_reason",
    [
        (DomainCacheOrigin.HISTORY_BOUNDARY, None),
        (DomainCacheOrigin.NONE, DomainFallbackReason.HISTORY_BOUNDARY),
    ],
)
def test_history_boundary_is_terminal_not_stale(
    cache_origin,
    fallback_reason,
):
    result = resolve_domain_snapshot_freshness(
        _context(
            domain=DomainName.KLINE,
            interval="1Mutc",
            transport=DomainTransport.CACHE_READ,
            cache_origin=cache_origin,
            source=DomainSource.MISSING,
            fallback_reason=fallback_reason,
        ),
        now_ms=NOW_MS,
    )

    assert result.freshness == DomainFreshness.MISSING
    assert result.age_ms is None
    assert result.ttl_ms is None
    assert result.stale is False
    assert result.freshness_basis == DomainFreshnessBasis.NOT_APPLICABLE


def test_invalid_now_ms_is_rejected():
    with pytest.raises(ValueError, match="now_ms"):
        resolve_domain_snapshot_freshness(_context(), now_ms=-1)
