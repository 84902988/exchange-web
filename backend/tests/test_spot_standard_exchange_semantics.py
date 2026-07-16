from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from app.schemas.market import DepthResponse
from app.services import market
from app.services.market_ws import MarketWsManager


class _MetricsWebSocket:
    def __init__(self, *, fail_send: bool = False, send_gate: asyncio.Event | None = None) -> None:
        self.fail_send = fail_send
        self.send_gate = send_gate
        self.send_started = asyncio.Event()
        self.sent: list[str] = []
        self.close_codes: list[int] = []

    async def send_text(self, text: str) -> None:
        self.send_started.set()
        if self.send_gate is not None:
            await self.send_gate.wait()
        if self.fail_send:
            raise RuntimeError("send failed")
        self.sent.append(text)

    async def close(self, code: int = 1000) -> None:
        self.close_codes.append(code)


async def _wait_until(predicate, *, timeout: float = 1.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() >= deadline:
            raise AssertionError("condition was not satisfied before timeout")
        await asyncio.sleep(0.001)


def _ensure_test_event_loop() -> None:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())


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
    _ensure_test_event_loop()
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


def test_spot_ws_metrics_snapshot_tracks_connections_subscriptions_fanout_and_cleanup() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op

        empty = await manager.get_metrics_snapshot()
        assert empty["connections"] == {"active": 0, "created": 0, "disconnected": 0}
        assert empty["rooms"] == {"active": 0}
        assert empty["subscriptions"] == {"symbol": 0, "kline_interval": 0, "total": 0}
        assert empty["fanout_summary"] == {
            "count": 0,
            "send_count": 0,
            "success": 0,
            "failed": 0,
            "slow_send_count": 0,
        }

        healthy = _MetricsWebSocket()
        failing = _MetricsWebSocket(fail_send=True)
        await manager.connect("BTCUSDT", healthy, accepted=True, interval="1m")
        await manager.connect("BTCUSDT", failing, accepted=True, interval="1m")
        failing_state = manager._client_send_states[failing]

        connected = await manager.get_metrics_snapshot()
        assert connected["connections"] == {"active": 2, "created": 2, "disconnected": 0}
        assert connected["rooms"]["active"] == 1
        assert connected["subscriptions"] == {"symbol": 2, "kline_interval": 2, "total": 4}

        await manager._send_payload(
            "BTCUSDT",
            {"type": "spot_ticker_update", "symbol": "BTCUSDT", "ticker": {"last_price": "1"}},
        )
        await _wait_until(
            lambda: len(healthy.sent) == 1
            and failing not in manager._client_send_states
            and failing.close_codes == [1011]
            and failing_state.cleanup_completed
        )
        await asyncio.sleep(0)
        after_fanout = await manager.get_metrics_snapshot()
        assert after_fanout["connections"]["active"] == 1
        assert after_fanout["fanout_summary"]["count"] == 1
        assert after_fanout["fanout_summary"]["send_count"] == 2
        assert after_fanout["fanout_summary"]["success"] == 1
        assert after_fanout["fanout_summary"]["failed"] == 1
        assert after_fanout["cleanup"]["dead_websocket_cleanup_count"] == 1
        assert after_fanout["send_queues"]["cleanup_count"] == 1
        assert after_fanout["send_queues"]["slow_disconnect_count"] == 0
        assert after_fanout["latency"]["max_fanout_duration_ms"] >= 0
        assert after_fanout["latency"]["max_send_duration_ms"] >= 0

        await manager.disconnect("BTCUSDT", healthy)
        released = await manager.get_metrics_snapshot()
        assert released["connections"] == {"active": 0, "created": 2, "disconnected": 1}
        assert released["cleanup"] == {
            "disconnected_clients": 1,
            "dead_websocket_cleanup_count": 1,
            "reason_counts": {"send_exception": 1},
        }

    asyncio.run(run())


def test_spot_ws_queue_full_evicts_slow_client_without_blocking_normal_client() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op

        slow_gate = asyncio.Event()
        normal = _MetricsWebSocket()
        slow = _MetricsWebSocket(send_gate=slow_gate)
        await manager.connect("BTCUSDT", normal, accepted=True, interval="1m")
        await manager.connect("BTCUSDT", slow, accepted=True, interval="1m")
        slow_state = manager._client_send_states[slow]
        slow_sender = slow_state.sender_task

        await manager._send_payload(
            "BTCUSDT",
            {
                "type": "spot_kline_update",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "kline": {"open_time": 1, "close": "1"},
            },
        )
        await asyncio.wait_for(slow.send_started.wait(), timeout=0.1)
        for price in range(2, 35):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_kline_update",
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                    "kline": {"open_time": price, "close": str(price)},
                },
            )
            await asyncio.sleep(0)

        await _wait_until(
            lambda: slow not in manager._client_send_states
            and slow.close_codes == [1013]
            and len(normal.sent) == 34
        )
        await asyncio.sleep(0)

        assert slow_sender is not None and slow_sender.done()
        assert slow_state.closing is True
        assert slow_state.slow is True
        assert slow_state.queue_full_count == 1
        assert slow_state.slow_disconnect_count == 1
        assert slow_state.queue_high_watermark == 32
        assert slow_state.mailbox.empty()

        await manager._send_payload(
            "BTCUSDT",
            {
                "type": "spot_kline_update",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "kline": {"open_time": 35, "close": "35"},
            },
        )
        await _wait_until(lambda: len(normal.sent) == 35)

        metrics = await manager.get_metrics_snapshot()
        assert metrics["connections"]["active"] == 1
        assert metrics["send_queues"]["queue_full_count"] == 1
        assert metrics["send_queues"]["queue_high_watermark"] == 32
        assert metrics["send_queues"]["send_timeout_count"] == 0
        assert metrics["send_queues"]["slow_disconnect_count"] == 1
        assert metrics["send_queues"]["slow_clients"] == 0
        assert metrics["send_queues"]["cleanup_count"] == 1
        assert metrics["send_queues"]["active_cleanup_tasks"] == 0
        assert metrics["cleanup"]["reason_counts"] == {"queue_full": 1}

        await manager.disconnect("BTCUSDT", normal)

    asyncio.run(run())


def test_spot_ws_send_timeout_isolates_same_and_other_rooms(monkeypatch) -> None:
    from app.services import market_ws as market_ws_module

    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        monkeypatch.setattr(market_ws_module, "SPOT_WS_CLIENT_SEND_TIMEOUT_SECONDS", 0.01)

        slow_gate = asyncio.Event()
        slow_btc = _MetricsWebSocket(send_gate=slow_gate)
        normal_btc = _MetricsWebSocket()
        normal_eth = _MetricsWebSocket()
        await manager.connect("BTCUSDT", slow_btc, accepted=True, interval="1m")
        await manager.connect("BTCUSDT", normal_btc, accepted=True, interval="1m")
        await manager.connect("ETHUSDT", normal_eth, accepted=True, interval="1m")
        slow_state = manager._client_send_states[slow_btc]

        await manager.broadcast_ticker_update(
            "BTCUSDT",
            {"symbol": "BTCUSDT", "last_price": "1"},
        )
        await manager.broadcast_ticker_update(
            "ETHUSDT",
            {"symbol": "ETHUSDT", "last_price": "2"},
        )
        await _wait_until(
            lambda: len(normal_btc.sent) == 1
            and len(normal_eth.sent) == 1
            and slow_btc not in manager._client_send_states
            and slow_btc.close_codes == [1013]
        )
        await asyncio.sleep(0)

        await manager.broadcast_ticker_update(
            "BTCUSDT",
            {"symbol": "BTCUSDT", "last_price": "3"},
        )
        await manager.broadcast_ticker_update(
            "ETHUSDT",
            {"symbol": "ETHUSDT", "last_price": "4"},
        )
        await _wait_until(lambda: len(normal_btc.sent) == 2 and len(normal_eth.sent) == 2)

        assert slow_state.send_timeout_count == 1
        assert slow_state.slow_disconnect_count == 1
        assert slow_state.last_send_duration_ms is not None
        metrics = await manager.get_metrics_snapshot()
        assert metrics["connections"]["active"] == 2
        assert metrics["rooms"]["active"] == 2
        assert metrics["send_queues"]["send_timeout_count"] == 1
        assert metrics["send_queues"]["slow_disconnect_count"] == 1
        assert metrics["send_queues"]["cleanup_count"] == 1
        assert metrics["send_queues"]["slow_clients"] == 0
        assert metrics["cleanup"]["reason_counts"] == {"send_timeout": 1}

        await manager.disconnect("BTCUSDT", normal_btc)
        await manager.disconnect("ETHUSDT", normal_eth)
        await manager.disconnect("BTCUSDT", slow_btc)
        final_metrics = await manager.get_metrics_snapshot()
        assert final_metrics["connections"]["active"] == 0
        assert final_metrics["send_queues"]["active_sender_tasks"] == 0

    asyncio.run(run())


def test_spot_ws_client_mailboxes_are_independent_ordered_and_cleaned_on_disconnect() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op

        slow_gate = asyncio.Event()
        fast = _MetricsWebSocket()
        slow = _MetricsWebSocket(send_gate=slow_gate)
        await manager.connect("BTCUSDT", fast, accepted=True, interval="1m")
        await manager.connect("BTCUSDT", slow, accepted=True, interval="1m")

        fast_state = manager._client_send_states[fast]
        slow_state = manager._client_send_states[slow]
        assert fast_state.mailbox is not slow_state.mailbox
        assert fast_state.mailbox.maxsize == 32
        assert slow_state.mailbox.maxsize == 32
        assert fast_state.sender_task is not None and not fast_state.sender_task.done()
        assert slow_state.sender_task is not None and not slow_state.sender_task.done()
        assert fast_state.connected_at > 0
        assert slow_state.connected_at > 0

        for price in ("1", "2", "3"):
            await asyncio.wait_for(
                manager._send_payload(
                    "BTCUSDT",
                    {
                        "type": "spot_trade",
                        "symbol": "BTCUSDT",
                        "trade": {"price": price},
                    },
                ),
                timeout=0.1,
            )

        await asyncio.wait_for(slow.send_started.wait(), timeout=0.1)
        await _wait_until(lambda: len(fast.sent) == 3)
        assert [json.loads(item)["trade"]["price"] for item in fast.sent] == ["1", "2", "3"]
        assert slow_state.queue_depth == 2
        assert fast_state.last_enqueue_at is not None
        assert fast_state.last_send_started_at is not None
        assert fast_state.last_send_completed_at is not None
        assert slow_state.last_enqueue_at is not None
        assert slow_state.last_send_started_at is not None
        assert slow_state.last_send_completed_at is None

        connected_metrics = await manager.get_metrics_snapshot()
        send_queue_metrics = dict(connected_metrics["send_queues"])
        assert send_queue_metrics.pop("last_send_duration_ms") is not None
        assert send_queue_metrics.pop("oldest_trade_age_ms") >= 0
        assert send_queue_metrics == {
            "active": 2,
            "active_sender_tasks": 2,
            "active_senders": 2,
            "capacity_per_client": 1056,
            "non_trade_capacity_per_client": 32,
            "trade_capacity_per_client": 1024,
            "total_depth": 2,
            "queue_depth": 2,
            "max_depth": 2,
            "queue_high_watermark": 2,
            "queue_full_count": 0,
            "send_timeout_count": 0,
            "slow_disconnect_count": 0,
            "depth_coalesced_count": 0,
            "ticker_coalesced_count": 0,
                "kline_revision_replace_count": 0,
                "kline_stale_replace_reject_count": 0,
                "preview_replace_count": 0,
                "preview_stale_replace_reject_count": 0,
            "pending_depth_slot": 0,
            "pending_ticker_slot": 0,
                "pending_kline_count": 0,
                "pending_preview_count": 0,
            "trade_queue_depth": 2,
            "trade_queue_high_watermark": 2,
            "trade_backlog_warning_count": 0,
            "trade_backlog_disconnect_count": 0,
            "slow_clients": 0,
            "cleanup_count": 0,
            "active_cleanup_tasks": 0,
        }

        fast_sender = fast_state.sender_task
        slow_sender = slow_state.sender_task
        await manager.disconnect("BTCUSDT", slow)
        await manager.disconnect("BTCUSDT", fast)
        await manager.disconnect("BTCUSDT", slow)
        await manager.disconnect("BTCUSDT", fast)

        assert fast_sender.done()
        assert slow_sender.done()
        assert fast_state.mailbox.empty()
        assert slow_state.mailbox.empty()
        assert manager._client_send_states == {}
        released_metrics = await manager.get_metrics_snapshot()
        assert released_metrics["send_queues"]["active"] == 0
        assert released_metrics["send_queues"]["active_sender_tasks"] == 0
        assert released_metrics["send_queues"]["total_depth"] == 0
        assert released_metrics["connections"]["disconnected"] == 2

    asyncio.run(run())


def test_spot_ws_client_domain_mailbox_routes_domains_and_preserves_global_order() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op

        send_gate = asyncio.Event()
        websocket = _MetricsWebSocket(send_gate=send_gate)
        await manager.connect("BTCUSDT", websocket, accepted=True, interval="1m")
        state = manager._client_send_states[websocket]
        sender = state.sender_task

        assert sender is not None and not sender.done()
        await manager.enqueue_to_client(
            websocket,
            "blocked-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await asyncio.wait_for(websocket.send_started.wait(), timeout=0.1)

        await manager.enqueue_to_client(
            websocket,
            "queued-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await manager.send_trade(
            symbol="BTCUSDT",
            price="100",
            amount="1",
            side="BUY",
            ts=1_000,
            trade_id="trade-1",
        )
        await manager._send_payload(
            "BTCUSDT",
            {
                "type": "spot_depth_update",
                "symbol": "BTCUSDT",
                "depth": {"bids": [], "asks": []},
            },
        )
        await manager.broadcast_ticker_update(
            "BTCUSDT",
            {"symbol": "BTCUSDT", "last_price": "100"},
        )
        await manager._send_payload(
            "BTCUSDT",
            {
                "type": "spot_kline_update",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "kline": {"open_time": 1_000, "close": "100"},
            },
        )

        mailbox = state.mailbox
        assert mailbox.domain_depths() == {
            "control": 1,
            "trade": 1,
            "depth": 1,
            "ticker": 1,
            "kline": 1,
            "preview": 0,
        }
        assert mailbox.depth_slot is not None
        assert mailbox.depth_slot.event_type == "spot_depth_update"
        assert mailbox.ticker_slot is not None
        assert mailbox.ticker_slot.event_type == "spot_ticker_update"
        assert len(mailbox.kline_pending) == 1
        assert state.sender_task is sender

        send_gate.set()
        await _wait_until(lambda: len(websocket.sent) == 6)
        assert websocket.sent[:2] == ["blocked-control", "queued-control"]
        assert [json.loads(text)["type"] for text in websocket.sent[2:]] == [
            "spot_trade",
            "spot_depth_update",
            "spot_ticker_update",
            "spot_kline_update",
        ]
        assert mailbox.empty()

        await manager.disconnect("BTCUSDT", websocket)
        assert sender.done()
        assert mailbox.empty()
        assert mailbox.domain_depths() == {
            "control": 0,
            "trade": 0,
            "depth": 0,
            "ticker": 0,
            "kline": 0,
            "preview": 0,
        }

    asyncio.run(run())


def test_spot_ws_depth_burst_coalesces_without_displacing_trade_fifo() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op

        send_gate = asyncio.Event()
        websocket = _MetricsWebSocket(send_gate=send_gate)
        await manager.connect("BTCUSDT", websocket, accepted=True, interval="1m")
        state = manager._client_send_states[websocket]

        await manager.enqueue_to_client(
            websocket,
            "blocked-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await asyncio.wait_for(websocket.send_started.wait(), timeout=0.1)

        for trade_index in range(20):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_trade",
                    "symbol": "BTCUSDT",
                    "trade": {"trade_id": trade_index},
                },
            )
        for depth_index in range(1_000):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_depth_update",
                    "symbol": "BTCUSDT",
                    "depth": {"marker": depth_index},
                },
            )

        mailbox = state.mailbox
        assert mailbox.qsize() == 21
        assert len(mailbox.trade_queue) == 20
        assert mailbox.depth_slot is not None
        assert mailbox.depth_slot.first_sequence < mailbox.depth_slot.latest_sequence
        assert json.loads(mailbox.depth_slot.text)["depth"]["marker"] == 999
        metrics = await manager.get_metrics_snapshot()
        assert metrics["send_queues"]["depth_coalesced_count"] == 999
        assert metrics["send_queues"]["pending_depth_slot"] == 1
        assert metrics["send_queues"]["queue_full_count"] == 0

        send_gate.set()
        await _wait_until(lambda: len(websocket.sent) == 22)
        sent_payloads = [json.loads(text) for text in websocket.sent[1:]]
        assert [payload["trade"]["trade_id"] for payload in sent_payloads[:20]] == list(
            range(20)
        )
        assert sent_payloads[-1]["type"] == "spot_depth_update"
        assert sent_payloads[-1]["depth"]["marker"] == 999

        await manager.disconnect("BTCUSDT", websocket)

    asyncio.run(run())


def test_spot_ws_ticker_burst_sends_only_latest_pending_ticker() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op

        send_gate = asyncio.Event()
        websocket = _MetricsWebSocket(send_gate=send_gate)
        await manager.connect("BTCUSDT", websocket, accepted=True)
        state = manager._client_send_states[websocket]
        await manager.enqueue_to_client(
            websocket,
            "blocked-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await asyncio.wait_for(websocket.send_started.wait(), timeout=0.1)

        for trade_index in range(20):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_trade",
                    "symbol": "BTCUSDT",
                    "trade": {"trade_id": trade_index},
                },
            )
        for ticker_index in range(200):
            await manager.broadcast_ticker_update(
                "BTCUSDT",
                {"symbol": "BTCUSDT", "last_price": str(ticker_index)},
            )

        mailbox = state.mailbox
        assert mailbox.qsize() == 21
        assert len(mailbox.trade_queue) == 20
        assert mailbox.ticker_slot is not None
        assert mailbox.ticker_slot.first_sequence < mailbox.ticker_slot.latest_sequence
        assert json.loads(mailbox.ticker_slot.text)["ticker"]["last_price"] == "199"
        metrics = await manager.get_metrics_snapshot()
        assert metrics["send_queues"]["ticker_coalesced_count"] == 199
        assert metrics["send_queues"]["pending_ticker_slot"] == 1

        send_gate.set()
        await _wait_until(lambda: len(websocket.sent) == 22)
        assert [
            json.loads(text)["trade"]["trade_id"] for text in websocket.sent[1:21]
        ] == list(range(20))
        assert json.loads(websocket.sent[-1])["ticker"]["last_price"] == "199"
        await manager.disconnect("BTCUSDT", websocket)

    asyncio.run(run())


def test_spot_ws_trade_fifo_keeps_one_hundred_trades() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        websocket = _MetricsWebSocket()
        await manager.connect("BTCUSDT", websocket, accepted=True)

        for trade_index in range(100):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_trade",
                    "symbol": "BTCUSDT",
                    "trade": {"trade_id": trade_index},
                },
            )
            await _wait_until(lambda: len(websocket.sent) == trade_index + 1)

        assert [json.loads(text)["trade"]["trade_id"] for text in websocket.sent] == list(
            range(100)
        )
        metrics = await manager.get_metrics_snapshot()
        assert metrics["send_queues"]["queue_full_count"] == 0
        assert metrics["send_queues"]["depth_coalesced_count"] == 0
        assert metrics["send_queues"]["ticker_coalesced_count"] == 0
        await manager.disconnect("BTCUSDT", websocket)

    asyncio.run(run())


def test_spot_ws_trade_burst_keeps_one_thousand_fifo_items_with_reserved_capacity() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        send_gate = asyncio.Event()
        websocket = _MetricsWebSocket(send_gate=send_gate)
        await manager.connect("BTCUSDT", websocket, accepted=True)
        state = manager._client_send_states[websocket]
        await manager.enqueue_to_client(
            websocket,
            "blocked-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await asyncio.wait_for(websocket.send_started.wait(), timeout=0.1)

        for trade_index in range(1_000):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_trade",
                    "symbol": "BTCUSDT",
                    "trade": {"trade_id": trade_index},
                },
            )

        mailbox = state.mailbox
        assert len(mailbox.trade_queue) == 1_000
        assert mailbox.trade_queue_high_watermark == 1_000
        metrics = await manager.get_metrics_snapshot()
        assert metrics["send_queues"]["trade_queue_depth"] == 1_000
        assert metrics["send_queues"]["trade_queue_high_watermark"] == 1_000
        assert metrics["send_queues"]["trade_backlog_warning_count"] == 1
        assert metrics["send_queues"]["trade_backlog_disconnect_count"] == 0
        assert metrics["send_queues"]["oldest_trade_age_ms"] >= 0

        send_gate.set()
        await _wait_until(lambda: len(websocket.sent) == 1_001, timeout=5.0)
        assert [json.loads(text)["trade"]["trade_id"] for text in websocket.sent[1:]] == list(
            range(1_000)
        )
        await manager.disconnect("BTCUSDT", websocket)

    asyncio.run(run())


def test_spot_ws_trade_backlog_full_evicts_only_slow_client_and_records_reason() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        normal = _MetricsWebSocket()
        slow_gate = asyncio.Event()
        slow = _MetricsWebSocket(send_gate=slow_gate)
        await manager.connect("BTCUSDT", normal, accepted=True)
        await manager.connect("BTCUSDT", slow, accepted=True)
        slow_state = manager._client_send_states[slow]
        slow_state.mailbox.trade_capacity = 8

        await manager._send_payload(
            "BTCUSDT",
            {"type": "spot_trade", "symbol": "BTCUSDT", "trade": {"trade_id": 0}},
        )
        await asyncio.wait_for(slow.send_started.wait(), timeout=0.1)
        await _wait_until(lambda: len(normal.sent) == 1)

        for trade_index in range(1, 10):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_trade",
                    "symbol": "BTCUSDT",
                    "trade": {"trade_id": trade_index},
                },
            )
            await _wait_until(lambda: len(normal.sent) == trade_index + 1)

        await _wait_until(
            lambda: slow not in manager._client_send_states
            and slow.close_codes == [1013]
            and slow_state.cleanup_completed
        )
        assert slow_state.cleanup_reason == "trade_backlog_full"
        assert slow_state.slow is True
        assert slow_state.mailbox.empty()
        metrics = await manager.get_metrics_snapshot()
        assert metrics["connections"]["active"] == 1
        assert metrics["send_queues"]["queue_full_count"] == 0
        assert metrics["send_queues"]["trade_queue_high_watermark"] == 8
        assert metrics["send_queues"]["trade_backlog_warning_count"] == 1
        assert metrics["send_queues"]["trade_backlog_disconnect_count"] == 1
        assert metrics["cleanup"]["reason_counts"] == {"trade_backlog_full": 1}

        await manager._send_payload(
            "BTCUSDT",
            {"type": "spot_trade", "symbol": "BTCUSDT", "trade": {"trade_id": 10}},
        )
        await _wait_until(lambda: len(normal.sent) == 11)
        assert [json.loads(text)["trade"]["trade_id"] for text in normal.sent] == list(
            range(11)
        )
        await manager.disconnect("BTCUSDT", normal)

    asyncio.run(run())


def test_spot_ws_expired_trade_backlog_disconnects_instead_of_dropping() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        send_gate = asyncio.Event()
        websocket = _MetricsWebSocket(send_gate=send_gate)
        await manager.connect("BTCUSDT", websocket, accepted=True)
        state = manager._client_send_states[websocket]
        state.mailbox.trade_max_age_seconds = 0.001
        await manager.enqueue_to_client(
            websocket,
            "blocked-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await asyncio.wait_for(websocket.send_started.wait(), timeout=0.1)
        await manager._send_payload(
            "BTCUSDT",
            {"type": "spot_trade", "symbol": "BTCUSDT", "trade": {"trade_id": 1}},
        )
        await asyncio.sleep(0.01)
        await manager._send_payload(
            "BTCUSDT",
            {"type": "spot_trade", "symbol": "BTCUSDT", "trade": {"trade_id": 2}},
        )

        await _wait_until(
            lambda: websocket not in manager._client_send_states
            and websocket.close_codes == [1013]
            and state.cleanup_completed
        )
        assert state.cleanup_reason == "trade_backlog_expired"
        assert state.mailbox.empty()
        metrics = await manager.get_metrics_snapshot()
        assert metrics["send_queues"]["trade_backlog_disconnect_count"] == 1
        assert metrics["cleanup"]["reason_counts"] == {"trade_backlog_expired": 1}

    asyncio.run(run())


def test_spot_ws_kline_pending_uses_revision_and_close_state_without_cross_bucket_merge() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        async def send_kline(
            *,
            open_time: int,
            revision_seq: int,
            close: str,
            is_closed: bool,
        ) -> None:
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_kline_update",
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                    "kline": {
                        "open_time": open_time,
                        "close": close,
                        "revision_epoch": 1,
                        "revision_seq": revision_seq,
                        "is_closed": is_closed,
                    },
                },
            )

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        send_gate = asyncio.Event()
        websocket = _MetricsWebSocket(send_gate=send_gate)
        await manager.connect("BTCUSDT", websocket, accepted=True, interval="1m")
        state = manager._client_send_states[websocket]
        await manager.enqueue_to_client(
            websocket,
            "blocked-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await asyncio.wait_for(websocket.send_started.wait(), timeout=0.1)

        for trade_index in range(10):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_trade",
                    "symbol": "BTCUSDT",
                    "trade": {"trade_id": trade_index},
                },
            )
        await send_kline(open_time=1_000, revision_seq=1, close="100", is_closed=False)
        first_sequence = state.mailbox.kline_pending[("BTCUSDT", "1m", 1_000)].first_sequence
        await send_kline(open_time=1_000, revision_seq=2, close="101", is_closed=False)
        await send_kline(open_time=1_000, revision_seq=1, close="99", is_closed=False)
        await send_kline(open_time=1_000, revision_seq=2, close="101", is_closed=True)
        await send_kline(open_time=1_000, revision_seq=3, close="102", is_closed=False)
        await send_kline(open_time=2_000, revision_seq=1, close="103", is_closed=False)

        mailbox = state.mailbox
        assert len(mailbox.kline_pending) == 2
        assert len(mailbox.trade_queue) == 10
        winner = mailbox.kline_pending[("BTCUSDT", "1m", 1_000)]
        assert winner.first_sequence == first_sequence
        assert winner.latest_sequence > winner.first_sequence
        assert winner.revision_seq == 2
        assert winner.is_closed is True
        assert json.loads(winner.text)["kline"]["close"] == "101"
        metrics = await manager.get_metrics_snapshot()
        assert metrics["send_queues"]["kline_revision_replace_count"] == 2
        assert metrics["send_queues"]["kline_stale_replace_reject_count"] == 2
        assert metrics["send_queues"]["pending_kline_count"] == 2

        send_gate.set()
        await _wait_until(lambda: len(websocket.sent) == 13)
        assert [
            json.loads(text)["trade"]["trade_id"] for text in websocket.sent[1:11]
        ] == list(range(10))
        kline_payloads = [json.loads(text)["kline"] for text in websocket.sent[11:]]
        assert [payload["open_time"] for payload in kline_payloads] == [1_000, 2_000]
        assert kline_payloads[0]["is_closed"] is True
        assert kline_payloads[0]["close"] == "101"

        await manager.disconnect("BTCUSDT", websocket)
        assert mailbox.empty()

    asyncio.run(run())


def test_spot_ws_disconnect_clears_pending_coalesced_state() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        send_gate = asyncio.Event()
        websocket = _MetricsWebSocket(send_gate=send_gate)
        await manager.connect("BTCUSDT", websocket, accepted=True, interval="1m")
        state = manager._client_send_states[websocket]
        sender = state.sender_task
        await manager.enqueue_to_client(
            websocket,
            "blocked-control",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await asyncio.wait_for(websocket.send_started.wait(), timeout=0.1)

        for marker in (1, 2):
            await manager._send_payload(
                "BTCUSDT",
                {
                    "type": "spot_depth_update",
                    "symbol": "BTCUSDT",
                    "depth": {"marker": marker},
                },
            )
            await manager.broadcast_ticker_update(
                "BTCUSDT",
                {"symbol": "BTCUSDT", "last_price": str(marker)},
            )
        await manager._send_payload(
            "BTCUSDT",
            {
                "type": "spot_kline_update",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "kline": {
                    "open_time": 1_000,
                    "revision_epoch": 1,
                    "revision_seq": 1,
                    "is_closed": False,
                },
            },
        )
        mailbox = state.mailbox
        assert mailbox.domain_depths() == {
            "control": 0,
            "trade": 0,
            "depth": 1,
            "ticker": 1,
            "kline": 1,
            "preview": 0,
        }

        await manager.disconnect("BTCUSDT", websocket)
        assert sender is not None and sender.done()
        assert mailbox.empty()
        assert mailbox.depth_slot is None
        assert mailbox.ticker_slot is None
        assert mailbox.kline_pending == {}

    asyncio.run(run())


def test_spot_ws_client_mailbox_keeps_kline_interval_filtering() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op

        subscribed = _MetricsWebSocket()
        unsubscribed = _MetricsWebSocket()
        await manager.connect("BTCUSDT", subscribed, accepted=True, interval="1m")
        await manager.connect("BTCUSDT", unsubscribed, accepted=True)

        await manager._send_payload(
            "BTCUSDT",
            {
                "type": "spot_kline_update",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "kline": {"open_time": 1_000, "close": "100"},
            },
        )
        await _wait_until(lambda: len(subscribed.sent) == 1)
        await asyncio.sleep(0)

        assert len(unsubscribed.sent) == 0
        assert manager._client_send_states[subscribed].mailbox.empty()
        assert manager._client_send_states[unsubscribed].mailbox.empty()

        await manager.disconnect("BTCUSDT", subscribed)
        await manager.disconnect("BTCUSDT", unsubscribed)

    asyncio.run(run())


def test_spot_ws_targeted_snapshot_and_pong_only_reach_current_client() -> None:
    async def run() -> None:
        manager = MarketWsManager()

        async def no_op(*_args, **_kwargs) -> None:
            return None

        async def snapshot_payload(_symbol: str) -> dict:
            return {
                "type": "spot_market_snapshot",
                "symbol": "BTCUSDT",
                "depth": None,
                "ticker": None,
                "trades": None,
            }

        manager._ensure_spot_provider_depth = no_op
        manager._release_spot_provider_depth_if_idle = no_op
        manager._snapshot_payload = snapshot_payload

        current = _MetricsWebSocket()
        other = _MetricsWebSocket()
        await manager.connect("BTCUSDT", current, accepted=True, interval="1m")
        await manager.connect("BTCUSDT", other, accepted=True, interval="1m")

        await manager.send_snapshot_to_client(None, "BTCUSDT", current)
        await manager.enqueue_to_client(
            current,
            "pong",
            symbol="BTCUSDT",
            event_type="pong",
        )
        await _wait_until(lambda: len(current.sent) == 2)
        await asyncio.sleep(0)

        assert json.loads(current.sent[0])["type"] == "spot_market_snapshot"
        assert current.sent[1] == "pong"
        assert other.sent == []

        await manager.disconnect("BTCUSDT", current)
        await manager.disconnect("BTCUSDT", other)

    asyncio.run(run())


def test_spot_market_router_queues_initial_snapshot_and_pong(monkeypatch) -> None:
    from app.routers import market as market_router

    events: list[tuple] = []

    class FakeDb:
        def close(self) -> None:
            events.append(("db_close",))

    class FakeManager:
        async def connect(self, symbol, websocket, *, interval=None, accepted=False) -> None:
            events.append(("connect", symbol, interval, accepted, websocket))

        async def send_snapshot_to_client(self, db, symbol, websocket) -> None:
            events.append(("snapshot", symbol, websocket, db))

        async def enqueue_to_client(
            self,
            websocket,
            payload,
            *,
            symbol,
            event_type=None,
        ) -> bool:
            events.append(("enqueue", symbol, event_type, payload, websocket))
            return True

        async def disconnect(self, symbol, websocket) -> None:
            events.append(("disconnect", symbol, websocket))

    class FakeWebSocket:
        query_params = {"symbol": "BTCUSDT", "interval": "1m"}

        def __init__(self) -> None:
            self.messages = iter(
                [
                    {"type": "websocket.receive", "text": "ping"},
                    {"type": "websocket.disconnect"},
                ]
            )

        async def receive(self) -> dict:
            return next(self.messages)

    fake_db = FakeDb()
    fake_manager = FakeManager()
    websocket = FakeWebSocket()
    monkeypatch.setattr(market_router, "SessionLocal", lambda: fake_db)
    monkeypatch.setattr(market_router, "market_ws_manager", fake_manager)

    asyncio.run(market_router.spot_market_ws(websocket))

    assert events == [
        ("connect", "BTCUSDT", "1m", False, websocket),
        ("snapshot", "BTCUSDT", websocket, fake_db),
        ("enqueue", "BTCUSDT", "pong", "pong", websocket),
        ("disconnect", "BTCUSDT", websocket),
        ("db_close",),
    ]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASSED {name}")
