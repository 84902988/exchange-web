from __future__ import annotations

from dataclasses import replace

from app.services.spot_kline_revision import (
    KlineCloseState,
    KlineRevisionCandidate,
    KlineRevisionDecision,
    KlineRevisionReason,
    KlineRestWatermark,
    KlineTransport,
    close_state_rank,
    compare_kline_revision,
    is_same_kline_revision,
    kline_identity_key,
    merge_kline_revision,
    normalize_close_state,
    reconcile_rest_kline_candidate,
)


def _candidate(**overrides: object) -> KlineRevisionCandidate:
    values: dict[str, object] = {
        "symbol": "BTCUSDT",
        "interval": "1m",
        "open_time": 2_000,
        "open": "100",
        "high": "102",
        "low": "99",
        "close": "101",
        "volume": "10",
        "quote_volume": "1010",
        "provider": "OKX_SPOT",
        "source": "LIVE_WS",
        "transport": "WS",
        "provider_generation": 2,
        "revision_epoch": 3,
        "revision_seq": 10,
        "received_at_ms": 5_000,
        "is_closed": False,
        "close_state_source": "PROVIDER_CONFIRMED",
        "provider_update_time_ms": None,
    }
    values.update(overrides)
    return KlineRevisionCandidate(**values)


def _assert_result(
    existing: KlineRevisionCandidate,
    incoming: KlineRevisionCandidate,
    decision: KlineRevisionDecision,
    reason: KlineRevisionReason,
) -> None:
    result = compare_kline_revision(existing, incoming)
    assert result.decision == decision
    assert result.reason == reason


def _watermark(
    winner: KlineRevisionCandidate | None,
    *,
    provider: str = "OKX_SPOT",
    revision_epoch: int | None = None,
    revision_seq: int | None = None,
) -> KlineRestWatermark:
    return KlineRestWatermark(
        provider=provider,
        revision_epoch=(winner.revision_epoch if winner is not None else 0)
        if revision_epoch is None
        else revision_epoch,
        revision_seq=(winner.revision_seq if winner is not None else 0)
        if revision_seq is None
        else revision_seq,
        winner=winner,
    )


def test_same_bucket_identity_can_be_compared() -> None:
    existing = _candidate()
    incoming = replace(existing, revision_seq=11, close="101.5")

    assert kline_identity_key(existing) == ("BTCUSDT", "1m", 2_000)
    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.NEWER_REVISION,
    )


def test_different_open_time_is_rejected_as_identity_mismatch() -> None:
    existing = _candidate()
    incoming = replace(existing, open_time=3_000, revision_seq=11)

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.IDENTITY_MISMATCH,
    )


def test_new_epoch_bootstraps_provider_switch() -> None:
    existing = _candidate(is_closed=True, close_state_source="PROVIDER_CONFIRMED")
    incoming = replace(
        existing,
        provider="BITGET_SPOT",
        revision_epoch=4,
        provider_generation=1,
        revision_seq=1,
        is_closed=False,
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.PROVIDER_SWITCH_BOOTSTRAP,
    )


def test_old_epoch_is_rejected() -> None:
    existing = _candidate()
    incoming = replace(existing, revision_epoch=2, revision_seq=99)

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.STALE_EPOCH,
    )


def test_old_ws_generation_is_rejected() -> None:
    existing = _candidate()
    incoming = replace(existing, provider_generation=1, revision_seq=99)

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.STALE_GENERATION,
    )


def test_new_generation_is_accepted_when_close_state_does_not_downgrade() -> None:
    existing = _candidate()
    incoming = replace(existing, provider_generation=3, revision_seq=1, close="101.5")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.NEW_GENERATION,
    )


def test_new_generation_cannot_reopen_provider_confirmed_candle() -> None:
    existing = _candidate(is_closed=True, close_state_source="PROVIDER_CONFIRMED")
    incoming = replace(
        existing,
        provider_generation=3,
        revision_seq=1,
        is_closed=False,
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.CLOSED_DOWNGRADE,
    )


def test_new_generation_precedes_older_provider_update_evidence() -> None:
    existing = _candidate(provider_update_time_ms=10_000)
    incoming = replace(
        existing,
        provider_generation=3,
        revision_seq=1,
        provider_update_time_ms=9_000,
        close="101.5",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.NEW_GENERATION,
    )


def test_open_to_time_derived_closed_is_accepted() -> None:
    existing = _candidate()
    incoming = replace(existing, revision_seq=11, is_closed=True, close_state_source="TIME_BOUNDARY")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.CLOSED_UPGRADE,
    )


def test_open_to_provider_confirmed_closed_is_accepted() -> None:
    existing = _candidate()
    incoming = replace(existing, revision_seq=11, is_closed=True, close_state_source="OKX_CONFIRM")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.CLOSED_UPGRADE,
    )


def test_close_upgrade_precedes_stale_revision_sequence() -> None:
    existing = _candidate(revision_seq=10)
    incoming = replace(
        existing,
        revision_seq=9,
        is_closed=True,
        close_state_source="PROVIDER_CONFIRMED",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.CLOSED_UPGRADE,
    )


def test_close_upgrade_precedes_older_provider_update_evidence() -> None:
    existing = _candidate(provider_update_time_ms=10_000)
    incoming = replace(
        existing,
        provider_update_time_ms=9_000,
        is_closed=True,
        close_state_source="PROVIDER_CONFIRMED",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.CLOSED_UPGRADE,
    )


def test_provider_confirmed_closed_to_open_is_rejected() -> None:
    existing = _candidate(is_closed=True, close_state_source="PROVIDER_CONFIRMED")
    incoming = replace(existing, revision_seq=11, is_closed=False)

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.CLOSED_DOWNGRADE,
    )


def test_provider_confirmed_closed_to_time_derived_closed_is_rejected() -> None:
    existing = _candidate(is_closed=True, close_state_source="PROVIDER_CONFIRMED")
    incoming = replace(existing, revision_seq=11, close_state_source="TIME_DERIVED")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.CLOSED_DOWNGRADE,
    )


def test_newer_provider_update_time_is_accepted() -> None:
    existing = _candidate(provider_update_time_ms=10_000)
    incoming = replace(existing, provider_update_time_ms=11_000, close="101.5")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.NEWER_PROVIDER_UPDATE,
    )


def test_older_provider_update_time_is_rejected() -> None:
    existing = _candidate(provider_update_time_ms=10_000)
    incoming = replace(existing, provider_update_time_ms=9_000, revision_seq=11)

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.OLDER_PROVIDER_UPDATE,
    )


def test_newer_provider_update_time_precedes_stale_revision_sequence() -> None:
    existing = _candidate(provider_update_time_ms=10_000, revision_seq=10)
    incoming = replace(
        existing,
        provider_update_time_ms=11_000,
        revision_seq=9,
        close="101.5",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.NEWER_PROVIDER_UPDATE,
    )


def test_newer_revision_sequence_is_accepted() -> None:
    existing = _candidate()
    incoming = replace(existing, revision_seq=11, close="101.5")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.NEWER_REVISION,
    )


def test_same_revision_and_same_content_is_no_change() -> None:
    existing = _candidate()
    incoming = replace(existing, received_at_ms=99_999)

    assert is_same_kline_revision(existing, incoming)
    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.NO_CHANGE,
        KlineRevisionReason.DUPLICATE,
    )


def test_same_revision_with_different_ohlcv_is_rejected_as_conflict() -> None:
    existing = _candidate()
    incoming = replace(existing, close="101.5")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.REVISION_CONFLICT,
    )
    assert merge_kline_revision(existing, incoming) is None


def test_unsequenced_ws_has_priority_over_unsequenced_rest() -> None:
    existing = _candidate(transport="REST", source="REST_SNAPSHOT", revision_seq=0)
    incoming = replace(
        existing,
        transport=KlineTransport.WS,
        source="LIVE_WS",
        close="101.5",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.ACTIVE_WS_OVER_REST,
    )


def test_later_received_rest_cannot_override_unsequenced_ws() -> None:
    existing = _candidate(transport="WS", source="LIVE_WS", revision_seq=0)
    incoming = replace(
        existing,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        received_at_ms=99_999,
        close="101.5",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.LOWER_TRANSPORT_PRIORITY,
    )


def test_ws_transport_cannot_override_higher_rest_revision() -> None:
    existing = _candidate(transport="REST", source="REST_SNAPSHOT", revision_seq=11)
    incoming = replace(
        existing,
        transport=KlineTransport.WS,
        source="LIVE_WS",
        revision_seq=10,
        close="101.5",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.STALE_REVISION,
    )


def test_newer_rest_revision_can_beat_ws_transport_priority() -> None:
    existing = _candidate(transport="WS", source="LIVE_WS", revision_seq=10)
    incoming = replace(
        existing,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=11,
        close="101.5",
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.NEWER_REVISION,
    )


def test_later_received_time_alone_cannot_win() -> None:
    existing = _candidate(transport="REST", source="REST_SNAPSHOT", revision_seq=0)
    incoming = replace(existing, received_at_ms=99_999, close="101.5")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.RECEIVED_AT_ONLY,
    )


def test_sparse_candle_uses_identity_rejection_not_revision_ordering() -> None:
    existing = _candidate(open_time=2_000, revision_seq=10)
    incoming = replace(
        existing,
        open_time=8_000,
        revision_epoch=99,
        provider_generation=99,
        revision_seq=99,
    )

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.IDENTITY_MISMATCH,
    )


def test_close_state_normalization_and_rank_are_monotonic() -> None:
    states = [
        normalize_close_state(None, None),
        normalize_close_state(False, None),
        normalize_close_state(True, "TIME_DERIVED"),
        normalize_close_state(True, "PROVIDER_CONFIRM"),
    ]

    assert states == [
        KlineCloseState.UNKNOWN,
        KlineCloseState.OPEN,
        KlineCloseState.CLOSED_TIME_DERIVED,
        KlineCloseState.CLOSED_PROVIDER_CONFIRMED,
    ]
    assert [close_state_rank(state) for state in states] == [0, 1, 2, 3]


def test_new_bucket_merge_returns_incoming_candidate() -> None:
    incoming = _candidate()

    result = compare_kline_revision(None, incoming)
    assert result.decision == KlineRevisionDecision.ACCEPT
    assert result.reason == KlineRevisionReason.NEW_BUCKET
    assert merge_kline_revision(None, incoming) is incoming


def test_rejected_stale_revision_keeps_existing_winner() -> None:
    existing = _candidate(revision_seq=10)
    incoming = replace(existing, revision_seq=9, close="101.5")

    _assert_result(
        existing,
        incoming,
        KlineRevisionDecision.REJECT,
        KlineRevisionReason.STALE_REVISION,
    )
    assert merge_kline_revision(existing, incoming) is existing


def test_rest_cold_start_bootstraps_without_ws_winner() -> None:
    watermark = _watermark(None)
    incoming = _candidate(transport="REST", source="REST_SNAPSHOT", revision_seq=0)

    result = reconcile_rest_kline_candidate(watermark, watermark, incoming)

    assert result.decision == KlineRevisionDecision.ACCEPT
    assert result.reason == KlineRevisionReason.REST_COLD_START


def test_rest_same_bucket_is_rejected_when_ws_revision_advances_during_request() -> None:
    request_winner = _candidate(revision_seq=1, close="100")
    current_winner = replace(request_winner, revision_seq=2, close="101")
    incoming = replace(
        request_winner,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=0,
        close="100",
        received_at_ms=99_999,
    )

    result = reconcile_rest_kline_candidate(
        _watermark(request_winner),
        _watermark(current_winner),
        incoming,
    )

    assert result.decision == KlineRevisionDecision.REJECT
    assert result.reason == KlineRevisionReason.REST_WATERMARK_ADVANCED


def test_rest_cannot_replace_stable_open_ws_current_bucket() -> None:
    winner = _candidate(revision_seq=2, close="101", is_closed=False)
    incoming = replace(
        winner,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=0,
        close="100",
        received_at_ms=99_999,
    )

    result = reconcile_rest_kline_candidate(
        _watermark(winner),
        _watermark(winner),
        incoming,
    )

    assert result.decision == KlineRevisionDecision.REJECT
    assert result.reason == KlineRevisionReason.REST_ACTIVE_WS_CURRENT


def test_rest_older_bucket_is_accepted_as_history() -> None:
    winner = _candidate(open_time=3_000, revision_seq=2)
    incoming = replace(
        winner,
        open_time=2_000,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=0,
    )

    result = reconcile_rest_kline_candidate(
        _watermark(winner),
        _watermark(winner),
        incoming,
    )

    assert result.decision == KlineRevisionDecision.ACCEPT
    assert result.reason == KlineRevisionReason.REST_HISTORICAL_BUCKET


def test_rest_same_closed_bucket_can_complete_final_reconciliation() -> None:
    winner = _candidate(
        revision_seq=2,
        is_closed=True,
        close_state_source="PROVIDER_CONFIRMED",
    )
    incoming = replace(
        winner,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=0,
    )

    result = reconcile_rest_kline_candidate(
        _watermark(winner),
        _watermark(winner),
        incoming,
    )

    assert result.decision == KlineRevisionDecision.ACCEPT
    assert result.reason == KlineRevisionReason.REST_FINAL_RECONCILIATION


def test_rest_cannot_reopen_provider_confirmed_closed_bucket() -> None:
    winner = _candidate(
        revision_seq=2,
        is_closed=True,
        close_state_source="PROVIDER_CONFIRMED",
    )
    incoming = replace(
        winner,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=0,
        is_closed=False,
    )

    result = reconcile_rest_kline_candidate(
        _watermark(winner),
        _watermark(winner),
        incoming,
    )

    assert result.decision == KlineRevisionDecision.REJECT
    assert result.reason == KlineRevisionReason.CLOSED_DOWNGRADE


def test_later_rest_received_at_does_not_win_current_ws_bucket() -> None:
    winner = _candidate(revision_seq=2, received_at_ms=5_000, is_closed=False)
    incoming = replace(
        winner,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=0,
        received_at_ms=999_999,
        close="102",
    )

    result = reconcile_rest_kline_candidate(
        _watermark(winner),
        _watermark(winner),
        incoming,
    )

    assert result.decision == KlineRevisionDecision.REJECT
    assert result.reason == KlineRevisionReason.REST_ACTIVE_WS_CURRENT


def test_provider_switch_invalidates_old_rest_watermark() -> None:
    request_winner = _candidate(provider="OKX_SPOT", revision_epoch=3, revision_seq=5)
    current_winner = replace(
        request_winner,
        provider="BITGET_SPOT",
        revision_epoch=4,
        revision_seq=1,
    )
    incoming = replace(
        request_winner,
        transport=KlineTransport.REST,
        source="REST_SNAPSHOT",
        revision_seq=0,
    )

    result = reconcile_rest_kline_candidate(
        _watermark(request_winner),
        _watermark(current_winner, provider="BITGET_SPOT"),
        incoming,
    )

    assert result.decision == KlineRevisionDecision.REJECT
    assert result.reason == KlineRevisionReason.REST_PROVIDER_SWITCH
