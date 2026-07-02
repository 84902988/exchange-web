from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.contract_market_view import build_contract_market_view


NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


def _contract(
    *,
    symbol: str = "BTCUSDT_PERP",
    category: str = "CRYPTO",
    provider: str = "BINANCE",
    mode: str = "DISABLED",
):
    return SimpleNamespace(
        symbol=symbol,
        display_name=symbol,
        category=category,
        provider=provider,
        closed_market_execution_mode=mode,
    )


def _quote(**overrides):
    payload = {
        "symbol": "BTCUSDT_PERP",
        "provider": "BINANCE",
        "category": "CRYPTO",
        "market_status": "OPEN",
        "quote_source": "LIVE",
        "source": "LIVE",
        "quote_freshness": "LIVE",
        "closed_market_execution_mode": "DISABLED",
        "bid_price": "100",
        "ask_price": "102",
        "last_price": "250",
        "mark_price": "101",
        "executable": True,
        "ts": (NOW - timedelta(seconds=1)).isoformat(),
    }
    payload.update(overrides)
    return payload


def _depth(**overrides):
    payload = {
        "symbol": "BTCUSDT_PERP",
        "provider": "BINANCE",
        "category": "CRYPTO",
        "market_status": "OPEN",
        "quote_source": "LIVE",
        "source": "LIVE",
        "quote_freshness": "LIVE",
        "closed_market_execution_mode": "DISABLED",
        "best_bid": "100",
        "best_ask": "102",
        "executable": True,
        "ts": (NOW - timedelta(seconds=1)).isoformat(),
    }
    payload.update(overrides)
    return payload


def _kline(**overrides):
    payload = {
        "open_time": int((NOW - timedelta(minutes=1)).timestamp() * 1000),
        "open": "9999",
        "high": "9999",
        "low": "9999",
        "close": "9999",
        "volume": "1",
    }
    payload.update(overrides)
    return payload


def test_live_tradable_crypto_requires_fresh_bbo():
    view = build_contract_market_view(
        "BTCUSDT_PERP",
        quote=_quote(),
        depth=_depth(),
        contract_symbol=_contract(),
        now=NOW,
    )

    assert view["display_state"] == "LIVE_TRADABLE"
    assert view["display_price"] == "101"
    assert view["display_price_source"] == "LIVE_MID"
    assert view["executable"] is True
    assert view["execution_bid"] == "100"
    assert view["execution_ask"] == "102"
    assert view["execution_mode"] == "LIVE_BBO"


def test_live_tradfi_bbo_display_price_is_not_overwritten_by_kline_close():
    view = build_contract_market_view(
        "XAGUSDT_PERP",
        quote=_quote(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            bid_price="60.120",
            ask_price="60.130",
            last_price="60.125",
            mark_price="60.125",
        ),
        depth=_depth(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            best_bid="60.120",
            best_ask="60.130",
        ),
        latest_kline=_kline(close="60.049"),
        contract_symbol=_contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK"),
        now=NOW,
    )

    assert view["display_state"] == "LIVE_TRADABLE"
    assert view["display_price"] == "60.125"
    assert view["display_price_source"] == "LIVE_MID"
    assert view["current_price_source"] == "LIVE_MID"
    assert view["execution_bid"] == "60.120"
    assert view["execution_ask"] == "60.130"
    assert view["raw_source_summary"]["latest_kline_close"] == "60.049"


def test_crypto_stale_becomes_expired_not_last_good_tradable():
    view = build_contract_market_view(
        "BTCUSDT_PERP",
        quote=_quote(quote_freshness="STALE", executable=False),
        depth=_depth(quote_freshness="STALE", executable=False),
        contract_symbol=_contract(mode="LAST_GOOD_BBO"),
        now=NOW,
    )

    assert view["display_state"] == "EXPIRED"
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "CRYPTO_BBO_NOT_LIVE"


def test_crypto_closed_valid_last_good_bbo_remains_not_tradable():
    view = build_contract_market_view(
        "BTCUSDT_PERP",
        quote=_quote(
            market_status="CLOSED",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        depth=_depth(
            market_status="CLOSED",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        contract_symbol=_contract(mode="LAST_GOOD_BBO"),
        now=NOW,
    )

    assert view["display_state"] != "CLOSED_LAST_GOOD_TRADABLE"
    assert view["display_state"] == "EXPIRED"
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "CRYPTO_BBO_NOT_LIVE"


def test_us_stock_regular_open_fresh_bbo_is_live_tradable():
    quote = _quote(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        category="STOCK",
        market_status="OPEN",
        market_session_type="REGULAR_OPEN",
        quote_source="ITICK_DEPTH",
        source="ITICK_DEPTH",
        quote_freshness="LIVE",
        closed_market_execution_mode="LAST_GOOD_BBO",
    )
    depth = _depth(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        category="STOCK",
        market_status="OPEN",
        market_session_type="REGULAR_OPEN",
        quote_source="ITICK_DEPTH",
        source="ITICK_DEPTH",
        quote_freshness="LIVE",
        closed_market_execution_mode="LAST_GOOD_BBO",
    )

    view = build_contract_market_view(
        "AAPLUSDT_PERP",
        quote=quote,
        depth=depth,
        contract_symbol=_contract(
            symbol="AAPLUSDT_PERP",
            category="STOCK",
            provider="ITICK",
            mode="LAST_GOOD_BBO",
        ),
        now=NOW,
    )

    assert view["display_state"] == "LIVE_TRADABLE"
    assert view["display_price"] == "101"
    assert view["display_price_source"] == "LIVE_MID"
    assert view["executable"] is True
    assert view["execution_bid"] == "100"
    assert view["execution_ask"] == "102"
    assert view["execution_mode"] == "LIVE_BBO"


def test_us_stock_premarket_uses_kline_close_for_display_only():
    last_good_at = NOW - timedelta(hours=2)
    latest_kline_time = NOW - timedelta(hours=1)
    quote = _quote(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        category="STOCK",
        market_status="CLOSED",
        market_session_type="PRE_MARKET",
        quote_source="LAST_GOOD_BBO",
        source="LAST_GOOD_BBO",
        quote_freshness="LAST_VALID",
        closed_market_execution_mode="LAST_GOOD_BBO",
        last_good_bbo_valid=True,
        last_good_at=last_good_at.isoformat(),
    )
    depth = _depth(
        symbol="AAPLUSDT_PERP",
        provider="ITICK",
        category="STOCK",
        market_status="CLOSED",
        market_session_type="PRE_MARKET",
        quote_source="LAST_GOOD_BBO",
        source="LAST_GOOD_BBO",
        quote_freshness="LAST_VALID",
        closed_market_execution_mode="LAST_GOOD_BBO",
        last_good_bbo_valid=True,
        last_good_at=last_good_at.isoformat(),
    )

    view = build_contract_market_view(
        "AAPLUSDT_PERP",
        quote=quote,
        depth=depth,
        latest_kline=_kline(
            open_time=int(latest_kline_time.timestamp() * 1000),
            close="9999",
        ),
        contract_symbol=_contract(
            symbol="AAPLUSDT_PERP",
            category="STOCK",
            provider="ITICK",
            mode="LAST_GOOD_BBO",
        ),
        now=NOW,
    )

    assert view["display_state"] == "PRE_MARKET"
    assert view["display_price"] == "9999"
    assert view["display_price_source"] == "KLINE_CLOSE"
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["execution_mode"] == "DISABLED"
    assert view["last_good_bbo_valid"] is False
    assert view["reason_code"] == "PRE_MARKET"
    assert "non_trading_session" in view["warnings"]
    assert "last_good_bbo_diagnostic_only" in view["warnings"]
    assert view["raw_source_summary"]["latest_kline_open_time"] == latest_kline_time.isoformat()
    assert view["raw_source_summary"]["last_good_bbo_valid_raw"] is True


def test_us_stock_after_hours_is_display_only():
    view = build_contract_market_view(
        "AAPLUSDT_PERP",
        quote=_quote(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="AFTER_HOURS",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        depth=_depth(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="AFTER_HOURS",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        latest_kline=_kline(close="288.88"),
        contract_symbol=_contract(symbol="AAPLUSDT_PERP", category="STOCK", provider="ITICK", mode="LAST_GOOD_BBO"),
        now=NOW,
    )

    assert view["display_state"] == "AFTER_HOURS"
    assert view["display_price"] == "288.88"
    assert view["display_price_source"] == "KLINE_CLOSE"
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "AFTER_HOURS"


def test_us_stock_closed_last_good_is_not_tradable_or_display_price():
    view = build_contract_market_view(
        "AAPLUSDT_PERP",
        quote=_quote(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="CLOSED",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        depth=_depth(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="CLOSED",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        contract_symbol=_contract(symbol="AAPLUSDT_PERP", category="STOCK", provider="ITICK", mode="LAST_GOOD_BBO"),
        now=NOW,
    )

    assert view["display_state"] == "CLOSED"
    assert view["display_price"] is None
    assert view["display_price_source"] == "NONE"
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["execution_mode"] == "DISABLED"
    assert view["reason_code"] == "MARKET_CLOSED"


def test_us_stock_holiday_is_not_tradable():
    view = build_contract_market_view(
        "AAPLUSDT_PERP",
        quote=_quote(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="HOLIDAY",
            market_session_type="HOLIDAY",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        depth=_depth(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="HOLIDAY",
            market_session_type="HOLIDAY",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        contract_symbol=_contract(symbol="AAPLUSDT_PERP", category="STOCK", provider="ITICK", mode="LAST_GOOD_BBO"),
        now=NOW,
    )

    assert view["display_state"] == "HOLIDAY"
    assert view["display_price"] is None
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "HOLIDAY"


def test_tradfi_explicit_last_good_valid_requires_last_good_source():
    view = build_contract_market_view(
        "AAPLUSDT_PERP",
        quote=_quote(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="CLOSED",
            quote_source="LIVE",
            source="LIVE",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        depth=_depth(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="CLOSED",
            quote_source="LIVE",
            source="LIVE",
            quote_freshness="LAST_VALID",
            closed_market_execution_mode="LAST_GOOD_BBO",
            last_good_bbo_valid=True,
        ),
        contract_symbol=_contract(
            symbol="AAPLUSDT_PERP",
            category="STOCK",
            provider="ITICK",
            mode="LAST_GOOD_BBO",
        ),
        now=NOW,
    )

    assert view["display_state"] != "CLOSED_LAST_GOOD_TRADABLE"
    assert view["display_state"] == "CLOSED"
    assert view["last_good_bbo_valid"] is False
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "MARKET_CLOSED"


def test_tradfi_expired_last_good_is_closed_not_tradable():
    view = build_contract_market_view(
        "AAPLUSDT_PERP",
        quote=_quote(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="CLOSED",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            last_good_bbo_valid=False,
            last_good_at=(NOW - timedelta(days=4)).isoformat(),
        ),
        depth=_depth(
            symbol="AAPLUSDT_PERP",
            provider="ITICK",
            category="STOCK",
            market_status="CLOSED",
            market_session_type="CLOSED",
            quote_source="LAST_GOOD_BBO",
            source="LAST_GOOD_BBO",
            quote_freshness="LAST_VALID",
            last_good_bbo_valid=False,
            last_good_at=(NOW - timedelta(days=4)).isoformat(),
        ),
        contract_symbol=_contract(
            symbol="AAPLUSDT_PERP",
            category="STOCK",
            provider="ITICK",
            mode="LAST_GOOD_BBO",
        ),
        now=NOW,
    )

    assert view["display_state"] == "CLOSED"
    assert view["executable"] is False
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "MARKET_CLOSED"


def test_no_bbo_is_unavailable():
    view = build_contract_market_view(
        "EURUSD_PERP",
        quote=_quote(bid_price=None, ask_price=None),
        depth=_depth(best_bid=None, best_ask=None),
        contract_symbol=_contract(symbol="EURUSD_PERP", category="FOREX", provider="ITICK"),
        now=NOW,
    )

    assert view["display_state"] == "UNAVAILABLE"
    assert view["display_price"] is None
    assert view["execution_bid"] is None
    assert view["execution_ask"] is None
    assert view["reason_code"] == "BBO_UNAVAILABLE"


def test_display_price_and_execution_prices_are_separate_from_last_price():
    view = build_contract_market_view(
        "BTCUSDT_PERP",
        quote=_quote(last_price="999", mark_price="999"),
        depth=_depth(best_bid="100", best_ask="102"),
        contract_symbol=_contract(),
        now=NOW,
    )

    assert view["display_price"] == "101"
    assert view["execution_bid"] == "100"
    assert view["execution_ask"] == "102"
    assert view["display_price"] != "999"


def test_kline_close_does_not_participate_in_execution_price():
    view = build_contract_market_view(
        "BTCUSDT_PERP",
        quote=_quote(close="9999"),
        depth=_depth(best_bid="100", best_ask="102"),
        latest_kline=_kline(close="9999"),
        contract_symbol=_contract(),
        now=NOW,
    )

    assert view["display_price"] == "101"
    assert view["execution_bid"] == "100"
    assert view["execution_ask"] == "102"
