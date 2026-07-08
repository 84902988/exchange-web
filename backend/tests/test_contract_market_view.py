from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.contract_market_view import (
    apply_quote_driven_kline_overlays,
    build_contract_market_view,
    reset_contract_kline_current_candle_state_for_tests,
)


NOW = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _reset_kline_current_candle_state():
    reset_contract_kline_current_candle_state_for_tests()
    yield
    reset_contract_kline_current_candle_state_for_tests()


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


def test_tradfi_current_candle_uses_provider_bucket_not_server_now():
    provider_bucket = NOW + timedelta(minutes=1)
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
        latest_kline=_kline(
            open_time=int(provider_bucket.timestamp() * 1000),
            open="60.000",
            high="60.050",
            low="59.950",
            close="60.010",
            volume="100",
        ),
        contract_symbol=_contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK"),
        now=NOW,
    )

    candle = view["kline_current_candle"]
    assert candle["open_time"] == int(provider_bucket.timestamp() * 1000)
    assert candle["kline_mode"] == "PROVIDER_KLINE"
    assert candle["price_source"] == "KLINE_CLOSE"
    assert candle["volume_source"] == "PROVIDER_KLINE"
    assert candle["open"] == "60.000"
    assert candle["high"] == "60.050"
    assert candle["low"] == "59.950"
    assert candle["close"] == "60.010"
    assert candle["volume"] == "100"


def test_tradfi_current_candle_uses_provider_ohlc_revision():
    provider_bucket_ms = int(NOW.timestamp() * 1000)
    common = {
        "quote": _quote(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            bid_price="60.990",
            ask_price="61.010",
            last_price="61.000",
            mark_price="61.000",
        ),
        "depth": _depth(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            best_bid="60.990",
            best_ask="61.010",
        ),
        "contract_symbol": _contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK"),
        "now": NOW,
    }
    first = build_contract_market_view(
        "XAGUSDT_PERP",
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="60.000",
            high="60.300",
            low="59.900",
            close="60.100",
            volume="100",
        ),
        **common,
    )
    assert first["kline_current_candle"]["open"] == "60.000"
    assert first["kline_current_candle"]["high"] == "60.300"
    assert first["kline_current_candle"]["low"] == "59.900"
    assert first["kline_current_candle"]["close"] == "60.100"

    second = build_contract_market_view(
        "XAGUSDT_PERP",
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="60.000",
            high="62.250",
            low="59.920",
            close="60.100",
            volume="120",
        ),
        **common,
    )
    assert second["kline_current_candle"]["open"] == "60.000"
    assert second["kline_current_candle"]["high"] == "62.250"
    assert second["kline_current_candle"]["low"] == "59.920"
    assert second["kline_current_candle"]["close"] == "60.100"
    assert second["kline_current_candle"]["volume"] == "120"


def test_live_mid_does_not_pollute_provider_current_candle():
    provider_bucket_ms = int(NOW.timestamp() * 1000)
    contract_symbol = _contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK")
    first_quote = _quote(
        symbol="XAGUSDT_PERP",
        provider="ITICK",
        category="METAL",
        quote_source="ITICK_QUOTE",
        source="ITICK_QUOTE",
        bid_price="60.060",
        ask_price="60.070",
    )
    first_depth = _depth(
        symbol="XAGUSDT_PERP",
        provider="ITICK",
        category="METAL",
        quote_source="ITICK_QUOTE",
        source="ITICK_QUOTE",
        best_bid="60.060",
        best_ask="60.070",
    )
    build_contract_market_view(
        "XAGUSDT_PERP",
        quote=first_quote,
        depth=first_depth,
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="59.94498",
            high="59.950",
            low="59.93848",
            close="59.94098",
            volume="220.2",
        ),
        contract_symbol=contract_symbol,
        now=NOW,
    )

    second_quote = dict(first_quote, bid_price="60.050", ask_price="60.060")
    second_depth = dict(first_depth, best_bid="60.050", best_ask="60.060")
    view = build_contract_market_view(
        "XAGUSDT_PERP",
        quote=second_quote,
        depth=second_depth,
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="59.94498",
            high="61.500",
            low="59.9495",
            close="59.94098",
            volume="230.1",
        ),
        contract_symbol=contract_symbol,
        now=NOW + timedelta(seconds=1),
    )

    candle = view["kline_current_candle"]
    assert candle["open"] == "59.94498"
    assert candle["high"] == "61.500"
    assert candle["low"] == "59.9495"
    assert candle["close"] == "59.94098"
    assert candle["volume"] == "230.1"


def test_stale_quote_driven_overlay_state_is_ignored():
    provider_bucket_ms = int(NOW.timestamp() * 1000)

    quote = _quote(
        symbol="XAGUSDT_PERP",
        provider="ITICK",
        category="METAL",
        quote_source="ITICK_QUOTE",
        source="ITICK_QUOTE",
        bid_price="60.050",
        ask_price="60.060",
    )
    depth = _depth(
        symbol="XAGUSDT_PERP",
        provider="ITICK",
        category="METAL",
        quote_source="ITICK_QUOTE",
        source="ITICK_QUOTE",
        best_bid="60.050",
        best_ask="60.060",
    )
    view = build_contract_market_view(
        "XAGUSDT_PERP",
        quote=quote,
        depth=depth,
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="59.94498",
            high="61.500",
            low="59.9495",
            close="59.94098",
            volume="300",
        ),
        contract_symbol=_contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK"),
        now=NOW + timedelta(seconds=1),
    )

    candle = view["kline_current_candle"]
    assert candle["open"] == "59.94498"
    assert candle["high"] == "61.500"
    assert candle["low"] == "59.9495"
    assert candle["close"] == "59.94098"
    assert candle["volume"] == "300"


def test_readonly_view_uses_provider_ohlc_without_quote_overlay():
    provider_bucket_ms = int(NOW.timestamp() * 1000)
    contract_symbol = _contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK")

    build_contract_market_view(
        "XAGUSDT_PERP",
        quote=_quote(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            bid_price="60.060",
            ask_price="60.070",
        ),
        depth=_depth(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            best_bid="60.060",
            best_ask="60.070",
        ),
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="59.94498",
            high="59.950",
            low="59.800",
            close="59.94098",
            volume="220.2",
        ),
        contract_symbol=contract_symbol,
        now=NOW,
    )

    readonly = build_contract_market_view(
        "XAGUSDT_PERP",
        quote=_quote(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            bid_price="60.050",
            ask_price="60.060",
        ),
        depth=_depth(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            best_bid="60.050",
            best_ask="60.060",
        ),
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="59.94498",
            high="61.500",
            low="59.700",
            close="59.94098",
            volume="230.1",
        ),
        contract_symbol=contract_symbol,
        now=NOW + timedelta(seconds=1),
        mutate_quote_driven_state=False,
    )
    assert readonly["kline_current_candle"]["low"] == "59.700"

    view = build_contract_market_view(
        "XAGUSDT_PERP",
        quote=_quote(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            bid_price="60.060",
            ask_price="60.070",
        ),
        depth=_depth(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            best_bid="60.060",
            best_ask="60.070",
        ),
        latest_kline=_kline(
            open_time=provider_bucket_ms,
            open="59.94498",
            high="61.500",
            low="59.700",
            close="59.94098",
            volume="240.1",
        ),
        contract_symbol=contract_symbol,
        now=NOW + timedelta(seconds=2),
    )

    candle = view["kline_current_candle"]
    assert candle["open"] == "59.94498"
    assert candle["high"] == "61.500"
    assert candle["low"] == "59.700"
    assert candle["close"] == "59.94098"
    assert candle["volume"] == "240.1"


def test_tradfi_current_candle_volume_uses_provider_value():
    provider_bucket_ms = int(NOW.timestamp() * 1000)
    common = {
        "quote": _quote(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            bid_price="60.120",
            ask_price="60.130",
        ),
        "depth": _depth(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            quote_source="ITICK_QUOTE",
            source="ITICK_QUOTE",
            best_bid="60.120",
            best_ask="60.130",
        ),
        "contract_symbol": _contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK"),
        "now": NOW,
    }
    build_contract_market_view(
        "XAGUSDT_PERP",
        latest_kline=_kline(open_time=provider_bucket_ms, volume="500", high="60.2", low="60.0", close="60.1"),
        **common,
    )
    view = build_contract_market_view(
        "XAGUSDT_PERP",
        latest_kline=_kline(open_time=provider_bucket_ms, volume="300", high="60.2", low="60.0", close="60.1"),
        **common,
    )

    assert view["kline_current_candle"]["volume"] == "300"


def test_quote_driven_overlay_helper_returns_provider_rows_unchanged():
    first_bucket_ms = int(NOW.timestamp() * 1000)
    second_bucket_ms = int((NOW + timedelta(minutes=1)).timestamp() * 1000)
    quote = _quote(
        symbol="XAGUSDT_PERP",
        provider="ITICK",
        category="METAL",
        quote_source="ITICK_QUOTE",
        source="ITICK_QUOTE",
        bid_price="59.940",
        ask_price="59.950",
    )
    depth = _depth(
        symbol="XAGUSDT_PERP",
        provider="ITICK",
        category="METAL",
        quote_source="ITICK_QUOTE",
        source="ITICK_QUOTE",
        best_bid="59.940",
        best_ask="59.950",
    )
    contract_symbol = _contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK")

    first = build_contract_market_view(
        "XAGUSDT_PERP",
        quote=quote,
        depth=depth,
        latest_kline=_kline(
            open_time=first_bucket_ms,
            open="59.87002",
            high="59.87502",
            low="59.8265",
            close="59.82052",
            volume="500",
        ),
        contract_symbol=contract_symbol,
        now=NOW,
    )
    assert first["kline_current_candle"]["open"] == "59.87002"
    assert first["kline_current_candle"]["high"] == "59.87502"
    assert first["kline_current_candle"]["low"] == "59.8265"
    assert first["kline_current_candle"]["close"] == "59.82052"

    next_quote = dict(quote, bid_price="59.910", ask_price="59.920")
    next_depth = dict(depth, best_bid="59.910", best_ask="59.920")
    build_contract_market_view(
        "XAGUSDT_PERP",
        quote=next_quote,
        depth=next_depth,
        latest_kline=_kline(
            open_time=second_bucket_ms,
            open="59.82051",
            high="59.842",
            low="59.81698",
            close="59.83901",
            volume="100",
        ),
        contract_symbol=contract_symbol,
        now=NOW + timedelta(minutes=1),
    )

    rows = apply_quote_driven_kline_overlays(
        "XAGUSDT_PERP",
        "1m",
        [
            _kline(
                open_time=first_bucket_ms,
                open="59.87002",
                high="59.87502",
                low="59.81748",
                close="59.82052",
                volume="383.6",
            ),
            _kline(
                open_time=second_bucket_ms,
                open="59.82051",
                high="59.842",
                low="59.81698",
                close="59.83901",
                volume="100",
            ),
        ],
        limit=2,
    )

    protected = rows[0]
    assert protected["open"] == "59.87002"
    assert protected["high"] == "59.87502"
    assert protected["low"] == "59.81748"
    assert protected["close"] == "59.82052"
    assert protected["volume"] == "383.6"


def test_quote_driven_overlay_helper_does_not_add_missing_buckets():
    contract_symbol = _contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK")
    for index, mid in enumerate(["60.100", "60.200", "60.300", "60.400"]):
        bucket = NOW + timedelta(minutes=index)
        bid = str(float(mid) - 0.005)
        ask = str(float(mid) + 0.005)
        build_contract_market_view(
            "XAGUSDT_PERP",
            quote=_quote(
                symbol="XAGUSDT_PERP",
                provider="ITICK",
                category="METAL",
                quote_source="ITICK_QUOTE",
                source="ITICK_QUOTE",
                bid_price=bid,
                ask_price=ask,
            ),
            depth=_depth(
                symbol="XAGUSDT_PERP",
                provider="ITICK",
                category="METAL",
                quote_source="ITICK_QUOTE",
                source="ITICK_QUOTE",
                best_bid=bid,
                best_ask=ask,
            ),
            latest_kline=_kline(
                open_time=int(bucket.timestamp() * 1000),
                open="60.000",
                high="60.050",
                low="59.950",
                close="60.010",
                volume="10",
            ),
            contract_symbol=contract_symbol,
            now=bucket,
        )

    first_bucket_ms = int(NOW.timestamp() * 1000)
    rows = apply_quote_driven_kline_overlays(
        "XAGUSDT_PERP",
        "1m",
        [
            _kline(
                open_time=first_bucket_ms,
                open="60.000",
                high="60.050",
                low="59.950",
                close="60.010",
                volume="10",
            )
        ],
        limit=1,
        include_missing=False,
    )

    assert rows[0]["high"] == "60.050"
    assert rows[0]["close"] == "60.010"
    assert rows[0].get("kline_mode") is None


def test_crypto_klines_do_not_receive_quote_driven_overlay():
    build_contract_market_view(
        "BTCUSDT_PERP",
        quote=_quote(bid_price="100", ask_price="102"),
        depth=_depth(best_bid="100", best_ask="102"),
        latest_kline=_kline(open="90", high="95", low="85", close="92", volume="12"),
        contract_symbol=_contract(),
        now=NOW,
    )

    rows = apply_quote_driven_kline_overlays(
        "BTCUSDT_PERP",
        "1m",
        [_kline(open="90", high="95", low="85", close="92", volume="12")],
        limit=1,
    )

    assert rows[0]["high"] == "95"
    assert rows[0]["close"] == "92"
    assert rows[0].get("kline_mode") is None


def test_crypto_current_candle_does_not_enter_quote_driven_mode():
    view = build_contract_market_view(
        "BTCUSDT_PERP",
        quote=_quote(bid_price="100", ask_price="102"),
        depth=_depth(best_bid="100", best_ask="102"),
        latest_kline=_kline(open="90", high="95", low="85", close="92", volume="12"),
        contract_symbol=_contract(),
        now=NOW,
    )

    candle = view["kline_current_candle"]
    assert candle["kline_mode"] == "PROVIDER_KLINE"
    assert candle["price_source"] == "KLINE_CLOSE"
    assert candle["close"] == "92"
    assert candle["volume"] == "12"


def test_kline_current_candle_rejects_non_provider_kline_source():
    view = build_contract_market_view(
        "XAGUSDT_PERP",
        quote=_quote(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            bid_price="60.120",
            ask_price="60.130",
        ),
        depth=_depth(
            symbol="XAGUSDT_PERP",
            provider="ITICK",
            category="METAL",
            best_bid="60.120",
            best_ask="60.130",
        ),
        latest_kline=_kline(open="60", high="61", low="59", close="60.5", volume="12", price_source="LIVE_MID"),
        contract_symbol=_contract(symbol="XAGUSDT_PERP", category="METAL", provider="ITICK"),
        now=NOW,
    )

    assert view["kline_current_candle"] is None


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
