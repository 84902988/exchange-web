from __future__ import annotations

from typing import Any, Iterable, Optional


KLINE_CACHE_ORIGIN_DB_CACHE = "DB_CACHE"
KLINE_CACHE_ORIGIN_REST_FETCH = "REST_FETCH"
KLINE_CACHE_ORIGIN_STALE_CACHE = "STALE_CACHE"
KLINE_CACHE_ORIGIN_EMPTY = "EMPTY"
KLINE_CACHE_ORIGIN_PROCESS_CACHE = "PROCESS_CACHE"

KLINE_CACHE_STATUS_HIT = "HIT"
KLINE_CACHE_STATUS_MISS = "MISS"
KLINE_CACHE_STATUS_PROVIDER_EMPTY = "PROVIDER_EMPTY"

KLINE_PROVIDER_ERROR_TIMEOUT = "TIMEOUT"
KLINE_PROVIDER_ERROR_COOLDOWN = "COOLDOWN"
KLINE_PROVIDER_ERROR_HTTP = "HTTP_ERROR"
KLINE_PROVIDER_ERROR_EMPTY = "EMPTY"
KLINE_PROVIDER_ERROR_UNKNOWN = "UNKNOWN"

_RETRYABLE_PROVIDER_ERROR_CODES = {
    KLINE_PROVIDER_ERROR_TIMEOUT,
    KLINE_PROVIDER_ERROR_COOLDOWN,
    KLINE_PROVIDER_ERROR_HTTP,
    KLINE_PROVIDER_ERROR_EMPTY,
    KLINE_PROVIDER_ERROR_UNKNOWN,
}
_NON_RETRYABLE_EMPTY_CACHE_STATUSES = {
    "UNSUPPORTED_INTERVAL",
    "PROVIDER_NOT_CONFIGURED",
}


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().upper()


def _copy_items(items: Iterable[Any]) -> list[dict[str, Any]]:
    return [dict(item) for item in items if isinstance(item, dict)]


class ContractKlineResult(list):
    """List-compatible Contract Kline result carrying response semantics."""

    def __init__(
        self,
        items: Iterable[Any] = (),
        *,
        origin: str,
        cache_status: str,
        history_incomplete: bool = False,
        history_complete: Optional[bool] = None,
        has_more_before: Optional[bool] = None,
        provider_error_code: Optional[str] = None,
        retryable: Optional[bool] = None,
    ) -> None:
        super().__init__(_copy_items(items))
        self.origin = _normalize_text(origin) or KLINE_CACHE_ORIGIN_EMPTY
        self.cache_status = _normalize_text(cache_status) or KLINE_CACHE_STATUS_MISS
        self.history_incomplete = bool(history_incomplete)
        normalized_error = _normalize_text(provider_error_code)
        self.provider_error_code = normalized_error or None
        self.retryable = (
            bool(retryable)
            if retryable is not None
            else self.provider_error_code in _RETRYABLE_PROVIDER_ERROR_CODES
        )
        self.history_complete = None if history_complete is None else bool(history_complete)
        self.has_more_before = None if has_more_before is None else bool(has_more_before)
        if self.history_complete is True:
            if self.has_more_before is not False:
                raise ValueError("history_complete requires has_more_before=false")
            if self.history_incomplete:
                raise ValueError("history_complete requires history_incomplete=false")
            if self.retryable:
                raise ValueError("history_complete requires retryable=false")
        elif self.has_more_before is False:
            raise ValueError("has_more_before=false requires history_complete=true")

    @property
    def items(self) -> list[dict[str, Any]]:
        return _copy_items(self)

    def with_items(self, items: Iterable[Any]) -> "ContractKlineResult":
        return ContractKlineResult(
            items,
            origin=self.origin,
            cache_status=self.cache_status,
            history_incomplete=self.history_incomplete,
            history_complete=self.history_complete,
            has_more_before=self.has_more_before,
            provider_error_code=self.provider_error_code,
            retryable=self.retryable,
        )


def coerce_contract_kline_result(
    rows: Any,
    *,
    origin: Optional[str] = None,
    cache_status: Optional[str] = None,
    history_incomplete: Optional[bool] = None,
    history_complete: Optional[bool] = None,
    has_more_before: Optional[bool] = None,
    provider_error_code: Optional[str] = None,
    retryable: Optional[bool] = None,
) -> ContractKlineResult:
    if isinstance(rows, ContractKlineResult):
        if all(
            value is None
            for value in (
                origin,
                cache_status,
                history_incomplete,
                history_complete,
                has_more_before,
                provider_error_code,
                retryable,
            )
        ):
            return rows

    items = list(rows or []) if isinstance(rows, (list, tuple)) else []
    resolved_origin = origin or getattr(rows, "origin", None)
    resolved_cache_status = cache_status or getattr(rows, "cache_status", None)
    resolved_history_incomplete = (
        bool(history_incomplete)
        if history_incomplete is not None
        else bool(getattr(rows, "history_incomplete", False))
    )
    resolved_provider_error_code = (
        provider_error_code
        if provider_error_code is not None
        else getattr(rows, "provider_error_code", None)
    )
    resolved_history_complete = (
        history_complete
        if history_complete is not None
        else getattr(rows, "history_complete", None)
    )
    resolved_has_more_before = (
        has_more_before
        if has_more_before is not None
        else getattr(rows, "has_more_before", None)
    )
    resolved_retryable = retryable
    if resolved_retryable is None and hasattr(rows, "retryable"):
        resolved_retryable = bool(getattr(rows, "retryable"))

    return ContractKlineResult(
        items,
        origin=resolved_origin or (
            KLINE_CACHE_ORIGIN_REST_FETCH if items else KLINE_CACHE_ORIGIN_EMPTY
        ),
        cache_status=resolved_cache_status or (
            KLINE_CACHE_STATUS_MISS if items else "LEGACY"
        ),
        history_incomplete=resolved_history_incomplete,
        history_complete=resolved_history_complete,
        has_more_before=resolved_has_more_before,
        provider_error_code=resolved_provider_error_code,
        retryable=resolved_retryable,
    )


def contract_kline_provider_result(
    rows: Iterable[Any],
    *,
    end_time_ms: Optional[int] = None,
) -> ContractKlineResult:
    items = _copy_items(rows)
    if items:
        return ContractKlineResult(
            items,
            origin=KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status=KLINE_CACHE_STATUS_MISS,
        )
    return ContractKlineResult(
        [],
        origin=KLINE_CACHE_ORIGIN_EMPTY,
        cache_status=KLINE_CACHE_STATUS_PROVIDER_EMPTY,
        history_incomplete=bool(end_time_ms is not None),
        provider_error_code=KLINE_PROVIDER_ERROR_EMPTY,
        retryable=True,
    )


def contract_kline_process_cache_result(rows: Iterable[Any]) -> ContractKlineResult:
    return ContractKlineResult(
        rows,
        origin=KLINE_CACHE_ORIGIN_PROCESS_CACHE,
        cache_status=KLINE_CACHE_STATUS_HIT,
    )


def contract_kline_error_result(
    error: Exception,
    *,
    end_time_ms: Optional[int] = None,
) -> ContractKlineResult:
    lowered = str(error or "").lower()
    if "timeout" in lowered or "timed out" in lowered or "over_budget" in lowered:
        code = KLINE_PROVIDER_ERROR_TIMEOUT
    elif "cooldown" in lowered:
        code = KLINE_PROVIDER_ERROR_COOLDOWN
    elif "http " in lowered or "status_code" in lowered:
        code = KLINE_PROVIDER_ERROR_HTTP
    else:
        code = KLINE_PROVIDER_ERROR_UNKNOWN
    return ContractKlineResult(
        [],
        origin=KLINE_CACHE_ORIGIN_EMPTY,
        cache_status=KLINE_CACHE_STATUS_MISS,
        history_incomplete=bool(end_time_ms is not None),
        provider_error_code=code,
        retryable=True,
    )


def build_contract_kline_metadata(
    rows: Any,
    *,
    end_time_ms: Optional[int],
) -> dict[str, Any]:
    result = coerce_contract_kline_result(rows)
    origin = _normalize_text(result.origin)
    cache_status = _normalize_text(result.cache_status)

    if origin in {KLINE_CACHE_ORIGIN_DB_CACHE, KLINE_CACHE_ORIGIN_PROCESS_CACHE}:
        freshness = "CACHED"
        stale = False
    elif origin == KLINE_CACHE_ORIGIN_STALE_CACHE:
        freshness = "STALE"
        stale = True
    elif origin == KLINE_CACHE_ORIGIN_EMPTY:
        freshness = "MISSING"
        stale = False
    else:
        freshness = "RECENT"
        stale = False

    history_complete: Optional[bool] = None
    has_more_before: Optional[bool] = None
    if end_time_ms is not None:
        history_complete = result.history_complete is True
        has_more_before = True if result.has_more_before is True else None
        if history_complete:
            has_more_before = False
    deterministic_empty = bool(
        not result
        and cache_status in _NON_RETRYABLE_EMPTY_CACHE_STATUSES
    )
    unknown_empty = bool(
        not result
        and history_complete is not True
        and not deterministic_empty
    )
    retryable = False if history_complete else bool(result.retryable or unknown_empty)
    history_incomplete = bool(result.history_incomplete)
    if end_time_ms is not None and unknown_empty:
        history_incomplete = True

    return {
        "items": result.items,
        "cache_status": result.cache_status,
        "freshness": freshness,
        "stale": stale,
        "history_incomplete": False if history_complete else history_incomplete,
        "history_complete": history_complete,
        "has_more_before": has_more_before,
        "provider_error_code": result.provider_error_code,
        "retryable": retryable,
    }


def serialize_contract_kline_response(
    rows: Any,
    *,
    include_metadata: bool,
    end_time_ms: Optional[int],
) -> list[dict[str, Any]] | dict[str, Any]:
    if include_metadata:
        return build_contract_kline_metadata(rows, end_time_ms=end_time_ms)
    return _copy_items(rows or [])
