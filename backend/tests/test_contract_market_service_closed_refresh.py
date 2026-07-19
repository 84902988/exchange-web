from __future__ import annotations

import sys
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services import contract_market_service as service


class DummyDb:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


def _closed_status() -> service.ItickMarketStatus:
    return service.ItickMarketStatus(
        market_status=service.MARKET_STATUS_CLOSED,
        market_status_text="closed",
        market_session_code="US",
        market_timezone="America/New_York",
        market_trading_hours="04:00-09:30,09:30-16:00,16:00-20:00",
        market_session_type="PRE_MARKET",
    )


def _closed_status_with_session(session_type: str = "CLOSED") -> service.ItickMarketStatus:
    return service.ItickMarketStatus(
        market_status=service.MARKET_STATUS_CLOSED,
        market_status_text="closed",
        market_session_code="US",
        market_timezone="America/New_York",
        market_trading_hours="04:00-09:30,09:30-16:00,16:00-20:00",
        market_session_type=session_type,
    )


def _open_status() -> service.ItickMarketStatus:
    return service.ItickMarketStatus(
        market_status="OPEN",
        market_status_text="open",
        market_session_code="US",
        market_timezone="America/New_York",
        market_trading_hours="04:00-09:30,09:30-16:00,16:00-20:00",
        market_session_type="REGULAR",
    )


def _contract(
    symbol: str = "AAPLUSDT_PERP",
    provider_symbol: str = "AAPL",
    category: str = "STOCK",
    provider: str = "ITICK",
):
    return SimpleNamespace(
        symbol=symbol,
        provider=provider,
        provider_symbol=provider_symbol,
        category=category,
        price_precision=2,
        closed_market_execution_mode="LAST_GOOD_BBO",
        quote_asset="USDT",
    )


def _quote(*, ts: datetime, bid: str = "294.15", ask: str = "294.45", source: str = "LAST_GOOD_BBO"):
    bid_decimal = Decimal(bid)
    ask_decimal = Decimal(ask)
    mid = (bid_decimal + ask_decimal) / Decimal("2")
    return {
        "symbol": "AAPLUSDT_PERP",
        "provider": "ITICK",
        "provider_symbol": "AAPL",
        "bid_price": bid_decimal,
        "ask_price": ask_decimal,
        "best_bid": bid_decimal,
        "best_ask": ask_decimal,
        "last_price": mid,
        "mark_price": mid,
        "source": source,
        "quote_source": source,
        "ts": ts,
        "last_good_at": ts,
        "price_precision": 2,
    }


def _depth(*, ts: datetime, bid: str = "294.15", ask: str = "294.45", source: str = "LAST_GOOD_BBO"):
    return service._depth_payload(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        provider_symbol="AAPL",
        bids=[service._depth_level(Decimal(bid), Decimal("1"))],
        asks=[service._depth_level(Decimal(ask), Decimal("1"))],
        source=source,
        ts=ts,
    )


def _reset_closed_caches() -> None:
    service._closed_market_quote_cache.clear()
    service._closed_market_depth_cache.clear()
    service._last_valid_depth_cache.clear()
    service._tradfi_quote_cache.clear()


def test_closed_market_fresh_last_good_quote_returns_without_itick_refresh():
    _reset_closed_caches()
    contract = _contract()
    service._closed_market_quote_cache[contract.symbol] = _quote(
        ts=datetime.now(timezone.utc) - timedelta(hours=1)
    )

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_closed_status()))
        stack.enter_context(patch.object(service, "_get_itick_live_quote", side_effect=AssertionError("should not refresh")))
        result = service.get_contract_quote(DummyDb(), contract.symbol)

    assert result["source"] == "LAST_GOOD_BBO"
    assert result["bid_price"] == Decimal("294.15")
    assert result["ask_price"] == Decimal("294.45")


def test_weekend_accepts_previous_friday_last_good_bbo():
    status = _closed_status_with_session("CLOSED")
    contract = _contract()
    quote = _quote(ts=datetime(2026, 7, 3, 20, 0, tzinfo=timezone.utc))

    assert service._closed_market_last_good_bbo_is_recent(
        quote,
        contract,
        status,
        now=datetime(2026, 7, 5, 16, 0, tzinfo=timezone.utc),
    ) is True


def test_monday_premarket_accepts_previous_friday_last_good_bbo():
    status = _closed_status_with_session("PRE_MARKET")
    contract = _contract()
    quote = _quote(ts=datetime(2026, 7, 3, 20, 0, tzinfo=timezone.utc))

    assert service._closed_market_last_good_bbo_is_recent(
        quote,
        contract,
        status,
        now=datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc),
    ) is True


def test_tuesday_premarket_requires_monday_last_good_bbo():
    status = _closed_status_with_session("PRE_MARKET")
    contract = _contract()
    monday_quote = _quote(ts=datetime(2026, 7, 6, 20, 0, tzinfo=timezone.utc))
    previous_wednesday_quote = _quote(ts=datetime(2026, 7, 1, 20, 0, tzinfo=timezone.utc))
    now = datetime(2026, 7, 7, 12, 0, tzinfo=timezone.utc)

    assert service._closed_market_last_good_bbo_is_recent(monday_quote, contract, status, now=now) is True
    assert service._closed_market_last_good_bbo_is_recent(previous_wednesday_quote, contract, status, now=now) is False


def test_holiday_accepts_previous_trading_day_last_good_bbo():
    status = _closed_status_with_session("CLOSED")
    contract = _contract()
    quote = _quote(ts=datetime(2026, 7, 2, 20, 0, tzinfo=timezone.utc))

    with patch.object(service, "_holiday_rows_for_status", return_value=[{"d": "2026-07-03"}]):
        assert service._closed_market_last_good_bbo_is_recent(
            quote,
            contract,
            status,
            now=datetime(2026, 7, 3, 16, 0, tzinfo=timezone.utc),
        ) is True


def test_closed_market_expired_last_good_quote_refreshes_itick_and_updates_last_good():
    _reset_closed_caches()
    contract = _contract()
    old_ts = datetime.now(timezone.utc) - timedelta(days=8)
    new_ts = datetime.now(timezone.utc)
    service._closed_market_quote_cache[contract.symbol] = _quote(ts=old_ts)
    saved: list[dict] = []

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_closed_status()))
        stack.enter_context(patch.object(
            service,
            "_get_itick_live_quote",
            return_value=_quote(ts=new_ts, bid="281.10", ask="281.30", source="ITICK_DEPTH"),
        ))
        stack.enter_context(patch.object(service, "save_last_valid_contract_quote", side_effect=lambda db, **kwargs: saved.append(kwargs)))
        result = service.get_contract_quote(DummyDb(), contract.symbol)

    assert result["source"] == "LAST_GOOD_BBO"
    assert result["quote_source"] == "LAST_GOOD_BBO"
    assert result["quote_freshness"] == "LAST_VALID"
    assert result["bid_price"] == Decimal("281.10")
    assert result["ask_price"] == Decimal("281.30")
    assert result["last_good_at"] == new_ts
    assert result["last_good_bbo_valid"] is True
    assert result["executable"] is False
    synced_depth = service._get_closed_depth(contract.symbol, limit=5)
    assert synced_depth is not None
    assert synced_depth["best_bid"] == Decimal("281.10")
    assert synced_depth["best_ask"] == Decimal("281.30")
    assert saved and saved[0]["bid_price"] == Decimal("281.10")


def test_closed_market_expired_last_good_quote_refresh_failure_returns_expired_quote_not_executable():
    _reset_closed_caches()
    contract = _contract()
    old_ts = datetime.now(timezone.utc) - timedelta(days=8)
    service._closed_market_quote_cache[contract.symbol] = _quote(ts=old_ts)

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_closed_status()))
        stack.enter_context(patch.object(service, "_get_itick_live_quote", side_effect=service.ItickQuoteUnavailable("boom")))
        result = service.get_contract_quote(DummyDb(), contract.symbol)

    assert result["source"] == "LAST_GOOD_BBO"
    assert result["bid_price"] == Decimal("294.15")
    assert result["last_good_bbo_valid"] is False
    assert result["executable"] is False


def test_closed_market_expired_depth_uses_refreshed_quote_when_depth_unavailable():
    _reset_closed_caches()
    contract = _contract()
    old_ts = datetime.now(timezone.utc) - timedelta(days=8)
    new_ts = datetime.now(timezone.utc)
    service._closed_market_depth_cache[contract.symbol] = _depth(ts=old_ts)
    saved: list[dict] = []

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_closed_status()))
        stack.enter_context(patch.object(service, "_get_stock_contract_depth", side_effect=service.ItickQuoteUnavailable("depth down")))
        stack.enter_context(patch.object(
            service,
            "_get_itick_live_quote",
            return_value=_quote(ts=new_ts, bid="281.10", ask="281.30", source="ITICK_DEPTH"),
        ))
        stack.enter_context(patch.object(service, "save_last_valid_contract_quote", side_effect=lambda db, **kwargs: saved.append(kwargs)))
        result = service.get_contract_depth(DummyDb(), contract.symbol, limit=5)

    assert result["source"] == "LAST_GOOD_BBO"
    assert result["quote_freshness"] == "LAST_VALID"
    assert result["executable"] is False
    assert result["best_bid"] == Decimal("281.10")
    assert result["best_ask"] == Decimal("281.30")
    assert saved and saved[0]["bid_price"] == Decimal("281.10")


def test_closed_market_depth_refresh_success_syncs_quote_but_remains_not_executable():
    _reset_closed_caches()
    contract = _contract()
    old_ts = datetime.now(timezone.utc) - timedelta(days=8)
    new_ts = datetime.now(timezone.utc)
    service._closed_market_quote_cache[contract.symbol] = _quote(ts=old_ts)
    service._closed_market_depth_cache[contract.symbol] = _depth(ts=old_ts)
    saved: list[dict] = []

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_closed_status()))
        stack.enter_context(patch.object(
            service,
            "_get_stock_contract_depth",
            return_value=_depth(ts=new_ts, bid="204.35", ask="204.83", source="ITICK_DEPTH"),
        ))
        stack.enter_context(patch.object(service, "save_last_valid_contract_quote", side_effect=lambda db, **kwargs: saved.append(kwargs)))
        depth = service.get_contract_depth(DummyDb(), contract.symbol, limit=5)

    assert depth["source"] == "LAST_GOOD_BBO"
    assert depth["quote_freshness"] == "LAST_VALID"
    assert depth["executable"] is False
    assert depth["best_bid"] == Decimal("204.35")
    assert depth["best_ask"] == Decimal("204.83")

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_closed_status()))
        stack.enter_context(patch.object(service, "_get_itick_live_quote", side_effect=AssertionError("synced quote should be reused")))
        quote = service.get_contract_quote(DummyDb(), contract.symbol)

    assert quote["source"] == "LAST_GOOD_BBO"
    assert quote["quote_freshness"] == "LAST_VALID"
    assert quote["executable"] is False
    assert quote["bid_price"] == Decimal("204.35")
    assert quote["ask_price"] == Decimal("204.83")
    assert saved and saved[0]["bid_price"] == Decimal("204.35")


def test_open_market_quote_stale_uses_live_depth_bbo():
    _reset_closed_caches()
    contract = _contract()
    stale_ts = datetime.now(timezone.utc) - timedelta(minutes=10)
    live_ts = datetime.now(timezone.utc)
    saved: list[dict] = []

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_open_status()))
        stack.enter_context(patch.object(
            service,
            "_get_itick_live_quote",
            return_value=_quote(ts=stale_ts, bid="206.33", ask="206.53", source="ITICK_QUOTE"),
        ))
        stack.enter_context(patch.object(
            service,
            "_get_itick_depth_for_contract",
            return_value=_depth(ts=live_ts, bid="204.12", ask="204.44", source="ITICK_DEPTH"),
        ))
        stack.enter_context(patch.object(service, "save_last_valid_contract_quote", side_effect=lambda db, **kwargs: saved.append(kwargs)))
        quote = service.get_contract_quote(DummyDb(), contract.symbol)

    assert quote["source"] == "ITICK_DEPTH"
    assert quote["quote_freshness"] == "LIVE"
    assert quote["executable"] is True
    assert quote["bid_price"] == Decimal("204.12")
    assert quote["ask_price"] == Decimal("204.44")
    assert quote["last_price"] == Decimal("204.28")
    assert quote["mark_price"] == Decimal("204.28")
    assert saved and saved[0]["bid_price"] == Decimal("204.12")


def test_open_market_depth_missing_uses_live_quote_bbo():
    _reset_closed_caches()
    contract = _contract()
    live_ts = datetime.now(timezone.utc)
    saved: list[dict] = []

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_open_status()))
        stack.enter_context(patch.object(service, "_get_stock_contract_depth", side_effect=service.ItickQuoteUnavailable("depth down")))
        stack.enter_context(patch.object(
            service,
            "_get_itick_live_quote",
            return_value=_quote(ts=live_ts, bid="281.60", ask="281.88", source="ITICK_QUOTE"),
        ))
        stack.enter_context(patch.object(service, "save_last_valid_contract_quote", side_effect=lambda db, **kwargs: saved.append(kwargs)))
        depth = service.get_contract_depth(DummyDb(), contract.symbol, limit=5)

    assert depth["source"] == "ITICK_QUOTE"
    assert depth["quote_freshness"] == "LIVE"
    assert depth["executable"] is True
    assert depth["best_bid"] == Decimal("281.60")
    assert depth["best_ask"] == Decimal("281.88")
    assert saved and saved[0]["bid_price"] == Decimal("281.60")


def test_open_market_depth_stale_uses_live_quote_bbo():
    _reset_closed_caches()
    contract = _contract()
    stale_ts = datetime.now(timezone.utc) - timedelta(minutes=10)
    live_ts = datetime.now(timezone.utc)
    saved: list[dict] = []

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_open_status()))
        stack.enter_context(patch.object(
            service,
            "_get_stock_contract_depth",
            return_value=_depth(ts=stale_ts, bid="204.12", ask="204.44", source="ITICK_DEPTH"),
        ))
        stack.enter_context(patch.object(
            service,
            "_get_itick_live_quote",
            return_value=_quote(ts=live_ts, bid="281.60", ask="281.88", source="ITICK_QUOTE"),
        ))
        stack.enter_context(patch.object(service, "save_last_valid_contract_quote", side_effect=lambda db, **kwargs: saved.append(kwargs)))
        depth = service.get_contract_depth(DummyDb(), contract.symbol, limit=5)

    assert depth["source"] == "ITICK_QUOTE"
    assert depth["quote_freshness"] == "LIVE"
    assert depth["executable"] is True
    assert depth["best_bid"] == Decimal("281.60")
    assert depth["best_ask"] == Decimal("281.88")
    assert saved and saved[0]["bid_price"] == Decimal("281.60")


def test_open_market_plain_stale_without_live_depth_remains_not_executable():
    _reset_closed_caches()
    contract = _contract()
    stale_ts = datetime.now(timezone.utc) - timedelta(minutes=10)

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_open_status()))
        stack.enter_context(patch.object(
            service,
            "_get_itick_live_quote",
            return_value=_quote(ts=stale_ts, bid="206.33", ask="206.53", source="ITICK_QUOTE"),
        ))
        stack.enter_context(patch.object(service, "_get_itick_depth_for_contract", side_effect=service.ItickQuoteUnavailable("depth down")))
        quote = service.get_contract_quote(DummyDb(), contract.symbol)

    assert quote["source"] == "ITICK_QUOTE"
    assert quote["quote_freshness"] == "LAST_VALID"
    assert quote["executable"] is False


def test_open_market_live_quote_and_depth_prefers_depth_bbo_for_quote():
    _reset_closed_caches()
    contract = _contract()
    live_ts = datetime.now(timezone.utc)

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "_market_status_for_contract_symbol", return_value=_open_status()))
        stack.enter_context(patch.object(
            service,
            "_get_itick_live_quote",
            return_value=_quote(ts=live_ts, bid="206.33", ask="206.53", source="ITICK_QUOTE"),
        ))
        stack.enter_context(patch.object(
            service,
            "_get_itick_depth_for_contract",
            return_value=_depth(ts=live_ts, bid="204.12", ask="204.44", source="ITICK_DEPTH"),
        ))
        stack.enter_context(patch.object(service, "save_last_valid_contract_quote", lambda *args, **kwargs: None))
        quote = service.get_contract_quote(DummyDb(), contract.symbol)

    assert quote["source"] == "ITICK_DEPTH"
    assert quote["quote_freshness"] == "LIVE"
    assert quote["executable"] is True
    assert quote["bid_price"] == Decimal("204.12")
    assert quote["ask_price"] == Decimal("204.44")
    assert quote["last_price"] == Decimal("204.28")


def test_stock_kline_path_still_uses_itick_kline_fetcher():
    contract = _contract()
    expected_rows = [{"open_time": 1, "close": "281.30"}]

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        fetch = stack.enter_context(patch.object(service, "_get_stock_contract_klines_from_itick", return_value=expected_rows))
        rows = service.get_contract_klines(DummyDb(), contract.symbol, interval="1m", limit=5)

    assert rows == expected_rows
    fetch.assert_called_once()


def test_binance_kline_failure_returns_empty_without_last_good_synthetic():
    contract = _contract(
        symbol="BTCUSDT_PERP",
        provider_symbol="BTCUSDT",
        category="CRYPTO",
        provider="BINANCE",
    )

    with ExitStack() as stack:
        stack.enter_context(patch.object(service, "_load_contract_symbol", return_value=contract))
        stack.enter_context(patch.object(service, "get_klines_cache_first", side_effect=RuntimeError("boom")))
        stack.enter_context(patch.object(service, "contract_market_last_good_enabled", return_value=True))
        last_good = stack.enter_context(patch.object(service, "get_last_valid_contract_quote", return_value={
            "last_price": Decimal("62100"),
        }))
        rows = service.get_contract_klines(DummyDb(), contract.symbol, interval="1m", limit=5)

    assert rows == []
    last_good.assert_not_called()


if __name__ == "__main__":
    test_closed_market_fresh_last_good_quote_returns_without_itick_refresh()
    test_weekend_accepts_previous_friday_last_good_bbo()
    test_monday_premarket_accepts_previous_friday_last_good_bbo()
    test_tuesday_premarket_requires_monday_last_good_bbo()
    test_holiday_accepts_previous_trading_day_last_good_bbo()
    test_closed_market_expired_last_good_quote_refreshes_itick_and_updates_last_good()
    test_closed_market_expired_last_good_quote_refresh_failure_returns_expired_quote_not_executable()
    test_closed_market_expired_depth_uses_refreshed_quote_when_depth_unavailable()
    test_closed_market_depth_refresh_success_syncs_quote_and_is_executable()
    test_open_market_quote_stale_uses_live_depth_bbo()
    test_open_market_depth_missing_uses_live_quote_bbo()
    test_open_market_depth_stale_uses_live_quote_bbo()
    test_open_market_plain_stale_without_live_depth_remains_not_executable()
    test_open_market_live_quote_and_depth_prefers_depth_bbo_for_quote()
    test_stock_kline_path_still_uses_itick_kline_fetcher()
    test_binance_kline_failure_returns_empty_without_last_good_synthetic()
