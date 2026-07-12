from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas.market import KlineResponse
from app.services import market
from app.services.spot_kline_response import build_spot_kline_terminal_metadata
from app.services.market_kline_cache import (
    KLINE_CACHE_ORIGIN_EMPTY,
    KLINE_CACHE_ORIGIN_REST_FETCH,
    KLINE_CACHE_ORIGIN_STALE_CACHE,
    KLINE_CACHE_STATUS_PROVIDER_EMPTY,
    KLINE_CACHE_STATUS_SHORT,
    KLINE_PROVIDER_ERROR_COOLDOWN,
    KLINE_PROVIDER_ERROR_EMPTY,
    KLINE_PROVIDER_ERROR_HTTP,
    KLINE_PROVIDER_ERROR_TIMEOUT,
    KLINE_PROVIDER_ERROR_UNKNOWN,
    KlineCacheResult,
    KlineProviderHistoryBoundary,
)


def _result(
    *,
    origin: str = KLINE_CACHE_ORIGIN_REST_FETCH,
    cache_status: str = "MISS",
    history_incomplete: bool = False,
    provider_error_code: str | None = None,
) -> KlineCacheResult:
    return KlineCacheResult(
        [],
        origin=origin,
        cache_status=cache_status,
        history_incomplete=history_incomplete,
        provider_error_code=provider_error_code,
    )


def test_current_kline_metadata_keeps_history_terminal_fields_unknown():
    metadata = build_spot_kline_terminal_metadata(_result(), end_time_ms=None)

    assert metadata["history_terminal"] is None
    assert metadata["terminal_reason"] is None
    assert metadata["earliest_available_time"] is None


def test_provider_empty_history_is_explicitly_non_terminal():
    result = _result(
        origin=KLINE_CACHE_ORIGIN_EMPTY,
        cache_status=KLINE_CACHE_STATUS_PROVIDER_EMPTY,
        history_incomplete=True,
        provider_error_code=KLINE_PROVIDER_ERROR_EMPTY,
    )
    metadata = build_spot_kline_terminal_metadata(
        result,
        end_time_ms=1_700_000_000_000,
    )

    assert result.history_incomplete is True
    assert result.cache_status == KLINE_CACHE_STATUS_PROVIDER_EMPTY
    assert result.provider_error_code == KLINE_PROVIDER_ERROR_EMPTY
    assert metadata["history_terminal"] is False
    assert metadata["terminal_reason"] is None
    assert metadata["earliest_available_time"] is None


def test_timeout_short_and_stale_history_cannot_claim_terminal():
    cases = [
        _result(
            cache_status=KLINE_CACHE_STATUS_SHORT,
            history_incomplete=True,
            provider_error_code=KLINE_PROVIDER_ERROR_TIMEOUT,
        ),
        _result(
            origin=KLINE_CACHE_ORIGIN_STALE_CACHE,
            cache_status="HIT",
        ),
        _result(
            cache_status="ERROR",
            provider_error_code=KLINE_PROVIDER_ERROR_HTTP,
        ),
        _result(
            cache_status="ERROR",
            provider_error_code=KLINE_PROVIDER_ERROR_COOLDOWN,
        ),
        _result(
            cache_status="ERROR",
            provider_error_code=KLINE_PROVIDER_ERROR_UNKNOWN,
        ),
    ]
    for result in cases:
        result.history_terminal = True
        result.terminal_reason = "PROVIDER_HISTORY_START"
        result.earliest_available_time = 1_600_000_000_000
        metadata = build_spot_kline_terminal_metadata(result, end_time_ms=1_700_000_000_000)

        assert metadata["history_terminal"] is False
        assert metadata["terminal_reason"] is None
        assert metadata["earliest_available_time"] is None


def test_reliable_explicit_history_boundary_metadata_is_preserved():
    result = _result(cache_status="HISTORY_BOUNDARY")
    result.history_terminal = True
    result.terminal_reason = "PROVIDER_HISTORY_START"
    result.earliest_available_time = 1_600_000_000_000

    metadata = build_spot_kline_terminal_metadata(result, end_time_ms=1_700_000_000_000)

    assert metadata["history_terminal"] is True
    assert metadata["terminal_reason"] == "PROVIDER_HISTORY_START"
    assert metadata["earliest_available_time"] == 1_600_000_000_000


def test_terminal_true_requires_reason_and_earliest_time_evidence():
    result = _result(cache_status="HISTORY_BOUNDARY")
    result.history_terminal = True

    metadata = build_spot_kline_terminal_metadata(result, end_time_ms=1_700_000_000_000)

    assert metadata["history_terminal"] is False
    assert metadata["terminal_reason"] is None
    assert metadata["earliest_available_time"] is None


def test_monthly_provider_empty_is_classified_as_history_boundary_signal(monkeypatch):
    provider = SimpleNamespace(provider_code="OKX_SPOT", cooldown_seconds=0)

    class Pair:
        symbol = "BTCUSDT"

    monkeypatch.setattr(
        market,
        "_enabled_spot_market_providers_for_pair",
        lambda *_args, **_kwargs: [provider],
    )
    monkeypatch.setattr(market, "_spot_provider_symbol", lambda *_args, **_kwargs: "BTCUSDT")
    monkeypatch.setattr(market, "_spot_provider_request_config", lambda value, **_kwargs: value)
    monkeypatch.setattr(market, "_fetch_okx_spot_klines", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(market, "mark_contract_market_provider_failure", lambda *_args, **_kwargs: None)

    with pytest.raises(KlineProviderHistoryBoundary) as caught:
        market._fetch_external_spot_klines(
            None,
            Pair(),
            interval="1Mutc",
            limit=60,
            end_time_ms=1_514_764_800_000,
        )

    assert caught.value.provider_error_code == KLINE_PROVIDER_ERROR_EMPTY
    assert caught.value.provider_error_provider == "OKX_SPOT"


def test_public_monthly_kline_response_preserves_history_boundary(monkeypatch):
    provider = SimpleNamespace(provider_code="OKX_SPOT")
    pair = SimpleNamespace(symbol="BTCUSDT", data_source=market.DATA_SOURCE_BINANCE)
    boundary = KlineCacheResult(
        [],
        origin=KLINE_CACHE_ORIGIN_EMPTY,
        cache_status="HISTORY_BOUNDARY",
        history_terminal=True,
        terminal_reason="PROVIDER_HISTORY_BOUNDARY",
        earliest_available_time=1_514_764_800_000,
    )

    monkeypatch.setattr(market, "_get_active_pair", lambda *_args, **_kwargs: pair)
    monkeypatch.setattr(
        market,
        "_enabled_spot_market_providers_for_pair",
        lambda *_args, **_kwargs: [provider],
    )
    monkeypatch.setattr(market, "get_klines_cache_first", lambda *_args, **_kwargs: boundary)

    payload = market.get_klines(
        None,
        "BTCUSDT",
        "1Mutc",
        limit=60,
        end_time_ms=1_514_764_800_000,
        force_rest=True,
    )

    assert payload["items"] == []
    assert payload["source"] == "EMPTY"
    assert payload["freshness"] == "MISSING"
    assert payload["cache_status"] == "HISTORY_BOUNDARY"
    assert payload["history_incomplete"] is False
    assert payload["history_terminal"] is True
    assert payload["terminal_reason"] == "PROVIDER_HISTORY_BOUNDARY"
    assert payload["earliest_available_time"] == 1_514_764_800_000


def test_kline_response_model_serializes_terminal_metadata():
    response = KlineResponse(
        symbol="BTCUSDT",
        interval="1m",
        items=[],
        history_incomplete=False,
        history_terminal=True,
        terminal_reason="PROVIDER_HISTORY_START",
        earliest_available_time=1_600_000_000_000,
    )
    payload = response.model_dump() if hasattr(response, "model_dump") else response.dict()

    assert payload["history_terminal"] is True
    assert payload["terminal_reason"] == "PROVIDER_HISTORY_START"
    assert payload["earliest_available_time"] == 1_600_000_000_000
