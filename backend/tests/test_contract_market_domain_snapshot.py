from datetime import datetime, timezone

from app.schemas.contract_market import ContractQuoteResponse
from app.schemas.contract_market_domain_snapshot import (
    CONTRACT_MARKET_DOMAIN_SNAPSHOT_SCHEMA_VERSION,
    ContractMarketDomainCacheOrigin,
    ContractMarketDomainCompletenessStatus,
    ContractMarketDomainFallbackReason,
    ContractMarketDomainFreshness,
    ContractMarketDomainFreshnessBasis,
    ContractMarketDomainName,
    ContractMarketDomainSource,
    ContractMarketDomainTransport,
)
from app.services.contract_market_domain_freshness import (
    ContractMarketDomainFreshnessContext,
    resolve_contract_market_domain_freshness,
)
from app.services.contract_market_domain_snapshot import (
    ContractMarketDomainSnapshotAuthorityReason,
    ContractMarketDomainSnapshotContext,
    compare_contract_market_domain_snapshots,
    map_contract_depth_domain_snapshot,
    map_contract_kline_domain_snapshot,
    map_contract_ticker_domain_snapshot,
    map_contract_trades_domain_snapshot,
    unwrap_contract_market_domain_snapshot,
)


NOW_MS = 1_720_000_000_200


def _live_context(**overrides):
    values = {
        "symbol": "BTCUSDT_PERP",
        "transport": ContractMarketDomainTransport.PROVIDER_WS,
        "cache_origin": ContractMarketDomainCacheOrigin.PROVIDER_MEMORY,
        "source": ContractMarketDomainSource.LIVE_WS,
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "provider_event_time_ms": 1_720_000_000_100,
        "received_at_ms": 1_720_000_000_150,
        "cache_updated_at_ms": 1_720_000_000_175,
        "ttl_ms": 1_500,
        "provider_generation": 3,
        "emitted_at_ms": NOW_MS,
    }
    values.update(overrides)
    return ContractMarketDomainSnapshotContext(**values)


def test_ticker_snapshot_carries_authority_metadata_and_schema_version():
    ticker = {
        "symbol": "BTCUSDT_PERP",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "source": "LIVE_WS",
        "last_price": "60780.0",
        "bid_price": "60779.9",
        "ask_price": "60780.1",
        "sequence": 88,
        "checksum": "ticker-88",
    }

    snapshot = map_contract_ticker_domain_snapshot(
        context=_live_context(snapshot_id="ticker-live-1"),
        ticker=ticker,
    )

    assert snapshot.schema_version == CONTRACT_MARKET_DOMAIN_SNAPSHOT_SCHEMA_VERSION
    assert snapshot.snapshot_id == "ticker-live-1"
    assert snapshot.data == ticker
    assert snapshot.metadata.domain == ContractMarketDomainName.TICKER
    assert snapshot.metadata.symbol == "BTCUSDT_PERP"
    assert snapshot.metadata.source == ContractMarketDomainSource.LIVE_WS
    assert snapshot.metadata.provider == "OKX_SWAP"
    assert snapshot.metadata.provider_symbol == "BTC-USDT-SWAP"
    assert snapshot.metadata.freshness == ContractMarketDomainFreshness.LIVE
    assert snapshot.metadata.freshness_basis == ContractMarketDomainFreshnessBasis.RECEIVED_AT
    assert snapshot.metadata.age_ms == 50
    assert snapshot.metadata.provider_generation == 3
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.epoch == 3
    assert snapshot.metadata.revision.sequence == 88
    assert snapshot.metadata.revision.checksum == "ticker-88"
    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.COMPLETE


def test_ticker_snapshot_preserves_legacy_model_and_unwrap_is_isolated():
    quote = ContractQuoteResponse(
        symbol="BTCUSDT_PERP",
        provider="OKX_SWAP",
        provider_symbol="BTC-USDT-SWAP",
        bid="60779.9",
        ask="60780.1",
        bid_price="60779.9",
        ask_price="60780.1",
        best_bid="60779.9",
        best_ask="60780.1",
        last_price="60780.0",
        mark_price="60780.0",
        source="LIVE_WS",
        ts=datetime(2024, 7, 3, tzinfo=timezone.utc),
    )
    legacy_before = quote.model_dump()

    snapshot = map_contract_ticker_domain_snapshot(
        context=_live_context(),
        ticker=quote,
    )
    unwrapped = unwrap_contract_market_domain_snapshot(snapshot)
    unwrapped["last_price"] = "1"

    assert quote.model_dump() == legacy_before
    assert snapshot.data == legacy_before
    assert snapshot.data["last_price"] == "60780.0"


def test_depth_snapshot_preserves_book_and_marks_one_sided_data_partial():
    depth = {
        "symbol": "BTCUSDT_PERP",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "source": "LIVE_WS",
        "bids": [["60779.9", "1.25"]],
        "asks": [],
        "generation": 4,
        "sequence": 1,
        "checksum": 123456,
    }
    original = dict(depth)

    snapshot = map_contract_depth_domain_snapshot(
        context=_live_context(provider_generation=None),
        depth=depth,
    )

    assert depth == original
    assert snapshot.data == depth
    assert snapshot.metadata.domain == ContractMarketDomainName.DEPTH
    assert snapshot.metadata.provider_generation == 4
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.epoch == 4
    assert snapshot.metadata.revision.sequence == 1
    assert snapshot.metadata.revision.checksum == "123456"
    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.PARTIAL
    assert snapshot.metadata.completeness.missing_fields == ["asks"]


def test_bbo_snapshot_keeps_prices_when_provider_quantity_is_unavailable():
    snapshot = map_contract_depth_domain_snapshot(
        context=_live_context(provider_generation=1),
        depth={
            "symbol": "XAGUSDT_PERP",
            "provider": "ITICK",
            "source": "LIVE_WS",
            "depth_mode": "BBO_ONLY",
            "bids": [["57.084", "0"]],
            "asks": [["57.105", "0"]],
        },
    )

    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.COMPLETE
    assert snapshot.data["bids"] == [["57.084", "0"]]
    assert snapshot.data["asks"] == [["57.105", "0"]]


def test_trades_snapshot_accepts_legacy_list_without_reshaping_it():
    trades = [
        {
            "id": "trade-2",
            "symbol": "BTCUSDT_PERP",
            "price": "60780.1",
            "qty": "0.5",
            "time": 1_720_000_000_120,
            "provider": "OKX_SWAP",
            "provider_symbol": "BTC-USDT-SWAP",
            "source": "LIVE_WS",
            "quote_source": "LIVE_WS",
            "quote_freshness": "LIVE",
            "price_source": "TRADE_TICK",
            "synthetic": False,
        },
        {
            "id": "trade-1",
            "symbol": "BTCUSDT_PERP",
            "price": "60780.0",
            "amount": "0.25",
            "time": 1_720_000_000_100,
            "provider": "OKX_SWAP",
            "provider_symbol": "BTC-USDT-SWAP",
            "source": "LIVE_WS",
            "quote_source": "LIVE_WS",
            "quote_freshness": "LIVE",
            "price_source": "TRADE_TICK",
            "synthetic": False,
        },
    ]

    snapshot = map_contract_trades_domain_snapshot(
        context=_live_context(source=None, provider=None, provider_symbol=None),
        trades=trades,
    )

    assert snapshot.data == trades
    assert isinstance(snapshot.data, list)
    assert snapshot.metadata.domain == ContractMarketDomainName.TRADES
    assert snapshot.metadata.source == ContractMarketDomainSource.LIVE_WS
    assert snapshot.metadata.provider == "OKX_SWAP"
    assert snapshot.metadata.provider_symbol == "BTC-USDT-SWAP"
    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.COMPLETE
    assert snapshot.metadata.completeness.item_count == 2


def test_provider_rest_trade_snapshot_is_recent():
    trade = {
        "id": "trade-rest-1",
        "symbol": "BTCUSDT_PERP",
        "price": "60780.1",
        "qty": "0.5",
        "time": 1_720_000_000_120,
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "source": "PROVIDER_REST",
        "quote_source": "PROVIDER_REST",
        "quote_freshness": "RECENT",
        "price_source": "TRADE_TICK",
        "synthetic": False,
        "received_at_ms": 1_720_000_000_150,
    }
    context = ContractMarketDomainSnapshotContext(
        symbol="BTCUSDT_PERP",
        transport=ContractMarketDomainTransport.PROVIDER_REST,
        cache_origin=ContractMarketDomainCacheOrigin.NONE,
        source=ContractMarketDomainSource.REST_SNAPSHOT,
        received_at_ms=1_720_000_000_150,
        ttl_ms=1_500,
        emitted_at_ms=NOW_MS,
    )

    snapshot = map_contract_trades_domain_snapshot(context=context, trades=[trade])

    assert snapshot.metadata.source == ContractMarketDomainSource.REST_SNAPSHOT
    assert snapshot.metadata.freshness == ContractMarketDomainFreshness.RECENT
    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.COMPLETE


def test_itick_rest_quote_and_depth_sources_are_recent_snapshots():
    context = ContractMarketDomainSnapshotContext(
        symbol="XAUUSDT_PERP",
        transport=ContractMarketDomainTransport.PROVIDER_REST,
        cache_origin=ContractMarketDomainCacheOrigin.NONE,
        received_at_ms=NOW_MS - 50,
        ttl_ms=1_500,
        emitted_at_ms=NOW_MS,
    )

    ticker = map_contract_ticker_domain_snapshot(
        context=context,
        ticker={
            "symbol": "XAUUSDT_PERP",
            "provider": "ITICK",
            "source": "ITICK_QUOTE",
            "last_price": "4012.5",
        },
    )
    depth = map_contract_depth_domain_snapshot(
        context=context,
        depth={
            "symbol": "XAUUSDT_PERP",
            "provider": "ITICK",
            "source": "ITICK_DEPTH",
            "bids": [["4012.1", "0"]],
            "asks": [["4012.9", "0"]],
        },
    )

    assert ticker.metadata.source == ContractMarketDomainSource.REST_SNAPSHOT
    assert ticker.metadata.freshness == ContractMarketDomainFreshness.RECENT
    assert depth.metadata.source == ContractMarketDomainSource.REST_SNAPSHOT
    assert depth.metadata.freshness == ContractMarketDomainFreshness.RECENT


def test_synthetic_trade_snapshot_is_invalid_and_cannot_bootstrap_authority():
    synthetic = {
        "id": "fake-1",
        "symbol": "BTCUSDT_PERP",
        "price": "60780.1",
        "qty": "0.5",
        "time": 1_720_000_000_120,
        "source": "SYNTHETIC_FROM_QUOTE",
        "quote_source": "SYNTHETIC_FROM_QUOTE",
        "quote_freshness": "LIVE",
        "price_source": "SYNTHETIC_FROM_QUOTE",
        "synthetic": True,
    }
    snapshot = map_contract_trades_domain_snapshot(
        context=_live_context(source=None, provider=None, provider_symbol=None),
        trades=[synthetic],
    )

    assert snapshot.metadata.source == ContractMarketDomainSource.MISSING
    assert snapshot.metadata.freshness == ContractMarketDomainFreshness.MISSING
    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.INVALID
    result = compare_contract_market_domain_snapshots(None, snapshot)
    assert result.accepted is False
    assert result.reason == ContractMarketDomainSnapshotAuthorityReason.INVALID_SNAPSHOT


def test_kline_snapshot_carries_revision_and_complete_terminal_evidence():
    boundary = {
        "symbol": "BTCUSDT_PERP",
        "interval": "1M",
        "items": [],
        "source": "MISSING",
        "history_terminal": True,
        "history_incomplete": False,
        "terminal_reason": "PROVIDER_HISTORY_BOUNDARY",
        "earliest_available_time": 1_514_764_800_000,
        "coverage_complete": True,
        "continuity_valid": True,
        "history_complete": True,
        "has_more_before": False,
        "retryable": False,
    }
    context = ContractMarketDomainSnapshotContext(
        symbol="BTCUSDT_PERP",
        interval="1M",
        transport=ContractMarketDomainTransport.CACHE_READ,
        cache_origin=ContractMarketDomainCacheOrigin.HISTORY_BOUNDARY,
        source=ContractMarketDomainSource.MISSING,
        fallback_reason=ContractMarketDomainFallbackReason.HISTORY_BOUNDARY,
        emitted_at_ms=NOW_MS,
    )

    snapshot = map_contract_kline_domain_snapshot(context=context, kline=boundary)
    terminal = snapshot.metadata.terminal

    assert snapshot.data == boundary
    assert snapshot.metadata.domain == ContractMarketDomainName.KLINE
    assert snapshot.metadata.interval == "1M"
    assert snapshot.metadata.freshness == ContractMarketDomainFreshness.MISSING
    assert snapshot.metadata.stale is False
    assert terminal.history_terminal is True
    assert terminal.history_incomplete is False
    assert terminal.terminal_reason == "PROVIDER_HISTORY_BOUNDARY"
    assert terminal.earliest_available_time == 1_514_764_800_000
    assert terminal.coverage_complete is True
    assert terminal.continuity_valid is True
    assert terminal.history_complete is True
    assert terminal.has_more_before is False
    assert terminal.retryable is False
    assert terminal.evidence_complete is True


def test_kline_current_snapshot_preserves_provider_candle_revision():
    kline = {
        "symbol": "BTCUSDT_PERP",
        "interval": "1m",
        "open_time": 1_720_000_000_000,
        "open": "60750.1",
        "high": "60800.0",
        "low": "60700.0",
        "close": "60780.0",
        "volume": "12.5",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "source": "LIVE_WS",
        "revision_epoch": 7,
        "revision_seq": 12,
        "is_closed": False,
        "close_state_source": "PROVIDER_CONFIRMED",
    }

    snapshot = map_contract_kline_domain_snapshot(
        context=_live_context(interval="1m"),
        kline=kline,
    )

    assert snapshot.data == kline
    assert snapshot.metadata.interval == "1m"
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.epoch == 7
    assert snapshot.metadata.revision.sequence == 12
    assert snapshot.metadata.revision.is_closed is False
    assert snapshot.metadata.revision.close_state_source == "PROVIDER_CONFIRMED"
    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.COMPLETE


def test_transient_empty_kline_is_not_promoted_to_terminal():
    transient = {
        "items": [],
        "source": "MISSING",
        "history_incomplete": True,
        "history_complete": False,
        "has_more_before": None,
        "retryable": True,
    }
    snapshot = map_contract_kline_domain_snapshot(
        context=ContractMarketDomainSnapshotContext(
            symbol="BTCUSDT_PERP",
            interval="1w",
            source=ContractMarketDomainSource.MISSING,
            fallback_reason=ContractMarketDomainFallbackReason.PROVIDER_TIMEOUT,
            emitted_at_ms=NOW_MS,
        ),
        kline=transient,
    )

    assert snapshot.metadata.terminal.history_terminal is None
    assert snapshot.metadata.terminal.history_incomplete is True
    assert snapshot.metadata.terminal.retryable is True
    assert snapshot.metadata.terminal.evidence_complete is False
    assert snapshot.metadata.completeness.status == ContractMarketDomainCompletenessStatus.EMPTY


def test_freshness_uses_local_time_and_provider_time_only_as_lag_guard():
    context = ContractMarketDomainFreshnessContext(
        domain=ContractMarketDomainName.TICKER,
        symbol="BTCUSDT_PERP",
        transport=ContractMarketDomainTransport.PROVIDER_WS,
        cache_origin=ContractMarketDomainCacheOrigin.PROVIDER_MEMORY,
        source=ContractMarketDomainSource.LIVE_WS,
        provider_event_time_ms=100,
        received_at_ms=1_000,
        ttl_ms=500,
    )

    result = resolve_contract_market_domain_freshness(context, now_ms=1_100)

    assert result.age_ms == 100
    assert result.freshness_basis == ContractMarketDomainFreshnessBasis.RECEIVED_AT
    assert result.freshness == ContractMarketDomainFreshness.STALE
    assert result.stale is True
