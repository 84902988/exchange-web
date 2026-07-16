from __future__ import annotations

from app.schemas.contract_market_domain_snapshot import (
    ContractMarketDomainCacheOrigin,
    ContractMarketDomainName,
    ContractMarketDomainRevision,
    ContractMarketDomainSource,
    ContractMarketDomainTransport,
)
from app.services.contract_market_domain_snapshot import (
    ContractMarketDomainSnapshotAuthorityReason,
    ContractMarketDomainSnapshotContext,
    map_contract_kline_domain_snapshot,
    map_contract_ticker_domain_snapshot,
)
from app.services.contract_market_gateway import (
    CONTRACT_MARKET_CACHE_DEPTH,
    CONTRACT_MARKET_CACHE_KLINE,
    CONTRACT_MARKET_CACHE_QUOTE,
    CONTRACT_MARKET_CACHE_TRADES,
    ContractMarketGateway,
)
from app.services.contract_market_provider_ws import (
    ContractMarketProviderWsService,
    ProviderTickerSubscription,
)


NOW_MS = 1_720_000_000_000
SYMBOL = "BTCUSDT_PERP"


def _context(
    *,
    received_at_ms: int,
    generation: int | None = None,
    revision_sequence: int | None = None,
    interval: str | None = None,
    emitted_at_ms: int | None = None,
) -> ContractMarketDomainSnapshotContext:
    revision = None
    if revision_sequence is not None:
        revision = ContractMarketDomainRevision(
            epoch=generation,
            sequence=revision_sequence,
        )
    return ContractMarketDomainSnapshotContext(
        symbol=SYMBOL,
        interval=interval,
        transport=ContractMarketDomainTransport.PROVIDER_WS,
        cache_origin=ContractMarketDomainCacheOrigin.PROVIDER_MEMORY,
        source=ContractMarketDomainSource.LIVE_WS,
        provider="OKX_SWAP",
        provider_symbol="BTC-USDT-SWAP",
        provider_event_time_ms=received_at_ms,
        received_at_ms=received_at_ms,
        ttl_ms=5_000,
        provider_generation=generation,
        revision=revision,
        emitted_at_ms=emitted_at_ms or received_at_ms,
    )


def test_gateway_rejects_snapshot_from_old_provider_generation():
    gateway = ContractMarketGateway()
    current = {"bids": [["100", "1"]], "asks": [["101", "1"]]}
    old_generation = {"bids": [["99", "1"]], "asks": [["100", "1"]]}
    authority = {
        "source": "PROVIDER_WS",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": NOW_MS,
        "provider_generation": 2,
        "revision_epoch": 2,
        "revision_sequence": 10,
    }

    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_DEPTH,
        SYMBOL,
        current,
        authority_payload=authority,
    )
    assert not gateway._set_latest(
        CONTRACT_MARKET_CACHE_DEPTH,
        SYMBOL,
        old_generation,
        authority_payload={
            **authority,
            "received_at_ms": NOW_MS + 1,
            "provider_generation": 1,
            "revision_epoch": 1,
            "revision_sequence": 99,
        },
    )

    winner = gateway.get_domain_snapshot(ContractMarketDomainName.DEPTH, SYMBOL)
    assert winner is not None
    assert winner.metadata.provider_generation == 2
    assert winner.data == current
    assert gateway._get_latest(CONTRACT_MARKET_CACHE_DEPTH, SYMBOL) == current


def test_gateway_rejects_stale_snapshot_without_revision_evidence():
    gateway = ContractMarketGateway()
    current = map_contract_ticker_domain_snapshot(
        context=_context(received_at_ms=NOW_MS),
        ticker={"last_price": "101", "bid_price": "100", "ask_price": "102"},
    )
    stale = map_contract_ticker_domain_snapshot(
        context=_context(
            received_at_ms=NOW_MS - 1_000,
            emitted_at_ms=NOW_MS + 1,
        ),
        ticker={"last_price": "99", "bid_price": "98", "ask_price": "100"},
    )

    assert gateway._accept_domain_snapshot(current).accepted is True
    rejected = gateway._accept_domain_snapshot(stale)

    assert rejected.accepted is False
    assert rejected.reason == ContractMarketDomainSnapshotAuthorityReason.STALE_SNAPSHOT
    winner = gateway.get_domain_snapshot(ContractMarketDomainName.TICKER, SYMBOL)
    assert winner is not None
    assert winner.data["last_price"] == "101"


def test_gateway_rejects_revision_sequence_rollback():
    gateway = ContractMarketGateway()
    current = map_contract_kline_domain_snapshot(
        context=_context(
            received_at_ms=NOW_MS,
            generation=3,
            revision_sequence=12,
            interval="1m",
        ),
        kline={
            "open_time": NOW_MS - 60_000,
            "open": "100",
            "high": "103",
            "low": "99",
            "close": "102",
            "volume": "5",
        },
    )
    rollback = map_contract_kline_domain_snapshot(
        context=_context(
            received_at_ms=NOW_MS + 1,
            generation=3,
            revision_sequence=11,
            interval="1m",
        ),
        kline={
            "open_time": NOW_MS - 60_000,
            "open": "100",
            "high": "101",
            "low": "98",
            "close": "99",
            "volume": "4",
        },
    )

    assert gateway._accept_domain_snapshot(current).accepted is True
    rejected = gateway._accept_domain_snapshot(rollback)

    assert rejected.accepted is False
    assert rejected.reason == ContractMarketDomainSnapshotAuthorityReason.REVISION_ROLLBACK
    winner = gateway.get_domain_snapshot(
        ContractMarketDomainName.KLINE,
        SYMBOL,
        interval="1m",
    )
    assert winner is not None
    assert winner.metadata.revision is not None
    assert winner.metadata.revision.sequence == 12
    assert winner.data["close"] == "102"


def test_gateway_builds_four_domain_snapshots_without_changing_legacy_payloads():
    gateway = ContractMarketGateway()
    authority = {
        "source": "PROVIDER_WS",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": NOW_MS,
        "provider_generation": 4,
        "revision_epoch": 4,
        "revision_sequence": 1,
    }
    ticker = {"last_price": "101", "bid_price": "100", "ask_price": "102"}
    depth = {"bids": [["100", "1"]], "asks": [["102", "1"]]}
    trades = [
        {
            "id": "t-1",
            "symbol": SYMBOL,
            "price": "101",
            "qty": "1",
            "time": NOW_MS,
            "source": "PROVIDER_WS",
            "quote_source": "PROVIDER_WS",
            "quote_freshness": "LIVE",
            "price_source": "TRADE_TICK",
            "provider": "OKX_SWAP",
            "provider_symbol": "BTC-USDT-SWAP",
            "synthetic": False,
        }
    ]
    kline = {
        "open_time": NOW_MS - 60_000,
        "open": "100",
        "high": "103",
        "low": "99",
        "close": "101",
        "volume": "5",
    }

    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_QUOTE,
        SYMBOL,
        ticker,
        authority_payload=authority,
    )
    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_DEPTH,
        SYMBOL,
        depth,
        authority_payload=authority,
    )
    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_TRADES,
        SYMBOL,
        trades,
        authority_payload={**authority, "trades": trades},
    )
    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_KLINE,
        SYMBOL,
        kline,
        interval="1m",
        authority_payload={**authority, **kline},
    )

    for domain in ContractMarketDomainName:
        snapshot = gateway.get_domain_snapshot(
            domain,
            SYMBOL,
            interval="1m" if domain == ContractMarketDomainName.KLINE else None,
        )
        assert snapshot is not None
        assert snapshot.metadata.provider_generation == 4

    assert gateway._get_latest(CONTRACT_MARKET_CACHE_QUOTE, SYMBOL) == ticker
    envelope = gateway._quote_message(SYMBOL, ticker)
    assert envelope["data"] == ticker
    assert "snapshot" not in envelope
    assert "metadata" not in envelope
    assert "provider_generation" not in envelope["data"]


def test_provider_ws_cache_carries_generation_and_rejects_old_writer():
    service = ContractMarketProviderWsService()
    subscription = ProviderTickerSubscription(
        local_symbol=SYMBOL,
        provider="OKX_SWAP",
        provider_symbol="BTC-USDT-SWAP",
        ws_symbol="BTC-USDT-SWAP",
    )
    key = (subscription.provider, subscription.local_symbol)
    service._ticker_generations[key] = 2
    service._set_ticker_cache(
        subscription,
        {
            "bid_price": "100",
            "ask_price": "102",
            "last_price": "101",
            "source": "PROVIDER_WS",
        },
        generation=2,
    )
    service._set_ticker_cache(
        subscription,
        {
            "bid_price": "90",
            "ask_price": "92",
            "last_price": "91",
            "source": "PROVIDER_WS",
        },
        generation=1,
    )

    winner = service.get_fresh_provider_ws_ticker(SYMBOL, "OKX_SWAP")

    assert winner is not None
    assert winner["provider_generation"] == 2
    assert winner["revision_epoch"] == 2
    assert winner["revision_sequence"] == 1
    assert winner["last_price"] == "101"
