from __future__ import annotations

import asyncio

from app.schemas.market import DepthItem, DepthResponse, TradeItem, TradesResponse
from app.services import market
from app.services.spot_market_gateway import SpotMarketGateway


class FakeWsManager:
    def __init__(self) -> None:
        self.count = 0
        self.broadcasts: list[tuple[str, DepthResponse]] = []
        self.ticker_broadcasts: list[tuple[str, dict]] = []
        self.trade_broadcasts: list[dict] = []
        self.kline_broadcasts: list[dict] = []
        self.kline_call_count = 0
        self.intervals = ["1m"]

    async def subscriber_count(self, symbol: str) -> int:
        return self.count

    async def broadcast_depth_update(self, symbol: str, depth: DepthResponse) -> None:
        self.broadcasts.append((symbol, depth))

    async def broadcast_ticker_update(self, symbol: str, ticker: dict) -> None:
        self.ticker_broadcasts.append((symbol, ticker))

    async def send_trade(self, **kwargs) -> None:
        self.trade_broadcasts.append(kwargs)

    async def send_kline_update(self, **kwargs) -> None:
        raise AssertionError("send_kline_update must not be called for provider kline")

    async def broadcast_provider_kline_update(self, symbol: str, interval: str, kline: dict, **kwargs) -> None:
        self.kline_broadcasts.append({"symbol": symbol, "interval": interval, "kline": kline, **kwargs})

    async def kline_intervals(self, symbol: str) -> list[str]:
        self.kline_call_count += 1
        return list(self.intervals)


class FakeProvider:
    def __init__(self) -> None:
        self.ensured: list[str] = []
        self.released: list[str] = []
        self.depth = DepthResponse(
            symbol="BTCUSDT",
            bids=[DepthItem(price="2", amount="1")],
            asks=[DepthItem(price="3", amount="1")],
            ts=1000,
            provider="BITGET_SPOT",
            source="LIVE_WS",
            fetched_at=1000,
        )

    def ensure(self, symbol: str) -> None:
        self.ensured.append(symbol)

    def release(self, symbol: str) -> None:
        self.released.append(symbol)

    def get_depth(self, symbol: str, **kwargs) -> DepthResponse:
        return self.depth

    def get_ticker(self, symbol: str, **kwargs) -> dict:
        return {
            "symbol": "BTCUSDT",
            "last_price": "2",
            "open_24h": "1",
            "price_change_24h": "1",
            "price_change_percent": "100",
            "high_24h": "3",
            "low_24h": "1",
            "base_volume_24h": "10",
            "quote_volume_24h": "20",
            "source": "LIVE_WS",
            "provider": "BITGET_SPOT",
            "quote_freshness": "LIVE",
            "ts": 1000,
        }

    def get_trades(self, symbol: str, **kwargs) -> TradesResponse:
        return TradesResponse(
            symbol="BTCUSDT",
            provider="BITGET_SPOT",
            source="LIVE_WS",
            freshness="LIVE",
            trades=[
                TradeItem(
                    id="trade-1",
                    price="2.1234",
                    amount="1.2345",
                    side="BUY",
                    ts=1000,
                )
            ],
        )

    def get_klines(self, symbol: str, interval: str, **kwargs) -> dict:
        return {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "provider": "BITGET_SPOT",
            "source": "LIVE_WS",
            "freshness": "LIVE",
            "items": [
                {
                    "open_time": 1000,
                    "close_time": 61000,
                    "open": "2",
                    "high": "3",
                    "low": "1",
                    "close": "2.5",
                    "volume": "10",
                    "quote_volume": "25",
                }
            ],
        }


def _new_test_gateway() -> SpotMarketGateway:
    ws_manager = FakeWsManager()
    provider = FakeProvider()
    return SpotMarketGateway(
        ensure_depth=provider.ensure,
        ensure_kline=lambda symbol, interval: None,
        release_depth=provider.release,
        get_depth=provider.get_depth,
        get_ticker=provider.get_ticker,
        get_trades=provider.get_trades,
        get_klines=provider.get_klines,
        provider_symbol_allowed=lambda symbol: True,
        precision_resolver=lambda symbol: (2, 3),
        ws_manager=ws_manager,
    )


def _age_broadcast_state(gateway: SpotMarketGateway, domain_key, signature=None) -> None:
    gateway._broadcast_state.remember_broadcast(
        domain_key,
        signature,
        now_ms=gateway._broadcast_state.now_ms() - 10_000,
    )


def _depth_response(*, bid_amount: str = "1", ts: int = 1000) -> DepthResponse:
    return DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="2", amount=bid_amount)],
        asks=[DepthItem(price="3", amount="1")],
        ts=ts,
        provider="BITGET_SPOT",
        source="LIVE_WS",
        fetched_at=ts,
    )


def _ticker_payload(**overrides) -> dict:
    payload = {
        "symbol": "BTCUSDT",
        "last_price": "2",
        "open_24h": "1",
        "price_change_24h": "1",
        "price_change_percent": "100",
        "high_24h": "3",
        "low_24h": "1",
        "base_volume_24h": "10",
        "quote_volume_24h": "20",
        "source": "LIVE_WS",
        "provider": "BITGET_SPOT",
        "quote_freshness": "LIVE",
        "ts": 1000,
    }
    payload.update(overrides)
    return payload


def _trade_item(
    trade_id: str | None,
    *,
    price: str = "2",
    amount: str = "1",
    side: str = "BUY",
    ts: int = 1000,
) -> TradeItem:
    return TradeItem(id=trade_id, price=price, amount=amount, side=side, ts=ts)


def _trades_response(items: list[TradeItem]) -> TradesResponse:
    return TradesResponse(
        symbol="BTCUSDT",
        provider="BITGET_SPOT",
        source="LIVE_WS",
        freshness="LIVE",
        trades=items,
    )


def _kline_payload(**overrides) -> dict:
    payload = {
        "open_time": 1000,
        "close_time": 61000,
        "open": "2",
        "high": "3",
        "low": "1",
        "close": "2.5",
        "volume": "10",
        "quote_volume": "25",
        "provider": "BITGET_SPOT",
    }
    payload.update(overrides)
    return payload


def test_gateway_depth_broadcast_state_dedupes_and_isolates_symbols() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        depth = _depth_response()

        assert gateway._should_broadcast_depth("BTCUSDT", depth) is True
        assert gateway._should_broadcast_depth("BTCUSDT", depth) is False

        key = gateway._domain_key("depth", "BTCUSDT", provider="BITGET_SPOT")
        _age_broadcast_state(gateway, key, gateway._depth_signature(depth))
        assert gateway._should_broadcast_depth("BTCUSDT", depth) is False

        changed_depth = _depth_response(bid_amount="2")
        _age_broadcast_state(gateway, key)
        assert gateway._should_broadcast_depth("BTCUSDT", changed_depth) is True

        assert gateway._should_broadcast_depth("ETHUSDT", depth) is True

    asyncio.run(run())


def test_gateway_ticker_broadcast_state_dedupes_and_detects_24h_changes() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        ticker = _ticker_payload()

        assert gateway._should_broadcast_ticker("BTCUSDT", ticker) is True
        assert gateway._should_broadcast_ticker("BTCUSDT", ticker) is False

        key = gateway._domain_key("ticker", "BTCUSDT", provider="BITGET_SPOT")
        _age_broadcast_state(gateway, key, gateway._ticker_signature(ticker))
        assert gateway._should_broadcast_ticker("BTCUSDT", ticker) is False

        changed_ticker = _ticker_payload(high_24h="4")
        _age_broadcast_state(gateway, key)
        assert gateway._should_broadcast_ticker("BTCUSDT", changed_ticker) is True

    asyncio.run(run())


def test_gateway_trade_broadcast_state_dedupes_ids_and_preserves_new_trade_order() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        trades = _trades_response(
            [
                _trade_item("trade-2", ts=2000),
                _trade_item("trade-1", ts=1000),
            ]
        )

        first_batch = gateway._new_trades_for_broadcast("BTCUSDT", trades)
        assert [trade.id for trade in first_batch] == ["trade-1", "trade-2"]

        key = gateway._domain_key("trades", "BTCUSDT", provider="BITGET_SPOT")
        _age_broadcast_state(gateway, key)
        assert gateway._new_trades_for_broadcast("BTCUSDT", trades) == []

        next_trades = _trades_response(
            [
                _trade_item("trade-4", ts=4000),
                _trade_item("trade-3", ts=3000),
                _trade_item("trade-2", ts=2000),
            ]
        )
        _age_broadcast_state(gateway, key)
        next_batch = gateway._new_trades_for_broadcast("BTCUSDT", next_trades)
        assert [trade.id for trade in next_batch] == ["trade-3", "trade-4"]

    asyncio.run(run())


def test_gateway_trade_broadcast_state_uses_fallback_signature_without_trade_id() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        trade = _trade_item(None, price="2", amount="1", side="BUY", ts=1000)
        trades = _trades_response([trade])

        first_batch = gateway._new_trades_for_broadcast("BTCUSDT", trades)
        assert len(first_batch) == 1
        assert first_batch[0].id is None

        key = gateway._domain_key("trades", "BTCUSDT", provider="BITGET_SPOT")
        _age_broadcast_state(gateway, key)
        assert gateway._new_trades_for_broadcast("BTCUSDT", trades) == []

        changed_trade = _trade_item(None, price="2", amount="1", side="BUY", ts=1001)
        _age_broadcast_state(gateway, key)
        changed_batch = gateway._new_trades_for_broadcast("BTCUSDT", _trades_response([changed_trade]))
        assert len(changed_batch) == 1
        assert changed_batch[0].ts == 1001

    asyncio.run(run())


def test_gateway_kline_broadcast_state_dedupes_detects_ohlcv_changes_and_isolates_intervals() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        kline = _kline_payload()

        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is True
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is False

        key = gateway._domain_key("kline", "BTCUSDT", provider="BITGET_SPOT", interval="1m")
        assert gateway._kline_broadcast_interval_ms() == 500
        fixed_now = 1_000_000
        gateway._broadcast_state.now_ms = lambda: fixed_now
        changed_close = _kline_payload(close="2.6")
        gateway._broadcast_state.remember_broadcast(
            key,
            gateway._kline_signature("BTCUSDT", "1m", kline),
            now_ms=fixed_now - 400,
        )
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", changed_close, provider="BITGET_SPOT") is False
        gateway._broadcast_state.remember_broadcast(
            key,
            gateway._kline_signature("BTCUSDT", "1m", kline),
            now_ms=fixed_now - 500,
        )
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", changed_close, provider="BITGET_SPOT") is True

        _age_broadcast_state(gateway, key, gateway._kline_signature("BTCUSDT", "1m", kline))
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is False

        for field, value in (
            ("close", "2.6"),
            ("volume", "11"),
            ("high", "3.5"),
            ("low", "0.9"),
            ("quote_volume", "26"),
        ):
            _age_broadcast_state(gateway, key)
            assert gateway._should_broadcast_kline(
                "BTCUSDT",
                "1m",
                _kline_payload(**{field: value}),
                provider="BITGET_SPOT",
            ) is True

        other_interval_gateway = _new_test_gateway()
        assert other_interval_gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is True
        assert other_interval_gateway._should_broadcast_kline("BTCUSDT", "5m", kline, provider="BITGET_SPOT") is True

    asyncio.run(run())


def test_gateway_sync_kline_intervals_releases_inactive_and_ensures_new_interval() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        ensured_klines: list[tuple[str, str]] = []
        released_klines: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            release_depth=provider.release,
            ensure_kline=lambda symbol, interval: ensured_klines.append((symbol, interval)),
            release_kline=lambda symbol, interval: released_klines.append((symbol, interval)),
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        gateway._ensured_kline_intervals["BTCUSDT"] = {"1m"}
        kline = _kline_payload()
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is True
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is False

        ready = await gateway._sync_kline_intervals("BTCUSDT", ["5m"])

        assert ready == ["5m"]
        assert released_klines == [("BTCUSDT", "1m")]
        assert ("BTCUSDT", "5m") in ensured_klines
        assert gateway._ensured_kline_intervals["BTCUSDT"] == {"5m"}
        assert provider.released == []
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is True

    asyncio.run(run())


def test_gateway_sync_kline_intervals_keeps_simultaneous_active_intervals() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        ensured_klines: list[tuple[str, str]] = []
        released_klines: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            release_depth=provider.release,
            ensure_kline=lambda symbol, interval: ensured_klines.append((symbol, interval)),
            release_kline=lambda symbol, interval: released_klines.append((symbol, interval)),
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        gateway._ensured_kline_intervals["BTCUSDT"] = {"1m", "5m"}
        ready = await gateway._sync_kline_intervals("BTCUSDT", ["1m", "5m"])

        assert ready == ["1m", "5m"]
        assert released_klines == []
        assert ("BTCUSDT", "1m") in ensured_klines
        assert ("BTCUSDT", "5m") in ensured_klines
        assert gateway._ensured_kline_intervals["BTCUSDT"] == {"1m", "5m"}
        assert provider.released == []

    asyncio.run(run())


def test_gateway_sync_kline_intervals_does_not_affect_other_symbols() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        ensured_klines: list[tuple[str, str]] = []
        released_klines: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            release_depth=provider.release,
            ensure_kline=lambda symbol, interval: ensured_klines.append((symbol, interval)),
            release_kline=lambda symbol, interval: released_klines.append((symbol, interval)),
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        gateway._ensured_kline_intervals["BTCUSDT"] = {"1m"}
        gateway._ensured_kline_intervals["ETHUSDT"] = {"1m"}

        await gateway._sync_kline_intervals("BTCUSDT", ["5m"])

        assert released_klines == [("BTCUSDT", "1m")]
        assert ("BTCUSDT", "5m") in ensured_klines
        assert gateway._ensured_kline_intervals["BTCUSDT"] == {"5m"}
        assert gateway._ensured_kline_intervals["ETHUSDT"] == {"1m"}
        assert provider.released == []

    asyncio.run(run())


def test_gateway_idle_release_clears_tracked_kline_intervals_without_per_interval_release() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            ensure_kline=lambda symbol, interval: None,
            release_depth=provider.release,
            release_kline=lambda symbol, interval: (_ for _ in ()).throw(
                AssertionError("symbol idle release should use provider symbol release")
            ),
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("BTC/USDT", interval="1m")
        await asyncio.sleep(0.01)
        assert gateway._ensured_kline_intervals.get("BTCUSDT") == {"1m"}

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("BTCUSDT", idle_delay_seconds=0)
        await asyncio.sleep(0.05)

        assert provider.released == ["BTCUSDT"]
        assert "BTCUSDT" not in gateway._ensured_kline_intervals

    asyncio.run(run())


def test_gateway_subscriber_count_and_idle_release() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            ensure_kline=lambda symbol, interval: None,
            release_depth=provider.release,
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("BTC/USDT")
        await asyncio.sleep(0.01)
        assert provider.ensured == ["BTCUSDT"]
        assert ws_manager.broadcasts
        _symbol, depth = ws_manager.broadcasts[-1]
        assert depth.price_precision == 2
        assert depth.amount_precision == 3
        assert depth.bids[0].price == "2.00"
        assert depth.bids[0].amount == "1.000"

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("btcusdt", idle_delay_seconds=0)
        await asyncio.sleep(0.05)
        assert provider.released == ["BTCUSDT"]

    asyncio.run(run())


def test_gateway_broadcasts_ticker_by_default() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            ensure_kline=lambda symbol, interval: None,
            release_depth=provider.release,
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("BTC/USDT")
        await asyncio.sleep(0.01)
        assert provider.ensured == ["BTCUSDT"]
        assert ws_manager.ticker_broadcasts
        _symbol, ticker = ws_manager.ticker_broadcasts[-1]
        assert ticker["symbol"] == "BTCUSDT"
        assert ticker["source"] == "LIVE_WS"
        assert ticker["price_precision"] == 2
        assert ticker["amount_precision"] == 3

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("btcusdt", idle_delay_seconds=0)
        await asyncio.sleep(0.05)
        assert provider.released == ["BTCUSDT"]

    asyncio.run(run())


def test_gateway_broadcasts_provider_trade_once() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            ensure_kline=lambda symbol, interval: None,
            release_depth=provider.release,
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("BTC/USDT")
        await asyncio.sleep(0.03)
        assert provider.ensured == ["BTCUSDT"]
        assert len(ws_manager.trade_broadcasts) == 1
        assert ws_manager.trade_broadcasts[0]["symbol"] == "BTCUSDT"
        assert ws_manager.trade_broadcasts[0]["trade_id"] == "trade-1"
        assert ws_manager.trade_broadcasts[0]["price"] == "2.1234"

        await asyncio.sleep(0.25)
        assert len(ws_manager.trade_broadcasts) == 1

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("btcusdt", idle_delay_seconds=0)
        await asyncio.sleep(0.05)
        assert provider.released == ["BTCUSDT"]

    asyncio.run(run())


def test_gateway_broadcasts_provider_kline_once_without_trade_aggregation() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        ensured_klines: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            release_depth=provider.release,
            ensure_kline=lambda symbol, interval: ensured_klines.append((symbol, interval)),
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("BTC/USDT", interval="1m")
        await asyncio.sleep(0.05)
        assert provider.ensured == ["BTCUSDT"]
        assert ("BTCUSDT", "1m") in ensured_klines
        assert len(ws_manager.kline_broadcasts) == 1
        assert ws_manager.kline_broadcasts[0]["symbol"] == "BTCUSDT"
        assert ws_manager.kline_broadcasts[0]["interval"] == "1m"
        assert ws_manager.kline_broadcasts[0]["source"] == "LIVE_WS"
        assert ws_manager.kline_broadcasts[0]["kline"]["close"] == "2.5"

        await asyncio.sleep(1.1)
        assert len(ws_manager.kline_broadcasts) == 1

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("btcusdt", idle_delay_seconds=0)
        await asyncio.sleep(0.05)
        assert provider.released == ["BTCUSDT"]

    asyncio.run(run())


def test_gateway_broadcasts_trades_driven_provider_kline() -> None:
    class TradesDrivenProvider(FakeProvider):
        def get_klines(self, symbol: str, interval: str, **kwargs) -> dict:
            return {
                "symbol": "BTCUSDT",
                "interval": "1m",
                "provider": "BITGET_SPOT",
                "source": "LIVE_WS",
                "freshness": "LIVE",
                "items": [
                    {
                        "open_time": 1000,
                        "close_time": 61000,
                        "open": "100",
                        "high": "121",
                        "low": "95",
                        "close": "120",
                        "volume": "10",
                        "quote_volume": "1000",
                    }
                ],
            }

    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = TradesDrivenProvider()
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            ensure_kline=lambda symbol, interval: None,
            release_depth=provider.release,
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("BTC/USDT", interval="1m")
        await asyncio.sleep(0.05)

        assert len(ws_manager.kline_broadcasts) == 1
        assert ws_manager.kline_broadcasts[0]["symbol"] == "BTCUSDT"
        assert ws_manager.kline_broadcasts[0]["interval"] == "1m"
        assert ws_manager.kline_broadcasts[0]["source"] == "LIVE_WS"
        assert ws_manager.kline_broadcasts[0]["kline"]["close"] == "120"

    asyncio.run(run())


def test_gateway_does_not_ensure_provider_ws_for_internal_symbol() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            ensure_kline=lambda symbol, interval: (_ for _ in ()).throw(
                AssertionError("internal symbol must not ensure provider kline")
            ),
            release_depth=provider.release,
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: False,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("MFCUSDT")
        await asyncio.sleep(0.02)
        assert provider.ensured == []
        assert ws_manager.broadcasts == []
        assert ws_manager.ticker_broadcasts == []
        assert ws_manager.trade_broadcasts == []
        assert ws_manager.kline_broadcasts == []

    asyncio.run(run())


def test_get_depth_prefers_live_ws_and_falls_back_to_rest() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    live_depth = DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="2.12345678", amount="1.23456")],
        asks=[DepthItem(price="3.12345678", amount="1.23456")],
        ts=1000,
        provider="BITGET_SPOT",
        source="LIVE_WS",
    )
    rest_depth = DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="1", amount="1")],
        asks=[DepthItem(price="4", amount="1")],
        ts=2000,
        provider="BITGET_SPOT",
        source="external",
    )

    original_get_active_pair = market._get_active_pair
    original_get_ws_depth = market.get_spot_provider_ws_depth
    original_get_external_depth = market._get_external_spot_depth
    fallback_called = {"value": False}

    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market.get_spot_provider_ws_depth = lambda symbol, **kwargs: live_depth
        market._get_external_spot_depth = lambda *args, **kwargs: rest_depth
        live_result = market.get_depth(None, "BTCUSDT")
        assert live_result.source == "LIVE_WS"
        assert live_result.price_precision == 2
        assert live_result.amount_precision == 3
        assert live_result.bids[0].price == "2.12"
        assert live_result.bids[0].amount == "1.235"

        market.get_spot_provider_ws_depth = lambda symbol, **kwargs: None

        def fallback(*args, **kwargs):
            fallback_called["value"] = True
            return rest_depth

        market._get_external_spot_depth = fallback
        result = market.get_depth(None, "BTCUSDT")
        assert fallback_called["value"] is True
        assert result.source == "external"
    finally:
        market._get_active_pair = original_get_active_pair
        market.get_spot_provider_ws_depth = original_get_ws_depth
        market._get_external_spot_depth = original_get_external_depth


def test_external_spot_ticker_prefers_live_ws() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    original_get_ws_ticker = market.get_spot_provider_ws_ticker
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    try:
        market.get_spot_provider_ws_ticker = lambda symbol, **kwargs: {
            "symbol": "BTCUSDT",
            "provider": "BITGET_SPOT",
            "source": "LIVE_WS",
            "last_price": "2.123",
            "open_24h": "2",
            "price_change_24h": "0.123",
            "price_change_percent": "6.15",
            "high_24h": "3",
            "low_24h": "1",
            "base_volume_24h": "10.12345",
            "quote_volume_24h": "21.5",
            "updated_at": "2026-07-04T00:00:00",
        }
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("REST provider should not be called")
        )
        ticker = market._get_external_spot_ticker(None, Pair())
        assert ticker is not None
        assert ticker.source == "LIVE_WS"
        assert ticker.provider == "BITGET_SPOT"
        assert ticker.last_price == "2.12"
        assert ticker.base_volume_24h == "10.123"
    finally:
        market.get_spot_provider_ws_ticker = original_get_ws_ticker
        market._enabled_spot_market_providers_for_pair = original_enabled_providers


def test_bitget_rest_ticker_uses_provider_change24h_ratio() -> None:
    class Pair:
        symbol = "BTCUSDT"
        price_precision = 2
        amount_precision = 3

    ticker = market._spot_ticker_from_provider(
        pair=Pair(),
        provider_code=market.PROVIDER_BITGET_SPOT,
        payload={
            "data": [
                {
                    "lastPr": "99",
                    "open": "100",
                    "openUtc": "120",
                    "change24h": "-0.01",
                    "high24h": "105",
                    "low24h": "95",
                    "baseVolume": "10",
                    "quoteVolume": "1000",
                    "ts": "1000",
                }
            ]
        },
    )

    assert ticker.open_24h == "100.00"
    assert ticker.price_change_24h == "-1.00"
    assert ticker.price_change_percent == "-1.00"


def test_get_trades_prefers_live_ws_and_falls_back_to_rest() -> None:
    class Pair:
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

        def __init__(self, symbol: str = "BTCUSDT") -> None:
            self.symbol = symbol

    provider = market.MarketDataProviderConfig(
        provider_code=market.PROVIDER_BITGET_SPOT,
        provider_name="Bitget Spot",
        market_type="SPOT",
        enabled=True,
        priority=1,
        base_url="https://example.invalid",
        timeout_ms=1000,
        cooldown_seconds=0,
    )
    def live_trades_for(symbol: str) -> TradesResponse:
        return TradesResponse(
            symbol=symbol,
            provider="BITGET_SPOT",
            source="LIVE_WS",
            freshness="LIVE",
            trades=[
                TradeItem(id=f"{symbol}-live-1", price="2.123", amount="1.2345", side="BUY", ts=1000),
            ],
        )

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_trades = market.get_spot_provider_ws_trades
    original_spot_provider_symbol = market._spot_provider_symbol
    original_request_json = market.request_contract_market_provider_json
    original_mark_success = market.mark_contract_market_provider_success
    try:
        market._get_active_pair = lambda db, symbol: Pair(symbol)
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_trades = lambda symbol, **kwargs: live_trades_for(symbol)
        market.request_contract_market_provider_json = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("REST provider should not be called when LIVE_WS trades are fresh")
        )

        for symbol in ("BTCUSDT", "ETHUSDT"):
            result = market.get_trades(None, symbol, limit=30)
            assert result.symbol == symbol
            assert result.source == "LIVE_WS"
            assert result.freshness == "LIVE"
            assert result.provider == "BITGET_SPOT"
            assert result.trades[0].id == f"{symbol}-live-1"
            assert result.trades[0].price == "2.12"
            assert result.trades[0].amount == "1.234"

        market.get_spot_provider_ws_trades = lambda symbol, **kwargs: None
        market._spot_provider_symbol = lambda *args, **kwargs: "BTCUSDT"
        market.mark_contract_market_provider_success = lambda *args, **kwargs: None
        market.request_contract_market_provider_json = lambda *args, **kwargs: {
            "data": [
                {
                    "price": "3.456",
                    "size": "2.3456",
                    "side": "sell",
                    "ts": "2000",
                }
            ]
        }

        fallback = market.get_trades(None, "BTCUSDT", limit=30)
        assert fallback.provider == "BITGET_SPOT"
        assert fallback.source is None
        assert fallback.trades[0].price == "3.46"
        assert fallback.trades[0].amount == "2.346"
        assert fallback.trades[0].side == "SELL"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_trades = original_get_ws_trades
        market._spot_provider_symbol = original_spot_provider_symbol
        market.request_contract_market_provider_json = original_request_json
        market.mark_contract_market_provider_success = original_mark_success


def test_internal_pair_does_not_use_live_ws_trades() -> None:
    class Pair:
        symbol = "MFCUSDT"
        data_source = market.DATA_SOURCE_INTERNAL
        price_precision = 2
        amount_precision = 3

    internal_trades = TradesResponse(
        symbol="MFCUSDT",
        trades=[TradeItem(price="1.00", amount="1.000", side="BUY", ts=1000)],
    )

    original_get_active_pair = market._get_active_pair
    original_get_ws_trades = market.get_spot_provider_ws_trades
    original_get_internal_trades = market._get_internal_trades
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market.get_spot_provider_ws_trades = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("internal pair must not read Bitget LIVE_WS trades")
        )
        market._get_internal_trades = lambda *args, **kwargs: internal_trades

        result = market.get_trades(None, "MFCUSDT", limit=30)
        assert result.symbol == "MFCUSDT"
        assert result.source is None
        assert result.trades[0].price == "1.00"
    finally:
        market._get_active_pair = original_get_active_pair
        market.get_spot_provider_ws_trades = original_get_ws_trades
        market._get_internal_trades = original_get_internal_trades


def test_get_klines_prefers_live_ws_and_falls_back_to_rest() -> None:
    class Pair:
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

        def __init__(self, symbol: str = "BTCUSDT") -> None:
            self.symbol = symbol

    provider = market.MarketDataProviderConfig(
        provider_code=market.PROVIDER_BITGET_SPOT,
        provider_name="Bitget Spot",
        market_type="SPOT",
        enabled=True,
        priority=1,
        base_url="https://example.invalid",
        timeout_ms=1000,
        cooldown_seconds=0,
    )

    def live_klines_for(symbol: str) -> dict:
        return {
            "symbol": symbol,
            "interval": "1m",
            "provider": "BITGET_SPOT",
            "source": "LIVE_WS",
            "freshness": "LIVE",
            "updated_at": "2026-07-04T00:00:00",
            "items": [
                {
                    "open_time": 120000,
                    "close_time": 180000,
                    "open": "2",
                    "high": "3",
                    "low": "1",
                    "close": "2.5",
                    "volume": "10",
                    "quote_volume": "25",
                }
            ],
        }

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    original_fetch_external = market._fetch_external_spot_klines
    try:
        market._get_active_pair = lambda db, symbol: Pair(symbol)
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda symbol, interval, **kwargs: live_klines_for(symbol)
        market.get_klines_cache_first = lambda *args, **kwargs: [
            {
                "open_time": 60000,
                "close_time": 120000,
                "open": "1",
                "high": "2",
                "low": "1",
                "close": "1.5",
                "volume": "5",
                "quote_volume": "7.5",
            }
        ]
        market._fetch_external_spot_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("direct REST fetch should not be called in get_klines test")
        )

        for symbol in ("BTCUSDT", "ETHUSDT"):
            result = market.get_klines(None, symbol, "1m", limit=30)
            assert result["symbol"] == symbol
            assert result["source"] == "LIVE_WS"
            assert result["freshness"] == "LIVE"
            assert result["provider"] == "BITGET_SPOT"
            assert result["items"][-1]["open_time"] == 120000
            assert result["items"][-1]["close"] == "2.5"

        market.get_spot_provider_ws_klines = lambda symbol, interval, **kwargs: None
        fallback = market.get_klines(None, "BTCUSDT", "1m", limit=30)
        assert fallback.get("source") is None
        assert fallback["provider"] == "EXTERNAL_SPOT"
        assert fallback["items"][-1]["close"] == "1.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first
        market._fetch_external_spot_klines = original_fetch_external


def test_internal_pair_does_not_use_live_ws_klines() -> None:
    class Pair:
        symbol = "MFCUSDT"
        data_source = market.DATA_SOURCE_INTERNAL
        price_precision = 2
        amount_precision = 3

    internal_payload = {
        "symbol": "MFCUSDT",
        "interval": "1m",
        "items": [
            {
                "open_time": 1000,
                "close_time": 61000,
                "open": "1",
                "high": "1",
                "low": "1",
                "close": "1",
                "volume": "0",
                "quote_volume": "0",
            }
        ],
    }

    original_get_active_pair = market._get_active_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_internal_klines = market._get_internal_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("internal pair must not read Bitget LIVE_WS klines")
        )
        market._get_internal_klines = lambda *args, **kwargs: internal_payload
        market.get_klines_cache_first = lambda *args, **kwargs: kwargs["fetch_external"](
            kwargs["limit"],
            kwargs.get("end_time_ms"),
        )

        result = market.get_klines(None, "MFCUSDT", "1m", limit=30)
        assert result["symbol"] == "MFCUSDT"
        assert result["items"][0]["close"] == "1"
    finally:
        market._get_active_pair = original_get_active_pair
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market._get_internal_klines = original_get_internal_klines
        market.get_klines_cache_first = original_get_klines_cache_first


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_market_gateway tests passed")
