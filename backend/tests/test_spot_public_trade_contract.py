from __future__ import annotations

import inspect
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from app.services import market
from app.services import spot_market_provider_ws as provider_ws


def _pair() -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        symbol="BTCUSDT",
        price_precision=2,
        amount_precision=4,
    )


def _assert_provider_identity(item, *, trade_id: str, provider: str, provider_symbol: str) -> None:
    assert item.id == trade_id
    assert item.trade_id == trade_id
    assert item.provider_trade_id == trade_id
    assert item.provider == provider
    assert item.provider_symbol == provider_symbol
    assert item.source == "external"
    assert item.freshness == "RECENT"
    assert item.time_origin == "PROVIDER"


def test_okx_rest_trade_preserves_provider_time_and_identity() -> None:
    with patch.object(market, "_now_ms", return_value=5_000):
        response = market._spot_trades_from_provider(
            pair=_pair(),
            provider_code="OKX_SPOT",
            provider_symbol="BTC-USDT",
            payload={
                "data": [
                    {
                        "tradeId": "okx-1",
                        "px": "100",
                        "sz": "1.25",
                        "side": "buy",
                        "ts": "1000",
                    }
                ]
            },
            limit=20,
        )

    item = response.trades[0]
    _assert_provider_identity(item, trade_id="okx-1", provider="OKX_SPOT", provider_symbol="BTC-USDT")
    assert item.event_time_ms == 1_000
    assert item.received_at_ms == 5_000
    assert item.ts == 1_000
    assert item.created_at == datetime.utcfromtimestamp(1).isoformat()
    assert response.received_at_ms == 5_000


def test_bitget_rest_trade_preserves_provider_time_and_identity() -> None:
    with patch.object(market, "_now_ms", return_value=6_000):
        response = market._spot_trades_from_provider(
            pair=_pair(),
            provider_code="BITGET_SPOT",
            provider_symbol="BTCUSDT",
            payload={
                "data": [
                    {
                        "tradeId": "bitget-1",
                        "price": "101",
                        "size": "2",
                        "side": "sell",
                        "ts": "2000",
                    }
                ]
            },
            limit=20,
        )

    item = response.trades[0]
    _assert_provider_identity(item, trade_id="bitget-1", provider="BITGET_SPOT", provider_symbol="BTCUSDT")
    assert item.event_time_ms == 2_000
    assert item.received_at_ms == 6_000
    assert item.ts == 2_000
    assert item.created_at == datetime.utcfromtimestamp(2).isoformat()


def test_binance_rest_trade_preserves_provider_time_and_identity() -> None:
    with patch.object(market, "_now_ms", return_value=7_000):
        response = market._spot_trades_from_provider(
            pair=_pair(),
            provider_code="BINANCE_SPOT",
            provider_symbol="BTCUSDT",
            payload=[
                {
                    "id": 42,
                    "price": "102",
                    "qty": "3",
                    "isBuyerMaker": False,
                    "time": 3_000,
                }
            ],
            limit=20,
        )

    item = response.trades[0]
    _assert_provider_identity(item, trade_id="42", provider="BINANCE_SPOT", provider_symbol="BTCUSDT")
    assert item.event_time_ms == 3_000
    assert item.received_at_ms == 7_000
    assert item.ts == 3_000


def test_rest_batch_captures_receive_time_once_and_keeps_untimed_trade_explicit() -> None:
    clock_calls: list[int] = []

    def clock() -> int:
        clock_calls.append(9_000)
        return 9_000

    with patch.object(market, "_now_ms", side_effect=clock):
        response = market._spot_trades_from_provider(
            pair=_pair(),
            provider_code="OKX_SPOT",
            provider_symbol="BTC-USDT",
            payload={
                "data": [
                    {"tradeId": "timed", "px": "100", "sz": "1", "side": "buy", "ts": "1000"},
                    {"tradeId": "untimed", "px": "99", "sz": "2", "side": "sell"},
                ]
            },
            limit=20,
        )

    assert clock_calls == [9_000]
    assert response.received_at_ms == 9_000
    assert {item.received_at_ms for item in response.trades} == {9_000}
    timed, untimed = response.trades
    assert timed.event_time_ms == 1_000
    assert timed.created_at == datetime.utcfromtimestamp(1).isoformat()
    assert untimed.event_time_ms is None
    assert untimed.ts == 9_000
    assert untimed.created_at is None
    assert untimed.time_origin == "PROVIDER"


def test_ws_cache_to_public_response_preserves_trade_contract() -> None:
    response = provider_ws._trades_response_from_record(
        {
            "symbol": "BTCUSDT",
            "provider": "OKX_SPOT",
            "provider_symbol": "BTC-USDT",
            "source": "LIVE_WS",
            "freshness": "LIVE",
            "updated_at_ms": 8_000,
            "updated_at": datetime.utcfromtimestamp(8).isoformat(),
            "trades": [
                {
                    "id": "ws-1",
                    "trade_id": "ws-1",
                    "provider_trade_id": "ws-1",
                    "price": "100",
                    "amount": "1",
                    "side": "BUY",
                    "ts": 4_000,
                    "event_time_ms": 4_000,
                    "received_at_ms": 8_000,
                    "time_origin": "PROVIDER",
                    "provider": "OKX_SPOT",
                    "provider_symbol": "BTC-USDT",
                    "source": "LIVE_WS",
                    "freshness": "LIVE",
                }
            ],
        }
    )

    assert response.received_at_ms == 8_000
    item = response.trades[0]
    assert item.id == "ws-1"
    assert item.trade_id == "ws-1"
    assert item.provider_trade_id == "ws-1"
    assert item.event_time_ms == 4_000
    assert item.received_at_ms == 8_000
    assert item.time_origin == "PROVIDER"
    assert item.provider == "OKX_SPOT"
    assert item.provider_symbol == "BTC-USDT"
    assert item.source == "LIVE_WS"
    assert item.freshness == "LIVE"

    formatted = market._format_trades_for_pair(_pair(), response)
    formatted_item = formatted.trades[0]
    assert formatted_item.id == "ws-1"
    assert formatted_item.event_time_ms == 4_000
    assert formatted_item.received_at_ms == 8_000
    assert formatted_item.time_origin == "PROVIDER"


def test_internal_trade_uses_platform_identity_and_created_at() -> None:
    created_at = datetime(2026, 7, 11, 1, 2, 3, 456000, tzinfo=timezone.utc)
    row = SimpleNamespace(
        id=77,
        price=Decimal("100.25"),
        amount=Decimal("1.5"),
        created_at=created_at,
        taker_order_id=None,
    )

    class Query:
        def filter(self, *args, **kwargs):
            return self

        def order_by(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def all(self):
            return [row]

    class Db:
        def query(self, *args, **kwargs):
            return Query()

    response = market._get_internal_trades(Db(), _pair(), limit=10)
    item = response.trades[0]
    expected_ms = int(created_at.timestamp() * 1000)
    assert item.id == "77"
    assert item.trade_id == "77"
    assert item.provider_trade_id is None
    assert item.ts == expected_ms
    assert item.event_time_ms == expected_ms
    assert item.received_at_ms is None
    assert item.created_at == "2026-07-11T01:02:03.456000Z"
    assert item.time_origin == "PLATFORM_TRADE"
    assert item.source == "INTERNAL"


def test_internal_trade_normalizes_legacy_mysql_local_time_without_touching_kline_buckets() -> None:
    created_at = datetime(2026, 7, 21, 0, 29, 55, 690000)
    row = SimpleNamespace(
        id=78,
        price=Decimal("100.25"),
        amount=Decimal("1.5"),
        created_at=created_at,
        taker_order_id=None,
    )

    class Query:
        def filter(self, *args, **kwargs):
            return self

        def order_by(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def all(self):
            return [row]

    class Db:
        def query(self, *args, **kwargs):
            return Query()

    item = market._get_internal_trades(Db(), _pair(), limit=10).trades[0]

    assert item.event_time_ms == 1_784_564_995_690
    assert item.created_at == "2026-07-20T16:29:55.690000Z"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not inspect.signature(fn).parameters:
            fn()
    print("spot public trade contract tests passed")
