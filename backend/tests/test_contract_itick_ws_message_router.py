from __future__ import annotations

import json

from app.services.contract_itick_ws_message_router import ItickWsMessageRouter


def test_router_dispatches_only_matching_market_symbol_and_stream():
    router = ItickWsMessageRouter()
    received: list[str] = []
    router.register(
        market="forex",
        provider_symbol="EURUSD$GB",
        stream="kline@1",
        consumer_id="EURUSD_PERP:1m",
        handler=lambda _message: received.append("eur-kline"),
    )
    router.register(
        market="forex",
        provider_symbol="XAUUSD$GB",
        stream="kline@1",
        consumer_id="XAUUSDT_PERP:1m",
        handler=lambda _message: received.append("xau-kline"),
    )

    count = router.dispatch(
        "forex",
        json.dumps({"code": 1, "data": {"s": "eurusd", "r": "GB", "type": "kline@1", "c": 1.1}}),
    )

    assert count == 1
    assert received == ["eur-kline"]


def test_router_supports_multiple_consumers_without_duplicate_registration_keys():
    router = ItickWsMessageRouter()
    received: list[str] = []
    for consumer in ("chart", "header"):
        router.register(
            market="stock",
            provider_symbol="AAPL",
            stream="quote",
            consumer_id=consumer,
            handler=lambda _message, item=consumer: received.append(item),
        )
    router.register(
        market="stock",
        provider_symbol="AAPL",
        stream="quote",
        consumer_id="chart",
        handler=lambda _message: received.append("chart-new"),
    )

    assert router.registered_count() == 2
    assert router.dispatch("stock", {"data": {"s": "AAPL", "type": "quote"}}) == 2
    assert sorted(received) == ["chart-new", "header"]


def test_unregister_prevents_late_socket_frames_from_reaching_old_symbol():
    router = ItickWsMessageRouter()
    received: list[str] = []
    registration = {
        "market": "forex",
        "provider_symbol": "EURUSD",
        "stream": "depth",
        "consumer_id": "EURUSD_PERP",
    }
    router.register(**registration, handler=lambda _message: received.append("late"))
    router.unregister(**registration)

    assert router.dispatch("forex", {"data": {"s": "EURUSD", "type": "depth", "a": [], "b": []}}) == 0
    assert received == []


def test_router_ignores_auth_heartbeat_invalid_json_and_cross_market_frames():
    router = ItickWsMessageRouter()
    router.register(
        market="forex",
        provider_symbol="EURUSD",
        stream="tick",
        consumer_id="EURUSD_PERP",
        handler=lambda _message: None,
    )

    assert router.dispatch("forex", "not-json") == 0
    assert router.dispatch("forex", {"resAc": "auth", "data": {"params": None}}) == 0
    assert router.dispatch("stock", {"data": {"s": "EURUSD", "type": "tick"}}) == 0
