from __future__ import annotations

from typing import Any, Optional

from app.services.market_kline_cache import (
    KLINE_CACHE_ORIGIN_STALE_CACHE,
    KlineCacheResult,
)


def build_spot_kline_terminal_metadata(
    result: KlineCacheResult,
    *,
    end_time_ms: Optional[int],
) -> dict[str, Any]:
    if end_time_ms is None:
        return {
            "history_terminal": None,
            "terminal_reason": None,
            "earliest_available_time": None,
        }

    terminal_reason = str(getattr(result, "terminal_reason", None) or "").strip() or None
    try:
        earliest_available_time = int(getattr(result, "earliest_available_time", None) or 0) or None
    except (TypeError, ValueError):
        earliest_available_time = None

    cache_status = str(getattr(result, "cache_status", None) or "").strip().upper()
    has_terminal_contradiction = bool(
        result.history_incomplete
        or result.provider_error_code
        or result.origin == KLINE_CACHE_ORIGIN_STALE_CACHE
        or cache_status in {
            "PROVIDER_EMPTY",
            "SHORT",
            "TIMEOUT",
            "ERROR",
            "STALE",
            "STALE_OPEN",
            "CONTINUITY_INVALID",
            "COVERAGE_INVALID",
        }
    )
    has_terminal_evidence = bool(terminal_reason and earliest_available_time)
    history_terminal = bool(
        getattr(result, "history_terminal", False) is True
        and has_terminal_evidence
        and not has_terminal_contradiction
    )
    return {
        "history_terminal": history_terminal,
        "terminal_reason": terminal_reason if history_terminal else None,
        "earliest_available_time": earliest_available_time if history_terminal else None,
    }
