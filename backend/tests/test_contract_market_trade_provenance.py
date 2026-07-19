from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routers import contract_market as market_router
from app.services import contract_market_gateway as gateway_module
from app.services import contract_market_service as market_service
from app.services.contract_market_gateway import (
    CONTRACT_MARKET_CACHE_TRADES,
    ContractMarketGateway,
)


SYMBOL = "BTCUSDT_PERP"


@pytest.fixture(autouse=True)
def gateway_event_loop():
    """Keep direct gateway construction deterministic on Python 3.9."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        yield
    finally:
        asyncio.set_event_loop(None)
        loop.close()


def test_provider_rest_trade_normalization_carries_complete_evidence(monkeypatch):
    monkeypatch.setattr(market_service.time, "time", lambda: 1_720_000_000.125)
    trades = market_service._normalize_provider_trade_rows(
        "OKX_SWAP",
        {
            "data": [
                {
                    "tradeId": "trade-1",
                    "px": "60000.5",
                    "sz": "0.01",
                    "ts": "1720000000000",
                    "side": "buy",
                }
            ]
        },
        30,
        symbol=SYMBOL,
        provider_symbol="BTC-USDT-SWAP",
    )

    assert len(trades) == 1
    trade = trades[0]
    assert trade["symbol"] == SYMBOL
    assert trade["price_source"] == "TRADE_TICK"
    assert trade["freshness"] == "RECENT"
    assert trade["quote_freshness"] == "RECENT"
    assert trade["source"] == "PROVIDER_REST"
    assert trade["quote_source"] == "PROVIDER_REST"
    assert trade["provider"] == "OKX_SWAP"
    assert trade["provider_symbol"] == "BTC-USDT-SWAP"
    assert trade["event_time_ms"] == 1720000000000
    assert trade["received_at_ms"] == 1720000000125
    assert trade["synthetic"] is False


def test_itick_rest_tick_is_a_recent_real_trade_source(monkeypatch):
    monkeypatch.setattr(market_service.time, "time", lambda: 1_720_000_001.250)
    trade = market_service._normalize_itick_stock_tick_trade(
        symbol="AAPLUSDT_PERP",
        provider_symbol="AAPL",
        row={
            "ld": "213.55",
            "v": "100",
            "t": 1_720_000_000_000,
            "d": "2",
            "s": "AAPL",
            "r": "US",
        },
    )

    assert trade is not None
    assert trade["source"] == "ITICK_TICK"
    assert trade["price_source"] == "TRADE_TICK"
    assert trade["freshness"] == "RECENT"
    assert trade["quote_freshness"] == "RECENT"
    assert trade["received_at_ms"] == 1720000001250
    assert trade["synthetic"] is False

    monkeypatch.setattr(gateway_module, "provider_ws_trades_enabled", lambda: False)
    monkeypatch.setattr(
        gateway_module,
        "get_contract_recent_trades",
        lambda *_args, **_kwargs: [trade],
    )
    gateway = ContractMarketGateway()
    trades, _authority = gateway._load_trades_payload(
        object(),
        "AAPLUSDT_PERP",
        allow_provider_ws=False,
    )
    assert trades == [trade]


def test_gateway_preserves_trade_provenance_without_quote_source_inheritance(monkeypatch):
    payload = {
        "source": "LIVE_WS",
        "quote_source": "LIVE_WS",
        "freshness": "LIVE",
        "quote_freshness": "LIVE",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": 1720000000100,
        "trades": [
            {
                "id": "trade-1",
                "symbol": SYMBOL,
                "price": "60000.5",
                "qty": "0.01",
                "time": 1720000000000,
                "source": "LIVE_WS",
                "price_source": "TRADE_TICK",
            }
        ],
    }
    monkeypatch.setattr(gateway_module, "provider_ws_trades_enabled", lambda: True)
    monkeypatch.setattr(
        gateway_module,
        "select_fresh_provider_ws_trades",
        lambda *_args, **_kwargs: payload,
    )

    gateway = ContractMarketGateway()
    trades, authority = gateway._load_trades_payload(
        object(),
        SYMBOL,
        allow_provider_ws=True,
        allow_rest_fallback=False,
    )

    assert authority is payload
    assert len(trades) == 1
    trade = trades[0]
    assert trade["source"] == "LIVE_WS"
    assert trade["quote_source"] == "LIVE_WS"
    assert trade["quote_freshness"] == "LIVE"
    assert trade["price_source"] == "TRADE_TICK"
    assert trade["provider"] == "OKX_SWAP"

    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_TRADES,
        SYMBOL,
        trades,
        authority_payload=authority,
    )
    cached = gateway._get_latest(CONTRACT_MARKET_CACHE_TRADES, SYMBOL)
    assert cached[0]["provider"] == "OKX_SWAP"
    assert cached[0]["price_source"] == "TRADE_TICK"

    message = gateway._trades_message(SYMBOL, trades)
    assert message["provider"] == "OKX_SWAP"
    assert message["source"] == "LIVE_WS"
    assert message["quote_freshness"] == "LIVE"
    assert message["price_source"] == "TRADE_TICK"


def _valid_ws_trade_payload() -> dict:
    return {
        "source": "LIVE_WS",
        "quote_source": "LIVE_WS",
        "freshness": "LIVE",
        "quote_freshness": "LIVE",
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "received_at_ms": 1_720_000_000_100,
        "trades": [
            {
                "id": "trade-1",
                "symbol": SYMBOL,
                "price": "60000.5",
                "qty": "0.01",
                "time": 1_720_000_000_000,
                "source": "LIVE_WS",
                "quote_source": "LIVE_WS",
                "freshness": "LIVE",
                "quote_freshness": "LIVE",
                "price_source": "TRADE_TICK",
                "provider": "OKX_SWAP",
                "provider_symbol": "BTC-USDT-SWAP",
                "synthetic": False,
            }
        ],
    }


@pytest.mark.parametrize(
    "case",
    [
        "synthetic_quote",
        "ticker_source",
        "quote_source",
        "bbo_source",
        "mark_source",
        "wrong_symbol",
        "missing_qty",
        "invalid_event_time",
    ],
)
def test_gateway_rejects_non_truthful_trade_evidence(monkeypatch, case):
    payload = _valid_ws_trade_payload()
    trade = payload["trades"][0]
    if case == "synthetic_quote":
        trade.update(
            source="SYNTHETIC_FROM_QUOTE",
            quote_source="SYNTHETIC_FROM_QUOTE",
            price_source="SYNTHETIC_FROM_QUOTE",
            synthetic=True,
        )
    elif case == "ticker_source":
        trade.update(source="TICKER", quote_source="TICKER")
    elif case == "quote_source":
        trade.update(source="QUOTE", quote_source="QUOTE")
    elif case == "bbo_source":
        trade.update(source="BBO", quote_source="BBO")
    elif case == "mark_source":
        trade.update(source="MARK_PRICE", quote_source="MARK_PRICE")
    elif case == "wrong_symbol":
        trade["symbol"] = "ETHUSDT_PERP"
    elif case == "missing_qty":
        trade.pop("qty")
    elif case == "invalid_event_time":
        trade["time"] = "not-a-time"

    monkeypatch.setattr(gateway_module, "provider_ws_trades_enabled", lambda: True)
    monkeypatch.setattr(
        gateway_module,
        "select_fresh_provider_ws_trades",
        lambda *_args, **_kwargs: payload,
    )
    gateway = ContractMarketGateway()

    trades, authority = gateway._load_trades_payload(
        object(),
        SYMBOL,
        allow_provider_ws=True,
        allow_rest_fallback=False,
    )

    assert trades == []
    assert authority is None
    assert gateway._get_latest(CONTRACT_MARKET_CACHE_TRADES, SYMBOL) is None


def test_gateway_cache_writer_rejects_invalid_trade_directly():
    invalid_payload = _valid_ws_trade_payload()
    invalid_trade = invalid_payload["trades"][0]
    invalid_trade.update(source="QUOTE", quote_source="QUOTE")
    gateway = ContractMarketGateway()

    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_TRADES,
        SYMBOL,
        [invalid_trade],
        authority_payload=invalid_payload,
    ) is False
    assert gateway._get_latest(CONTRACT_MARKET_CACHE_TRADES, SYMBOL) is None


def test_provider_failure_does_not_fabricate_trade_from_quote(monkeypatch):
    contract_symbol = SimpleNamespace(
        symbol=SYMBOL,
        provider="BINANCE",
        provider_symbol="BTCUSDT",
    )
    unavailable = market_service.ContractTradesUnavailable(
        "CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE"
    )
    monkeypatch.setattr(
        market_service,
        "_load_contract_symbol",
        lambda *_args, **_kwargs: contract_symbol,
    )
    monkeypatch.setattr(
        market_service,
        "_get_configured_contract_recent_trades",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(unavailable),
    )
    monkeypatch.setattr(
        market_service,
        "contract_market_last_good_enabled",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        market_service,
        "get_contract_quote",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("provider failure must not fabricate quote-driven trades")
        ),
    )

    with pytest.raises(
        market_service.ContractQuoteUnavailable,
        match="CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE",
    ):
        market_service.get_contract_recent_trades(object(), SYMBOL, limit=30)


def test_closed_itick_market_returns_empty_trades_without_provider_calls(monkeypatch):
    contract_symbol = SimpleNamespace(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        provider_symbol="AAPL",
        category="STOCK",
    )
    monkeypatch.setattr(
        market_service,
        "_load_contract_symbol",
        lambda *_args, **_kwargs: contract_symbol,
    )
    monkeypatch.setattr(market_service, "_market_status_for_contract_symbol", lambda *_args: object())
    monkeypatch.setattr(market_service, "_is_market_closed", lambda *_args: True)
    monkeypatch.setattr(
        market_service,
        "_get_provider_ws_stock_tick_trade",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("closed markets must not request WS trades")
        ),
    )

    assert market_service.get_contract_recent_trades(object(), "AAPLUSDT_PERP") == []


def test_active_itick_market_fails_closed_when_ws_and_rest_trades_are_unavailable(monkeypatch):
    contract_symbol = SimpleNamespace(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        provider_symbol="AAPL",
        category="STOCK",
    )
    monkeypatch.setattr(
        market_service,
        "_load_contract_symbol",
        lambda *_args, **_kwargs: contract_symbol,
    )
    monkeypatch.setattr(market_service, "_market_status_for_contract_symbol", lambda *_args: object())
    monkeypatch.setattr(market_service, "_is_market_closed", lambda *_args: False)
    monkeypatch.setattr(market_service, "_get_provider_ws_stock_tick_trade", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(market_service, "_get_itick_stock_tick_trade", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(
        market_service,
        "get_contract_quote",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("unavailable iTick trades must not fall back to quote")
        ),
    )

    with pytest.raises(
        market_service.ContractTradesUnavailable,
        match="CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE",
    ):
        market_service.get_contract_recent_trades(object(), "AAPLUSDT_PERP")


def test_rest_route_returns_503_for_provider_trades_unavailable(monkeypatch):
    unavailable = market_service.ContractTradesUnavailable(
        "CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE"
    )
    monkeypatch.setattr(
        market_router,
        "get_contract_recent_trades",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(unavailable),
    )

    class _Db:
        rolled_back = False

        def rollback(self):
            self.rolled_back = True

    db = _Db()
    request = SimpleNamespace(state=SimpleNamespace(trace_id="trace-1"))
    with pytest.raises(HTTPException) as exc_info:
        market_router.contract_market_trades(request, symbol=SYMBOL, limit=30, db=db)

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["code"] == "CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE"
    assert db.rolled_back is True


def test_rest_route_preserves_closed_market_empty_list(monkeypatch):
    monkeypatch.setattr(market_router, "get_contract_recent_trades", lambda *_args, **_kwargs: [])

    class _Db:
        def rollback(self):
            raise AssertionError("successful empty response must not roll back")

    request = SimpleNamespace(state=SimpleNamespace(trace_id="trace-2"))
    response = market_router.contract_market_trades(request, symbol=SYMBOL, limit=30, db=_Db())

    assert response["data"] == []


def test_provider_ws_unavailable_does_not_broadcast_or_overwrite_real_cache(monkeypatch):
    class _Session:
        def close(self):
            return None

    gateway = ContractMarketGateway()
    payload = _valid_ws_trade_payload()
    real_trade = payload["trades"][0]
    assert gateway._set_latest(
        CONTRACT_MARKET_CACHE_TRADES,
        SYMBOL,
        [real_trade],
        authority_payload=payload,
    )
    cached_before = gateway._get_latest(CONTRACT_MARKET_CACHE_TRADES, SYMBOL)
    invalid_payload = _valid_ws_trade_payload()
    invalid_payload["trades"][0].update(
        source="QUOTE",
        quote_source="QUOTE",
    )
    monkeypatch.setattr(gateway_module, "provider_ws_trades_enabled", lambda: True)
    monkeypatch.setattr(gateway_module, "SessionLocal", _Session)
    monkeypatch.setattr(
        gateway_module,
        "select_fresh_provider_ws_trades",
        lambda *_args, **_kwargs: invalid_payload,
    )
    assert gateway._refresh_provider_ws_trades_once(SYMBOL) == []
    assert gateway._get_latest(CONTRACT_MARKET_CACHE_TRADES, SYMBOL) == cached_before


def test_trades_failure_isolated_from_quote_and_depth(monkeypatch):
    runtime_ms = gateway_module._utc_ms()
    quote = {
        "symbol": SYMBOL,
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "source": "PROVIDER_REST",
        "last_price": "101",
        "bid_price": "100",
        "ask_price": "102",
        "received_at_ms": runtime_ms,
    }
    depth = {
        "symbol": SYMBOL,
        "provider": "OKX_SWAP",
        "provider_symbol": "BTC-USDT-SWAP",
        "source": "PROVIDER_REST",
        "bids": [["100", "1"]],
        "asks": [["102", "1"]],
        "received_at_ms": runtime_ms,
    }
    gateway = ContractMarketGateway()

    class _Response:
        def __init__(self, **values):
            self.values = values

        def model_dump(self):
            return dict(self.values)

    monkeypatch.setattr(gateway_module, "_load_contract_symbol", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(gateway_module, "contract_quote_to_response", lambda value: value)
    monkeypatch.setattr(gateway_module, "contract_depth_to_response", lambda value: value)
    monkeypatch.setattr(gateway_module, "ContractQuoteResponse", _Response)
    monkeypatch.setattr(gateway_module, "ContractDepthResponse", _Response)
    monkeypatch.setattr(gateway, "_load_quote_payload", lambda *_args, **_kwargs: quote)
    monkeypatch.setattr(gateway, "_load_depth_payload", lambda *_args, **_kwargs: depth)
    monkeypatch.setattr(
        gateway,
        "_load_trades_payload",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            market_service.ContractQuoteUnavailable(
                "CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE"
            )
        ),
    )
    monkeypatch.setattr(
        gateway,
        "_state_message_from_latest",
        lambda *_args, **_kwargs: {"type": "contract_market_state"},
    )

    messages = gateway._load_market_state(
        object(),
        SYMBOL,
        ensure_provider_ws=False,
        intervals=[],
    )

    assert [message["type"] for message in messages] == [
        "contract_quote",
        "contract_depth",
        "contract_market_state",
    ]
    assert gateway._get_latest(gateway_module.CONTRACT_MARKET_CACHE_QUOTE, SYMBOL) == quote
    assert gateway._get_latest(gateway_module.CONTRACT_MARKET_CACHE_DEPTH, SYMBOL) == depth
