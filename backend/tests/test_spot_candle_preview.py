from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.spot_candle_preview import (
    SpotCandlePreviewEngine,
    SpotNativePreviewStatus,
    SpotPreviewTradeStatus,
)


OPEN_TIME = 1_710_000_060_000
NEXT_OPEN_TIME = OPEN_TIME + 60_000


def _native(
    *,
    symbol: str = "BTCUSDT",
    provider: str = "OKX_SPOT",
    open_time: int = OPEN_TIME,
    open_price: str = "100",
    high: str = "105",
    low: str = "99",
    close: str = "101",
    volume: str = "10",
    quote_volume: str = "1010",
    revision_epoch: int = 1,
    revision_seq: int = 1,
    generation: int = 1,
    is_closed: bool = False,
) -> dict[str, object]:
    return {
        "symbol": symbol,
        "interval": "1m",
        "provider": provider,
        "open_time": open_time,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "quote_volume": quote_volume,
        "revision_epoch": revision_epoch,
        "revision_seq": revision_seq,
        "generation": generation,
        "is_closed": is_closed,
    }


def _trade(
    *,
    trade_id: str,
    symbol: str = "BTCUSDT",
    provider: str = "OKX_SPOT",
    price: str = "106",
    size: str = "2",
    event_time_ms: int = OPEN_TIME + 1_000,
    generation: int = 1,
) -> dict[str, object]:
    return {
        "symbol": symbol,
        "interval": "1m",
        "provider": provider,
        "provider_trade_id": trade_id,
        "price": price,
        "size": size,
        "event_time_ms": event_time_ms,
        "generation": generation,
    }


def test_first_native_open_revision_creates_exact_baseline() -> None:
    engine = SpotCandlePreviewEngine()

    result = engine.accept_native_revision(_native())

    assert result.status is SpotNativePreviewStatus.BASELINE_CREATED
    assert result.preview is not None
    assert result.preview.symbol == "BTCUSDT"
    assert result.preview.interval == "1m"
    assert result.preview.provider == "OKX_SPOT"
    assert result.preview.open_time == OPEN_TIME
    assert result.preview.open == Decimal("100")
    assert result.preview.high == Decimal("105")
    assert result.preview.low == Decimal("99")
    assert result.preview.close == Decimal("101")
    assert result.preview.volume == Decimal("10")
    assert result.preview.quote_volume == Decimal("1010")
    assert result.preview.revision_epoch == 1
    assert result.preview.revision_seq == 1
    assert result.preview.generation == 1
    assert result.preview.preview_seq == 0
    assert result.preview.applied_trade_count == 0


def test_trade_updates_preview_ohlcv_without_changing_open() -> None:
    engine = SpotCandlePreviewEngine()
    engine.accept_native_revision(_native())

    high_result = engine.accept_trade(_trade(trade_id="high", price="106", size="2"))
    low_result = engine.accept_trade(
        _trade(
            trade_id="low",
            price="98",
            size="0.5",
            event_time_ms=OPEN_TIME + 2_000,
        )
    )

    assert high_result.status is SpotPreviewTradeStatus.APPLIED
    assert low_result.status is SpotPreviewTradeStatus.APPLIED
    assert low_result.preview is not None
    assert low_result.preview.open == Decimal("100")
    assert low_result.preview.high == Decimal("106")
    assert low_result.preview.low == Decimal("98")
    assert low_result.preview.close == Decimal("98")
    assert low_result.preview.volume == Decimal("12.5")
    assert low_result.preview.quote_volume == Decimal("1271")
    assert low_result.preview.preview_seq == 2
    assert low_result.preview.applied_trade_count == 2


def test_duplicate_trade_is_reported_without_second_mutation() -> None:
    engine = SpotCandlePreviewEngine()
    engine.accept_native_revision(_native())
    trade = _trade(trade_id="duplicate", price="102", size="3")

    first = engine.accept_trade(trade)
    duplicate = engine.accept_trade(trade)

    assert first.status is SpotPreviewTradeStatus.APPLIED
    assert duplicate.status is SpotPreviewTradeStatus.DUPLICATE
    assert duplicate.preview == first.preview


def test_duplicate_and_conflicting_replay_cannot_double_count_volume() -> None:
    engine = SpotCandlePreviewEngine()
    engine.accept_native_revision(_native())
    original = _trade(trade_id="stable-id", price="102", size="3")
    first = engine.accept_trade(original)

    for _ in range(3):
        assert engine.accept_trade(original).status is SpotPreviewTradeStatus.DUPLICATE
    conflict = engine.accept_trade(_trade(trade_id="stable-id", price="103", size="4"))

    assert conflict.status is SpotPreviewTradeStatus.CONFLICT
    assert conflict.preview == first.preview
    assert conflict.preview is not None
    assert conflict.preview.volume == Decimal("13")
    assert conflict.preview.quote_volume == Decimal("1316")
    assert conflict.preview.applied_trade_count == 1


def test_newer_native_open_revision_discards_preview_and_rebases() -> None:
    engine = SpotCandlePreviewEngine()
    engine.accept_native_revision(_native())
    accepted_trade = _trade(trade_id="already-native", price="106", size="2")
    engine.accept_trade(accepted_trade)

    result = engine.accept_native_revision(
        _native(
            high="107",
            close="104",
            volume="15",
            quote_volume="1550",
            revision_seq=2,
        )
    )

    assert result.status is SpotNativePreviewStatus.REBASED
    assert result.preview is not None
    assert result.preview.open == Decimal("100")
    assert result.preview.high == Decimal("107")
    assert result.preview.low == Decimal("99")
    assert result.preview.close == Decimal("104")
    assert result.preview.volume == Decimal("15")
    assert result.preview.quote_volume == Decimal("1550")
    assert result.preview.revision_seq == 2
    assert result.preview.preview_seq == 0
    assert result.preview.applied_trade_count == 0

    replay = engine.accept_trade(accepted_trade)
    assert replay.status is SpotPreviewTradeStatus.DUPLICATE
    assert replay.preview == result.preview


def test_native_close_removes_preview_and_tombstone_prevents_reopen() -> None:
    engine = SpotCandlePreviewEngine()
    engine.accept_native_revision(_native())
    engine.accept_trade(_trade(trade_id="before-close"))

    closed = engine.accept_native_revision(
        _native(revision_seq=2, is_closed=True)
    )

    assert closed.status is SpotNativePreviewStatus.CLOSED
    assert closed.preview is None
    assert engine.get_preview("BTCUSDT") is None
    assert engine.is_tombstoned(
        symbol="BTCUSDT",
        interval="1m",
        open_time=OPEN_TIME,
    )

    reopen = engine.accept_native_revision(_native(revision_seq=3))
    late_trade = engine.accept_trade(_trade(trade_id="after-close"))
    assert reopen.status is SpotNativePreviewStatus.TOMBSTONED
    assert reopen.preview is None
    assert late_trade.status is SpotPreviewTradeStatus.TOMBSTONED
    assert late_trade.preview is None


def test_generation_change_rebases_and_rejects_old_generation_trade() -> None:
    engine = SpotCandlePreviewEngine()
    engine.accept_native_revision(_native(generation=1))
    engine.accept_trade(_trade(trade_id="generation-one", generation=1))

    rebased = engine.accept_native_revision(
        _native(
            close="103",
            volume="12",
            quote_volume="1220",
            generation=2,
        )
    )
    old_trade = engine.accept_trade(
        _trade(trade_id="late-old-generation", generation=1)
    )
    new_trade = engine.accept_trade(
        _trade(trade_id="generation-two", price="104", size="1", generation=2)
    )

    assert rebased.status is SpotNativePreviewStatus.REBASED
    assert rebased.preview is not None
    assert rebased.preview.preview_seq == 0
    assert old_trade.status is SpotPreviewTradeStatus.GENERATION_MISMATCH
    assert new_trade.status is SpotPreviewTradeStatus.APPLIED
    assert new_trade.preview is not None
    assert new_trade.preview.close == Decimal("104")
    assert new_trade.preview.volume == Decimal("13")


def test_provider_switch_invalidates_okx_preview_until_new_okx_baseline() -> None:
    engine = SpotCandlePreviewEngine()
    engine.accept_native_revision(_native())

    switched = engine.accept_native_revision(_native(provider="BITGET_SPOT"))
    without_baseline = engine.accept_trade(_trade(trade_id="while-switched"))
    restored = engine.accept_native_revision(_native(revision_epoch=2))

    assert switched.status is SpotNativePreviewStatus.PROVIDER_SWITCHED
    assert switched.preview is None
    assert engine.get_preview("BTCUSDT") == restored.preview
    assert without_baseline.status is SpotPreviewTradeStatus.NO_BASELINE
    assert restored.status is SpotNativePreviewStatus.BASELINE_CREATED


def test_btc_and_eth_preview_state_is_isolated() -> None:
    engine = SpotCandlePreviewEngine()
    btc_baseline = engine.accept_native_revision(_native(symbol="BTCUSDT"))
    eth_baseline = engine.accept_native_revision(
        _native(
            symbol="ETHUSDT",
            open_price="3000",
            high="3010",
            low="2990",
            close="3005",
            volume="20",
            quote_volume="60000",
        )
    )

    btc_trade = engine.accept_trade(
        _trade(trade_id="btc", symbol="BTCUSDT", price="106", size="1")
    )

    assert btc_trade.status is SpotPreviewTradeStatus.APPLIED
    assert btc_trade.preview is not None
    assert btc_trade.preview.close == Decimal("106")
    assert engine.get_preview("ETHUSDT") == eth_baseline.preview
    assert engine.get_preview("BTCUSDT") != btc_baseline.preview
    assert len(engine.previews()) == 2


def test_trade_for_other_bucket_cannot_mutate_active_open_candle() -> None:
    engine = SpotCandlePreviewEngine()
    baseline = engine.accept_native_revision(_native())

    result = engine.accept_trade(
        _trade(
            trade_id="next-minute",
            event_time_ms=NEXT_OPEN_TIME + 1_000,
        )
    )

    assert result.status is SpotPreviewTradeStatus.OPEN_TIME_MISMATCH
    assert result.preview == baseline.preview


def test_new_generation_cannot_regress_to_an_older_open_bucket() -> None:
    engine = SpotCandlePreviewEngine()
    baseline = engine.accept_native_revision(_native())

    result = engine.accept_native_revision(
        _native(open_time=OPEN_TIME - 60_000, generation=2)
    )

    assert result.status is SpotNativePreviewStatus.STALE
    assert result.preview == baseline.preview


@pytest.mark.parametrize(
    ("event", "error"),
    [
        (_native(symbol="SOLUSDT"), "unsupported spot candle preview symbol"),
        ({**_native(), "interval": "5m"}, "unsupported spot candle preview interval"),
    ],
)
def test_scope_rejects_other_symbols_and_intervals(
    event: dict[str, object],
    error: str,
) -> None:
    engine = SpotCandlePreviewEngine()

    with pytest.raises(ValueError, match=error):
        engine.accept_native_revision(event)
