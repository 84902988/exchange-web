from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from unittest.mock import patch

from app.routers import market as market_router
from app.schemas.market import DepthItem, DepthResponse, TradeItem, TradesResponse
from app.services import market
from app.services import market_kline_cache
from app.services import spot_market_gateway as gateway_module
from app.services.spot_candle_preview import SpotCandlePreview, SpotPreviewTradeStatus
from app.services.spot_market_gateway import SpotMarketGateway
from app.services.spot_kline_bucket import spot_kline_bucket_start_ms
from app.services.spot_kline_events import ProviderKlineRevisionAccepted


def _ms(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp() * 1000)


class FakeWsManager:
    def __init__(self) -> None:
        self.count = 0
        self.broadcasts: list[tuple[str, DepthResponse]] = []
        self.ticker_broadcasts: list[tuple[str, dict]] = []
        self.trade_broadcasts: list[dict] = []
        self.preview_broadcasts: list[dict] = []
        self.event_order: list[tuple[str, str]] = []
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
        self.event_order.append(("trade", str(kwargs.get("trade_id") or kwargs.get("id"))))

    async def broadcast_spot_candle_preview_update(
        self,
        symbol: str,
        interval: str,
        preview: SpotCandlePreview,
        **kwargs,
    ) -> None:
        self.preview_broadcasts.append(
            {"symbol": symbol, "interval": interval, "preview": preview, **kwargs}
        )
        self.event_order.append(("preview", format(preview.close, "f")))

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
            provider_symbol="BTCUSDT",
            source="LIVE_WS",
            freshness="LIVE",
            updated_at_ms=9_000,
            received_at_ms=8_000,
            trades=[
                TradeItem(
                    id="trade-1",
                    trade_id="trade-1",
                    provider_trade_id="provider-trade-1",
                    price="2.1234",
                    amount="1.2345",
                    side="BUY",
                    ts=1000,
                    event_time_ms=1000,
                    received_at_ms=2_345,
                    time_origin="PROVIDER",
                    created_at="1970-01-01T00:00:01",
                    provider="BITGET_SPOT",
                    provider_symbol="BTCUSDT",
                    source="LIVE_WS",
                    freshness="LIVE",
                    updated_at_ms=5_678,
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


def _new_authority_test_gateway() -> SpotMarketGateway:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
    return _new_test_gateway()


def _age_broadcast_state(gateway: SpotMarketGateway, domain_key, signature=None) -> None:
    gateway._broadcast_state.remember_broadcast(
        domain_key,
        signature,
        now_ms=gateway._broadcast_state.now_ms() - 10_000,
    )


def _depth_response(*, bid_amount: str = "1", ts: int = 1000, provider: str = "BITGET_SPOT") -> DepthResponse:
    return DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="2", amount=bid_amount)],
        asks=[DepthItem(price="3", amount="1")],
        ts=ts,
        provider=provider,
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
    item_id: str | None,
    *,
    price: str = "2",
    amount: str = "1",
    side: str = "BUY",
    ts: int = 1000,
    **overrides,
) -> TradeItem:
    payload = {"id": item_id, "price": price, "amount": amount, "side": side, "ts": ts}
    payload.update(overrides)
    return TradeItem(**payload)


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


def _accepted_kline_event(
    gateway: SpotMarketGateway,
    kline: dict,
    *,
    generation: int = 1,
    provider: str = "BITGET_SPOT",
    symbol: str = "BTCUSDT",
    interval: str = "1m",
) -> ProviderKlineRevisionAccepted:
    return ProviderKlineRevisionAccepted(
        provider=provider,
        symbol=symbol,
        interval=interval,
        open_time=int(kline["open_time"]),
        revision_epoch=int(kline["revision_epoch"]),
        revision_seq=int(kline["revision_seq"]),
        generation=generation,
        signature=gateway._kline_signature(symbol, interval, kline),
        accepted_at_ms=10_000,
        is_closed=kline.get("is_closed"),
    )


def _new_event_kline_gateway(
    items: list[dict],
    *,
    generation: int = 1,
) -> tuple[SpotMarketGateway, FakeWsManager]:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
    ws_manager = FakeWsManager()
    provider = FakeProvider()

    def get_kline_revisions(symbol: str, interval: str, **kwargs) -> dict:
        return {
            "symbol": symbol,
            "interval": interval,
            "provider": "BITGET_SPOT",
            "provider_symbol": symbol,
            "source": "LIVE_WS",
            "freshness": "LIVE",
            "updated_at_ms": 10_000,
            "items": list(items),
        }

    gateway = SpotMarketGateway(
        ensure_depth=provider.ensure,
        ensure_kline=lambda symbol, interval: None,
        release_depth=provider.release,
        get_depth=provider.get_depth,
        get_ticker=provider.get_ticker,
        get_trades=provider.get_trades,
        get_kline_revisions=get_kline_revisions,
        get_kline_generation=lambda symbol, interval: generation,
        provider_symbol_allowed=lambda symbol: True,
        precision_resolver=lambda symbol: (2, 3),
        ws_manager=ws_manager,
    )
    gateway._symbol_providers["BTCUSDT"] = "BITGET_SPOT"
    gateway._ensured_kline_intervals["BTCUSDT"] = {"1m"}
    return gateway, ws_manager


def _spot_provider(code: str, *, priority: int = 1, enabled: bool = True):
    return market.MarketDataProviderConfig(
        provider_code=code,
        provider_name=code,
        market_type="SPOT",
        enabled=enabled,
        priority=priority,
        base_url="https://example.invalid",
        timeout_ms=1000,
        cooldown_seconds=0,
    )


def _kline_cache_result(
    items: list[dict],
    *,
    origin: str = market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE,
    cache_status: str = market_kline_cache.KLINE_CACHE_STATUS_HIT,
    history_incomplete: bool = False,
    provider_error_code: str | None = None,
    provider_error_provider: str | None = None,
) -> market_kline_cache.KlineCacheResult:
    return market_kline_cache.KlineCacheResult(
        items,
        origin=origin,
        cache_status=cache_status,
        history_incomplete=history_incomplete,
        provider_error_code=provider_error_code,
        provider_error_provider=provider_error_provider,
    )


class _GatewaySelectorDb:
    def __init__(self, pair) -> None:
        self.pair = pair
        self.closed = False

    def query(self, model):
        return self

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self.pair

    def close(self) -> None:
        self.closed = True


def test_gateway_ws_selector_uses_primary_provider_priority() -> None:
    async def run() -> None:
        class Pair:
            symbol = "BTCUSDT"
            data_source = market.DATA_SOURCE_BINANCE
            status = 1

        original_session_local = gateway_module.SessionLocal
        original_enabled_providers = gateway_module.enabled_spot_market_providers
        db = _GatewaySelectorDb(Pair())
        gateway = SpotMarketGateway(ws_manager=FakeWsManager())

        try:
            gateway_module.SessionLocal = lambda: db
            gateway_module.enabled_spot_market_providers = lambda db_arg: (
                _spot_provider(market.PROVIDER_BITGET_SPOT, priority=1),
            )
            assert gateway._select_provider_ws_code("BTCUSDT") == market.PROVIDER_BITGET_SPOT

            gateway_module.enabled_spot_market_providers = lambda db_arg: (
                _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
                _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
            )
            assert gateway._select_provider_ws_code("BTCUSDT") == market.PROVIDER_OKX_SPOT

            gateway_module.enabled_spot_market_providers = lambda db_arg: (
                _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            )
            assert gateway._select_provider_ws_code("BTCUSDT") == market.PROVIDER_OKX_SPOT
        finally:
            gateway_module.SessionLocal = original_session_local
            gateway_module.enabled_spot_market_providers = original_enabled_providers

    asyncio.run(run())


def test_gateway_ws_selector_skips_internal_pairs() -> None:
    async def run() -> None:
        class Pair:
            symbol = "MFCUSDT"
            data_source = market.DATA_SOURCE_INTERNAL
            status = 1

        original_session_local = gateway_module.SessionLocal
        original_enabled_providers = gateway_module.enabled_spot_market_providers
        db = _GatewaySelectorDb(Pair())
        gateway = SpotMarketGateway(ws_manager=FakeWsManager())

        try:
            gateway_module.SessionLocal = lambda: db
            gateway_module.enabled_spot_market_providers = lambda db_arg: (
                _spot_provider(market.PROVIDER_BITGET_SPOT, priority=1),
            )
            assert gateway._select_provider_ws_code("MFCUSDT") is None
        finally:
            gateway_module.SessionLocal = original_session_local
            gateway_module.enabled_spot_market_providers = original_enabled_providers

    asyncio.run(run())


def test_gateway_does_not_start_bitget_when_primary_provider_has_no_ws() -> None:
    async def run() -> None:
        ensure_calls: list[str] = []
        ensure_kline_calls: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=lambda symbol: ensure_calls.append(symbol),
            ensure_kline=lambda symbol, interval: ensure_kline_calls.append((symbol, interval)),
            ws_manager=FakeWsManager(),
        )
        gateway._select_provider_ws_code = lambda symbol: None

        await gateway.ensure_symbol("BTCUSDT")

        assert ensure_calls == []
        assert ensure_kline_calls == []
        assert gateway._tasks == {}

    asyncio.run(run())


def test_gateway_okx_primary_ensures_depth_and_kline() -> None:
    async def run() -> None:
        ensure_calls: list[str] = []
        ensure_kline_calls: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=lambda symbol: ensure_calls.append(symbol),
            ensure_kline=lambda symbol, interval: ensure_kline_calls.append((symbol, interval)),
            ws_manager=FakeWsManager(),
        )
        gateway._select_provider_ws_code = lambda symbol: market.PROVIDER_OKX_SPOT
        gateway._provider_symbol_allowed_async = lambda symbol: asyncio.sleep(0, result=True)

        await gateway.ensure_symbol("BTCUSDT")

        assert ensure_calls == ["BTCUSDT"]
        assert ensure_kline_calls == [("BTCUSDT", "1m")]
        assert gateway._symbol_providers["BTCUSDT"] == market.PROVIDER_OKX_SPOT
        assert gateway._ensured_kline_intervals.get("BTCUSDT") == {"1m"}

    asyncio.run(run())


def test_gateway_okx_primary_broadcasts_all_supported_domains() -> None:
    class OkxProvider(FakeProvider):
        def __init__(self) -> None:
            super().__init__()
            self.depth = DepthResponse(
                symbol="BTCUSDT",
                bids=[DepthItem(price="2", amount="1")],
                asks=[DepthItem(price="3", amount="1")],
                ts=1000,
                provider=market.PROVIDER_OKX_SPOT,
                source="LIVE_WS",
                fetched_at=1000,
            )

        def get_ticker(self, symbol: str, **kwargs) -> dict:
            ticker = super().get_ticker(symbol, **kwargs)
            ticker["provider"] = market.PROVIDER_OKX_SPOT
            return ticker

        def get_trades(self, symbol: str, **kwargs) -> TradesResponse:
            return TradesResponse(
                symbol="BTCUSDT",
                provider=market.PROVIDER_OKX_SPOT,
                source="LIVE_WS",
                freshness="LIVE",
                trades=[
                    TradeItem(
                        id="okx-trade-1",
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
                "provider": market.PROVIDER_OKX_SPOT,
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
                        "provider": market.PROVIDER_OKX_SPOT,
                    }
                ],
            }

    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = OkxProvider()
        ensured_klines: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            ensure_kline=lambda symbol, interval: ensured_klines.append((symbol, interval)),
            release_depth=provider.release,
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )
        gateway._select_provider_ws_code = lambda symbol: market.PROVIDER_OKX_SPOT
        gateway._provider_symbol_allowed_async = lambda symbol: asyncio.sleep(0, result=True)

        ws_manager.count = 1
        await gateway.ensure_symbol("BTC/USDT", interval="1m")
        await asyncio.sleep(0.05)

        assert provider.ensured == ["BTCUSDT"]
        assert ("BTCUSDT", "1m") in ensured_klines
        assert ws_manager.broadcasts[-1][1].provider == market.PROVIDER_OKX_SPOT
        assert ws_manager.ticker_broadcasts[-1][1]["provider"] == market.PROVIDER_OKX_SPOT
        assert ws_manager.trade_broadcasts[-1]["trade_id"] == "okx-trade-1"
        assert len(ws_manager.kline_broadcasts) == 1
        assert ws_manager.kline_broadcasts[0]["source"] == "LIVE_WS"
        assert ws_manager.kline_broadcasts[0]["kline"]["provider"] == market.PROVIDER_OKX_SPOT

    asyncio.run(run())


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
        trade = _trade_item(
            None,
            price="2",
            amount="1",
            side="BUY",
            ts=1000,
            event_time_ms=1000,
        )
        trades = _trades_response([trade])

        first_batch = gateway._new_trades_for_broadcast("BTCUSDT", trades)
        assert len(first_batch) == 1
        assert first_batch[0].id is None

        key = gateway._domain_key("trades", "BTCUSDT", provider="BITGET_SPOT")
        _age_broadcast_state(gateway, key)
        assert gateway._new_trades_for_broadcast("BTCUSDT", trades) == []

        changed_trade = _trade_item(
            None,
            price="2",
            amount="1",
            side="BUY",
            ts=1001,
            event_time_ms=1001,
        )
        _age_broadcast_state(gateway, key)
        changed_batch = gateway._new_trades_for_broadcast("BTCUSDT", _trades_response([changed_trade]))
        assert len(changed_batch) == 1
        assert changed_batch[0].ts == 1001

    asyncio.run(run())


def test_gateway_trade_signature_uses_shared_strong_identity_priority_and_provider_scope() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        full = _trade_item(
            "item-id",
            trade_id="trade-id",
            provider_trade_id="provider-id",
            provider="OKX_SPOT",
        )
        without_provider_id = _trade_item(
            "item-id",
            trade_id="trade-id",
            provider_trade_id=None,
            provider="OKX_SPOT",
        )
        without_trade_id = _trade_item(
            "item-id",
            trade_id=None,
            provider_trade_id=None,
            provider="OKX_SPOT",
        )

        assert gateway._trade_signature(full) == "provider:OKX_SPOT|trade:provider-id"
        assert gateway._trade_signature(without_provider_id) == "provider:OKX_SPOT|trade:trade-id"
        assert gateway._trade_signature(without_trade_id) == "provider:OKX_SPOT|trade:item-id"
        assert gateway._trade_signature(full) != gateway._trade_signature(
            full.model_copy(update={"provider": "BITGET_SPOT"})
        )

    asyncio.run(run())


def test_gateway_weak_trade_occurrences_preserve_multiplicity_without_rebroadcast() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        weak = {
            "event_time_ms": 1_000,
            "received_at_ms": 2_000,
            "provider": "BITGET_SPOT",
            "provider_symbol": "BTCUSDT",
        }
        two = _trades_response([
            _trade_item(None, **weak),
            _trade_item(None, **weak),
        ])

        first_batch = gateway._new_trades_for_broadcast("BTCUSDT", two)
        assert len(first_batch) == 2

        key = gateway._domain_key("trades", "BTCUSDT", provider="BITGET_SPOT")
        _age_broadcast_state(gateway, key)
        assert gateway._new_trades_for_broadcast("BTCUSDT", two) == []

        three = _trades_response([
            _trade_item(None, **weak),
            _trade_item(None, **weak),
            _trade_item(None, **weak),
        ])
        _age_broadcast_state(gateway, key)
        third_occurrence = gateway._new_trades_for_broadcast("BTCUSDT", three)
        assert len(third_occurrence) == 1

    asyncio.run(run())


def test_gateway_kline_broadcast_state_dedupes_detects_ohlcv_changes_and_isolates_intervals() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        kline = _kline_payload()

        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is True
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", kline, provider="BITGET_SPOT") is False

        key = gateway._domain_key("kline", "BTCUSDT", provider="BITGET_SPOT", interval="1m")
        assert gateway._kline_broadcast_interval_ms() == 200
        assert gateway._loop_interval_seconds() == 0.2
        fixed_now = 1_000_000
        gateway._broadcast_state.now_ms = lambda: fixed_now
        changed_close = _kline_payload(close="2.6")
        gateway._broadcast_state.remember_broadcast(
            key,
            gateway._kline_signature("BTCUSDT", "1m", kline),
            now_ms=fixed_now - 199,
        )
        assert gateway._should_broadcast_kline("BTCUSDT", "1m", changed_close, provider="BITGET_SPOT") is False
        gateway._broadcast_state.remember_broadcast(
            key,
            gateway._kline_signature("BTCUSDT", "1m", kline),
            now_ms=fixed_now - 200,
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


def test_gateway_kline_revision_watermark_handles_close_epoch_seq_and_receive_time() -> None:
    gateway = _new_authority_test_gateway()
    first = _kline_payload(
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
        revision_epoch=1,
        revision_seq=1,
        received_at_ms=10_000,
    )
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        first,
        provider="BITGET_SPOT",
    ) is True
    key = gateway._domain_key("kline", "BTCUSDT", provider="BITGET_SPOT", interval="1m")

    finalized = _kline_payload(
        is_closed=True,
        close_state_source="PROVIDER_CONFIRMED",
        revision_epoch=1,
        revision_seq=2,
        received_at_ms=10_100,
    )
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        finalized,
        provider="BITGET_SPOT",
    ) is False
    assert gateway._kline_revision_high_water[key] == (1_000, 1, 1)
    _age_broadcast_state(gateway, key, gateway._kline_signature("BTCUSDT", "1m", first))
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        finalized,
        provider="BITGET_SPOT",
    ) is True

    _age_broadcast_state(gateway, key, gateway._kline_signature("BTCUSDT", "1m", finalized))
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        finalized,
        provider="BITGET_SPOT",
    ) is False

    stale_revision = _kline_payload(
        is_closed=False,
        close_state_source="PROVIDER_CONFIRMED",
        revision_epoch=1,
        revision_seq=1,
        received_at_ms=99_999,
    )
    _age_broadcast_state(gateway, key, gateway._kline_signature("BTCUSDT", "1m", finalized))
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        stale_revision,
        provider="BITGET_SPOT",
    ) is False

    old_epoch = _kline_payload(
        is_closed=True,
        close_state_source="PROVIDER_CONFIRMED",
        revision_epoch=0,
        revision_seq=99,
    )
    _age_broadcast_state(gateway, key, gateway._kline_signature("BTCUSDT", "1m", finalized))
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        old_epoch,
        provider="BITGET_SPOT",
    ) is False

    new_epoch = _kline_payload(
        is_closed=False,
        close_state_source="UNKNOWN",
        revision_epoch=2,
        revision_seq=1,
        received_at_ms=10_200,
    )
    _age_broadcast_state(gateway, key, gateway._kline_signature("BTCUSDT", "1m", finalized))
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        new_epoch,
        provider="BITGET_SPOT",
    ) is True

    received_only = _kline_payload(
        is_closed=False,
        close_state_source="UNKNOWN",
        revision_epoch=2,
        revision_seq=1,
        received_at_ms=88_888,
    )
    assert gateway._kline_signature("BTCUSDT", "1m", received_only) == gateway._kline_signature(
        "BTCUSDT",
        "1m",
        new_epoch,
    )
    _age_broadcast_state(gateway, key, gateway._kline_signature("BTCUSDT", "1m", new_epoch))
    assert gateway._should_broadcast_kline(
        "BTCUSDT",
        "1m",
        received_only,
        provider="BITGET_SPOT",
    ) is False


def test_gateway_latest_kline_remains_ordered_by_open_time_not_revision_seq() -> None:
    gateway = _new_authority_test_gateway()
    latest = gateway._latest_kline_for_broadcast(
        {
            "items": [
                _kline_payload(open_time=2_000, revision_epoch=1, revision_seq=1),
                _kline_payload(open_time=1_000, revision_epoch=1, revision_seq=99),
            ]
        }
    )

    assert latest is not None
    assert latest["open_time"] == 2_000
    assert latest["revision_seq"] == 1


def test_gateway_provider_kline_notification_only_schedules_on_gateway_loop() -> None:
    kline = _kline_payload(revision_epoch=1, revision_seq=1)
    gateway, ws_manager = _new_event_kline_gateway([kline])
    scheduled: list[tuple[object, tuple[object, ...]]] = []

    class DeferredLoop:
        @staticmethod
        def is_closed() -> bool:
            return False

        @staticmethod
        def call_soon_threadsafe(callback, *args) -> None:
            scheduled.append((callback, args))

    gateway._kline_event_loop = DeferredLoop()
    event = _accepted_kline_event(gateway, kline)
    gateway.notify_provider_kline_revision(event)

    assert ws_manager.kline_broadcasts == []
    assert gateway._kline_pending == {}
    assert len(scheduled) == 1
    callback, args = scheduled[0]
    assert callback == gateway._enqueue_provider_kline_revision
    assert args == (event,)


def test_gateway_accepted_kline_event_wakes_worker_and_uses_existing_broadcast_path() -> None:
    async def run() -> None:
        kline = _kline_payload(
            revision_epoch=1,
            revision_seq=1,
            is_closed=False,
            close_state_source="PROVIDER_CONFIRMED",
        )
        gateway, ws_manager = _new_event_kline_gateway([kline])
        await gateway._ensure_kline_event_worker("BTCUSDT")
        try:
            event = _accepted_kline_event(gateway, kline)
            gateway.notify_provider_kline_revision(event)
            await asyncio.sleep(0.05)

            assert len(ws_manager.kline_broadcasts) == 1
            broadcast = ws_manager.kline_broadcasts[0]
            assert broadcast["symbol"] == "BTCUSDT"
            assert broadcast["interval"] == "1m"
            assert broadcast["kline"]["revision_seq"] == 1
            assert broadcast["revision_epoch"] == 1
            assert broadcast["revision_seq"] == 1

            gateway.notify_provider_kline_revision(event)
            await asyncio.sleep(0.05)
            assert len(ws_manager.kline_broadcasts) == 1
        finally:
            await gateway._stop_kline_event_worker("BTCUSDT")

    asyncio.run(run())


def test_gateway_event_pending_coalesces_same_bucket_to_highest_revision() -> None:
    async def run() -> None:
        revisions = [
            _kline_payload(close=str(2 + revision / 10), revision_epoch=1, revision_seq=revision)
            for revision in (1, 2, 3)
        ]
        gateway, ws_manager = _new_event_kline_gateway([revisions[-1]])
        await gateway._ensure_kline_event_worker("BTCUSDT")
        try:
            for kline in revisions:
                gateway._enqueue_provider_kline_revision(
                    _accepted_kline_event(gateway, kline)
                )
            await asyncio.sleep(0.05)

            assert len(ws_manager.kline_broadcasts) == 1
            assert ws_manager.kline_broadcasts[0]["revision_seq"] == 3
            assert ws_manager.kline_broadcasts[0]["kline"]["close"] == revisions[-1]["close"]
        finally:
            await gateway._stop_kline_event_worker("BTCUSDT")

    asyncio.run(run())


def test_gateway_event_pending_preserves_old_final_before_new_bucket_open() -> None:
    async def run() -> None:
        old_final = _kline_payload(
            open_time=1_000,
            close_time=60_999,
            close="2.7",
            revision_epoch=1,
            revision_seq=1,
            is_closed=True,
            close_state_source="PROVIDER_CONFIRMED",
        )
        new_open = _kline_payload(
            open_time=61_000,
            close_time=120_999,
            open="2.7",
            high="2.7",
            low="2.7",
            close="2.7",
            volume="0.1",
            quote_volume="0.27",
            revision_epoch=1,
            revision_seq=2,
            is_closed=False,
            close_state_source="PROVIDER_CONFIRMED",
        )
        gateway, ws_manager = _new_event_kline_gateway([old_final, new_open])
        await gateway._ensure_kline_event_worker("BTCUSDT")
        try:
            gateway._enqueue_provider_kline_revision(
                _accepted_kline_event(gateway, new_open)
            )
            gateway._enqueue_provider_kline_revision(
                _accepted_kline_event(gateway, old_final)
            )
            for _ in range(100):
                if len(ws_manager.kline_broadcasts) >= 2:
                    break
                await asyncio.sleep(0.01)

            assert [
                broadcast["kline"]["open_time"]
                for broadcast in ws_manager.kline_broadcasts
            ] == [1_000, 61_000]
            assert ws_manager.kline_broadcasts[0]["is_closed"] is True
            assert ws_manager.kline_broadcasts[1]["is_closed"] is False
        finally:
            await gateway._stop_kline_event_worker("BTCUSDT")

    asyncio.run(run())


def test_gateway_event_rejects_retired_provider_generation() -> None:
    kline = _kline_payload(revision_epoch=1, revision_seq=1)
    gateway, ws_manager = _new_event_kline_gateway([kline], generation=2)

    gateway._enqueue_provider_kline_revision(
        _accepted_kline_event(gateway, kline, generation=1)
    )

    assert gateway._kline_pending == {}
    assert ws_manager.kline_broadcasts == []


def test_gateway_polling_kline_fallback_broadcasts_without_accepted_event() -> None:
    async def run() -> None:
        kline = _kline_payload(revision_epoch=1, revision_seq=1)
        gateway, ws_manager = _new_event_kline_gateway([kline])
        gateway._kline_emit_locks["BTCUSDT"] = asyncio.Lock()

        async with gateway._kline_emit_locks["BTCUSDT"]:
            await gateway._poll_provider_kline_interval(
                "BTCUSDT",
                "1m",
                "BITGET_SPOT",
            )

        assert len(ws_manager.kline_broadcasts) == 1
        assert gateway._kline_pending == {}

    asyncio.run(run())


def test_gateway_defaults_to_revision_aware_provider_kline_getter() -> None:
    calls = []

    def revision_getter(*args, **kwargs):
        calls.append((args, kwargs))
        return None

    with patch.object(
        gateway_module,
        "get_spot_provider_ws_kline_revisions",
        revision_getter,
    ):
        try:
            asyncio.get_event_loop()
        except RuntimeError:
            asyncio.set_event_loop(asyncio.new_event_loop())
        gateway = SpotMarketGateway(
            ensure_depth=lambda symbol: None,
            ensure_kline=lambda symbol, interval: None,
            release_depth=lambda symbol: None,
            get_depth=lambda symbol: None,
            get_ticker=lambda symbol: None,
            get_trades=lambda symbol: None,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=FakeWsManager(),
        )

    assert gateway._get_klines is revision_getter
    assert gateway._get_klines_accepts_provider is True
    assert gateway._get_klines("BTCUSDT", "1m", provider="BITGET_SPOT") is None
    assert calls == [(('BTCUSDT', '1m'), {"provider": "BITGET_SPOT"})]


def test_gateway_kline_interval_lifecycle_preserves_utc_intervals() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        ws_manager.intervals = ["1dutc", "1Wutc", "1mutc"]
        ensured_klines: list[tuple[str, str]] = []
        released_klines: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_kline=lambda symbol, interval: ensured_klines.append((symbol, interval)),
            release_kline=lambda symbol, interval: released_klines.append((symbol, interval)),
            provider_symbol_allowed=lambda symbol: True,
            ws_manager=ws_manager,
            kline_release_grace_seconds=0,
        )
        gateway._symbol_providers["BTCUSDT"] = market.PROVIDER_OKX_SPOT

        active = await gateway._active_kline_intervals("BTCUSDT")
        assert active == ["1Dutc", "1Mutc", "1Wutc"]

        ready = await gateway._sync_kline_intervals("BTCUSDT", active)
        assert ready == ["1Dutc", "1Mutc", "1Wutc"]
        assert set(ensured_klines) == {
            ("BTCUSDT", "1Dutc"),
            ("BTCUSDT", "1Wutc"),
            ("BTCUSDT", "1Mutc"),
        }
        assert gateway._ensured_kline_intervals["BTCUSDT"] == {"1Dutc", "1Wutc", "1Mutc"}

        ready = await gateway._sync_kline_intervals("BTCUSDT", ["1Dutc"])
        assert ready == ["1Dutc"]
        assert set(released_klines) == {("BTCUSDT", "1Wutc"), ("BTCUSDT", "1Mutc")}
        assert gateway._ensured_kline_intervals["BTCUSDT"] == {"1Dutc"}
        assert gateway._domain_key(
            "kline",
            "BTCUSDT",
            provider=market.PROVIDER_OKX_SPOT,
            interval="1dutc",
        ) == gateway._domain_key(
            "kline",
            "BTCUSDT",
            provider=market.PROVIDER_OKX_SPOT,
            interval="1Dutc",
        )

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
            kline_release_grace_seconds=0,
        )

        gateway._ensured_kline_intervals["BTCUSDT"] = {"1m"}
        kline = _kline_payload(revision_epoch=1, revision_seq=1)
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


def test_gateway_sync_kline_intervals_graces_inactive_interval_release() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        released_klines: list[tuple[str, str]] = []
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            release_depth=provider.release,
            ensure_kline=lambda symbol, interval: None,
            release_kline=lambda symbol, interval: released_klines.append((symbol, interval)),
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_klines=provider.get_klines,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
            kline_release_grace_seconds=0.02,
        )

        gateway._ensured_kline_intervals["BTCUSDT"] = {"1m"}

        ready = await gateway._sync_kline_intervals("BTCUSDT", ["5m"])
        assert ready == ["5m"]
        assert released_klines == []
        assert gateway._ensured_kline_intervals["BTCUSDT"] == {"1m", "5m"}

        await asyncio.sleep(0.03)
        ready = await gateway._sync_kline_intervals("BTCUSDT", ["5m"])

        assert ready == ["5m"]
        assert released_klines == [("BTCUSDT", "1m")]
        assert gateway._ensured_kline_intervals["BTCUSDT"] == {"5m"}

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
            kline_release_grace_seconds=0,
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
            kline_release_grace_seconds=0,
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
        revision_key = gateway._domain_key(
            "kline",
            "BTCUSDT",
            provider="BITGET_SPOT",
            interval="1m",
        )
        gateway._kline_revision_high_water[revision_key] = (1_000, 1, 1)

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("BTCUSDT", idle_delay_seconds=0)
        await asyncio.sleep(0.05)

        assert provider.released == ["BTCUSDT"]
        assert "BTCUSDT" not in gateway._ensured_kline_intervals
        assert revision_key not in gateway._kline_revision_high_water

    asyncio.run(run())


def test_gateway_refresh_loop_exits_quietly_on_executor_shutdown() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        ws_manager.count = 1
        gateway = _new_test_gateway()
        gateway._ws_manager = ws_manager
        gateway._symbol_providers["BTCUSDT"] = market.PROVIDER_BITGET_SPOT

        async def fail_provider_allowed(symbol: str) -> bool:
            raise RuntimeError("Executor shutdown has been called")

        gateway._provider_symbol_allowed_async = fail_provider_allowed

        await gateway._refresh_loop("BTCUSDT")

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
        assert ws_manager.trade_broadcasts[0]["id"] == "trade-1"
        assert ws_manager.trade_broadcasts[0]["trade_id"] == "trade-1"
        assert ws_manager.trade_broadcasts[0]["provider_trade_id"] == "provider-trade-1"
        assert ws_manager.trade_broadcasts[0]["provider"] == "BITGET_SPOT"
        assert ws_manager.trade_broadcasts[0]["provider_symbol"] == "BTCUSDT"
        assert ws_manager.trade_broadcasts[0]["source"] == "LIVE_WS"
        assert ws_manager.trade_broadcasts[0]["freshness"] == "LIVE"
        assert ws_manager.trade_broadcasts[0]["updated_at_ms"] == 5_678
        assert ws_manager.trade_broadcasts[0]["event_time_ms"] == 1000
        assert ws_manager.trade_broadcasts[0]["received_at_ms"] == 2_345
        assert ws_manager.trade_broadcasts[0]["time_origin"] == "PROVIDER"
        assert ws_manager.trade_broadcasts[0]["created_at"] == "1970-01-01T00:00:01"
        assert ws_manager.trade_broadcasts[0]["price"] == "2.1234"

        await asyncio.sleep(0.25)
        assert len(ws_manager.trade_broadcasts) == 1

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("btcusdt", idle_delay_seconds=0)
        await asyncio.sleep(0.05)
        assert provider.released == ["BTCUSDT"]

    asyncio.run(run())


def test_gateway_batches_preview_after_all_corresponding_trades() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        preview_symbol = "SOLUSDT"
        gateway = SpotMarketGateway(
            get_kline_generation=lambda _symbol, _interval: 7,
            ws_manager=ws_manager,
        )
        open_time = spot_kline_bucket_start_ms(
            1_710_000_090_000,
            "1m",
            provider="OKX_SPOT",
        )
        gateway._accept_candle_preview_native(
            symbol=preview_symbol,
            interval="1m",
            provider="OKX_SPOT",
            generation=7,
            kline={
                "open_time": open_time,
                "open": "100",
                "high": "100",
                "low": "100",
                "close": "100",
                "volume": "10",
                "quote_volume": "1000",
                "revision_epoch": 1,
                "revision_seq": 5,
                "is_closed": False,
            },
        )
        trades = TradesResponse(
            symbol=preview_symbol,
            provider="OKX_SPOT",
            provider_symbol="SOL-USDT",
            source="LIVE_WS",
            freshness="LIVE",
            received_at_ms=open_time + 30_020,
            trades=[
                TradeItem(
                    id="trade-1",
                    trade_id="trade-1",
                    provider_trade_id="trade-1",
                    price="101",
                    amount="1",
                    side="BUY",
                    ts=open_time + 30_000,
                    event_time_ms=open_time + 30_000,
                    received_at_ms=open_time + 30_010,
                    provider="OKX_SPOT",
                    provider_symbol="SOL-USDT",
                    source="LIVE_WS",
                    freshness="LIVE",
                ),
                TradeItem(
                    id="trade-2",
                    trade_id="trade-2",
                    provider_trade_id="trade-2",
                    price="102",
                    amount="2",
                    side="BUY",
                    ts=open_time + 30_001,
                    event_time_ms=open_time + 30_001,
                    received_at_ms=open_time + 30_020,
                    provider="OKX_SPOT",
                    provider_symbol="SOL-USDT",
                    source="LIVE_WS",
                    freshness="LIVE",
                ),
            ],
        )

        await gateway._broadcast_trade_batch(preview_symbol, trades, list(trades.trades))

        assert ws_manager.event_order == [
            ("trade", "trade-1"),
            ("trade", "trade-2"),
            ("preview", "102"),
        ]
        assert len(ws_manager.preview_broadcasts) == 1
        assert [
            format(item["candle_preview"].close, "f")
            for item in ws_manager.trade_broadcasts
        ] == ["101", "102"]
        assert [
            item["candle_preview"].preview_seq
            for item in ws_manager.trade_broadcasts
        ] == [1, 2]
        assert all(
            item["candle_preview_received_at_ms"] is not None
            for item in ws_manager.trade_broadcasts
        )
        preview = ws_manager.preview_broadcasts[0]["preview"]
        assert preview.volume == 13
        assert preview.preview_seq == 2
        assert ws_manager.preview_broadcasts[0]["received_at_ms"] == open_time + 30_020

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


def test_gateway_broadcasts_revision_aware_provider_kline_metadata() -> None:
    class RevisionProvider(FakeProvider):
        def get_kline_revisions(self, symbol: str, interval: str, **kwargs) -> dict:
            payload = self.get_klines(symbol, interval, **kwargs)
            payload["items"][0].update(
                {
                    "revision_epoch": 2,
                    "revision_seq": 7,
                    "is_closed": True,
                    "close_state_source": "PROVIDER_CONFIRMED",
                    "received_at_ms": 99_999,
                }
            )
            return payload

    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = RevisionProvider()
        gateway = SpotMarketGateway(
            ensure_depth=provider.ensure,
            release_depth=provider.release,
            ensure_kline=lambda symbol, interval: None,
            get_depth=provider.get_depth,
            get_ticker=provider.get_ticker,
            get_trades=provider.get_trades,
            get_kline_revisions=provider.get_kline_revisions,
            provider_symbol_allowed=lambda symbol: True,
            precision_resolver=lambda symbol: (2, 3),
            ws_manager=ws_manager,
        )

        ws_manager.count = 1
        await gateway.ensure_symbol("BTCUSDT", interval="1m")
        await asyncio.sleep(0.05)

        assert len(ws_manager.kline_broadcasts) == 1
        broadcast = ws_manager.kline_broadcasts[0]
        assert broadcast["kline"]["revision_epoch"] == 2
        assert broadcast["kline"]["revision_seq"] == 7
        assert broadcast["revision_epoch"] == 2
        assert broadcast["revision_seq"] == 7
        assert broadcast["is_closed"] is True
        assert broadcast["close_state_source"] == "PROVIDER_CONFIRMED"

        ws_manager.count = 0
        await gateway.release_symbol_if_idle("BTCUSDT", idle_delay_seconds=0)
        await asyncio.sleep(0.05)

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
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_shared_depth_cache = market.get_spot_depth_with_shared_cache
    fallback_called = {"value": False}

    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_BITGET_SPOT),
        )
        market.get_spot_depth_with_shared_cache = lambda **kwargs: kwargs["loader"]()
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
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_depth_with_shared_cache = original_shared_depth_cache


def test_external_spot_ticker_prefers_live_ws() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    original_get_ws_ticker = market.get_spot_provider_ws_ticker
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_request_json = market.request_contract_market_provider_json
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
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_BITGET_SPOT),
        )
        market.request_contract_market_provider_json = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("REST request should not be called")
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
        market.request_contract_market_provider_json = original_request_json


def test_primary_okx_spot_uses_okx_ticker_live_ws() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    okx = _spot_provider(market.PROVIDER_OKX_SPOT, priority=1)
    bitget = _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2)

    original_get_ws_ticker = market.get_spot_provider_ws_ticker
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_spot_provider_symbol = market._spot_provider_symbol
    original_request_json = market.request_contract_market_provider_json
    original_mark_success = market.mark_contract_market_provider_success

    try:
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (okx, bitget)
        market.get_spot_provider_ws_ticker = lambda symbol, **kwargs: (
            {
                "symbol": "BTCUSDT",
                "provider": market.PROVIDER_OKX_SPOT,
                "source": "LIVE_WS",
                "last_price": "10",
                "open_24h": "8",
                "price_change_24h": "2",
                "price_change_percent": "25",
                "high_24h": "11",
                "low_24h": "7",
                "base_volume_24h": "2",
                "quote_volume_24h": "20",
                "updated_at": "2026-07-05T00:00:00",
            }
            if kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            else (_ for _ in ()).throw(AssertionError("ticker WS must use primary OKX_SPOT provider"))
        )
        market._spot_provider_symbol = lambda db, pair, provider: "BTC-USDT"
        market.request_contract_market_provider_json = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("REST request should not be called when OKX ticker LIVE_WS is fresh")
        )
        market.mark_contract_market_provider_success = lambda *args, **kwargs: None

        ticker = market._get_external_spot_ticker(None, Pair())
        assert ticker is not None
        assert ticker.provider == market.PROVIDER_OKX_SPOT
        assert ticker.source == "LIVE_WS"
        assert ticker.last_price == "10.00"
        assert ticker.price_change_percent == "25.00"
    finally:
        market.get_spot_provider_ws_ticker = original_get_ws_ticker
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market._spot_provider_symbol = original_spot_provider_symbol
        market.request_contract_market_provider_json = original_request_json
        market.mark_contract_market_provider_success = original_mark_success


def test_primary_okx_spot_ticker_live_ws_miss_falls_back_to_okx_rest() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    okx = _spot_provider(market.PROVIDER_OKX_SPOT, priority=1)
    bitget = _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2)

    original_get_ws_ticker = market.get_spot_provider_ws_ticker
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_spot_provider_symbol = market._spot_provider_symbol
    original_request_json = market.request_contract_market_provider_json
    original_mark_success = market.mark_contract_market_provider_success

    try:
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (okx, bitget)
        market.get_spot_provider_ws_ticker = lambda symbol, **kwargs: (
            None
            if kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            else (_ for _ in ()).throw(AssertionError("must not steal Bitget ticker LIVE_WS when OKX is primary"))
        )
        market._spot_provider_symbol = lambda db, pair, provider: "BTC-USDT"

        def request_json(provider, endpoint_type, provider_symbol, **kwargs):
            assert provider.provider_code == market.PROVIDER_OKX_SPOT
            assert endpoint_type == "ticker"
            assert provider_symbol == "BTC-USDT"
            return {
                "data": [
                    {
                        "last": "10",
                        "open24h": "8",
                        "high24h": "11",
                        "low24h": "7",
                        "vol24h": "2",
                        "volCcy24h": "20",
                        "ts": "1000",
                    }
                ]
            }

        market.request_contract_market_provider_json = request_json
        market.mark_contract_market_provider_success = lambda *args, **kwargs: None

        ticker = market._get_external_spot_ticker(None, Pair())
        assert ticker is not None
        assert ticker.provider == market.PROVIDER_OKX_SPOT
        assert ticker.source == "external"
        assert ticker.last_price == "10.00"
    finally:
        market.get_spot_provider_ws_ticker = original_get_ws_ticker
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market._spot_provider_symbol = original_spot_provider_symbol
        market.request_contract_market_provider_json = original_request_json
        market.mark_contract_market_provider_success = original_mark_success


def test_depth_uses_okx_live_ws_when_okx_is_primary() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    okx_depth = DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="9", amount="1")],
        asks=[DepthItem(price="10", amount="1")],
        ts=2000,
        provider="OKX_SPOT",
        source="LIVE_WS",
    )

    original_get_active_pair = market._get_active_pair
    original_get_ws_depth = market.get_spot_provider_ws_depth
    original_get_external_depth = market._get_external_spot_depth
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
        )
        market.get_spot_provider_ws_depth = lambda symbol, **kwargs: (
            okx_depth
            if kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            else (_ for _ in ()).throw(AssertionError("depth WS must use primary OKX_SPOT provider"))
        )
        market._get_external_spot_depth = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("REST fallback should not be called when OKX depth LIVE_WS is fresh")
        )

        result = market.get_depth(None, "BTCUSDT")
        assert result.provider == "OKX_SPOT"
        assert result.source == "LIVE_WS"
    finally:
        market._get_active_pair = original_get_active_pair
        market.get_spot_provider_ws_depth = original_get_ws_depth
        market._get_external_spot_depth = original_get_external_depth
        market._enabled_spot_market_providers_for_pair = original_enabled_providers


def test_okx_depth_live_ws_miss_falls_back_to_okx_rest_without_bitget_ws() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    rest_depth = DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="9", amount="1")],
        asks=[DepthItem(price="10", amount="1")],
        ts=2000,
        provider="OKX_SPOT",
        source="external",
    )

    original_get_active_pair = market._get_active_pair
    original_get_ws_depth = market.get_spot_provider_ws_depth
    original_get_external_depth = market._get_external_spot_depth
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_shared_depth_cache = market.get_spot_depth_with_shared_cache
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
        )
        market.get_spot_depth_with_shared_cache = lambda **kwargs: kwargs["loader"]()

        def get_ws_depth(symbol, **kwargs):
            assert kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            return None

        market.get_spot_provider_ws_depth = get_ws_depth
        market._get_external_spot_depth = lambda *args, **kwargs: rest_depth

        result = market.get_depth(None, "BTCUSDT")
        assert result.provider == "OKX_SPOT"
        assert result.source == "external"
    finally:
        market._get_active_pair = original_get_active_pair
        market.get_spot_provider_ws_depth = original_get_ws_depth
        market._get_external_spot_depth = original_get_external_depth
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_depth_with_shared_cache = original_shared_depth_cache


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
    original_shared_trades_cache = market.get_spot_trades_with_shared_cache
    try:
        market._get_active_pair = lambda db, symbol: Pair(symbol)
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_trades_with_shared_cache = lambda **kwargs: kwargs["loader"]()
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
        market.get_spot_trades_with_shared_cache = original_shared_trades_cache


def test_okx_primary_trades_use_live_ws_without_bitget_cache() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_trades = market.get_spot_provider_ws_trades
    original_spot_provider_symbol = market._spot_provider_symbol
    original_request_json = market.request_contract_market_provider_json
    original_mark_success = market.mark_contract_market_provider_success
    original_shared_trades_cache = market.get_spot_trades_with_shared_cache
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
        )
        market.get_spot_trades_with_shared_cache = lambda **kwargs: kwargs["loader"]()
        market.get_spot_provider_ws_trades = lambda symbol, **kwargs: (
            TradesResponse(
                symbol="BTCUSDT",
                provider=market.PROVIDER_OKX_SPOT,
                source="LIVE_WS",
                freshness="LIVE",
                trades=[
                    TradeItem(id="okx-live-1", price="3.456", amount="2.3456", side="SELL", ts=2000),
                ],
            )
            if kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            else (_ for _ in ()).throw(AssertionError("must not steal Bitget trades LIVE_WS when OKX is primary"))
        )
        market._spot_provider_symbol = lambda *args, **kwargs: "BTC-USDT"
        market.mark_contract_market_provider_success = lambda *args, **kwargs: None
        market.request_contract_market_provider_json = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("REST request should not be called when OKX trades LIVE_WS is fresh")
        )

        result = market.get_trades(None, "BTCUSDT", limit=30)
        assert result.provider == market.PROVIDER_OKX_SPOT
        assert result.source == "LIVE_WS"
        assert result.freshness == "LIVE"
        assert result.trades[0].id == "okx-live-1"
        assert result.trades[0].price == "3.46"
        assert result.trades[0].amount == "2.346"
        assert result.trades[0].side == "SELL"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_trades = original_get_ws_trades
        market._spot_provider_symbol = original_spot_provider_symbol
        market.request_contract_market_provider_json = original_request_json
        market.mark_contract_market_provider_success = original_mark_success
        market.get_spot_trades_with_shared_cache = original_shared_trades_cache


def test_okx_primary_trades_live_ws_miss_falls_back_to_okx_rest() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_trades = market.get_spot_provider_ws_trades
    original_spot_provider_symbol = market._spot_provider_symbol
    original_request_json = market.request_contract_market_provider_json
    original_mark_success = market.mark_contract_market_provider_success
    original_shared_trades_cache = market.get_spot_trades_with_shared_cache
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
        )
        market.get_spot_trades_with_shared_cache = lambda **kwargs: kwargs["loader"]()
        market.get_spot_provider_ws_trades = lambda symbol, **kwargs: (
            None
            if kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            else (_ for _ in ()).throw(AssertionError("must not steal Bitget trades LIVE_WS when OKX is primary"))
        )
        market._spot_provider_symbol = lambda *args, **kwargs: "BTC-USDT"
        market.mark_contract_market_provider_success = lambda *args, **kwargs: None

        def request_json(provider, endpoint_type, provider_symbol, **kwargs):
            assert provider.provider_code == market.PROVIDER_OKX_SPOT
            assert endpoint_type == "trades"
            assert provider_symbol == "BTC-USDT"
            return {
                "data": [
                    {
                        "tradeId": "okx-rest-1",
                        "px": "3.456",
                        "sz": "2.3456",
                        "side": "sell",
                        "ts": "2000",
                    }
                ]
            }

        market.request_contract_market_provider_json = request_json

        result = market.get_trades(None, "BTCUSDT", limit=30)
        assert result.provider == market.PROVIDER_OKX_SPOT
        assert result.source is None
        assert result.trades[0].price == "3.46"
        assert result.trades[0].amount == "2.346"
        assert result.trades[0].side == "SELL"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_trades = original_get_ws_trades
        market._spot_provider_symbol = original_spot_provider_symbol
        market.request_contract_market_provider_json = original_request_json
        market.mark_contract_market_provider_success = original_mark_success
        market.get_spot_trades_with_shared_cache = original_shared_trades_cache


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


def test_market_kline_router_accepts_end_time_ms_alias() -> None:
    original_get_klines = market_router.get_klines
    calls: list[dict] = []

    def fake_get_klines(**kwargs):
        calls.append(dict(kwargs))
        return {"symbol": kwargs["symbol"], "interval": kwargs["interval"], "items": []}

    try:
        market_router.get_klines = fake_get_klines

        market_router.kline(
            symbol="BTCUSDT",
            interval="1m",
            limit=500,
            end_time=111,
            end_time_ms=222,
            db=None,
        )
        assert calls[-1]["end_time_ms"] == 222

        market_router.kline(
            symbol="BTCUSDT",
            interval="1m",
            limit=500,
            end_time=333,
            end_time_ms=None,
            db=None,
        )
        assert calls[-1]["end_time_ms"] == 333
    finally:
        market_router.get_klines = original_get_klines


def test_get_klines_uses_rest_history_with_live_ws_overlay() -> None:
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
        def cache_first(*args, **kwargs):
            market._SPOT_LAST_GOOD_KLINES[(kwargs["symbol"], kwargs["interval"])] = {
                "provider": market.PROVIDER_BITGET_SPOT,
                "updated_at": "2026-07-04T00:00:00",
            }
            return _kline_cache_result(
                [
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
                ],
                origin=market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE,
                cache_status=market_kline_cache.KLINE_CACHE_STATUS_HIT,
            )

        market.get_klines_cache_first = cache_first
        market._fetch_external_spot_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("direct REST fetch should not be called in get_klines test")
        )

        for symbol in ("BTCUSDT", "ETHUSDT"):
            result = market.get_klines(None, symbol, "1m", limit=30)
            assert result["symbol"] == symbol
            assert result.get("source") == "LIVE_WS"
            assert result.get("freshness") == "LIVE"
            assert result["provider"] == "BITGET_SPOT"
            assert result["items"][-1]["open_time"] == 120000
            assert result["items"][-1]["close"] == "2.5"

        market.get_spot_provider_ws_klines = lambda symbol, interval, **kwargs: None
        fallback = market.get_klines(None, "BTCUSDT", "1m", limit=30)
        assert fallback.get("source") == "DB_CACHE"
        assert fallback.get("freshness") == "CACHED"
        assert fallback.get("stale") is False
        assert fallback.get("cache_status") == market_kline_cache.KLINE_CACHE_STATUS_HIT
        assert fallback["provider"] == "BITGET_SPOT"
        assert fallback["items"][-1]["close"] == "1.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first
        market._fetch_external_spot_klines = original_fetch_external


def test_get_klines_limit_500_does_not_return_live_ws_cache_only() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    history_items = [
        {
            "open_time": (index + 1) * 60000,
            "close_time": (index + 2) * 60000,
            "open": "1",
            "high": "2",
            "low": "1",
            "close": "1.5",
            "volume": "5",
            "quote_volume": "7.5",
        }
        for index in range(500)
    ]
    live_item = {
        "open_time": 501 * 60000,
        "close_time": 502 * 60000,
        "open": "2",
        "high": "3",
        "low": "1",
        "close": "2.5",
        "volume": "10",
        "quote_volume": "25",
    }

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda symbol, interval, **kwargs: {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "provider": market.PROVIDER_OKX_SPOT,
            "source": "LIVE_WS",
            "freshness": "LIVE",
            "items": [live_item],
        }

        def cache_first(*args, **kwargs):
            assert kwargs["limit"] == 500
            assert kwargs.get("end_time_ms") is None
            market._SPOT_LAST_GOOD_KLINES[(Pair.symbol, kwargs["interval"])] = {
                "provider": market.PROVIDER_OKX_SPOT,
                "updated_at": "2026-07-05T00:00:00",
            }
            return list(history_items)

        market.get_klines_cache_first = cache_first

        result = market.get_klines(None, "BTCUSDT", "1m", limit=500)
        assert len(result["items"]) == 500
        assert result.get("source") == "LIVE_WS"
        assert result.get("freshness") == "LIVE"
        assert result["provider"] == market.PROVIDER_OKX_SPOT
        assert result["items"][-1]["open_time"] == live_item["open_time"]
        assert result["items"][-1]["close"] == "2.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_kline_history_pagination_does_not_read_live_ws() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_BITGET_SPOT)

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("historical pagination must not read LIVE_WS kline")
        )
        market.get_klines_cache_first = lambda *args, **kwargs: _kline_cache_result(
            [
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
            ],
            origin=market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE,
            cache_status=market_kline_cache.KLINE_CACHE_STATUS_HIT,
        )

        result = market.get_klines(None, "BTCUSDT", "1m", limit=30, end_time_ms=180000)
        assert result.get("source") == "DB_CACHE"
        assert result.get("freshness") == "CACHED"
        assert result.get("stale") is False
        assert result.get("cache_status") == market_kline_cache.KLINE_CACHE_STATUS_HIT
        assert result.get("history_incomplete") is False
        assert result["items"][-1]["close"] == "1.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_kline_history_rest_fetch_reports_continuity_invalid_metadata() -> None:
    class Pair:
        symbol = "ETHUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    end_time_ms = 180000
    item = {
        "open_time": 60000,
        "close_time": 120000,
        "open": "1",
        "high": "2",
        "low": "1",
        "close": "1.5",
        "volume": "5",
        "quote_volume": "7.5",
    }

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("historical pagination must not read LIVE_WS kline")
        )
        market.get_klines_cache_first = lambda *args, **kwargs: _kline_cache_result(
            [item],
            origin=market_kline_cache.KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status=market_kline_cache.KLINE_CACHE_STATUS_CONTINUITY_INVALID,
            history_incomplete=False,
        )

        result = market.get_klines(None, "ETHUSDT", "4h", limit=30, end_time_ms=end_time_ms)

        assert result.get("source") == "REST_HISTORY"
        assert result.get("freshness") == "RECENT"
        assert result.get("stale") is False
        assert result.get("cache_status") == market_kline_cache.KLINE_CACHE_STATUS_CONTINUITY_INVALID
        assert result.get("history_incomplete") is False
        assert result["provider"] == market.PROVIDER_OKX_SPOT
        assert result["items"][-1]["close"] == "1.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_kline_history_stale_short_cache_reports_provider_error_metadata() -> None:
    class Pair:
        symbol = "ETHUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    end_time_ms = 180000
    item = {
        "open_time": 60000,
        "close_time": 120000,
        "open": "1",
        "high": "2",
        "low": "1",
        "close": "1.5",
        "volume": "5",
        "quote_volume": "7.5",
    }

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("historical pagination must not read LIVE_WS kline")
        )
        market.get_klines_cache_first = lambda *args, **kwargs: _kline_cache_result(
            [item],
            origin=market_kline_cache.KLINE_CACHE_ORIGIN_STALE_CACHE,
            cache_status=market_kline_cache.KLINE_CACHE_STATUS_SHORT,
            history_incomplete=True,
            provider_error_code=market_kline_cache.KLINE_PROVIDER_ERROR_TIMEOUT,
            provider_error_provider=market.PROVIDER_OKX_SPOT,
        )

        result = market.get_klines(None, "ETHUSDT", "4h", limit=30, end_time_ms=end_time_ms)

        assert result.get("source") == "STALE_CACHE"
        assert result.get("freshness") == "STALE"
        assert result.get("stale") is True
        assert result.get("cache_status") == market_kline_cache.KLINE_CACHE_STATUS_SHORT
        assert result.get("history_incomplete") is True
        assert result.get("provider_error_code") == market_kline_cache.KLINE_PROVIDER_ERROR_TIMEOUT
        assert result.get("provider_error_provider") == market.PROVIDER_OKX_SPOT
        assert result["items"][-1]["close"] == "1.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_kline_history_provider_empty_reports_missing_metadata() -> None:
    class Pair:
        symbol = "ETHUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    end_time_ms = 180000

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("historical pagination must not read LIVE_WS kline")
        )
        market.get_klines_cache_first = lambda *args, **kwargs: _kline_cache_result(
            [],
            origin=market_kline_cache.KLINE_CACHE_ORIGIN_EMPTY,
            cache_status=market_kline_cache.KLINE_CACHE_STATUS_PROVIDER_EMPTY,
            history_incomplete=True,
            provider_error_code=market_kline_cache.KLINE_PROVIDER_ERROR_EMPTY,
            provider_error_provider=market.PROVIDER_OKX_SPOT,
        )

        result = market.get_klines(None, "ETHUSDT", "4h", limit=30, end_time_ms=end_time_ms)

        assert result.get("source") == "EMPTY"
        assert result.get("freshness") == "MISSING"
        assert result.get("stale") is False
        assert result.get("cache_status") == market_kline_cache.KLINE_CACHE_STATUS_PROVIDER_EMPTY
        assert result.get("history_incomplete") is True
        assert result.get("provider_error_code") == market_kline_cache.KLINE_PROVIDER_ERROR_EMPTY
        assert result["items"] == []
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_kline_history_provider_unavailable_downgrades_repeated_warning() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    class CaptureLogger:
        def __init__(self) -> None:
            self.warning_calls: list[tuple[str, tuple]] = []
            self.debug_calls: list[tuple[str, tuple]] = []

        def warning(self, message: str, *args, **kwargs) -> None:
            self.warning_calls.append((message, args))

        def debug(self, message: str, *args, **kwargs) -> None:
            self.debug_calls.append((message, args))

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    capture_logger = CaptureLogger()

    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_provider_symbol = market._spot_provider_symbol
    original_request_config = market._spot_provider_request_config
    original_fetch_okx_klines = market._fetch_okx_spot_klines
    original_mark_failure = market.mark_contract_market_provider_failure
    original_last_good_enabled = market.contract_market_last_good_enabled
    original_logger = market.logger
    original_throttle = dict(market._SPOT_PROVIDER_LOG_THROTTLE)
    try:
        market._SPOT_PROVIDER_LOG_THROTTLE.clear()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market._spot_provider_symbol = lambda *args, **kwargs: "BTCUSDT"
        market._spot_provider_request_config = lambda provider_config, **kwargs: provider_config
        market._fetch_okx_spot_klines = lambda *args, **kwargs: []
        market.mark_contract_market_provider_failure = lambda *args, **kwargs: None
        market.contract_market_last_good_enabled = lambda db: False
        market.logger = capture_logger

        for _ in range(2):
            try:
                market._fetch_external_spot_klines(
                    None,
                    Pair(),
                    interval="1Mutc",
                    limit=30,
                    end_time_ms=1514764800000,
                )
            except market.KlineProviderFetchError:
                pass

        assert capture_logger.warning_calls == []
        assert len(capture_logger.debug_calls) == 1
        assert capture_logger.debug_calls[0][0].startswith("spot_provider_kline_history_unavailable")
    finally:
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market._spot_provider_symbol = original_provider_symbol
        market._spot_provider_request_config = original_request_config
        market._fetch_okx_spot_klines = original_fetch_okx_klines
        market.mark_contract_market_provider_failure = original_mark_failure
        market.contract_market_last_good_enabled = original_last_good_enabled
        market.logger = original_logger
        market._SPOT_PROVIDER_LOG_THROTTLE.clear()
        market._SPOT_PROVIDER_LOG_THROTTLE.update(original_throttle)


def test_kline_current_provider_unavailable_keeps_warning() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    class CaptureLogger:
        def __init__(self) -> None:
            self.warning_calls: list[tuple[str, tuple]] = []
            self.debug_calls: list[tuple[str, tuple]] = []

        def warning(self, message: str, *args, **kwargs) -> None:
            self.warning_calls.append((message, args))

        def debug(self, message: str, *args, **kwargs) -> None:
            self.debug_calls.append((message, args))

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    capture_logger = CaptureLogger()

    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_provider_symbol = market._spot_provider_symbol
    original_request_config = market._spot_provider_request_config
    original_fetch_okx_klines = market._fetch_okx_spot_klines
    original_mark_failure = market.mark_contract_market_provider_failure
    original_last_good_enabled = market.contract_market_last_good_enabled
    original_logger = market.logger
    original_throttle = dict(market._SPOT_PROVIDER_LOG_THROTTLE)
    try:
        market._SPOT_PROVIDER_LOG_THROTTLE.clear()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market._spot_provider_symbol = lambda *args, **kwargs: "BTCUSDT"
        market._spot_provider_request_config = lambda provider_config, **kwargs: provider_config
        market._fetch_okx_spot_klines = lambda *args, **kwargs: []
        market.mark_contract_market_provider_failure = lambda *args, **kwargs: None
        market.contract_market_last_good_enabled = lambda db: False
        market.logger = capture_logger

        for _ in range(2):
            try:
                market._fetch_external_spot_klines(
                    None,
                    Pair(),
                    interval="1Mutc",
                    limit=30,
                    end_time_ms=None,
                )
            except market.KlineProviderFetchError:
                pass

        assert len(capture_logger.warning_calls) == 1
        assert capture_logger.warning_calls[0][0].startswith("spot_provider_kline_failed")
        assert capture_logger.debug_calls == []
    finally:
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market._spot_provider_symbol = original_provider_symbol
        market._spot_provider_request_config = original_request_config
        market._fetch_okx_spot_klines = original_fetch_okx_klines
        market.mark_contract_market_provider_failure = original_mark_failure
        market.contract_market_last_good_enabled = original_last_good_enabled
        market.logger = original_logger
        market._SPOT_PROVIDER_LOG_THROTTLE.clear()
        market._SPOT_PROVIDER_LOG_THROTTLE.update(original_throttle)


def test_kline_monthly_history_db_cache_keeps_monthly_metadata() -> None:
    class Pair:
        symbol = "ETHUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    end_time_ms = _ms(2026, 4, 1, 0)
    items = [
        {
            "open_time": _ms(2026, month, 1, 0),
            "close_time": _ms(2026, month + 1, 1, 0),
            "open": "1",
            "high": "2",
            "low": "1",
            "close": "1.5",
            "volume": "5",
            "quote_volume": "7.5",
        }
        for month in (1, 2, 3)
    ]

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("historical pagination must not read LIVE_WS kline")
        )
        market.get_klines_cache_first = lambda *args, **kwargs: _kline_cache_result(
            items,
            origin=market_kline_cache.KLINE_CACHE_ORIGIN_DB_CACHE,
            cache_status=market_kline_cache.KLINE_CACHE_STATUS_HIT,
            history_incomplete=False,
        )

        result = market.get_klines(None, "ETHUSDT", "1Mutc", limit=60, end_time_ms=end_time_ms)

        assert result.get("source") == "DB_CACHE"
        assert result.get("freshness") == "CACHED"
        assert result.get("cache_status") == market_kline_cache.KLINE_CACHE_STATUS_HIT
        assert result.get("history_incomplete") is False
        assert result["interval"] == "1Mutc"
        assert [item["open_time"] for item in result["items"]] == [item["open_time"] for item in items]
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_okx_1d_history_pagination_uses_anchor_validator_without_live_ws() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    end_time_ms = 1_759_680_000_000
    valid_open_time = end_time_ms - 86_400_000

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("historical pagination must not read LIVE_WS kline")
        )

        def cache_first(*args, **kwargs):
            validator = kwargs.get("open_time_validator")
            assert validator is not None
            assert validator(valid_open_time)
            assert not validator(1_759_708_800_000)
            assert kwargs["interval"] == "1d"
            assert kwargs["end_time_ms"] == end_time_ms
            return [
                {
                    "open_time": valid_open_time,
                    "close_time": end_time_ms,
                    "open": "1",
                    "high": "2",
                    "low": "1",
                    "close": "1.5",
                    "volume": "5",
                    "quote_volume": "7.5",
                }
            ]

        market.get_klines_cache_first = cache_first

        result = market.get_klines(None, "BTCUSDT", "1d", limit=30, end_time_ms=end_time_ms)
        assert result.get("source") == "REST_HISTORY"
        assert result.get("freshness") == "RECENT"
        assert result["provider"] == market.PROVIDER_OKX_SPOT
        assert all(item["open_time"] < end_time_ms for item in result["items"])
        assert result["items"][-1]["open_time"] == valid_open_time
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_okx_weekly_monthly_kline_mapping_uses_provider_candles() -> None:
    assert market._spot_interval_value(market.PROVIDER_OKX_SPOT, "1w") == "1W"
    assert market._spot_interval_value(market.PROVIDER_OKX_SPOT, "1W") == "1W"
    assert market._spot_interval_value(market.PROVIDER_OKX_SPOT, "1M") == "1M"
    assert market._spot_interval_value(market.PROVIDER_OKX_SPOT, "1m") == "1m"

    assert market._spot_kline_extra_params(market.PROVIDER_OKX_SPOT, "1w", None) == {"bar": "1W"}
    assert market._spot_kline_extra_params(market.PROVIDER_OKX_SPOT, "1M", None) == {"bar": "1M"}
    assert market._spot_kline_extra_params(market.PROVIDER_OKX_SPOT, "1w", 12345) == {
        "bar": "1W",
        "after": 12345,
    }
    assert market._spot_kline_extra_params(market.PROVIDER_OKX_SPOT, "1M", 12345) == {
        "bar": "1M",
        "after": 12345,
    }


def test_okx_weekly_monthly_history_pagination_uses_anchor_validator_without_live_ws() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    provider = _spot_provider(market.PROVIDER_OKX_SPOT)
    cases = [
        ("1W", "1w", _ms(2026, 2, 15, 16), _ms(2026, 2, 8, 16), _ms(2026, 2, 9, 0)),
        ("1M", "1M", _ms(2026, 3, 31, 16), _ms(2026, 2, 28, 16), _ms(2026, 3, 1, 0)),
    ]

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (provider,)
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("historical pagination must not read LIVE_WS kline")
        )

        for requested_interval, normalized_interval, end_time_ms, valid_open_time, invalid_open_time in cases:
            def cache_first(*args, **kwargs):
                validator = kwargs.get("open_time_validator")
                assert validator is not None
                assert validator(valid_open_time)
                assert not validator(invalid_open_time)
                assert kwargs["interval"] == normalized_interval
                assert kwargs["end_time_ms"] == end_time_ms
                return [
                    {
                        "open_time": valid_open_time,
                        "close_time": end_time_ms,
                        "open": "1",
                        "high": "2",
                        "low": "1",
                        "close": "1.5",
                        "volume": "5",
                        "quote_volume": "7.5",
                    }
                ]

            market.get_klines_cache_first = cache_first

            result = market.get_klines(
                None,
                "BTCUSDT",
                requested_interval,
                limit=30,
                end_time_ms=end_time_ms,
            )
            assert result.get("source") == "REST_HISTORY"
            assert result.get("freshness") == "RECENT"
            assert result["interval"] == normalized_interval
            assert all(item["open_time"] < end_time_ms for item in result["items"])
            assert result["items"][-1]["open_time"] == valid_open_time
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_okx_primary_klines_use_okx_live_ws_without_bitget_cache() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
        )
        market.get_spot_provider_ws_klines = lambda symbol, interval, **kwargs: (
            {
                "symbol": "BTCUSDT",
                "interval": "1m",
                "provider": market.PROVIDER_OKX_SPOT,
                "source": "LIVE_WS",
                "freshness": "LIVE",
                "updated_at": "2026-07-05T00:00:00",
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
            if kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            else (_ for _ in ()).throw(AssertionError("must not steal Bitget kline LIVE_WS when OKX is primary"))
        )
        def cache_first(*args, **kwargs):
            market._SPOT_LAST_GOOD_KLINES[(Pair.symbol, kwargs["interval"])] = {
                "provider": market.PROVIDER_OKX_SPOT,
                "updated_at": "2026-07-05T00:00:00",
            }
            return [
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

        market.get_klines_cache_first = cache_first

        result = market.get_klines(None, "BTCUSDT", "1m", limit=30)
        assert result.get("source") == "LIVE_WS"
        assert result.get("freshness") == "LIVE"
        assert result["provider"] == market.PROVIDER_OKX_SPOT
        assert result["items"][-1]["close"] == "2.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first


def test_okx_primary_kline_live_ws_miss_falls_back_to_okx_rest() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    original_get_active_pair = market._get_active_pair
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    original_spot_provider_symbol = market._spot_provider_symbol
    original_request_json = market.request_contract_market_provider_json
    original_mark_success = market.mark_contract_market_provider_success
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
        )
        market.get_spot_provider_ws_klines = lambda symbol, interval, **kwargs: (
            None
            if kwargs.get("provider") == market.PROVIDER_OKX_SPOT
            else (_ for _ in ()).throw(AssertionError("must not steal Bitget kline LIVE_WS when OKX is primary"))
        )
        market.get_klines_cache_first = lambda *args, **kwargs: kwargs["fetch_external"](
            kwargs["limit"],
            kwargs.get("end_time_ms"),
        )
        market._spot_provider_symbol = lambda *args, **kwargs: "BTC-USDT"
        market.mark_contract_market_provider_success = lambda *args, **kwargs: None

        def request_json(provider, endpoint_type, provider_symbol, **kwargs):
            assert provider.provider_code == market.PROVIDER_OKX_SPOT
            assert endpoint_type == "kline"
            assert provider_symbol == "BTC-USDT"
            assert kwargs["extra_params"] == {"bar": "1m"}
            return {
                "data": [
                    ["60000", "1", "2", "1", "1.5", "5", "7.5", "7.5", "1"],
                ]
            }

        market.request_contract_market_provider_json = request_json

        result = market.get_klines(None, "BTCUSDT", "1m", limit=30)
        assert result.get("source") == "REST_SNAPSHOT"
        assert result.get("freshness") == "RECENT"
        assert result["provider"] == market.PROVIDER_OKX_SPOT
        assert result["items"][-1]["close"] == "1.5"
    finally:
        market._get_active_pair = original_get_active_pair
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market.get_klines_cache_first = original_get_klines_cache_first
        market._spot_provider_symbol = original_spot_provider_symbol
        market.request_contract_market_provider_json = original_request_json
        market.mark_contract_market_provider_success = original_mark_success


def test_okx_historical_klines_use_history_candles_after_pagination() -> None:
    class Pair:
        symbol = "BTCUSDT"
        data_source = market.DATA_SOURCE_BINANCE
        price_precision = 2
        amount_precision = 3

    calls: list[tuple[str, int, dict]] = []
    original_enabled_providers = market._enabled_spot_market_providers_for_pair
    original_spot_provider_symbol = market._spot_provider_symbol
    original_request_json = market.request_contract_market_provider_json
    original_mark_success = market.mark_contract_market_provider_success
    try:
        market._enabled_spot_market_providers_for_pair = lambda *args, **kwargs: (
            _spot_provider(market.PROVIDER_OKX_SPOT, priority=1),
            _spot_provider(market.PROVIDER_BITGET_SPOT, priority=2),
        )
        market._spot_provider_symbol = lambda *args, **kwargs: "BTC-USDT"
        market.mark_contract_market_provider_success = lambda *args, **kwargs: None

        def row(open_time: int) -> list[str]:
            return [str(open_time), "1", "2", "1", "1.5", "5", "7.5", "7.5", "1"]

        def request_json(provider, endpoint_type, provider_symbol, **kwargs):
            assert provider.provider_code == market.PROVIDER_OKX_SPOT
            assert provider_symbol == "BTC-USDT"
            calls.append((endpoint_type, kwargs["limit"], dict(kwargs["extra_params"])))
            if len(calls) == 1:
                assert endpoint_type == "kline_history"
                assert kwargs["extra_params"]["after"] == 20_000_000
                return {"data": [row(19_999_000 - index * 60_000) for index in range(300)]}
            if len(calls) == 2:
                assert endpoint_type == "kline_history"
                assert kwargs["extra_params"]["after"] < 20_000_000
                duplicate_open_time = 19_999_000 - 301 * 60_000
                return {
                    "data": [row(duplicate_open_time)]
                    + [row(19_999_000 - 300 * 60_000 - index * 60_000) for index in range(5)]
                }
            assert endpoint_type == "kline_history"
            assert kwargs["extra_params"]["after"] < 20_000_000
            return {"data": []}

        market.request_contract_market_provider_json = request_json

        items = market._fetch_external_spot_klines(
            None,
            Pair(),
            interval="1m",
            limit=306,
            end_time_ms=20_000_000,
            fast=True,
        )
        assert len(items) == 305
        assert [item["open_time"] for item in items] == sorted(item["open_time"] for item in items)
        assert len({item["open_time"] for item in items}) == len(items)
        assert all(item["open_time"] < 20_000_000 for item in items)
        assert calls[0][0] == "kline_history"
        assert calls[0][1] == 300
        assert calls[1][0] == "kline_history"
        assert calls[1][1] == 6
        assert calls[2][0] == "kline_history"
        assert calls[2][1] == 1
    finally:
        market._enabled_spot_market_providers_for_pair = original_enabled_providers
        market._spot_provider_symbol = original_spot_provider_symbol
        market.request_contract_market_provider_json = original_request_json
        market.mark_contract_market_provider_success = original_mark_success


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
    original_request_json = market.request_contract_market_provider_json
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
        market.request_contract_market_provider_json = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("internal pair must not request external OKX history-candles")
        )

        result = market.get_klines(None, "MFCUSDT", "1m", limit=30)
        assert result["symbol"] == "MFCUSDT"
        assert result["source"] == "INTERNAL"
        assert result["freshness"] == "RECENT"
        assert result["items"][0]["close"] == "1"
    finally:
        market._get_active_pair = original_get_active_pair
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market._get_internal_klines = original_get_internal_klines
        market.get_klines_cache_first = original_get_klines_cache_first
        market.request_contract_market_provider_json = original_request_json


def test_internal_weekly_monthly_klines_return_safe_empty_state() -> None:
    class Pair:
        symbol = "MFCUSDT"
        data_source = market.DATA_SOURCE_INTERNAL
        price_precision = 2
        amount_precision = 3

    original_get_active_pair = market._get_active_pair
    original_get_ws_klines = market.get_spot_provider_ws_klines
    original_get_internal_klines = market._get_internal_klines
    original_get_klines_cache_first = market.get_klines_cache_first
    original_request_json = market.request_contract_market_provider_json
    try:
        market._get_active_pair = lambda db, symbol: Pair()
        market.get_spot_provider_ws_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("internal pair must not read external LIVE_WS klines")
        )
        market.request_contract_market_provider_json = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("internal pair must not request external provider klines")
        )
        market._get_internal_klines = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("internal weekly/monthly klines should stay empty until aggregation is supported")
        )
        market.get_klines_cache_first = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("internal weekly/monthly klines must not read stale market_klines cache")
        )

        for interval in ("1w", "1M"):
            result = market.get_klines(None, "MFCUSDT", interval, limit=30)
            assert result["symbol"] == "MFCUSDT"
            assert result["interval"] == interval
            assert result["source"] == "INTERNAL"
            assert result["freshness"] == "MISSING"
            assert result["items"] == []
    finally:
        market._get_active_pair = original_get_active_pair
        market.get_spot_provider_ws_klines = original_get_ws_klines
        market._get_internal_klines = original_get_internal_klines
        market.get_klines_cache_first = original_get_klines_cache_first
        market.request_contract_market_provider_json = original_request_json


def test_okx_spot_precision_metadata_uses_tick_size() -> None:
    metadata = market._spot_provider_precision_metadata_from_payload(
        "OKX_SPOT",
        {"data": [{"instId": "BTC-USDT", "tickSz": "0.1"}]},
    )

    assert metadata is not None
    assert metadata["price_tick_size"] == "0.1"
    assert metadata["display_price_precision"] == 1
    assert metadata["price_precision_source"] == "PROVIDER_TICK_SIZE"
    assert metadata["price_precision_provider"] == "OKX_SPOT"


def test_bitget_spot_precision_metadata_uses_price_precision() -> None:
    metadata = market._spot_provider_precision_metadata_from_payload(
        "BITGET_SPOT",
        {"data": [{"symbol": "BTCUSDT", "pricePrecision": "2"}]},
    )

    assert metadata is not None
    assert metadata["price_tick_size"] == "0.01"
    assert metadata["display_price_precision"] == 2
    assert metadata["price_precision_source"] == "PROVIDER_TICK_SIZE"
    assert metadata["price_precision_provider"] == "BITGET_SPOT"


def test_authoritative_depth_initial_provider_uses_generation_one() -> None:
    gateway = _new_authority_test_gateway()
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    state = gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth_response(ts=1000, provider="OKX_SPOT"),
        event_time_ms=1000,
        received_at_ms=1100,
        freshness="LIVE",
        source="LIVE_WS",
    )
    assert state is not None
    assert state.provider == "OKX_SPOT"
    assert state.provider_generation == 1
    assert gateway.get_active_depth_provider("BTCUSDT") == ("OKX_SPOT", 1)


def test_authoritative_depth_fallback_switch_is_atomic_and_increments_generation() -> None:
    gateway = _new_authority_test_gateway()
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    okx = gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth_response(ts=1000, provider="OKX_SPOT"),
        event_time_ms=1000,
        received_at_ms=1100,
        freshness="LIVE",
        source="LIVE_WS",
    )
    bitget = gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        depth=_depth_response(bid_amount="2", ts=1200),
        event_time_ms=1200,
        received_at_ms=1300,
        freshness="RECENT",
        source="REST",
        allow_switch=True,
        expected_provider="OKX_SPOT",
    )
    assert okx is not None and bitget is not None
    assert bitget.provider == "BITGET_SPOT"
    assert bitget.provider_generation == 2
    assert gateway.get_active_depth_provider("BTCUSDT") == ("BITGET_SPOT", 2)


def test_incomplete_fallback_depth_cannot_switch_gateway_provider() -> None:
    gateway = _new_authority_test_gateway()
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    incomplete = DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price="99", amount="1")],
        asks=[],
        ts=1200,
        provider="BITGET_SPOT",
        source="REST",
        freshness="RECENT",
        fetched_at=1300,
    )
    state = gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        depth=incomplete,
        event_time_ms=1200,
        received_at_ms=1300,
        freshness="RECENT",
        source="REST",
        allow_switch=True,
        expected_provider="OKX_SPOT",
    )
    assert state is None
    assert gateway.get_active_depth_provider("BTCUSDT") == ("OKX_SPOT", 1)


def test_old_provider_late_depth_cannot_switch_back_after_fallback() -> None:
    gateway = _new_authority_test_gateway()
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    assert gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        depth=_depth_response(ts=1200),
        event_time_ms=1200,
        received_at_ms=1300,
        freshness="RECENT",
        source="REST",
        allow_switch=True,
        expected_provider="OKX_SPOT",
    ) is not None
    late = gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth_response(ts=1400, provider="OKX_SPOT"),
        event_time_ms=1400,
        received_at_ms=1500,
        freshness="LIVE",
        source="LIVE_WS",
    )
    assert late is None
    assert gateway.get_active_depth_provider("BTCUSDT") == ("BITGET_SPOT", 2)


def test_same_provider_older_event_cannot_rollback_authoritative_depth() -> None:
    gateway = _new_authority_test_gateway()
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    assert gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth_response(bid_amount="2", ts=2000, provider="OKX_SPOT"),
        event_time_ms=2000,
        received_at_ms=2100,
        freshness="LIVE",
        source="LIVE_WS",
    ) is not None
    assert gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth_response(bid_amount="1", ts=1000, provider="OKX_SPOT"),
        event_time_ms=1000,
        received_at_ms=2200,
        freshness="LIVE",
        source="LIVE_WS",
    ) is None
    state = gateway.get_authoritative_depth("BTCUSDT")
    assert state is not None
    assert state.event_time_ms == 2000
    assert state.depth.bids[0].amount == "2"


def test_provider_switch_releases_old_ws_owner_and_ensures_new_provider() -> None:
    gateway = _new_authority_test_gateway()
    calls = []
    gateway._release_depth_accepts_provider = True
    gateway._release_kline_accepts_provider = True
    gateway._ensure_depth_accepts_provider = True
    gateway._ensure_kline_accepts_provider = True
    gateway._release_depth = lambda symbol, provider: calls.append(("release", provider, symbol))
    gateway._release_kline = lambda symbol, interval, provider: calls.append(
        ("release_kline", provider, symbol, interval)
    )
    gateway._ensure_depth = lambda symbol, provider: calls.append(("ensure_depth", provider, symbol))
    gateway._ensure_kline = lambda symbol, interval, provider: calls.append(
        ("ensure_kline", provider, symbol, interval)
    )
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    gateway._symbol_providers["BTCUSDT"] = "OKX_SPOT"
    gateway._ensured_kline_intervals["BTCUSDT"] = {"1Dutc", "1Wutc", "1Mutc"}
    old_kline_keys = {
        gateway._domain_key(
            "kline",
            "BTCUSDT",
            provider="OKX_SPOT",
            interval=interval,
        )
        for interval in gateway._ensured_kline_intervals["BTCUSDT"]
    }
    for key in old_kline_keys:
        gateway._kline_revision_high_water[key] = (1_000, 1, 1)
    assert gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        depth=_depth_response(ts=1200),
        event_time_ms=1200,
        received_at_ms=1300,
        freshness="RECENT",
        source="REST",
        allow_switch=True,
        expected_provider="OKX_SPOT",
    ) is not None
    asyncio.run(gateway._apply_pending_provider_switch("BTCUSDT"))
    assert ("release", "OKX_SPOT", "BTCUSDT") in calls
    assert ("ensure_depth", "BITGET_SPOT", "BTCUSDT") in calls
    for interval in ("1Dutc", "1Wutc", "1Mutc"):
        assert ("release_kline", "OKX_SPOT", "BTCUSDT", interval) in calls
        assert ("ensure_kline", "BITGET_SPOT", "BTCUSDT", interval) in calls
    assert all(key not in gateway._kline_revision_high_water for key in old_kline_keys)
    assert gateway.get_active_depth_provider("BTCUSDT") == ("BITGET_SPOT", 2)
    first_metrics = asyncio.run(gateway.get_metrics_snapshot())
    assert first_metrics["provider_switch"]["count"] == 1
    assert first_metrics["provider_switch"]["success"] == 1
    assert first_metrics["provider_switch"]["failed"] == 0
    assert first_metrics["provider_switch"]["last_duration_ms"] is not None

    calls.clear()
    assert gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth_response(ts=1400, provider="OKX_SPOT"),
        event_time_ms=1400,
        received_at_ms=1500,
        freshness="RECENT",
        source="REST",
        allow_switch=True,
        expected_provider="BITGET_SPOT",
    ) is not None
    asyncio.run(gateway._apply_pending_provider_switch("BTCUSDT"))
    assert ("release", "BITGET_SPOT", "BTCUSDT") in calls
    assert ("ensure_depth", "OKX_SPOT", "BTCUSDT") in calls
    for interval in ("1Dutc", "1Wutc", "1Mutc"):
        assert ("release_kline", "BITGET_SPOT", "BTCUSDT", interval) in calls
        assert ("ensure_kline", "OKX_SPOT", "BTCUSDT", interval) in calls
    assert gateway.get_active_depth_provider("BTCUSDT") == ("OKX_SPOT", 3)
    assert gateway._ensured_kline_intervals["BTCUSDT"] == {"1Dutc", "1Wutc", "1Mutc"}
    second_metrics = asyncio.run(gateway.get_metrics_snapshot())
    assert second_metrics["provider_switch"]["count"] == 2
    assert second_metrics["provider_switch"]["success"] == 2
    assert second_metrics["provider_switch"]["failed"] == 0


def test_provider_switch_lifecycle_failure_keeps_rest_depth_public_and_retries() -> None:
    gateway = _new_authority_test_gateway()
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    gateway._symbol_providers["BTCUSDT"] = "OKX_SPOT"
    gateway._release_depth_accepts_provider = True
    gateway._ensure_depth_accepts_provider = True
    gateway._release_depth = lambda symbol, provider: None
    gateway._ensure_depth = lambda symbol, provider: (_ for _ in ()).throw(RuntimeError("ensure failed"))
    switched = gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider="BITGET_SPOT",
        provider_symbol="BTCUSDT",
        depth=_depth_response(ts=1200),
        event_time_ms=1200,
        received_at_ms=1300,
        freshness="RECENT",
        source="REST",
        allow_switch=True,
        expected_provider="OKX_SPOT",
    )
    assert switched is not None
    asyncio.run(gateway._apply_pending_provider_switch("BTCUSDT"))
    public_state = gateway.get_authoritative_depth("BTCUSDT")
    assert public_state is not None
    assert public_state.provider == "BITGET_SPOT"
    assert public_state.provider_generation == 2
    assert public_state.depth.bids[0].price == switched.depth.bids[0].price
    assert gateway._symbol_providers["BTCUSDT"] == "BITGET_SPOT"
    assert gateway._pending_provider_switches["BTCUSDT"] == ("OKX_SPOT", "BITGET_SPOT")
    metrics = asyncio.run(gateway.get_metrics_snapshot())
    assert metrics["provider_switch"]["count"] == 1
    assert metrics["provider_switch"]["success"] == 0
    assert metrics["provider_switch"]["failed"] == 1
    assert metrics["provider_switch"]["last_duration_ms"] is not None


def test_concurrent_fallback_candidates_cannot_publish_retired_generation() -> None:
    gateway = _new_authority_test_gateway()
    gateway._depth_authority.ensure_provider("BTCUSDT", "OKX_SPOT")
    gateway._symbol_providers["BTCUSDT"] = "OKX_SPOT"
    barrier = Barrier(2)

    def switch(provider: str, event_time_ms: int):
        barrier.wait()
        return gateway.commit_authoritative_depth(
            symbol="BTCUSDT",
            provider=provider,
            provider_symbol="BTCUSDT",
            depth=_depth_response(ts=event_time_ms, provider=provider),
            event_time_ms=event_time_ms,
            received_at_ms=event_time_ms + 1,
            freshness="RECENT",
            source="REST",
            allow_switch=True,
            expected_provider="OKX_SPOT",
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda args: switch(*args),
                (("BITGET_SPOT", 1200), ("BINANCE_SPOT", 1300)),
            )
        )
    accepted = [result for result in results if result is not None]
    assert len(accepted) == 1
    public_state = gateway.get_authoritative_depth("BTCUSDT")
    assert public_state is not None
    assert public_state.provider == accepted[0].provider
    assert public_state.provider_generation == accepted[0].provider_generation == 2


def test_gateway_metrics_snapshot_summarizes_symbols_intervals_subscribers_and_broadcasts() -> None:
    async def run() -> None:
        gateway = _new_test_gateway()
        ws_manager = gateway._ws_manager
        empty = await gateway.get_metrics_snapshot()
        assert empty["active_symbol_count"] == 0
        assert empty["active_interval_count"] == 0
        assert empty["active_refresh_loop_count"] == 0
        assert empty["subscriber_count"] == 0
        assert empty["broadcast"]["total_count"] == 0

        ws_manager.count = 3
        gateway._symbol_providers["BTCUSDT"] = "BITGET_SPOT"
        gateway._depth_authority.ensure_provider("BTCUSDT", "BITGET_SPOT")
        gateway._ensured_kline_intervals["BTCUSDT"] = {"1m", "5m"}
        refresh_task = asyncio.create_task(asyncio.sleep(60))
        gateway._tasks["BTCUSDT"] = refresh_task
        gateway._remember_broadcast_metric("BTCUSDT", "depth")
        gateway._remember_broadcast_metric("BTCUSDT", "ticker")
        try:
            snapshot = await gateway.get_metrics_snapshot()
        finally:
            refresh_task.cancel()
            await asyncio.gather(refresh_task, return_exceptions=True)

        assert snapshot["active_symbol_count"] == 1
        assert snapshot["active_interval_count"] == 2
        assert snapshot["active_refresh_loop_count"] == 1
        assert snapshot["subscriber_count"] == 3
        assert snapshot["active_intervals"] == {"BTCUSDT": ["1m", "5m"]}
        assert snapshot["broadcast"]["total_count"] == 2
        assert snapshot["broadcast"]["per_domain_count"]["depth"] == 1
        assert snapshot["broadcast"]["per_domain_count"]["ticker"] == 1
        assert snapshot["latency"]["available"] is False
        assert snapshot["latency"]["cache_to_gateway_ms"] is None

    asyncio.run(run())


def test_gateway_metrics_count_required_preview_reject_reasons_by_symbol() -> None:
    class RejectingPreviewEngine:
        def __init__(self) -> None:
            self.statuses = iter(
                (
                    SpotPreviewTradeStatus.NO_BASELINE,
                    SpotPreviewTradeStatus.GENERATION_MISMATCH,
                    SpotPreviewTradeStatus.OPEN_TIME_MISMATCH,
                )
            )

        def accept_trade(self, payload):
            status = next(self.statuses)
            return type("PreviewResult", (), {"status": status, "preview": None})()

    async def run() -> None:
        gateway = _new_test_gateway()
        gateway._candle_preview_engine = RejectingPreviewEngine()
        gateway._get_kline_generation = lambda symbol, interval, **kwargs: 7

        for trade_id in ("trade-1", "trade-2", "trade-3"):
            await gateway._accept_and_broadcast_candle_preview_trade(
                symbol="BTCUSDT",
                provider="OKX_SPOT",
                provider_trade_id=trade_id,
                price="100",
                amount="1",
                event_time_ms=1_695_709_800_000,
                received_at_ms=1_695_709_800_001,
            )

        snapshot = await gateway.get_metrics_snapshot()
        expected = {
            "NO_BASELINE": 1,
            "GENERATION_MISMATCH": 1,
            "OPEN_TIME_MISMATCH": 1,
        }
        assert snapshot["candle_preview"]["reject_counts"] == expected
        assert snapshot["candle_preview"]["reject_counts_by_symbol"] == {
            "BTCUSDT": expected
        }

    asyncio.run(run())


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_market_gateway tests passed")
