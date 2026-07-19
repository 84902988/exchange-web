from __future__ import annotations

from app.services.contract_candle_preview import (
    ContractCandlePreviewEngine,
    ContractNativePreviewStatus,
    ContractPreviewTradeStatus,
)


SYMBOL = "BTCUSDT_PERP"
OPEN_TIME = 1_720_000_020_000


def _native(**overrides):
    return {
        "symbol": SYMBOL,
        "interval": "1m",
        "provider": "OKX_SWAP",
        "open_time": OPEN_TIME,
        "open": "100",
        "high": "102",
        "low": "99",
        "close": "101",
        "volume": "50",
        "quote_volume": "5050",
        "revision_epoch": 3,
        "revision_sequence": 8,
        "generation": 3,
        "is_closed": False,
        **overrides,
    }


def _trade(trade_id: str, price: str, size: str, **overrides):
    return {
        "symbol": SYMBOL,
        "interval": "1m",
        "provider": "OKX_SWAP",
        "provider_trade_id": trade_id,
        "price": price,
        "size": size,
        "event_time_ms": OPEN_TIME + 30_000,
        "generation": 3,
        **overrides,
    }


def test_native_baseline_and_trades_advance_complete_ohlcv_together():
    engine = ContractCandlePreviewEngine()
    baseline = engine.accept_native_revision(_native())
    first = engine.accept_trade(_trade("t-1", "103", "2"))
    second = engine.accept_trade(_trade("t-2", "98", "1"))

    assert baseline.status is ContractNativePreviewStatus.BASELINE_CREATED
    assert first.status is ContractPreviewTradeStatus.APPLIED
    assert second.status is ContractPreviewTradeStatus.APPLIED
    assert second.preview is not None
    assert str(second.preview.open) == "100"
    assert str(second.preview.high) == "103"
    assert str(second.preview.low) == "98"
    assert str(second.preview.close) == "98"
    assert str(second.preview.volume) == "53"
    assert str(second.preview.quote_volume) == "5354"
    assert second.preview.preview_sequence == 2
    assert second.preview.applied_trade_count == 2


def test_duplicate_trade_is_idempotent_and_conflict_fails_closed():
    engine = ContractCandlePreviewEngine()
    engine.accept_native_revision(_native())
    first = engine.accept_trade(_trade("t-1", "103", "2"))
    duplicate = engine.accept_trade(_trade("t-1", "103", "2"))
    conflict = engine.accept_trade(_trade("t-1", "104", "2"))

    assert first.status is ContractPreviewTradeStatus.APPLIED
    assert duplicate.status is ContractPreviewTradeStatus.DUPLICATE
    assert conflict.status is ContractPreviewTradeStatus.CONFLICT
    assert duplicate.preview == first.preview
    assert conflict.preview == first.preview


def test_provider_generation_and_bucket_mismatch_are_rejected():
    engine = ContractCandlePreviewEngine()
    engine.accept_native_revision(_native())

    wrong_generation = engine.accept_trade(_trade("t-1", "103", "2", generation=2))
    wrong_bucket = engine.accept_trade(
        _trade("t-2", "103", "2", event_time_ms=OPEN_TIME + 120_000)
    )

    assert wrong_generation.status is ContractPreviewTradeStatus.GENERATION_MISMATCH
    assert wrong_bucket.status is ContractPreviewTradeStatus.OPEN_TIME_MISMATCH


def test_generic_symbol_contiguous_trade_opens_complete_next_bucket_before_native():
    engine = ContractCandlePreviewEngine()
    symbol = "SOLUSDT_PERP"
    engine.accept_native_revision(_native(symbol=symbol))

    result = engine.accept_trade(
        _trade(
            "sol-next-minute",
            "103",
            "2",
            symbol=symbol,
            event_time_ms=OPEN_TIME + 60_001,
        )
    )

    assert result.status is ContractPreviewTradeStatus.APPLIED
    assert result.preview is not None
    assert result.preview.open_time == OPEN_TIME + 60_000
    assert str(result.preview.open) == "103"
    assert str(result.preview.high) == "103"
    assert str(result.preview.low) == "103"
    assert str(result.preview.close) == "103"
    assert str(result.preview.volume) == "2"
    assert str(result.preview.quote_volume) == "206"
    assert result.preview.baseline_source == "TRADE_ROLLOVER"
    assert result.preview.baseline_anchor_open_time == OPEN_TIME
    assert result.preview.preview_sequence == 1


def test_native_rebase_settles_trade_seeded_rollover_without_regressing_ohlcv():
    engine = ContractCandlePreviewEngine()
    engine.accept_native_revision(_native())
    seeded = engine.accept_trade(
        _trade(
            "next-minute",
            "103",
            "2",
            event_time_ms=OPEN_TIME + 60_001,
        )
    )

    rebased = engine.accept_native_revision(
        _native(
            open_time=OPEN_TIME + 60_000,
            open="101",
            high="102",
            low="100",
            close="102",
            volume="1",
            quote_volume="101",
            revision_sequence=1,
        )
    )

    assert seeded.preview is not None
    assert rebased.status is ContractNativePreviewStatus.REBASED
    assert rebased.preview is not None
    assert str(rebased.preview.open) == "101"
    assert str(rebased.preview.high) == "103"
    assert str(rebased.preview.low) == "100"
    assert str(rebased.preview.close) == "103"
    assert str(rebased.preview.volume) == "2"
    assert str(rebased.preview.quote_volume) == "206"
    assert rebased.preview.baseline_source == "NATIVE"
    assert rebased.preview.baseline_anchor_open_time is None


def test_contiguous_rollover_requires_same_generation_and_real_native_anchor():
    engine = ContractCandlePreviewEngine()
    engine.accept_native_revision(_native())

    wrong_generation = engine.accept_trade(
        _trade(
            "wrong-generation-next-minute",
            "103",
            "2",
            event_time_ms=OPEN_TIME + 60_001,
            generation=4,
        )
    )
    first_next_bucket = engine.accept_trade(
        _trade(
            "first-next-minute",
            "103",
            "2",
            event_time_ms=OPEN_TIME + 60_001,
        )
    )
    skipped_again = engine.accept_trade(
        _trade(
            "second-next-minute",
            "104",
            "1",
            event_time_ms=OPEN_TIME + 120_001,
        )
    )

    assert wrong_generation.status is ContractPreviewTradeStatus.GENERATION_MISMATCH
    assert first_next_bucket.status is ContractPreviewTradeStatus.APPLIED
    assert skipped_again.status is ContractPreviewTradeStatus.OPEN_TIME_MISMATCH


def test_new_native_revision_rebases_without_overwriting_settled_trade_close():
    engine = ContractCandlePreviewEngine()
    engine.accept_native_revision(_native())
    engine.accept_trade(_trade("t-1", "103", "2"))
    rebased = engine.accept_native_revision(
        _native(
            high="104",
            close="104",
            volume="55",
            quote_volume="5560",
            revision_sequence=9,
        )
    )

    assert rebased.status is ContractNativePreviewStatus.REBASED
    assert rebased.preview is not None
    assert str(rebased.preview.close) == "103"
    assert str(rebased.preview.volume) == "55"
    assert rebased.preview.preview_sequence == 0
    assert rebased.preview.revision_sequence == 9


def test_same_generation_rebase_preserves_generic_symbol_ohlcv_high_water():
    engine = ContractCandlePreviewEngine()
    symbol = "SOLUSDT_PERP"
    engine.accept_native_revision(_native(symbol=symbol))
    first = engine.accept_trade(
        _trade("sol-before-rebase", "103", "2", symbol=symbol)
    )

    rebased = engine.accept_native_revision(
        _native(
            symbol=symbol,
            close="102",
            volume="51",
            quote_volume="5150",
            revision_sequence=9,
        )
    )
    next_trade = engine.accept_trade(
        _trade("sol-after-rebase", "104", "1", symbol=symbol)
    )

    assert first.preview is not None
    assert rebased.status is ContractNativePreviewStatus.REBASED
    assert rebased.preview is not None
    assert str(rebased.preview.close) == "103"
    assert str(rebased.preview.volume) == "52"
    assert str(rebased.preview.quote_volume) == "5256"
    assert rebased.preview.revision_sequence == 9
    assert rebased.preview.preview_sequence == 0
    assert next_trade.status is ContractPreviewTradeStatus.APPLIED
    assert next_trade.preview is not None
    assert str(next_trade.preview.close) == "104"
    assert str(next_trade.preview.volume) == "53"
    assert str(next_trade.preview.quote_volume) == "5360"
    assert next_trade.preview.preview_sequence == 1


def test_closed_native_tombstones_bucket_and_prevents_late_trade_reopen():
    engine = ContractCandlePreviewEngine()
    engine.accept_native_revision(_native())
    closed = engine.accept_native_revision(
        _native(is_closed=True, revision_sequence=9)
    )
    late = engine.accept_trade(_trade("t-late", "103", "2"))

    assert closed.status is ContractNativePreviewStatus.CLOSED
    assert late.status is ContractPreviewTradeStatus.TOMBSTONED
    assert late.preview is None


def test_stale_native_close_cannot_tombstone_the_active_revision():
    engine = ContractCandlePreviewEngine()
    baseline = engine.accept_native_revision(_native(revision_sequence=9))
    stale_close = engine.accept_native_revision(
        _native(is_closed=True, revision_sequence=8)
    )
    trade = engine.accept_trade(_trade("after-stale-close", "103", "2"))

    assert stale_close.status is ContractNativePreviewStatus.STALE
    assert stale_close.preview == baseline.preview
    assert engine.is_tombstoned(
        symbol=SYMBOL,
        interval="1m",
        open_time=OPEN_TIME,
    ) is False
    assert trade.status is ContractPreviewTradeStatus.APPLIED


def test_missing_or_negative_volume_and_unsupported_interval_fail_closed():
    engine = ContractCandlePreviewEngine()

    for native in (
        _native(volume=None),
        _native(volume="-1"),
        _native(symbol="@@@"),
        _native(interval="5m"),
    ):
        try:
            engine.accept_native_revision(native)
        except (TypeError, ValueError):
            pass
        else:
            raise AssertionError("invalid native OHLCV evidence was accepted")


def test_new_okx_contract_symbol_uses_the_same_preview_capability():
    engine = ContractCandlePreviewEngine()
    symbol = "SOLUSDT_PERP"

    baseline = engine.accept_native_revision(_native(symbol=symbol))
    result = engine.accept_trade(_trade("sol-trade-1", "103", "2", symbol=symbol))

    assert baseline.status is ContractNativePreviewStatus.BASELINE_CREATED
    assert result.status is ContractPreviewTradeStatus.APPLIED
    assert result.preview is not None
    assert result.preview.symbol == symbol
    assert str(result.preview.close) == "103"
    assert str(result.preview.volume) == "52"
