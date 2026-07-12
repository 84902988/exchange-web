import asyncio

import pytest

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
from app.services.market_kline_cache import build_market_kline_cache_metadata
from app.services.spot_domain_snapshot_freshness import DomainSnapshotContext
from app.services.spot_market_gateway import SpotMarketGateway


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
        "revision_epoch": 3,
        "revision_seq": 8,
        "is_closed": False,
        "close_state_source": "PROVIDER_CONFIRMED",
    }
    item.update(overrides)
    return item


def _kline(items=None, **overrides):
    payload = {
        "symbol": "BTCUSDT",
        "interval": "1m",
        "items": [_bar()] if items is None else items,
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "provider_event_time_ms": 1_720_000_000_120,
        "received_at_ms": 1_720_000_000_150,
        "updated_at_ms": 1_720_000_000_150,
    }
    payload.update(overrides)
    return payload


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


def test_gateway_records_live_ws_kline_snapshot_without_changing_bars_or_order():
    gateway = _gateway()
    later = _bar(open_time=1_720_000_060_000, revision_seq=9, close="61050.0")
    earlier = _bar(open_time=1_720_000_000_000, revision_seq=8, close="60780.0")
    payload = _kline(items=[later, earlier])
    snapshot = gateway._record_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1m",
        kline=payload,
        revision_epoch=3,
        revision_sequence=9,
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
        coverage_complete=True,
        continuity_valid=True,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data == payload
    assert snapshot.data["items"] == [later, earlier]
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.provider_symbol == "BTC-USDT"
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_WS
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.PROVIDER_MEMORY
    assert snapshot.metadata.source == DomainSource.LIVE_WS
    assert snapshot.metadata.freshness == DomainFreshness.LIVE
    assert snapshot.metadata.provider_event_time_ms == 1_720_000_000_120
    assert snapshot.metadata.received_at_ms == 1_720_000_000_150
    assert snapshot.metadata.cache_updated_at_ms == 1_720_000_000_150
    assert snapshot.metadata.age_ms == 50
    assert snapshot.metadata.ttl_ms == 1_500
    assert snapshot.metadata.interval == "1m"
    assert snapshot.metadata.coverage_complete is True
    assert snapshot.metadata.continuity_valid is True
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.COMPLETE
    assert gateway.get_kline_domain_snapshot("btcusdt", "1m") is snapshot


def test_gateway_consumes_current_market_snapshot_and_keeps_full_kline_response():
    gateway = _gateway()
    history = _bar(
        open_time=1_720_000_000_000,
        revision_seq=8,
        is_closed=True,
        close_state_source="REST_CONFIRMED",
    )
    current = _bar(
        open_time=1_720_000_060_000,
        revision_seq=9,
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
    )
    response = _kline(
        items=[history, current],
        coverage_complete=True,
        continuity_valid=True,
    )
    cache_metadata = build_market_kline_cache_metadata(
        data=[current],
        source="LIVE_WS",
        provider="OKX_SPOT",
        updated_at=1_720_000_000_150,
        interval="1m",
    )
    market_snapshot = cache_metadata.to_domain_snapshot(
        symbol="BTCUSDT",
        now_ms=1_720_000_000_200,
    )

    snapshot = gateway.record_kline_market_domain_snapshot(
        snapshot=market_snapshot,
        kline=response,
        context=DomainSnapshotContext(
            domain=DomainName.KLINE,
            symbol="BTCUSDT",
            interval="1m",
            transport=DomainTransport.PROVIDER_WS,
            cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
            source=DomainSource.LIVE_WS,
            provider="LEGACY_PROVIDER",
            provider_symbol="BTC-USDT",
            received_at_ms=1_720_000_000_150,
            ttl_ms=1_500,
        ),
        emitted_at_ms=1_720_000_000_200,
    )

    assert market_snapshot.data == [current]
    assert snapshot.data == response
    assert snapshot.data["items"] == [history, current]
    assert snapshot.metadata.interval == "1m"
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.coverage_complete is True
    assert snapshot.metadata.continuity_valid is True
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.epoch == 3
    assert snapshot.metadata.revision.sequence == 9
    assert snapshot.metadata.revision.is_closed is False
    assert snapshot.metadata.revision.close_state_source == "PROVIDER_CONFIRMED"


def test_gateway_refresh_loop_stores_snapshot_but_broadcasts_legacy_kline_only():
    class OneCycleWsManager:
        def __init__(self):
            self.subscriber_calls = 0
            self.kline_broadcasts = []

        async def subscriber_count(self, _symbol):
            self.subscriber_calls += 1
            return 1 if self.subscriber_calls == 1 else 0

        async def kline_intervals(self, _symbol):
            return ["1m"]

        async def broadcast_provider_kline_update(self, symbol, interval, kline, **kwargs):
            self.kline_broadcasts.append(
                {"symbol": symbol, "interval": interval, "kline": kline, **kwargs}
            )

    async def run():
        ws_manager = OneCycleWsManager()
        payload = _kline()
        gateway = SpotMarketGateway(
            ensure_depth=lambda _symbol: None,
            ensure_kline=lambda _symbol, _interval: None,
            release_depth=lambda _symbol: None,
            get_depth=lambda _symbol, **_kwargs: None,
            get_ticker=lambda _symbol, **_kwargs: None,
            get_trades=lambda _symbol, **_kwargs: None,
            get_klines=lambda _symbol, _interval, **_kwargs: payload,
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

        snapshot = gateway.get_kline_domain_snapshot("BTCUSDT", "1m")
        assert snapshot is not None
        assert snapshot.metadata.revision is not None
        assert snapshot.metadata.revision.epoch == 3
        assert snapshot.metadata.revision.sequence == 8
        assert len(ws_manager.kline_broadcasts) == 1
        legacy = ws_manager.kline_broadcasts[0]
        assert legacy["kline"] == payload["items"][0]
        assert legacy["revision_epoch"] == 3
        assert legacy["revision_seq"] == 8
        assert "metadata" not in legacy["kline"]
        assert "schema_version" not in legacy["kline"]

    asyncio.run(run())


def test_gateway_records_rest_history_kline_snapshot():
    gateway = _gateway()
    payload = _kline(
        source="REST_HISTORY",
        freshness="RECENT",
        history_terminal=False,
        history_incomplete=True,
        coverage_complete=False,
        continuity_valid=True,
    )
    snapshot = gateway._record_kline_domain_snapshot(
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
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS
    assert snapshot.metadata.history_terminal is False
    assert snapshot.metadata.history_incomplete is True
    assert snapshot.metadata.coverage_complete is False
    assert snapshot.metadata.continuity_valid is True


def test_gateway_records_db_cache_kline_snapshot():
    gateway = _gateway()
    payload = _kline(
        interval="1Dutc",
        source="DB_CACHE",
        freshness="CACHED",
        history_terminal=None,
        history_incomplete=False,
        coverage_complete=True,
        continuity_valid=True,
    )
    snapshot = gateway._record_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1Dutc",
        kline=payload,
        transport=DomainTransport.DB_READ,
        cache_origin=DomainCacheOrigin.DATABASE,
        cache_updated_at_ms=1_720_000_000_000,
        age_ms=200,
        ttl_ms=60_000,
        freshness_basis=DomainFreshnessBasis.DB_UPDATED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.interval == "1Dutc"
    assert snapshot.metadata.source == DomainSource.DB_CACHE
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.DATABASE
    assert snapshot.metadata.coverage_complete is True
    assert snapshot.metadata.continuity_valid is True


def test_gateway_records_history_boundary_without_kline_broadcast_candidate():
    gateway = _gateway()
    boundary = _kline(
        interval="1Mutc",
        items=[],
        source="EMPTY",
        freshness="MISSING",
        history_terminal=True,
        history_incomplete=False,
        terminal_reason="PROVIDER_HISTORY_BOUNDARY",
        earliest_available_time=1_514_764_800_000,
        coverage_complete=True,
        continuity_valid=True,
    )
    snapshot = gateway._record_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1Mutc",
        kline=boundary,
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.HISTORY_BOUNDARY,
        fallback_reason=DomainFallbackReason.HISTORY_BOUNDARY,
        emitted_at_ms=1_720_000_000_200,
    )

    assert gateway._latest_kline_for_broadcast(boundary) is None
    assert snapshot.metadata.history_terminal is True
    assert snapshot.metadata.history_incomplete is False
    assert snapshot.metadata.terminal_reason == "PROVIDER_HISTORY_BOUNDARY"
    assert snapshot.metadata.earliest_available_time == 1_514_764_800_000
    assert snapshot.metadata.coverage_complete is True
    assert snapshot.metadata.continuity_valid is True
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.EMPTY


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
def test_gateway_records_last_good_and_stale_kline_snapshots(
    source,
    freshness,
    cache_origin,
    expected_source,
    expected_freshness,
):
    gateway = _gateway()
    snapshot = gateway._record_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1m",
        kline=_kline(source=source, freshness=freshness, stale=True),
        transport=DomainTransport.CACHE_READ,
        cache_origin=cache_origin,
        fallback_reason=DomainFallbackReason.CACHE_STALE,
        stale=True,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.source == expected_source
    assert snapshot.metadata.freshness == expected_freshness
    assert snapshot.metadata.stale is True


def test_gateway_kline_snapshot_preserves_existing_revision_authority_and_interval_cleanup():
    gateway = _gateway()
    current = _bar(revision_epoch=4, revision_seq=12, is_closed=False)
    current_payload = _kline(items=[current])
    snapshot = gateway._record_kline_domain_snapshot(
        symbol="BTCUSDT",
        interval="1m",
        kline=current_payload,
        revision_epoch=4,
        revision_sequence=12,
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data["items"] == [current]
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.epoch == 4
    assert snapshot.metadata.revision.sequence == 12
    assert snapshot.metadata.revision.is_closed is False
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        current,
        provider="OKX_SPOT",
        snapshot=snapshot,
    ) is True

    older = _bar(revision_epoch=4, revision_seq=11, is_closed=False)
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        older,
        provider="OKX_SPOT",
        snapshot=snapshot,
    ) is False
    domain_key = gateway._domain_key("kline", "BTCUSDT", provider="OKX_SPOT", interval="1m")
    assert gateway._kline_revision_high_water[domain_key] == (
        current["open_time"],
        4,
        12,
    )

    gateway._clear_kline_interval_state("BTCUSDT", "1m", provider="OKX_SPOT")
    assert gateway.get_kline_domain_snapshot("BTCUSDT", "1m") is None
    assert domain_key not in gateway._kline_revision_high_water
