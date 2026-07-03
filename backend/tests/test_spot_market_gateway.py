from __future__ import annotations

import asyncio

from app.schemas.market import DepthItem, DepthResponse
from app.services import market
from app.services.spot_market_gateway import SpotMarketGateway


class FakeWsManager:
    def __init__(self) -> None:
        self.count = 0
        self.broadcasts: list[tuple[str, DepthResponse]] = []

    async def subscriber_count(self, symbol: str) -> int:
        return self.count

    async def broadcast_depth_update(self, symbol: str, depth: DepthResponse) -> None:
        self.broadcasts.append((symbol, depth))


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


def test_gateway_subscriber_count_and_idle_release() -> None:
    async def run() -> None:
        ws_manager = FakeWsManager()
        provider = FakeProvider()
        gateway = SpotMarketGateway(
            provider_depth_enabled=lambda: True,
            ensure_depth=provider.ensure,
            release_depth=provider.release,
            get_depth=provider.get_depth,
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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot_market_gateway tests passed")
