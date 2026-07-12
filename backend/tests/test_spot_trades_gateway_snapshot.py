import asyncio

from app.schemas.market import TradeItem, TradesResponse
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


def _trade(
    trade_id="trade-1",
    *,
    event_time_ms=1_720_000_000_100,
    received_at_ms=1_720_000_000_150,
    provider="OKX_SPOT",
    provider_symbol="BTC-USDT",
    source="LIVE_WS",
    freshness="LIVE",
):
    return TradeItem(
        id=trade_id,
        trade_id=trade_id,
        provider_trade_id=trade_id,
        price="60750.1",
        amount="0.25",
        side="BUY",
        ts=event_time_ms,
        event_time_ms=event_time_ms,
        received_at_ms=received_at_ms,
        updated_at_ms=received_at_ms,
        provider=provider,
        provider_symbol=provider_symbol,
        source=source,
        freshness=freshness,
        time_origin="PROVIDER",
    )


def _trades(items=None, **overrides):
    response = TradesResponse(
        symbol="BTCUSDT",
        trades=[_trade()] if items is None else items,
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        stale=False,
        updated_at_ms=1_720_000_000_150,
        received_at_ms=1_720_000_000_150,
        source="LIVE_WS",
        freshness="LIVE",
    )
    return response.model_copy(update=overrides) if overrides else response


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


def _age_trades_broadcast_state(gateway, provider):
    key = gateway._domain_key("trades", "BTCUSDT", provider=provider)
    gateway._broadcast_state.remember_broadcast(
        key,
        None,
        now_ms=gateway._broadcast_state.now_ms() - 10_000,
    )


def test_gateway_records_live_ws_trades_snapshot_and_preserves_fifo_legacy_batch():
    gateway = _gateway()
    newer = _trade("trade-2", event_time_ms=1_720_000_000_120)
    older = _trade("trade-1", event_time_ms=1_720_000_000_100)
    trades = _trades([newer, older])
    legacy = trades.model_dump()

    snapshot = gateway._record_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=trades,
        emitted_at_ms=1_720_000_000_200,
    )
    batch = gateway._new_trades_for_broadcast("BTCUSDT", trades, snapshot=snapshot)

    assert trades.model_dump() == legacy
    assert snapshot.data == legacy
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
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.COMPLETE
    assert [trade.provider_trade_id for trade in batch] == ["trade-1", "trade-2"]
    assert gateway.get_trades_domain_snapshot("btcusdt") is snapshot


def test_gateway_consumes_market_domain_snapshot_without_rewriting_trade_identity():
    gateway = _gateway()
    newer = _trade("trade-2", event_time_ms=1_720_000_000_120)
    older = _trade("trade-1", event_time_ms=1_720_000_000_100)
    payload = _trades([newer, older]).model_dump()
    payload["trades"][0].update(
        {
            "identity_strength": "STRONG",
            "identity_key": "provider:OKX_SPOT|trade:trade-2",
            "occurrence_index": None,
        }
    )
    market_snapshot = build_market_domain_snapshot(
        symbol="BTCUSDT",
        domain="trades",
        data=payload,
        source="LIVE_WS",
        provider="OKX_SPOT",
        updated_at=1_720_000_000_150,
        version="v1",
        max_age_ms=1_500,
        now_ms=1_720_000_000_200,
    )

    snapshot = gateway.record_trades_market_domain_snapshot(
        snapshot=market_snapshot,
        context=DomainSnapshotContext(
            domain=DomainName.TRADES,
            symbol="BTCUSDT",
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

    assert snapshot.data == payload
    assert [item["provider_trade_id"] for item in snapshot.data["trades"]] == [
        "trade-2",
        "trade-1",
    ]
    assert snapshot.data["trades"][0]["identity_strength"] == "STRONG"
    assert snapshot.data["trades"][0]["identity_key"] == (
        "provider:OKX_SPOT|trade:trade-2"
    )
    assert snapshot.data["trades"][0]["occurrence_index"] is None
    assert snapshot.metadata.provider == "OKX_SPOT"


def test_gateway_records_rest_fallback_trades_snapshot_without_changing_legacy():
    gateway = _gateway()
    item = _trade(
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        source="external",
        freshness="RECENT",
    )
    trades = _trades(
        [item],
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        source=None,
        freshness=None,
    )
    legacy = trades.model_dump()
    snapshot = gateway._record_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=trades,
        transport=DomainTransport.PROVIDER_REST,
        cache_origin=DomainCacheOrigin.NONE,
        fallback_reason=DomainFallbackReason.WS_MISS,
        ttl_ms=2_000,
        freshness_basis=DomainFreshnessBasis.RECEIVED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.provider == "BITGET_SPOT"
    assert snapshot.metadata.provider_symbol == "BTCUSDT"
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.fallback_reason == DomainFallbackReason.WS_MISS
    assert snapshot.data == legacy
    assert trades.model_dump() == legacy


def test_gateway_records_last_good_trades_snapshot_without_rewriting_legacy():
    gateway = _gateway()
    trades = _trades(
        provider="LAST_GOOD",
        stale=True,
        source=None,
        freshness=None,
    )
    legacy = trades.model_dump()
    snapshot = gateway._record_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=trades,
        transport=DomainTransport.CACHE_READ,
        cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
        source=DomainSource.LAST_GOOD,
        freshness=DomainFreshness.LAST_GOOD,
        fallback_reason=DomainFallbackReason.PROVIDER_TIMEOUT,
        cache_updated_at_ms=1_719_999_990_000,
        age_ms=10_200,
        ttl_ms=2_000,
        stale=True,
        freshness_basis=DomainFreshnessBasis.CACHE_UPDATED_AT,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.metadata.provider == "LAST_GOOD"
    assert snapshot.metadata.source == DomainSource.LAST_GOOD
    assert snapshot.metadata.freshness == DomainFreshness.LAST_GOOD
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.LAST_GOOD_MEMORY
    assert snapshot.metadata.stale is True
    assert snapshot.data == legacy


def test_gateway_missing_trades_snapshot_does_not_produce_trade_broadcast():
    gateway = _gateway()
    snapshot = gateway._record_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=None,
        provider="OKX_SPOT",
        transport=DomainTransport.PROVIDER_WS,
        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
        fallback_reason=DomainFallbackReason.CACHE_MISS,
        emitted_at_ms=1_720_000_000_200,
    )

    assert snapshot.data is None
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.completeness.status == DomainCompletenessStatus.EMPTY
    assert gateway._new_trades_for_broadcast("BTCUSDT", None, snapshot=snapshot) == []
    assert gateway._broadcast_state._seen_trade_signatures == {}


def test_gateway_trades_snapshot_preserves_strong_identity_authority():
    gateway = _gateway()
    identity_key = "provider:OKX_SPOT|trade:trade-1"
    raw = {
        "symbol": "BTCUSDT",
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "trades": [
            {
                **_trade().model_dump(),
                "identity_strength": "STRONG",
                "identity_key": identity_key,
                "occurrence_index": None,
            }
        ],
    }
    snapshot = gateway._record_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=raw,
        emitted_at_ms=1_720_000_000_200,
    )
    trade = _trade()
    response = _trades([trade])
    batch = gateway._new_trades_for_broadcast("BTCUSDT", response, snapshot=snapshot)

    assert snapshot.data["trades"][0]["identity_strength"] == "STRONG"
    assert snapshot.data["trades"][0]["identity_key"] == identity_key
    assert snapshot.data["trades"][0]["occurrence_index"] is None
    assert gateway._trade_signature(trade) == identity_key
    assert batch == [trade]


def test_gateway_trades_snapshot_preserves_weak_fingerprint_authority():
    gateway = _gateway()
    weak_trade = _trade(None)
    identity_key = "weak:('OKX_SPOT', 'BTC-USDT', 1720000000100, '60750.1', '0.25', 'BUY')"
    raw = {
        "symbol": "BTCUSDT",
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "trades": [
            {
                **weak_trade.model_dump(),
                "identity_strength": "WEAK",
                "identity_key": identity_key,
                "occurrence_index": 1,
            }
        ],
    }
    snapshot = gateway._record_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=raw,
        emitted_at_ms=1_720_000_000_200,
    )
    response = _trades([weak_trade])
    batch = gateway._new_trades_for_broadcast("BTCUSDT", response, snapshot=snapshot)

    assert snapshot.data["trades"][0]["identity_strength"] == "WEAK"
    assert snapshot.data["trades"][0]["identity_key"] == identity_key
    assert snapshot.data["trades"][0]["occurrence_index"] == 1
    assert gateway._trade_signature(weak_trade).startswith("weak:")
    assert batch == [weak_trade]


def test_gateway_trades_snapshot_preserves_repeated_occurrences_and_existing_dedupe():
    gateway = _gateway()
    weak_one = _trade(None)
    weak_two = _trade(None)
    response = _trades([weak_one, weak_two])
    identity_key = "weak:('OKX_SPOT', 'BTC-USDT', 1720000000100, '60750.1', '0.25', 'BUY')"
    raw = {
        "symbol": "BTCUSDT",
        "provider": "OKX_SPOT",
        "provider_symbol": "BTC-USDT",
        "source": "LIVE_WS",
        "freshness": "LIVE",
        "stale": False,
        "trades": [
            {**weak_one.model_dump(), "identity_strength": "WEAK", "identity_key": identity_key, "occurrence_index": 1},
            {**weak_two.model_dump(), "identity_strength": "WEAK", "identity_key": identity_key, "occurrence_index": 2},
        ],
    }
    snapshot = gateway._record_trades_domain_snapshot(
        symbol="BTCUSDT",
        trades=raw,
        emitted_at_ms=1_720_000_000_200,
    )

    first_batch = gateway._new_trades_for_broadcast("BTCUSDT", response, snapshot=snapshot)
    assert len(first_batch) == 2
    assert [item["occurrence_index"] for item in snapshot.data["trades"]] == [1, 2]

    _age_trades_broadcast_state(gateway, "OKX_SPOT")
    assert gateway._new_trades_for_broadcast("BTCUSDT", response, snapshot=snapshot) == []

    third = _trade(None)
    three = _trades([weak_one, weak_two, third])
    _age_trades_broadcast_state(gateway, "OKX_SPOT")
    third_occurrence = gateway._new_trades_for_broadcast("BTCUSDT", three, snapshot=snapshot)
    assert len(third_occurrence) == 1


def test_gateway_refresh_loop_stores_trades_snapshot_but_sends_legacy_trade_only():
    class OneCycleWsManager:
        def __init__(self):
            self.subscriber_calls = 0
            self.trade_broadcasts = []

        async def subscriber_count(self, _symbol):
            self.subscriber_calls += 1
            return 1 if self.subscriber_calls == 1 else 0

        async def send_trade(self, **kwargs):
            self.trade_broadcasts.append(kwargs)

        async def kline_intervals(self, _symbol):
            return []

    async def run():
        ws_manager = OneCycleWsManager()
        trades = _trades()
        gateway = SpotMarketGateway(
            ensure_depth=lambda _symbol: None,
            ensure_kline=lambda _symbol, _interval: None,
            release_depth=lambda _symbol: None,
            get_depth=lambda _symbol, **_kwargs: None,
            get_ticker=lambda _symbol, **_kwargs: None,
            get_trades=lambda _symbol, **_kwargs: trades,
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

        snapshot = gateway.get_trades_domain_snapshot("BTCUSDT")
        assert snapshot is not None
        assert snapshot.metadata.provider == "OKX_SPOT"
        assert len(ws_manager.trade_broadcasts) == 1
        legacy = ws_manager.trade_broadcasts[0]
        assert legacy["provider_trade_id"] == "trade-1"
        assert legacy["price"] == "60750.1"
        assert "metadata" not in legacy
        assert "schema_version" not in legacy

    asyncio.run(run())
