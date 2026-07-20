from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

from starlette.websockets import WebSocketDisconnect


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.contract_market_ws import (
    ContractMarketWsManager,
    WebSocketState,
    contract_ws_payload_action,
    handle_contract_ws_domain_command,
    handle_contract_ws_legacy_subscribe,
)
from app.routers import contract_market as contract_market_router


def test_domain_and_legacy_action_fields_are_both_supported() -> None:
    assert contract_ws_payload_action({"op": "subscribe", "domain": "market"}) == "subscribe"
    assert contract_ws_payload_action({"type": "subscribe", "interval": "1M"}) == "subscribe"


class WebSocketStub:
    application_state = WebSocketState.CONNECTED
    client_state = WebSocketState.CONNECTED

    def __init__(self) -> None:
        self.sent_text: list[str] = []

    async def send_text(self, payload: str) -> None:
        self.sent_text.append(payload)


class ManagerStub:
    def __init__(self) -> None:
        self.domain_calls: list[tuple[str, str, str | None]] = []
        self.legacy_calls: list[tuple[str, str | None, bool]] = []
        self.sent: list[dict[str, Any]] = []

    async def subscribe_domain(
        self,
        symbol: str,
        _websocket: Any,
        domain: str,
        *,
        interval: str | None = None,
    ) -> None:
        self.domain_calls.append((symbol, domain, interval))

    async def unsubscribe_domain(
        self,
        _websocket: Any,
        domain: str,
        *,
        interval: str | None = None,
    ) -> None:
        self.domain_calls.append(("unsubscribe", domain, interval))

    async def connect(
        self,
        symbol: str,
        _websocket: Any,
        *,
        interval: str | None = None,
        accepted: bool = False,
        legacy: bool = True,
    ) -> None:
        assert accepted is True
        self.legacy_calls.append((symbol, interval, legacy))

    async def send_to_one(self, _websocket: Any, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class GatewayStub:
    def __init__(self) -> None:
        self.market_calls: list[str] = []
        self.kline_calls: list[tuple[str, str]] = []
        self.legacy_calls: list[tuple[str, str]] = []
        self.ensure_calls: list[str] = []
        self.release_calls: list[str] = []

    async def market_snapshot(self, symbol: str) -> dict[str, Any]:
        self.market_calls.append(symbol)
        return {
            "type": "contract_market_snapshot",
            "domain": "market",
            "symbol": symbol,
            "data": {
                "quote": {"symbol": symbol},
                "depth": {"symbol": symbol},
                "trades": [],
                "market_state": {"symbol": symbol},
            },
        }

    async def kline_snapshot(self, symbol: str, interval: str) -> dict[str, Any]:
        self.kline_calls.append((symbol, interval))
        return {
            "type": "contract_kline_snapshot",
            "domain": "kline",
            "symbol": symbol,
            "interval": interval,
            "kline": {"symbol": symbol, "interval": interval},
        }

    async def snapshot(self, symbol: str, interval: str) -> dict[str, Any]:
        self.legacy_calls.append((symbol, interval))
        return {
            "type": "contract_market_snapshot",
            "symbol": symbol,
            "interval": interval,
        }

    async def ensure_symbol(self, symbol: str) -> None:
        self.ensure_calls.append(symbol)

    async def release_symbol_if_idle(self, symbol: str) -> None:
        self.release_calls.append(symbol)


def test_market_domain_subscribe_returns_only_market_domains() -> None:
    async def scenario() -> None:
        manager = ManagerStub()
        gateway = GatewayStub()
        websocket = object()

        result = await handle_contract_ws_domain_command(
            action="subscribe",
            payload={"op": "subscribe", "domain": "market", "symbol": "BTCUSDT_PERP"},
            websocket=websocket,
            manager=manager,
            gateway=gateway,
            connected_symbol="BTCUSDT_PERP",
            connected_interval="1m",
        )

        assert result == ("BTCUSDT_PERP", "1m")
        assert gateway.market_calls == ["BTCUSDT_PERP"]
        assert gateway.kline_calls == []
        assert gateway.legacy_calls == []
        assert manager.domain_calls == [("BTCUSDT_PERP", "market", None)]
        data = manager.sent[0]["data"]
        assert set(data) == {"quote", "depth", "trades", "market_state"}
        assert "klines" not in data

    asyncio.run(scenario())


def test_kline_domain_interval_switch_never_calls_market_or_legacy_snapshot() -> None:
    async def scenario() -> None:
        manager = ManagerStub()
        gateway = GatewayStub()
        websocket = object()
        symbol = "BTCUSDT_PERP"

        state = await handle_contract_ws_domain_command(
            action="subscribe",
            payload={"op": "subscribe", "domain": "kline", "symbol": symbol, "interval": "1M"},
            websocket=websocket,
            manager=manager,
            gateway=gateway,
            connected_symbol=symbol,
            connected_interval="1m",
        )
        assert state == (symbol, "1M")

        state = await handle_contract_ws_domain_command(
            action="subscribe",
            payload={"op": "subscribe", "domain": "kline", "symbol": symbol, "interval": "5m"},
            websocket=websocket,
            manager=manager,
            gateway=gateway,
            connected_symbol=state[0],
            connected_interval=state[1],
        )

        assert state == (symbol, "5m")
        assert gateway.kline_calls == [(symbol, "1M"), (symbol, "5m")]
        assert gateway.market_calls == []
        assert gateway.legacy_calls == []
        assert [payload["type"] for payload in manager.sent] == [
            "contract_kline_snapshot",
            "contract_kline_snapshot",
        ]

    asyncio.run(scenario())


def test_legacy_subscribe_still_uses_full_snapshot() -> None:
    async def scenario() -> None:
        manager = ManagerStub()
        gateway = GatewayStub()
        websocket = object()

        result = await handle_contract_ws_legacy_subscribe(
            action="subscribe",
            payload={"type": "subscribe", "symbol": "BTCUSDT_PERP", "interval": "1M"},
            websocket=websocket,
            manager=manager,
            gateway=gateway,
            connected_symbol="BTCUSDT_PERP",
            connected_interval="1m",
        )

        assert result == ("BTCUSDT_PERP", "1M")
        assert manager.legacy_calls == [("BTCUSDT_PERP", "1M", True)]
        assert gateway.legacy_calls == [("BTCUSDT_PERP", "1M")]
        assert gateway.market_calls == []
        assert gateway.kline_calls == []
        assert manager.sent[0]["type"] == "contract_market_snapshot"

    asyncio.run(scenario())


def test_domain_subscribe_prewarms_gateway_before_snapshot() -> None:
    async def scenario() -> None:
        events: list[str] = []

        class OrderedManager(ManagerStub):
            async def subscribe_domain(self, *args: Any, **kwargs: Any) -> None:
                events.append("subscribe")
                await super().subscribe_domain(*args, **kwargs)

            async def send_to_one(self, *args: Any, **kwargs: Any) -> None:
                events.append("send")
                await super().send_to_one(*args, **kwargs)

        class OrderedGateway(GatewayStub):
            async def ensure_symbol(self, symbol: str) -> None:
                events.append("ensure")
                await super().ensure_symbol(symbol)

            async def market_snapshot(self, symbol: str) -> dict[str, Any]:
                events.append("snapshot")
                return await super().market_snapshot(symbol)

        result = await handle_contract_ws_domain_command(
            action="subscribe",
            payload={"op": "subscribe", "domain": "market", "symbol": "BTCUSDT_PERP"},
            websocket=object(),
            manager=OrderedManager(),
            gateway=OrderedGateway(),
            connected_symbol="BTCUSDT_PERP",
            connected_interval="1m",
        )

        assert result == ("BTCUSDT_PERP", "1m")
        assert events == ["subscribe", "ensure", "snapshot", "send"]

    asyncio.run(scenario())


def test_legacy_subscribe_prewarms_gateway_before_snapshot() -> None:
    async def scenario() -> None:
        events: list[str] = []

        class OrderedManager(ManagerStub):
            async def connect(self, *args: Any, **kwargs: Any) -> None:
                events.append("connect")
                await super().connect(*args, **kwargs)

            async def send_to_one(self, *args: Any, **kwargs: Any) -> None:
                events.append("send")
                await super().send_to_one(*args, **kwargs)

        class OrderedGateway(GatewayStub):
            async def ensure_symbol(self, symbol: str) -> None:
                events.append("ensure")
                await super().ensure_symbol(symbol)

            async def snapshot(self, symbol: str, interval: str) -> dict[str, Any]:
                events.append("snapshot")
                return await super().snapshot(symbol, interval)

        result = await handle_contract_ws_legacy_subscribe(
            action="subscribe",
            payload={"type": "subscribe", "symbol": "BTCUSDT_PERP", "interval": "1m"},
            websocket=object(),
            manager=OrderedManager(),
            gateway=OrderedGateway(),
            connected_symbol="BTCUSDT_PERP",
            connected_interval="1m",
        )

        assert result == ("BTCUSDT_PERP", "1m")
        assert events == ["connect", "ensure", "snapshot", "send"]

    asyncio.run(scenario())


def test_public_ws_treats_disconnect_during_domain_snapshot_as_normal_cleanup() -> None:
    class DisconnectingWebSocket:
        def __init__(self) -> None:
            self.receive_count = 0

        async def receive(self) -> dict[str, Any]:
            self.receive_count += 1
            return {
                "type": "websocket.receive",
                "text": json.dumps({
                    "op": "subscribe",
                    "domain": "market",
                    "symbol": "BTCUSDT_PERP",
                }),
            }

    class DisconnectingManager(ManagerStub):
        def __init__(self) -> None:
            super().__init__()
            self.send_count = 0
            self.disconnect_count = 0

        async def connect(
            self,
            symbol: str,
            _websocket: Any,
            *,
            interval: str | None = None,
            accepted: bool = False,
            legacy: bool = True,
        ) -> None:
            self.legacy_calls.append((symbol, interval, legacy))

        async def send_to_one(self, _websocket: Any, payload: dict[str, Any]) -> None:
            self.send_count += 1
            if self.send_count == 2:
                raise WebSocketDisconnect(code=1006)
            self.sent.append(payload)

        async def disconnect(self, _websocket: Any) -> str:
            self.disconnect_count += 1
            return "BTCUSDT_PERP"

    async def scenario() -> None:
        manager = DisconnectingManager()
        gateway = GatewayStub()
        websocket = DisconnectingWebSocket()

        with (
            patch.object(contract_market_router, "contract_market_ws_manager", manager),
            patch.object(contract_market_router, "contract_market_gateway", gateway),
        ):
            await contract_market_router.contract_market_public_ws(
                websocket,
                symbol="BTCUSDT_PERP",
                interval="1m",
            )

        assert websocket.receive_count == 1
        assert manager.send_count == 2
        assert manager.disconnect_count == 1
        assert gateway.ensure_calls == ["BTCUSDT_PERP", "BTCUSDT_PERP"]
        assert gateway.release_calls == ["BTCUSDT_PERP"]

    asyncio.run(scenario())


def test_public_ws_prewarms_gateway_before_initial_snapshot() -> None:
    class DisconnectingWebSocket:
        async def receive(self) -> dict[str, Any]:
            raise WebSocketDisconnect(code=1000)

    async def scenario() -> None:
        events: list[str] = []

        class OrderedManager(ManagerStub):
            async def connect(
                self,
                symbol: str,
                _websocket: Any,
                *,
                interval: str | None = None,
                accepted: bool = False,
                legacy: bool = True,
            ) -> None:
                events.append("connect")
                self.legacy_calls.append((symbol, interval, legacy))

            async def send_to_one(self, *args: Any, **kwargs: Any) -> None:
                events.append("send")
                await super().send_to_one(*args, **kwargs)

            async def disconnect(self, _websocket: Any) -> str:
                events.append("disconnect")
                return "BTCUSDT_PERP"

        class OrderedGateway(GatewayStub):
            async def ensure_symbol(self, symbol: str) -> None:
                events.append("ensure")
                await super().ensure_symbol(symbol)

            async def snapshot(self, symbol: str, interval: str) -> dict[str, Any]:
                events.append("snapshot")
                return await super().snapshot(symbol, interval)

            async def release_symbol_if_idle(self, symbol: str) -> None:
                events.append("release")
                await super().release_symbol_if_idle(symbol)

        with (
            patch.object(contract_market_router, "contract_market_ws_manager", OrderedManager()),
            patch.object(contract_market_router, "contract_market_gateway", OrderedGateway()),
        ):
            await contract_market_router.contract_market_public_ws(
                DisconnectingWebSocket(),
                symbol="BTCUSDT_PERP",
                interval="1m",
            )

        assert events == [
            "connect",
            "ensure",
            "snapshot",
            "send",
            "disconnect",
            "release",
        ]

    asyncio.run(scenario())


def test_manager_transitions_legacy_socket_to_domain_filtered_lifecycle() -> None:
    async def scenario() -> None:
        manager = ContractMarketWsManager()
        websocket = WebSocketStub()
        symbol = "BTCUSDT_PERP"

        await manager.connect(symbol, websocket, interval="1M", accepted=True)
        assert await manager.market_subscriber_count(symbol) == 1
        assert await manager.subscribed_intervals(symbol) == ["1M"]

        await manager.subscribe_domain(symbol, websocket, "market")
        assert await manager.market_subscriber_count(symbol) == 1
        assert await manager.subscribed_intervals(symbol) == []

        await manager.subscribe_domain(symbol, websocket, "kline", interval="1M")
        await manager.subscribe_domain(symbol, websocket, "kline", interval="5m")
        assert await manager.subscribed_intervals(symbol) == ["5m"]

        await manager.broadcast_to_symbol(symbol, {"type": "contract_depth", "symbol": symbol})
        await manager.broadcast_to_symbol(
            symbol,
            {"type": "contract_kline_update", "symbol": symbol, "interval": "1M"},
        )
        await manager.broadcast_to_symbol(
            symbol,
            {"type": "contract_kline_update", "symbol": symbol, "interval": "5m"},
        )

        messages = [json.loads(payload) for payload in websocket.sent_text]
        assert [payload["type"] for payload in messages] == [
            "contract_depth",
            "contract_kline_update",
        ]
        assert messages[-1]["interval"] == "5m"

        await manager.unsubscribe_domain(websocket, "market")
        await manager.unsubscribe_domain(websocket, "kline", interval="5m")
        assert await manager.subscriber_count(symbol) == 0

    asyncio.run(scenario())
