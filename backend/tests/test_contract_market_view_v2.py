from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.schemas.contract_market import ContractMarketViewDetail
from app.schemas.contract_market_domain_snapshot import (
    ContractMarketDomainCacheOrigin,
    ContractMarketDomainRevision,
    ContractMarketDomainSource,
    ContractMarketDomainTransport,
)
from app.services import contract_market_service as market_service
from app.services import contract_market_view as market_view
from app.services.contract_market_domain_snapshot import (
    ContractMarketDomainSnapshotContext,
    map_contract_depth_domain_snapshot,
    map_contract_kline_domain_snapshot,
    map_contract_ticker_domain_snapshot,
    map_contract_trades_domain_snapshot,
)


NOW = datetime(2026, 7, 14, 12, 0, tzinfo=timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)
SYMBOL = "BTCUSDT_PERP"


def _contract():
    return SimpleNamespace(
        symbol=SYMBOL,
        display_name="BTC/USDT Perpetual",
        category="CRYPTO",
        provider="BINANCE",
        closed_market_execution_mode="DISABLED",
    )


def _context(*, interval: str | None = None, sequence: int = 1):
    return ContractMarketDomainSnapshotContext(
        symbol=SYMBOL,
        interval=interval,
        transport=ContractMarketDomainTransport.PROVIDER_WS,
        cache_origin=ContractMarketDomainCacheOrigin.PROVIDER_MEMORY,
        source=ContractMarketDomainSource.LIVE_WS,
        provider="BINANCE",
        provider_symbol="BTCUSDT",
        provider_event_time_ms=NOW_MS - 100,
        received_at_ms=NOW_MS - 50,
        ttl_ms=1_500,
        provider_generation=4,
        revision=ContractMarketDomainRevision(
            epoch=4,
            sequence=sequence,
        ),
        emitted_at_ms=NOW_MS,
    )


def _snapshots():
    ticker = map_contract_ticker_domain_snapshot(
        context=_context(),
        ticker={
            "symbol": SYMBOL,
            "category": "CRYPTO",
            "market_status": "OPEN",
            "quote_freshness": "LIVE",
            "quote_source": "LIVE_WS",
            "source": "LIVE_WS",
            "bid_price": "100",
            "ask_price": "102",
            "last_price": "999",
            "mark_price": "110",
            "index_price": "109",
            "executable": True,
            "ts": NOW.isoformat(),
        },
    )
    depth = map_contract_depth_domain_snapshot(
        context=_context(sequence=2),
        depth={
            "symbol": SYMBOL,
            "category": "CRYPTO",
            "market_status": "OPEN",
            "quote_freshness": "LIVE",
            "quote_source": "LIVE_WS",
            "source": "LIVE_WS",
            "best_bid": "100",
            "best_ask": "102",
            "bids": [["100", "2"]],
            "asks": [["102", "3"]],
            "executable": True,
            "ts": NOW.isoformat(),
        },
    )
    trades = map_contract_trades_domain_snapshot(
        context=_context(sequence=3),
        trades=[
            {
                "id": "trade-1",
                "price": "101",
                "qty": "0.5",
                "price_source": "TRADE_TICK",
                "source": "LIVE_WS",
                "quote_freshness": "LIVE",
                "time": NOW_MS - 25,
            }
        ],
    )
    kline = map_contract_kline_domain_snapshot(
        context=_context(interval="1m", sequence=4),
        kline={
            "symbol": SYMBOL,
            "interval": "1m",
            "open_time": NOW_MS - 60_000,
            "open": "95",
            "high": "105",
            "low": "94",
            "close": "97",
            "volume": "10",
            "source": "LIVE_WS",
        },
    )
    return ticker, depth, trades, kline


def test_market_view_v2_uses_four_snapshots_and_separates_price_roles():
    ticker, depth, trades, kline = _snapshots()

    view = market_view.build_contract_market_view_v2(
        SYMBOL,
        ticker_snapshot=ticker,
        depth_snapshot=depth,
        trades_snapshot=trades,
        kline_snapshot=kline,
        contract_symbol=_contract(),
        now=NOW,
    )

    assert view["view_version"] == "2"
    assert view["authority_source"] == "SNAPSHOT_AUTHORITY"
    assert view["snapshot_authority"] is True
    assert view["display_price"] == "101"
    assert view["execution_bid"] == "100"
    assert view["execution_ask"] == "102"
    assert view["mark_price"] == "110"
    assert view["index_price"] == "109"
    assert view["display_price"] not in {view["mark_price"], view["index_price"]}
    assert view["ticker"]["last_price"] == "999"
    assert view["depth"]["bids"] == [["100", "2"]]
    assert view["trades"][0]["id"] == "trade-1"
    assert view["kline"]["close"] == "97"
    assert set(view["snapshot_metadata"]) == {"ticker", "depth", "trades", "kline"}
    assert view["snapshot_metadata"]["ticker"]["provider_generation"] == 4
    ContractMarketViewDetail(**view)


def test_market_view_v2_reports_missing_domains_and_reason_code():
    ticker, _, _, _ = _snapshots()
    ticker.data["bid_price"] = None
    ticker.data["ask_price"] = None

    view = market_view.build_contract_market_view_v2(
        SYMBOL,
        ticker_snapshot=ticker,
        depth_snapshot=None,
        trades_snapshot=None,
        kline_snapshot=None,
        contract_symbol=_contract(),
        now=NOW,
    )

    assert view["reason_code"] == "CRYPTO_BBO_NOT_LIVE"
    assert "depth_snapshot_missing" in view["warnings"]
    assert "trades_snapshot_missing" in view["warnings"]
    assert "kline_snapshot_missing" in view["warnings"]
    assert "missing_bbo" in view["warnings"]


def test_market_view_v2_empty_trades_do_not_create_last_trade_price():
    ticker, depth, _, kline = _snapshots()
    empty_trades = map_contract_trades_domain_snapshot(
        context=_context(sequence=3),
        trades=[],
    )

    view = market_view.build_contract_market_view_v2(
        SYMBOL,
        ticker_snapshot=ticker,
        depth_snapshot=depth,
        trades_snapshot=empty_trades,
        kline_snapshot=kline,
        contract_symbol=_contract(),
        now=NOW,
    )

    assert view["trades"] == []
    assert view["last_trade_price"] is None


def test_market_view_v2_dynamically_expires_execution_prices():
    ticker, depth, trades, kline = _snapshots()

    view = market_view.build_contract_market_view_v2(
        SYMBOL,
        ticker_snapshot=ticker,
        depth_snapshot=depth,
        trades_snapshot=trades,
        kline_snapshot=kline,
        contract_symbol=_contract(),
        now=NOW + timedelta(seconds=2),
    )

    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert "ticker_snapshot_stale" in view["warnings"]
    assert "depth_snapshot_stale" in view["warnings"]


def test_market_view_v2_preserves_tradfi_closed_session_policy():
    ticker, depth, trades, kline = _snapshots()
    for snapshot in (ticker, depth):
        snapshot.data.update(
            {
                "category": "STOCK",
                "provider": "ITICK",
                "market_status": "CLOSED",
                "market_session_type": "CLOSED",
                "quote_source": "LAST_GOOD_BBO",
                "source": "LAST_GOOD_BBO",
                "quote_freshness": "LAST_VALID",
                "closed_market_execution_mode": "LAST_GOOD_BBO",
                "executable": True,
                "last_good_at": NOW.isoformat(),
            }
        )
    contract = SimpleNamespace(
        symbol=SYMBOL,
        display_name="Apple CFD",
        category="STOCK",
        provider="ITICK",
        closed_market_execution_mode="LAST_GOOD_BBO",
    )

    view = market_view.build_contract_market_view_v2(
        SYMBOL,
        ticker_snapshot=ticker,
        depth_snapshot=depth,
        trades_snapshot=trades,
        kline_snapshot=kline,
        contract_symbol=contract,
        now=NOW,
    )

    assert view["display_state"] == "CLOSED"
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "MARKET_CLOSED"
    assert "last_good_bbo_diagnostic_only" in view["warnings"]


def test_public_market_view_reads_authority_bundle(monkeypatch):
    ticker, depth, trades, kline = _snapshots()
    monkeypatch.setattr(
        market_view,
        "get_contract_market_snapshot_authority",
        lambda *_args, **_kwargs: {
            "ticker": ticker,
            "depth": depth,
            "trades": trades,
            "kline": kline,
            "warnings": [],
        },
    )

    class Query:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return _contract()

    class Db:
        def query(self, *_args, **_kwargs):
            return Query()

    view = market_view.get_contract_market_view(Db(), SYMBOL)

    assert view["snapshot_authority"] is True
    assert view["authority_source"] == "SNAPSHOT_AUTHORITY"
    assert view["depth"]["best_bid"] == "100"


def test_execution_view_keeps_legacy_input_adapter_with_quote_only_bbo(monkeypatch):
    monkeypatch.setattr(
        market_view,
        "get_contract_market_snapshot_authority",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("execution view must not use C-3 authority")
        ),
    )
    monkeypatch.setattr(
        market_view,
        "get_contract_market_view_legacy_inputs",
        lambda *_args, **_kwargs: {
            "symbol": SYMBOL,
            "contract_symbol": _contract(),
            "quote": _snapshots()[0].data,
            "depth": None,
            "latest_trade": None,
            "latest_kline": None,
            "warnings": [],
        },
    )

    execution = market_view.get_contract_execution_view(object(), SYMBOL)

    assert execution["executable"] is True
    assert execution["execution_bid"] == "100"
    assert execution["execution_ask"] == "102"


def test_execution_legacy_inputs_do_not_fan_out_after_complete_quote_bbo(monkeypatch):
    quote = {
        "symbol": SYMBOL,
        "bid_price": "100",
        "ask_price": "102",
        "last_price": "101",
        "market_status": "OPEN",
        "market_session_type": "REGULAR",
        "freshness": "LIVE",
    }
    monkeypatch.setattr(market_service, "get_contract_quote", lambda *_args, **_kwargs: quote)
    monkeypatch.setattr(
        market_service,
        "get_contract_depth",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("complete quote BBO must skip depth")),
    )
    monkeypatch.setattr(
        market_service,
        "get_contract_recent_trades",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("execution must skip recent trades")),
    )
    monkeypatch.setattr(
        market_service,
        "get_contract_klines",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("execution must skip klines")),
    )

    class Query:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return _contract()

    class Db:
        def query(self, *_args, **_kwargs):
            return Query()

    inputs = market_service.get_contract_market_view_legacy_inputs(Db(), SYMBOL)

    assert inputs["quote"] == quote
    assert inputs["depth"] is None
    assert inputs["latest_trade"] is None
    assert inputs["latest_kline"] is None
