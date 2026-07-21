from __future__ import annotations

import asyncio

import pytest

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
from app.services import contract_market_gateway as gateway_module
from app.services.contract_market_provider_ws import (
    ContractProviderKlineRevisionAccepted,
    ContractMarketProviderWsService,
    ProviderTickerSubscription,
)


NOW_MS = 1_720_000_000_000
SYMBOL = "BTCUSDT_PERP"


@pytest.fixture(autouse=True)
def _ensure_current_event_loop() -> None:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())


def test_gateway_snapshots_request_provider_ws_warmup() -> None:
    calls: list[tuple[str, str, str | None, bool]] = []

    async def scenario() -> None:
        gateway = ContractMarketGateway()
        gateway._refresh_symbol_once = lambda symbol, intervals, ensure: calls.append(
            ("full", symbol, intervals[0], ensure)
        )
        gateway._refresh_market_once = lambda symbol, ensure: calls.append(
            ("market", symbol, None, ensure)
        )
        gateway._refresh_kline_once = lambda symbol, interval, ensure: calls.append(
            ("kline", symbol, interval, ensure)
        )

        await gateway.snapshot(SYMBOL, "1m")
        await gateway.market_snapshot(SYMBOL)
        await gateway.kline_snapshot(SYMBOL, "5m")

    asyncio.run(scenario())

    assert calls == [
        ("full", SYMBOL, "1m", True),
        ("market", SYMBOL, None, True),
        ("kline", SYMBOL, "5m", True),
    ]


def test_gateway_uses_itick_cadence_ttl_without_weakening_crypto_ttl(monkeypatch):
    monkeypatch.setattr(gateway_module.settings, "CONTRACT_PROVIDER_WS_TICKER_MAX_AGE_MS", 1500)
    monkeypatch.setattr(gateway_module.settings, "CONTRACT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500)
    gateway = ContractMarketGateway()

    assert gateway._domain_snapshot_ttl_ms(
        ContractMarketDomainName.TICKER,
        provider="ITICK",
    ) == 5_000
    assert gateway._domain_snapshot_ttl_ms(
        ContractMarketDomainName.DEPTH,
        provider="itick",
    ) == 5_000
    assert gateway._domain_snapshot_ttl_ms(
        ContractMarketDomainName.TICKER,
        provider="OKX_SWAP",
    ) == 1_500


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


def test_gateway_contract_preview_advances_close_and_volume_from_same_trade_evidence(
    monkeypatch,
):
    gateway = ContractMarketGateway()
    preview_symbol = "SOLUSDT_PERP"
    open_time = (NOW_MS // 60_000) * 60_000
    monkeypatch.setattr(
        gateway_module,
        "get_contract_provider_ws_kline_generation",
        lambda *_args, **_kwargs: 3,
    )
    gateway._accept_candle_preview_native(
        preview_symbol,
        "1m",
        {
            "symbol": preview_symbol,
            "interval": "1m",
            "provider": "OKX_SWAP",
            "provider_generation": 3,
            "revision_epoch": 3,
            "revision_sequence": 8,
            "open_time": open_time,
            "open": "100",
            "high": "102",
            "low": "99",
            "close": "101",
            "volume": "50",
            "quote_volume": "5050",
            "is_closed": False,
        },
    )
    settlement_messages = gateway._trade_preview_settlement_messages(
        preview_symbol,
        ["1m"],
        [
            {
                "id": "trade-1",
                "symbol": preview_symbol,
                "provider": "OKX_SWAP",
                "provider_symbol": "SOL-USDT-SWAP",
                "price": "103",
                "qty": "2",
                "time": open_time + 30_000,
                "received_at_ms": open_time + 30_010 - (8 * 60 * 60 * 1000),
                "source": "LIVE_WS",
                "quote_source": "LIVE_WS",
                "quote_freshness": "LIVE",
                "price_source": "TRADE_TICK",
            }
        ],
        {
            "provider": "OKX_SWAP",
            # Trades and Kline subscriptions own independent transport
            # generations. Preview identity must use the Kline generation.
            "provider_generation": 99,
            "received_at_ms": open_time + 30_010,
        },
    )

    assert len(settlement_messages) == 2
    trade_message, message = settlement_messages
    assert trade_message["type"] == "contract_trade"
    assert trade_message["candle_previews"] == [message]
    assert trade_message["settlement_revision"] == message["settlement_revision"]
    assert trade_message["trade"]["id"] == message["settlement_trade_id"]
    assert trade_message["trade"]["price"] == message["preview"]["close"]
    assert message["type"] == "contract_candle_preview_update"
    assert message["domain"] == "kline"
    assert message["source"] == "TRADE_PREVIEW"
    assert message["provider_generation"] == 3
    assert message["received_at_ms"] == open_time + 30_010
    assert message["preview"]["received_at_ms"] == open_time + 30_010
    assert message["base_native_revision"] == {"epoch": 3, "sequence": 8}
    assert message["preview"]["open"] == "100"
    assert message["preview"]["high"] == "103"
    assert message["preview"]["low"] == "99"
    assert message["preview"]["close"] == "103"
    assert message["preview"]["volume"] == "52"
    assert message["preview"]["quote_volume"] == "5256"
    assert message["preview"]["preview_sequence"] == 1
    assert message["preview"]["baseline_source"] == "NATIVE"
    assert message["preview"]["baseline_anchor_open_time"] is None
    assert message["settlement_trade_id"] == "trade-1"
    assert message["settlement_trade_price"] == "103"
    assert message["settlement_revision"].endswith(":3:8:1")


def test_gateway_itick_preview_bootstraps_rest_native_with_live_generation(monkeypatch):
    gateway = ContractMarketGateway()
    symbol = "NAS100USDT_PERP"
    open_time = (NOW_MS // 60_000) * 60_000
    monkeypatch.setattr(
        gateway_module,
        "get_contract_provider_ws_kline_generation",
        lambda *_args, **_kwargs: 7,
    )
    gateway._accept_candle_preview_native(
        symbol,
        "1m",
        {
            "provider": "ITICK",
            "open_time": open_time,
            "open": "28820",
            "high": "28824",
            "low": "28818",
            "close": "28822",
            "volume": "490",
            "quote_volume": None,
            "is_closed": False,
        },
    )

    messages = gateway._candle_preview_messages(
        symbol,
        ["1m"],
        [{
            "id": "nas-tick-1",
            "provider": "ITICK",
            "price": "28821.84",
            "qty": "2",
            "time": open_time + 30_000,
        }],
        {"provider": "ITICK", "received_at_ms": open_time + 30_010},
    )

    assert len(messages) == 1
    assert messages[0]["provider"] == "ITICK"
    assert messages[0]["provider_generation"] == 7
    assert messages[0]["preview"]["close"] == "28821.84"
    assert messages[0]["preview"]["volume"] == "492"
    assert messages[0]["base_native_revision"] == {"epoch": 7, "sequence": 0}


def test_gateway_five_minute_preview_only_processes_the_subscribed_interval(monkeypatch):
    gateway = ContractMarketGateway()
    symbol = "AAPLUSDT_PERP"
    open_time = (NOW_MS // 300_000) * 300_000
    generation_reads: list[str] = []

    def read_generation(_symbol, interval, **_kwargs):
        generation_reads.append(interval)
        return 9

    monkeypatch.setattr(
        gateway_module,
        "get_contract_provider_ws_kline_generation",
        read_generation,
    )
    gateway._accept_candle_preview_native(
        symbol,
        "5m",
        {
            "provider": "ITICK",
            "provider_generation": 9,
            "revision_epoch": 9,
            "revision_sequence": 12,
            "open_time": open_time,
            "open": "329.20",
            "high": "329.70",
            "low": "329.10",
            "close": "329.54",
            "volume": "1000",
            "quote_volume": None,
            "is_closed": False,
        },
    )

    messages = gateway._candle_preview_messages(
        symbol,
        ["5m", "15m", "5m"],
        [{
            "id": "aapl-five-tick-1",
            "provider": "ITICK",
            "price": "329.43",
            "qty": "2",
            "time": open_time + 120_000,
        }],
        {"provider": "ITICK", "received_at_ms": open_time + 120_010},
    )

    assert generation_reads == ["5m"]
    assert len(messages) == 1
    assert messages[0]["interval"] == "5m"
    assert messages[0]["preview"]["open_time"] == open_time
    assert messages[0]["preview"]["close"] == "329.43"


def test_gateway_quote_falls_back_to_live_provider_depth_before_rest(monkeypatch):
    gateway = ContractMarketGateway()
    depth = {
        "provider": "ITICK",
        "provider_symbol": "NAS100",
        "best_bid": "28820",
        "best_ask": "28822",
        "source": "LIVE_WS",
    }
    monkeypatch.setattr(gateway_module, "provider_ws_ticker_enabled", lambda: True)
    monkeypatch.setattr(gateway_module, "provider_ws_depth_enabled", lambda: True)
    monkeypatch.setattr(gateway_module, "select_fresh_provider_ws_ticker", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gateway_module, "select_fresh_provider_ws_depth", lambda *_args, **_kwargs: depth)
    monkeypatch.setattr(
        gateway,
        "_prepare_provider_ws_depth_quote_payload",
        lambda _db, _symbol, payload, **_kwargs: {
            "source": "LIVE_WS",
            "best_bid": payload["best_bid"],
        },
    )
    monkeypatch.setattr(
        gateway_module,
        "get_contract_quote",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("REST must not run")),
    )

    quote = gateway._load_quote_payload(
        object(),
        "NAS100USDT_PERP",
        allow_provider_ws=True,
        ensure_provider_ws=True,
    )

    assert quote == {"source": "LIVE_WS", "best_bid": "28820"}


def test_gateway_carries_native_ticker_status_into_depth_quote(monkeypatch):
    gateway = ContractMarketGateway()
    ticker = {
        "provider": "ITICK",
        "provider_trading_status": 0,
        "provider_market_status": "OPEN",
        "source": "LIVE_WS",
    }
    depth = {
        "provider": "ITICK",
        "provider_symbol": "FUTURE_INDEX",
        "best_bid": "100",
        "best_ask": "101",
        "source": "LIVE_WS",
    }
    captured = {}
    monkeypatch.setattr(gateway_module, "provider_ws_ticker_enabled", lambda: True)
    monkeypatch.setattr(gateway_module, "provider_ws_depth_enabled", lambda: True)
    monkeypatch.setattr(gateway_module, "select_fresh_provider_ws_ticker", lambda *_args, **_kwargs: ticker)
    monkeypatch.setattr(gateway_module, "select_fresh_provider_ws_depth", lambda *_args, **_kwargs: depth)
    monkeypatch.setattr(gateway, "_prepare_provider_ws_quote_payload", lambda *_args, **_kwargs: None)

    def prepare_depth_quote(_db, _symbol, payload, *, status_payload=None):
        captured["depth"] = payload
        captured["status"] = status_payload
        return {"source": "LIVE_WS", "best_bid": payload["best_bid"]}

    monkeypatch.setattr(gateway, "_prepare_provider_ws_depth_quote_payload", prepare_depth_quote)

    quote = gateway._load_quote_payload(
        object(),
        "FUTUREINDEXUSDT_PERP",
        allow_provider_ws=True,
        allow_rest_fallback=False,
        ensure_provider_ws=True,
    )

    assert quote == {"source": "LIVE_WS", "best_bid": "100"}
    assert captured["depth"] is depth
    assert captured["status"] is ticker


def test_gateway_reuses_bounded_rest_ticker_evidence_for_partial_ws_frames(monkeypatch):
    gateway = ContractMarketGateway()
    symbol = "EURUSD_PERP"
    calls: list[tuple[list[str], int]] = []

    def load_tickers(_db, requested_symbol):
        calls.append(([requested_symbol], 1))
        return [{
            "symbol": symbol,
            "price_change_24h": "0.00075",
            "price_change_percent_24h": "0.065704",
            "high_24h": "1.14278",
            "low_24h": "1.14088",
            "base_volume_24h": "259978.6",
            "quote_volume_24h": "296805.11612",
        }]

    monkeypatch.setattr(gateway_module, "_load_contract_ticker_24h_evidence", load_tickers)
    provider_frame = {
        "symbol": symbol,
        "provider": "ITICK",
        "last_price": "1.14219",
    }
    first = gateway._enrich_provider_ws_ticker_24h(
        object(),
        symbol,
        {
            **provider_frame,
            "bid_price": "1.14210",
            "ask_price": "1.14225",
            "source": "LIVE_WS",
        },
        provider_frame=provider_frame,
    )
    gateway._latest[CONTRACT_MARKET_CACHE_QUOTE.format(symbol=symbol)] = first
    second = gateway._enrich_provider_ws_ticker_24h(
        object(),
        symbol,
        {
            **provider_frame,
            "last_price": "1.14227",
            "bid_price": "1.14220",
            "ask_price": "1.14235",
            "source": "LIVE_WS",
        },
        provider_frame=provider_frame,
    )

    assert calls == [([symbol], 1)]
    assert first["bid_price"] == "1.14210"
    assert second["bid_price"] == "1.14220"
    assert second["price_change_24h"] == "0.00075"
    assert second["high_24h"] == "1.14278"
    assert second["quote_volume_24h"] == "296805.11612"


def test_gateway_marks_generic_contiguous_rollover_as_trade_seeded(monkeypatch):
    gateway = ContractMarketGateway()
    symbol = "SOLUSDT_PERP"
    open_time = (NOW_MS // 60_000) * 60_000
    monkeypatch.setattr(
        gateway_module,
        "get_contract_provider_ws_kline_generation",
        lambda *_args, **_kwargs: 3,
    )
    gateway._accept_candle_preview_native(
        symbol,
        "1m",
        {
            "provider": "OKX_SWAP",
            "provider_generation": 3,
            "revision_epoch": 3,
            "revision_sequence": 8,
            "open_time": open_time,
            "open": "100",
            "high": "102",
            "low": "99",
            "close": "101",
            "volume": "50",
            "quote_volume": "5050",
            "is_closed": False,
        },
    )

    messages = gateway._candle_preview_messages(
        symbol,
        ["1m"],
        [{
            "id": "sol-next-minute",
            "provider": "OKX_SWAP",
            "price": "103",
            "qty": "2",
            "time": open_time + 60_001,
        }],
        {"provider": "OKX_SWAP", "received_at_ms": open_time + 60_010},
    )

    assert len(messages) == 1
    message = messages[0]
    assert message["preview"]["kline_mode"] == "TRADE_SEEDED_ROLLOVER_PREVIEW"
    assert message["preview"]["baseline_source"] == "TRADE_ROLLOVER"
    assert message["preview"]["baseline_anchor_open_time"] == open_time
    assert message["preview"]["open_time"] == open_time + 60_000
    assert message["preview"]["close"] == "103"
    assert message["preview"]["volume"] == "2"


def test_gateway_contract_preview_fails_closed_without_native_ohlcv_or_generation(
    monkeypatch,
):
    gateway = ContractMarketGateway()
    open_time = (NOW_MS // 60_000) * 60_000
    monkeypatch.setattr(
        gateway_module,
        "get_contract_provider_ws_kline_generation",
        lambda *_args, **_kwargs: 3,
    )
    gateway._accept_candle_preview_native(
        SYMBOL,
        "1m",
        {
            "provider": "OKX_SWAP",
            "provider_generation": 3,
            "revision_epoch": 3,
            "revision_sequence": 1,
            "open_time": open_time,
            "open": "100",
            "high": "100",
            "low": "100",
            "close": "100",
            "volume": None,
            "is_closed": False,
        },
    )

    assert gateway._candle_preview_messages(
        SYMBOL,
        ["1m"],
        [{"id": "trade-1", "provider": "OKX_SWAP", "price": "101", "qty": "1", "time": open_time + 1_000}],
        {"provider": "OKX_SWAP", "provider_generation": 3},
    ) == []
    gateway._accept_candle_preview_native(
        SYMBOL,
        "1m",
        {
            "provider": "OKX_SWAP",
            "provider_generation": 3,
            "revision_epoch": 3,
            "revision_sequence": 2,
            "open_time": open_time,
            "open": "100",
            "high": "100",
            "low": "100",
            "close": "100",
            "volume": "5",
            "is_closed": False,
        },
    )
    monkeypatch.setattr(
        gateway_module,
        "get_contract_provider_ws_kline_generation",
        lambda *_args, **_kwargs: 0,
    )
    assert gateway._candle_preview_messages(
        SYMBOL,
        ["1m"],
        [{"id": "trade-2", "provider": "OKX_SWAP", "price": "101", "qty": "1", "time": open_time + 2_000}],
        {"provider": "OKX_SWAP", "provider_generation": None},
    ) == []


def test_gateway_trade_dedupe_survives_rolling_provider_windows():
    gateway = ContractMarketGateway()
    trade_a = {"id": "trade-a", "price": "100", "qty": "1"}
    trade_b = {"id": "trade-b", "price": "101", "qty": "2"}

    assert gateway._filter_new_trades(SYMBOL, [trade_a]) == [trade_a]
    gateway._remember_trade_ids(SYMBOL, [trade_a])

    assert gateway._filter_new_trades(SYMBOL, [trade_b]) == [trade_b]
    gateway._remember_trade_ids(SYMBOL, [trade_b])

    # A trade that leaves the provider's rolling cache and later reappears must
    # not be broadcast again ahead of a newer Header/reference price.
    assert gateway._filter_new_trades(SYMBOL, [trade_a]) == []
    assert gateway._filter_new_trades(SYMBOL, [trade_b, trade_b]) == []


def test_gateway_trade_dedupe_rejects_duplicates_inside_one_batch():
    gateway = ContractMarketGateway()
    trade = {"id": "trade-a", "price": "100", "qty": "1"}

    assert gateway._filter_new_trades(SYMBOL, [trade, trade]) == [trade]


def test_gateway_trade_settlement_orders_header_evidence_by_event_time():
    gateway = ContractMarketGateway()

    message = gateway._trades_message(
        SYMBOL,
        [
            {"id": "older", "price": "100", "qty": "1", "time": NOW_MS - 10},
            {"id": "latest", "price": "101", "qty": "1", "time": NOW_MS},
        ],
    )

    assert message["trade"]["id"] == "latest"
    assert message["trades"][0]["price"] == "101"


def test_gateway_trade_settlement_prefers_the_preview_trade_over_timestamp_ties():
    gateway = ContractMarketGateway()

    message = gateway._trades_message(
        SYMBOL,
        [
            {"id": "first", "price": "100", "qty": "1", "time": NOW_MS},
            {"id": "settled", "price": "101", "qty": "1", "time": NOW_MS},
            {"id": "third", "price": "99", "qty": "1", "time": NOW_MS},
        ],
        preferred_trade_id="settled",
    )

    assert message["trade"]["id"] == "settled"
    assert message["trades"][0]["price"] == "101"


def test_gateway_coalesces_only_current_provider_kline_generation(monkeypatch):
    gateway = ContractMarketGateway()
    gateway._provider_ws_allowed_symbols.add(SYMBOL)
    gateway._kline_wakeup_events[SYMBOL] = __import__("asyncio").Event()
    monkeypatch.setattr(
        gateway_module,
        "get_contract_provider_ws_kline_generation",
        lambda *_args, **_kwargs: 3,
    )
    accepted = ContractProviderKlineRevisionAccepted(
        provider="OKX_SWAP",
        symbol=SYMBOL,
        interval="1m",
        generation=3,
        open_time=(NOW_MS // 60_000) * 60_000,
        revision_epoch=3,
        revision_sequence=8,
    )
    stale = ContractProviderKlineRevisionAccepted(
        provider="OKX_SWAP",
        symbol=SYMBOL,
        interval="1m",
        generation=2,
        open_time=accepted.open_time,
        revision_epoch=2,
        revision_sequence=99,
    )

    gateway._enqueue_provider_kline_revision(stale)
    assert gateway._pending_provider_kline_events == {}
    gateway._enqueue_provider_kline_revision(accepted)

    assert gateway._pending_provider_kline_events[(SYMBOL, "1m")] == accepted
    assert gateway._kline_wakeup_events[SYMBOL].is_set()


def test_gateway_broadcast_cycle_primes_native_revision_before_trade_preview(monkeypatch):
    import asyncio

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    gateway = ContractMarketGateway()
    emitted: list[str] = []
    monkeypatch.setattr(
        gateway,
        "_refresh_provider_ws_market_once",
        lambda *_args, **_kwargs: [
            {"type": "contract_trade"},
            {"type": "contract_candle_preview_update"},
        ],
    )
    monkeypatch.setattr(
        gateway,
        "_refresh_provider_ws_klines_once",
        lambda *_args, **_kwargs: [{"type": "contract_kline_update"}],
    )

    async def capture(_symbol, message):
        emitted.append(message["type"])

    monkeypatch.setattr(
        gateway_module.contract_market_ws_manager,
        "broadcast_to_symbol",
        capture,
    )

    try:
        loop.run_until_complete(gateway._refresh_and_broadcast_cycle(
            SYMBOL,
            ["1m"],
            market_subscriber_count=1,
            should_refresh_all=False,
        ))
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())

    assert emitted == [
        "contract_kline_update",
        "contract_trade",
        "contract_candle_preview_update",
    ]


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


def test_gateway_symbol_configuration_invalidation_drops_all_local_state():
    gateway = ContractMarketGateway()
    gateway._latest[f"contract:market:{SYMBOL}:quote"] = {"last_price": "101"}
    gateway._latest[f"contract:market:{SYMBOL}:kline:1m"] = [{"close": "101"}]
    gateway._latest["contract:market:ETHUSDT_PERP:quote"] = {"last_price": "200"}
    gateway._last_quote_signature[SYMBOL] = "old"
    gateway._last_kline_signature[(SYMBOL, "1m")] = "old"

    gateway.invalidate_symbol_configuration(SYMBOL)

    assert all(not key.startswith(f"contract:market:{SYMBOL}:") for key in gateway._latest)
    assert gateway._latest["contract:market:ETHUSDT_PERP:quote"] == {"last_price": "200"}
    assert SYMBOL not in gateway._last_quote_signature
    assert (SYMBOL, "1m") not in gateway._last_kline_signature


def test_gateway_kline_message_preserves_provider_ws_authority_evidence():
    gateway = ContractMarketGateway()
    now_ms = gateway_module._utc_ms()
    kline = {
        "open_time": now_ms - 60_000,
        "open": "100",
        "high": "103",
        "low": "99",
        "close": "102",
        "volume": "8",
        "source": "LIVE_WS",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": now_ms,
        "provider_generation": 7,
        "revision_epoch": 7,
        "revision_sequence": 12,
        "is_closed": False,
    }

    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_KLINE,
        SYMBOL,
        kline,
        interval="1m",
        authority_payload=kline,
    )

    message = gateway._kline_message(SYMBOL, "1m")

    assert message is not None
    assert message["source"] == "LIVE_WS"
    assert message["provider"] == "OKX_SWAP"
    assert message["transport"] == "PROVIDER_WS"
    assert message["freshness"] == "LIVE"
    assert message["provider_generation"] == 7
    assert message["revision_epoch"] == 7
    assert message["revision_sequence"] == 12
    assert message["revision"]["epoch"] == 7
    assert message["revision"]["sequence"] == 12
    assert message["revision"]["is_closed"] is False
    assert message["data"]["close"] == "102"
    assert message["data"]["volume"] == "8"
    assert message["data"]["provider_generation"] == 7
    assert message["data"]["revision_sequence"] == 12


def test_gateway_kline_message_fails_closed_without_volume():
    gateway = ContractMarketGateway()
    now_ms = gateway_module._utc_ms()
    kline = {
        "open_time": now_ms - 60_000,
        "open": "100",
        "high": "103",
        "low": "99",
        "close": "102",
        "volume": None,
        "source": "LIVE_WS",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": now_ms,
        "provider_generation": 7,
        "revision_epoch": 7,
        "revision_sequence": 12,
    }

    assert not gateway._set_latest(
        CONTRACT_MARKET_CACHE_KLINE,
        SYMBOL,
        kline,
        interval="1m",
        authority_payload=kline,
    )

    assert gateway.get_domain_snapshot(
        ContractMarketDomainName.KLINE,
        SYMBOL,
        interval="1m",
    ) is None
    assert gateway._kline_message(SYMBOL, "1m") is None


def test_gateway_kline_message_fails_closed_for_unstamped_process_cache():
    gateway = ContractMarketGateway()
    kline = {
        "open_time": NOW_MS - 60_000,
        "open": "100",
        "high": "103",
        "low": "99",
        "close": "102",
        "volume": "8",
        "source": "PROCESS_CACHE",
    }

    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_KLINE,
        SYMBOL,
        kline,
        interval="1m",
        authority_payload=kline,
    )

    snapshot = gateway.get_domain_snapshot(
        ContractMarketDomainName.KLINE,
        SYMBOL,
        interval="1m",
    )
    assert snapshot is not None
    assert snapshot.metadata.transport == ContractMarketDomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == ContractMarketDomainCacheOrigin.PROCESS_MEMORY
    assert snapshot.metadata.stale is True
    assert gateway._kline_message(SYMBOL, "1m") is None


def test_gateway_kline_message_expires_authority_at_read_time(monkeypatch):
    now_ms = 1_800_000_000_000
    clock = {"now_ms": now_ms}
    monkeypatch.setattr(gateway_module, "_utc_ms", lambda: clock["now_ms"])
    gateway = ContractMarketGateway()
    kline = {
        "open_time": now_ms - 60_000,
        "open": "100",
        "high": "103",
        "low": "99",
        "close": "102",
        "volume": "8",
        "source": "LIVE_WS",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": now_ms,
        "provider_generation": 7,
        "revision_epoch": 7,
        "revision_sequence": 12,
    }

    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_KLINE,
        SYMBOL,
        kline,
        interval="1m",
        authority_payload=kline,
    )
    assert gateway._kline_message(SYMBOL, "1m") is not None

    clock["now_ms"] += 1_501

    assert gateway._kline_message(SYMBOL, "1m") is None


def test_gateway_caps_kline_broadcast_interval_at_spot_parity(monkeypatch):
    monkeypatch.setattr(
        gateway_module.settings,
        "CONTRACT_PROVIDER_WS_ITICK_KLINE_BROADCAST_INTERVAL_MS",
        1000,
    )

    assert ContractMarketGateway()._provider_ws_kline_broadcast_interval_seconds() == 0.2


def test_gateway_throttles_rest_kline_fallback_and_marks_its_authority(monkeypatch):
    gateway = ContractMarketGateway()
    calls: list[tuple[bool, bool]] = []
    now_ms = gateway_module._utc_ms()

    class SessionStub:
        def close(self) -> None:
            return None

    def load_kline_payload(
        _db,
        symbol,
        *,
        interval,
        allow_provider_ws,
        allow_rest_fallback=True,
        ensure_provider_ws=False,
    ):
        assert symbol == SYMBOL
        assert interval == "1m"
        assert ensure_provider_ws is False
        calls.append((allow_provider_ws, allow_rest_fallback))
        if allow_provider_ws:
            return None
        return {
            "open_time": now_ms - 60_000,
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100.5",
            "volume": "4",
            "source": "PROVIDER_REST",
            "freshness": "RECENT",
            "fallback_reason": "WS_MISS",
            "received_at_ms": now_ms,
        }

    monkeypatch.setattr(gateway_module, "SessionLocal", SessionStub)
    monkeypatch.setattr(gateway, "_load_kline_payload", load_kline_payload)

    first = gateway._refresh_kline_once(SYMBOL, "1m")
    second = gateway._refresh_kline_once(SYMBOL, "1m")

    assert first is not None
    assert second is None
    assert calls == [(True, False), (False, True), (True, False)]
    message = gateway._kline_message(SYMBOL, "1m")
    assert message is not None
    assert message["source"] == "REST_SNAPSHOT"
    assert message["transport"] == "PROVIDER_REST"
    assert message["fallback_reason"] == "WS_MISS"
    assert message["freshness"] == "RECENT"
    assert message["data"]["volume"] == "4"


def test_gateway_suppresses_identical_ws_kline_but_emits_new_revision(monkeypatch):
    gateway = ContractMarketGateway()
    now_ms = gateway_module._utc_ms()
    revision_sequences = iter((1, 1, 2))

    class SessionStub:
        def close(self) -> None:
            return None

    def load_kline_payload(
        _db,
        symbol,
        *,
        interval,
        allow_provider_ws,
        allow_rest_fallback=True,
        ensure_provider_ws=False,
    ):
        assert symbol == SYMBOL
        assert interval == "1m"
        assert allow_provider_ws is True
        assert allow_rest_fallback is False
        return {
            "open_time": now_ms - 60_000,
            "open": "100",
            "high": "102",
            "low": "99",
            "close": "101",
            "volume": "6",
            "source": "LIVE_WS",
            "provider": "OKX_SWAP",
            "provider_symbol": "BTC-USDT-SWAP",
            "received_at_ms": now_ms,
            "provider_generation": 3,
            "revision_epoch": 3,
            "revision_sequence": next(revision_sequences),
        }

    monkeypatch.setattr(gateway_module, "SessionLocal", SessionStub)
    monkeypatch.setattr(gateway, "_load_kline_payload", load_kline_payload)

    first = gateway._refresh_kline_once(SYMBOL, "1m")
    duplicate = gateway._refresh_kline_once(SYMBOL, "1m")
    revised = gateway._refresh_kline_once(SYMBOL, "1m")

    assert first is not None
    assert duplicate is None
    assert revised is not None
    message = gateway._kline_message(SYMBOL, "1m")
    assert message is not None
    assert message["revision_sequence"] == 2
