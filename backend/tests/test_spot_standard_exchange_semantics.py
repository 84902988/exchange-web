from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app.schemas.market import DepthResponse
from app.services import market
from app.services.market_ws import MarketWsManager


def _asset(symbol: str) -> SimpleNamespace:
    return SimpleNamespace(symbol=symbol)


def _pair(
    *,
    symbol: str = "MFCUSDT",
    base: str = "MFC",
    quote: str = "USDT",
    asset_type: str = "RWA",
    market_category: str = "CRYPTO",
    display_category: str = "RWA",
    data_source: str = "INTERNAL",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        symbol=symbol,
        base_asset=_asset(base),
        quote_asset=_asset(quote),
        asset_type=asset_type,
        market_category=market_category,
        market_sub_category=None,
        display_category=display_category,
        display_group=None,
        external_symbol=None,
        data_source=data_source,
        market_mode="INTERNAL",
        sort_order=0,
        is_hot=False,
        status=1,
    )


def test_selector_spot_category_includes_enabled_internal_spot_pair() -> None:
    pair = _pair()
    pair_without_display_category = _pair(display_category=None)

    assert market._pair_matches_category(pair, "spot") is True
    assert market._pair_matches_category(pair, "rwa") is True
    assert market._pair_matches_category(pair_without_display_category, "spot") is True
    assert market._pair_matches_category(pair_without_display_category, "rwa") is True
    assert market._pair_matches_keyword(pair, "MFCUSDT") is True
    assert market._pair_matches_keyword(pair, "MFC/USDT") is True
    assert market._pair_matches_keyword(pair, "mfc") is True
    assert market._pair_matches_keyword(pair, "usdt") is True


def test_selector_spot_category_does_not_include_contract_pair() -> None:
    pair = _pair(
        symbol="BTCUSDT-PERP",
        base="BTC",
        asset_type="CONTRACT",
        market_category="CONTRACT",
        display_category="MAINSTREAM",
    )

    assert market._pair_matches_category(pair, "spot") is False


def test_spot_ws_depth_payload_marks_empty_book_missing() -> None:
    manager = MarketWsManager()
    depth = DepthResponse(
        symbol="MFCUSDT",
        price_precision=3,
        amount_precision=3,
        bids=[],
        asks=[],
        ts=1000,
        source="INTERNAL",
        freshness="RECENT",
    )

    payload = manager._depth_update_payload("MFCUSDT", depth)

    assert payload["type"] == "spot_depth_update"
    assert payload["symbol"] == "MFCUSDT"
    assert payload["depth"]["bids"] == []
    assert payload["depth"]["asks"] == []
    assert payload["depth"]["source"] == "MISSING"
    assert payload["depth"]["freshness"] == "MISSING"
    assert payload["depth"]["stale"] is False


def test_spot_ws_trade_incremental_payload_preserves_identity_and_time_contract() -> None:
    async def run() -> None:
        manager = MarketWsManager()
        sent: list[tuple[str, dict]] = []

        async def capture(symbol: str, payload: dict) -> None:
            sent.append((symbol, payload))

        manager._send_payload = capture
        await manager.send_trade(
            symbol="BTC/USDT",
            id="item-id",
            trade_id="trade-id",
            provider_trade_id="provider-id",
            price="100",
            amount="2",
            side="buy",
            ts=1_000,
            event_time_ms=1_000,
            received_at_ms=2_000,
            time_origin="PROVIDER",
            created_at="1970-01-01T00:00:01",
            provider="OKX_SPOT",
            provider_symbol="BTC-USDT",
            source="LIVE_WS",
            freshness="LIVE",
        )

        assert len(sent) == 1
        symbol, payload = sent[0]
        assert symbol == "BTCUSDT"
        assert payload["type"] == "spot_trade"
        assert payload["trade_id"] == "trade-id"
        assert payload["provider_trade_id"] == "provider-id"
        assert payload["ts"] == 1_000
        assert payload["event_time_ms"] == 1_000
        assert payload["received_at_ms"] == 2_000
        assert payload["time_origin"] == "PROVIDER"
        assert payload["trade"] == {
            "id": "item-id",
            "trade_id": "trade-id",
            "provider_trade_id": "provider-id",
            "price": "100",
            "amount": "2",
            "side": "BUY",
            "ts": 1_000,
            "event_time_ms": 1_000,
            "received_at_ms": 2_000,
            "time_origin": "PROVIDER",
            "created_at": "1970-01-01T00:00:01",
            "provider": "OKX_SPOT",
            "provider_symbol": "BTC-USDT",
            "source": "LIVE_WS",
            "freshness": "LIVE",
        }

    asyncio.run(run())


def test_spot_ws_provider_kline_payload_preserves_revision_and_close_evidence() -> None:
    async def run() -> None:
        manager = MarketWsManager()
        sent: list[tuple[str, dict]] = []

        async def capture(symbol: str, payload: dict) -> None:
            sent.append((symbol, payload))

        manager._send_payload = capture
        await manager.broadcast_provider_kline_update(
            "BTCUSDT",
            "1m",
            {
                "open_time": 2_000,
                "close_time": 62_000,
                "open": "100",
                "high": "110",
                "low": "95",
                "close": "101",
                "volume": "10",
                "quote_volume": "1010",
            },
            source="LIVE_WS",
            updated_at="1970-01-01T00:00:03",
            revision_epoch=2,
            revision_seq=7,
            is_closed=True,
            close_state_source="PROVIDER_CONFIRMED",
        )

        assert len(sent) == 1
        symbol, payload = sent[0]
        assert symbol == "BTCUSDT"
        assert payload["type"] == "spot_kline_update"
        assert payload["symbol"] == "BTCUSDT"
        assert payload["interval"] == "1m"
        assert payload["source"] == "LIVE_WS"
        assert payload["kline"]["open_time"] == 2_000
        assert payload["kline"]["revision_epoch"] == 2
        assert payload["kline"]["revision_seq"] == 7
        assert payload["kline"]["is_closed"] is True
        assert payload["kline"]["close_state_source"] == "PROVIDER_CONFIRMED"
        assert "event_time_ms" not in payload
        assert "event_time_ms" not in payload["kline"]

    asyncio.run(run())


def test_spot_ws_provider_kline_payload_keeps_legacy_call_compatible() -> None:
    async def run() -> None:
        manager = MarketWsManager()
        sent: list[tuple[str, dict]] = []

        async def capture(symbol: str, payload: dict) -> None:
            sent.append((symbol, payload))

        manager._send_payload = capture
        await manager.broadcast_provider_kline_update(
            "BTCUSDT",
            "1m",
            {"open_time": 2_000, "close": "101"},
        )

        kline = sent[0][1]["kline"]
        assert kline == {"open_time": 2_000, "close": "101"}
        assert "revision_epoch" not in kline
        assert "revision_seq" not in kline
        assert "is_closed" not in kline
        assert "close_state_source" not in kline

    asyncio.run(run())


def test_spot_ws_trade_incremental_keeps_explicit_untimed_and_zero_values() -> None:
    async def run() -> None:
        manager = MarketWsManager()
        sent: list[dict] = []

        async def capture(_symbol: str, payload: dict) -> None:
            sent.append(payload)

        manager._send_payload = capture
        await manager.send_trade(
            symbol="BTCUSDT",
            id=0,
            trade_id=0,
            provider_trade_id=0,
            price="100",
            amount="1",
            side="sell",
            ts=9_999,
            event_time_ms=None,
            received_at_ms=0,
            time_origin="PROVIDER",
            created_at=None,
            provider="BITGET_SPOT",
            provider_symbol="BTCUSDT",
            source="LIVE_WS",
            freshness="LIVE",
        )

        payload = sent[0]
        assert payload["trade_id"] == 0
        assert payload["provider_trade_id"] == 0
        assert payload["event_time_ms"] is None
        assert payload["received_at_ms"] == 0
        assert payload["trade"]["id"] == 0
        assert payload["trade"]["trade_id"] == 0
        assert payload["trade"]["provider_trade_id"] == 0
        assert payload["trade"]["event_time_ms"] is None
        assert payload["trade"]["received_at_ms"] == 0
        assert payload["trade"]["created_at"] is None

    asyncio.run(run())


def test_spot_ws_trade_incremental_accepts_legacy_send_trade_signature() -> None:
    async def run() -> None:
        manager = MarketWsManager()
        sent: list[dict] = []

        async def capture(_symbol: str, payload: dict) -> None:
            sent.append(payload)

        manager._send_payload = capture
        await manager.send_trade(
            symbol="MFCUSDT",
            price="10.5",
            amount="2",
            side="buy",
            ts=1_234,
            trade_id=77,
        )

        payload = sent[0]
        assert payload["type"] == "spot_trade"
        assert payload["symbol"] == "MFCUSDT"
        assert payload["trade_id"] == 77
        assert payload["provider_trade_id"] == 77
        assert payload["ts"] == 1_234
        assert payload["trade"]["id"] == 77
        assert payload["trade"]["trade_id"] == 77
        assert payload["trade"]["provider_trade_id"] == 77
        assert payload["trade"]["price"] == "10.5"
        assert payload["trade"]["amount"] == "2"
        assert payload["trade"]["side"] == "BUY"
        assert payload["trade"]["ts"] == 1_234

    asyncio.run(run())


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASSED {name}")
