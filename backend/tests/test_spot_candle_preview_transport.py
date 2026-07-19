from __future__ import annotations

import asyncio
from decimal import Decimal

from app.services.market_ws import (
    MAILBOX_KLINE_REPLACED,
    MAILBOX_PREVIEW_REPLACED,
    MAILBOX_PREVIEW_STALE_REJECTED,
    ClientSendMailbox,
    MarketWsManager,
    _client_send_mailbox_item,
)
from app.services.spot_candle_preview import SpotCandlePreview, SpotCandlePreviewEngine
from app.services.spot_kline_bucket import spot_kline_bucket_start_ms
from app.services.spot_market_gateway import SpotMarketGateway


def _mailbox_item(sequence: int, payload: dict):
    return _client_send_mailbox_item(
        sequence=sequence,
        symbol="BTCUSDT",
        event_type=str(payload["type"]),
        text=str(payload),
        payload=payload,
    )


def test_preview_mailbox_is_monotonic_and_never_replaces_native_kline() -> None:
    async def run() -> None:
        mailbox = ClientSendMailbox(maxsize=8)
        native = {
            "type": "spot_kline_update",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "kline": {
                "open_time": 1_710_000_060_000,
                "revision_epoch": 1,
                "revision_seq": 1,
                "is_closed": False,
            },
        }
        preview = {
            "type": "spot_candle_preview_update",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "preview": {
                "open_time": 1_710_000_060_000,
                "preview_seq": 1,
            },
        }

        mailbox.put_nowait(_mailbox_item(1, native))
        mailbox.put_nowait(_mailbox_item(2, preview))

        assert mailbox.domain_depths()["kline"] == 1
        assert mailbox.domain_depths()["preview"] == 1
        assert mailbox.put_nowait(_mailbox_item(3, {
            **preview,
            "preview": {**preview["preview"], "preview_seq": 2},
        })) == MAILBOX_PREVIEW_REPLACED
        assert mailbox.put_nowait(
            _mailbox_item(4, preview)
        ) == MAILBOX_PREVIEW_STALE_REJECTED
        assert mailbox.put_nowait(_mailbox_item(5, {
            **native,
            "kline": {**native["kline"], "revision_seq": 2},
        })) == MAILBOX_KLINE_REPLACED
        assert mailbox.domain_depths()["kline"] == 1
        assert mailbox.domain_depths()["preview"] == 1

    asyncio.run(run())


def test_preview_broadcast_payload_preserves_baseline_authority_fields() -> None:
    async def run() -> None:
        manager = MarketWsManager()
        captured: list[tuple[str, dict]] = []

        async def capture(symbol: str, payload: dict) -> None:
            captured.append((symbol, payload))

        manager._send_payload = capture
        preview = SpotCandlePreview(
            symbol="BTCUSDT",
            interval="1m",
            provider="OKX_SPOT",
            open_time=1_710_000_060_000,
            open=Decimal("100"),
            high=Decimal("106"),
            low=Decimal("99"),
            close=Decimal("104"),
            volume=Decimal("12"),
            quote_volume=Decimal("1220"),
            revision_epoch=3,
            revision_seq=8,
            generation=2,
            preview_seq=5,
            applied_trade_count=5,
        )

        await manager.broadcast_spot_candle_preview_update(
            "BTCUSDT",
            "1m",
            preview,
            received_at_ms=1_710_000_090_100,
        )

        assert len(captured) == 1
        symbol, payload = captured[0]
        assert symbol == "BTCUSDT"
        assert payload["type"] == "spot_candle_preview_update"
        assert payload["preview"]["close"] == "104"
        assert payload["preview"]["open_time"] == preview.open_time
        assert payload["provider_generation"] == 2
        assert payload["preview_seq"] == 5
        assert payload["base_native_revision"] == {"epoch": 3, "sequence": 8}
        assert payload["baseline_source"] == "NATIVE"
        assert payload["preview"]["baseline_source"] == "NATIVE"

        rollover = SpotCandlePreview(
            **{
                **preview.__dict__,
                "open_time": preview.open_time + 60_000,
                "open": Decimal("107"),
                "high": Decimal("107"),
                "low": Decimal("107"),
                "close": Decimal("107"),
                "volume": Decimal("1"),
                "quote_volume": Decimal("107"),
                "preview_seq": 1,
                "applied_trade_count": 1,
                "baseline_source": "TRADE_ROLLOVER",
                "baseline_anchor_open_time": preview.open_time,
            }
        )
        await manager.broadcast_spot_candle_preview_update(
            "BTCUSDT",
            "1m",
            rollover,
            received_at_ms=1_710_000_120_100,
        )
        rollover_payload = captured[-1][1]
        assert rollover_payload["baseline_source"] == "TRADE_ROLLOVER"
        assert rollover_payload["baseline_anchor_open_time"] == preview.open_time
        assert rollover_payload["preview"]["volume"] == "1"

    asyncio.run(run())


def test_trade_payload_embeds_the_same_preview_settlement_revision() -> None:
    async def run() -> None:
        manager = MarketWsManager()
        captured: list[tuple[str, dict]] = []

        async def capture(symbol: str, payload: dict) -> None:
            captured.append((symbol, payload))

        manager._send_payload = capture
        preview = SpotCandlePreview(
            symbol="BTCUSDT",
            interval="1m",
            provider="OKX_SPOT",
            open_time=1_710_000_060_000,
            open=Decimal("100"),
            high=Decimal("101"),
            low=Decimal("99"),
            close=Decimal("101"),
            volume=Decimal("12"),
            quote_volume=Decimal("1212"),
            revision_epoch=3,
            revision_seq=8,
            generation=2,
            preview_seq=5,
            applied_trade_count=5,
        )

        await manager.send_trade(
            symbol="BTCUSDT",
            id="trade-5",
            trade_id="trade-5",
            provider_trade_id="trade-5",
            price="101",
            amount="1",
            side="buy",
            ts=1_710_000_090_000,
            event_time_ms=1_710_000_090_000,
            received_at_ms=1_710_000_090_100,
            provider="OKX_SPOT",
            source="LIVE_WS",
            freshness="LIVE",
            candle_preview=preview,
            candle_preview_received_at_ms=1_710_000_090_100,
        )

        assert len(captured) == 1
        _, trade_payload = captured[0]
        embedded = trade_payload["candle_preview"]
        assert embedded["type"] == "spot_candle_preview_update"
        assert embedded["preview"]["close"] == trade_payload["trade"]["price"]
        assert embedded["preview"]["volume"] == "12"
        assert trade_payload["settlement_revision"] == embedded["settlement_revision"]
        assert embedded["settlement_revision"].endswith(":3:8:5")

    asyncio.run(run())


def test_gateway_preview_runtime_rebases_and_native_close_blocks_late_trade() -> None:
    class PreviewWsManager:
        def __init__(self) -> None:
            self.previews: list[SpotCandlePreview] = []

        async def broadcast_spot_candle_preview_update(
            self,
            symbol: str,
            interval: str,
            preview: SpotCandlePreview,
            **kwargs,
        ) -> None:
            assert symbol == preview.symbol
            assert interval == preview.interval
            self.previews.append(preview)

    async def run() -> None:
        manager = PreviewWsManager()
        engine = SpotCandlePreviewEngine()
        gateway = SpotMarketGateway(
            get_kline_generation=lambda symbol, interval: 7,
            ws_manager=manager,
            candle_preview_engine=engine,
        )
        open_time = spot_kline_bucket_start_ms(
            1_710_000_090_000,
            "1m",
            provider="OKX_SPOT",
        )

        def native(revision_seq: int, *, closed=False, provider: str = "OKX_SPOT"):
            gateway._accept_candle_preview_native(
                symbol="BTCUSDT",
                interval="1m",
                provider=provider,
                generation=7,
                kline={
                    "open_time": open_time,
                    "open": "100",
                    "high": "105",
                    "low": "99",
                    "close": "101",
                    "volume": "10",
                    "quote_volume": "1010",
                    "revision_epoch": 1,
                    "revision_seq": revision_seq,
                    "is_closed": closed,
                },
            )

        async def trade(trade_id: str, price: str) -> None:
            await gateway._accept_and_broadcast_candle_preview_trade(
                symbol="BTCUSDT",
                provider="OKX_SPOT",
                provider_trade_id=trade_id,
                price=price,
                amount="0.5",
                event_time_ms=open_time + 30_000,
                received_at_ms=open_time + 30_010,
            )

        native(1)
        await trade("trade-1", "106")
        assert len(manager.previews) == 1
        assert manager.previews[-1].revision_seq == 1
        assert manager.previews[-1].close == Decimal("106")

        native(2)
        await trade("trade-2", "103")
        assert len(manager.previews) == 2
        assert manager.previews[-1].revision_seq == 2
        assert manager.previews[-1].preview_seq == 1

        native(3, closed="true")
        await trade("late-trade", "107")
        assert len(manager.previews) == 2

        native(4, provider="BITGET_SPOT")
        await trade("wrong-provider-generation", "108")
        assert len(manager.previews) == 2

    asyncio.run(run())
