import pytest

from app.schemas.market import TradeItem, TradesResponse
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainCompletenessStatus,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainSource,
    DomainTransport,
)
from app.services.spot_trades_domain_snapshot import map_trades_domain_snapshot


def _trade(**overrides):
    item = {
        "provider_trade_id": "trade-1",
        "trade_id": "trade-1",
        "id": "trade-1",
        "price": "60750.1",
        "amount": "0.25",
        "side": "BUY",
        "ts": 1_720_000_000_100,
        "event_time_ms": 1_720_000_000_100,
        "received_at_ms": 1_720_000_000_150,
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
    }
    item.update(overrides)
    return item


def _trades_payload(items=None, **overrides):
    payload = {
        "symbol": "BTCUSDT",
        "trades": [_trade()] if items is None else items,
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "received_at_ms": 1_720_000_000_150,
    }
    payload.update(overrides)
    return payload


def test_trades_snapshot_maps_live_ws_batch_metadata():
    payload = _trades_payload(
        items=[
            _trade(event_time_ms=1_720_000_000_100),
            _trade(
                id="trade-2",
                trade_id="trade-2",
                provider_trade_id="trade-2",
                event_time_ms=1_720_000_000_120,
            ),
        ]
    )
    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=payload,
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        cache_updated_at_ms=1_720_000_000_175,
        age_ms=25,
        ttl_ms=1_500,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
        snapshot_id="trades-live-1",
    )

    metadata = snapshot.metadata
    assert snapshot.data == payload
    assert metadata.domain.value == "trades"
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


def test_trades_snapshot_maps_rest_fallback_from_real_item_metadata():
    batch_received_at_ms = 1_720_000_000_150
    response = TradesResponse(
        symbol="BTCUSDT",
        trades=[
            TradeItem(
                price="60750.1",
                amount="0.25",
                side="BUY",
                ts=1_720_000_000_100,
                event_time_ms=1_720_000_000_100,
                received_at_ms=batch_received_at_ms,
                provider="BITGET_SPOT",
                provider_symbol="BTCUSDT",
                source="external",
                freshness="RECENT",
            )
        ],
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        stale=False,
        received_at_ms=batch_received_at_ms,
    )
    legacy_response = response.model_dump()

    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=response,
        transport=DomainTransport.PROVIDER_REST,
        cache_origin=DomainCacheOrigin.NONE,
        fallback_reason=DomainFallbackReason.WS_MISS,
        ttl_ms=2_000,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert response.model_dump() == legacy_response
    assert snapshot.data == legacy_response
    assert snapshot.metadata.provider == "BITGET_SPOT"
    assert snapshot.metadata.provider_symbol == "BTCUSDT"
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS


def test_trades_snapshot_maps_explicit_last_good_context():
    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=_trades_payload(provider="LAST_GOOD", stale=True),
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


def test_trades_snapshot_missing_keeps_metadata_missing():
    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=None,
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


def test_trades_snapshot_preserves_strong_identity_authority():
    trade = _trade(
        identity_strength="STRONG",
        identity_key="provider:OKX_SPOT|trade:trade-1",
        occurrence_index=None,
    )
    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=_trades_payload(items=[trade]),
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data["trades"][0]["identity_strength"] == "STRONG"
    assert snapshot.data["trades"][0]["identity_key"] == "provider:OKX_SPOT|trade:trade-1"
    assert snapshot.data["trades"][0]["occurrence_index"] is None


def test_trades_snapshot_preserves_weak_fingerprint_authority():
    trade = _trade(
        id=None,
        trade_id=None,
        provider_trade_id=None,
        identity_strength="WEAK",
        identity_key="weak:('OKX_SPOT', 'BTC-USDT', 1720000000100, '60750.1', '0.25', 'BUY')",
        occurrence_index=1,
    )
    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=_trades_payload(items=[trade]),
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data["trades"][0]["identity_strength"] == "WEAK"
    assert snapshot.data["trades"][0]["identity_key"] == trade["identity_key"]
    assert snapshot.data["trades"][0]["occurrence_index"] == 1


def test_trades_snapshot_preserves_repeated_occurrences_without_deduplication():
    identity_key = "weak:('OKX_SPOT', 'BTC-USDT', 1720000000100, '60750.1', '0.25', 'BUY')"
    trades = [
        _trade(
            id=None,
            trade_id=None,
            provider_trade_id=None,
            identity_strength="WEAK",
            identity_key=identity_key,
            occurrence_index=1,
        ),
        _trade(
            id=None,
            trade_id=None,
            provider_trade_id=None,
            identity_strength="WEAK",
            identity_key=identity_key,
            occurrence_index=2,
        ),
    ]
    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=_trades_payload(items=trades),
        emitted_at_ms=1_720_000_000_200,
    )

    assert len(snapshot.data["trades"]) == 2
    assert [item["occurrence_index"] for item in snapshot.data["trades"]] == [1, 2]
    assert [item["identity_key"] for item in snapshot.data["trades"]] == [identity_key, identity_key]


@pytest.mark.parametrize(
    ("items", "expected"),
    [
        ([_trade(side=None, event_time_ms=None, ts=None)], DomainCompletenessStatus.PARTIAL),
        ([], DomainCompletenessStatus.EMPTY),
        ([_trade(price="invalid")], DomainCompletenessStatus.INVALID),
        ([_trade(amount="0")], DomainCompletenessStatus.INVALID),
        (["invalid"], DomainCompletenessStatus.INVALID),
    ],
)
def test_trades_snapshot_completeness_rules(items, expected):
    snapshot = map_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=_trades_payload(items=items),
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.completeness.status == expected
