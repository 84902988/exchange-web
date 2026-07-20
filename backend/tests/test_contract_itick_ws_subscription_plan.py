from __future__ import annotations

from app.services.contract_itick_ws_subscription_plan import ItickWsSubscriptionPlan


def test_plan_groups_symbols_and_streams_by_one_market_connection():
    plan = ItickWsSubscriptionPlan()

    plan.acquire(market="forex", symbol="EURUSD$GB", stream="quote")
    plan.acquire(market="forex", symbol="XAUUSD$GB", stream="quote")
    plan.acquire(market="forex", symbol="EURUSD$GB", stream="kline@1")
    plan.acquire(market="stock", symbol="AAPL$US", stream="tick")

    forex = plan.market_plan("forex")
    assert forex.symbols_for("quote") == ("EURUSD$GB", "XAUUSD$GB")
    assert forex.symbols_for("kline@1") == ("EURUSD$GB",)
    assert plan.market_plan("stock").symbols_for("tick") == ("AAPL$US",)
    assert plan.active_markets() == frozenset({"forex", "stock"})


def test_duplicate_consumers_share_one_logical_subscription_and_revision():
    plan = ItickWsSubscriptionPlan()

    assert plan.acquire(market="FOREX", symbol="eurusd$gb", stream="QUOTE") == 1
    first_revision = plan.market_plan("forex").revision
    assert plan.acquire(market="forex", symbol="EURUSD$GB", stream="quote") == 2
    assert plan.market_plan("forex").revision == first_revision

    assert plan.release(market="forex", symbol="EURUSD$GB", stream="quote") == 1
    assert plan.market_plan("forex").revision == first_revision
    assert plan.release(market="forex", symbol="EURUSD$GB", stream="quote") == 0
    assert plan.market_plan("forex").revision == first_revision + 1
    assert plan.active_markets() == frozenset()


def test_unrelated_market_revision_does_not_churn_existing_connection_plan():
    plan = ItickWsSubscriptionPlan()
    plan.acquire(market="forex", symbol="EURUSD$GB", stream="depth")
    forex_revision = plan.market_plan("forex").revision

    plan.acquire(market="stock", symbol="AAPL$US", stream="depth")
    plan.acquire(market="stock", symbol="MSFT$US", stream="depth")

    assert plan.market_plan("forex").revision == forex_revision


def test_invalid_market_symbol_and_stream_fail_closed():
    plan = ItickWsSubscriptionPlan()

    for kwargs in (
        {"market": "crypto", "symbol": "BTCUSDT", "stream": "quote"},
        {"market": "forex", "symbol": "", "stream": "quote"},
        {"market": "forex", "symbol": "EURUSD$GB", "stream": "bookTicker"},
    ):
        try:
            plan.acquire(**kwargs)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {kwargs}")
