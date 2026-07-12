from __future__ import annotations

import time
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Optional, Union
from uuid import uuid4

from pydantic import BaseModel

from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainCompleteness,
    DomainCompletenessStatus,
    DomainFallbackReason,
    DomainFreshness,
    DomainFreshnessBasis,
    DomainName,
    DomainRevision,
    DomainSnapshot,
    DomainSnapshotMetadata,
    DomainSource,
    DomainTransport,
)


KlinePayload = Union[Mapping[str, Any], BaseModel]
KlineData = dict[str, Any]


class KlineDomainSnapshotMetadata(DomainSnapshotMetadata):
    history_terminal: Optional[bool] = None
    history_incomplete: Optional[bool] = None
    terminal_reason: Optional[str] = None
    earliest_available_time: Optional[int] = None
    coverage_complete: Optional[bool] = None
    continuity_valid: Optional[bool] = None


class KlineDomainSnapshot(DomainSnapshot[KlineData]):
    metadata: KlineDomainSnapshotMetadata


# Fixed translations for existing Kline response fields. No value is inferred
# from interval, transport, bar count, terminal state, or cache age.
_LEGACY_KLINE_SOURCE_MAP = {
    "LIVE_WS": DomainSource.LIVE_WS,
    "REST_SNAPSHOT": DomainSource.REST_SNAPSHOT,
    "REST_HISTORY": DomainSource.REST_HISTORY,
    "EXTERNAL": DomainSource.REST_SNAPSHOT,
    "EXTERNAL_SPOT": DomainSource.REST_SNAPSHOT,
    "ITICK": DomainSource.REST_SNAPSHOT,
    "DB_CACHE": DomainSource.DB_CACHE,
    "STALE_CACHE": DomainSource.DB_CACHE,
    "INTERNAL": DomainSource.INTERNAL,
    "INTERNAL_TRADE": DomainSource.INTERNAL,
    "LAST_GOOD": DomainSource.LAST_GOOD,
    "EMPTY": DomainSource.MISSING,
    "MISSING": DomainSource.MISSING,
}

_LEGACY_KLINE_FRESHNESS_MAP = {
    "LIVE": DomainFreshness.LIVE,
    "RECENT": DomainFreshness.RECENT,
    "CACHED": DomainFreshness.RECENT,
    "STALE": DomainFreshness.STALE,
    "LAST_GOOD": DomainFreshness.LAST_GOOD,
    "LAST_VALID": DomainFreshness.LAST_GOOD,
    "MISSING": DomainFreshness.MISSING,
}


def _payload_dict(kline: Any) -> tuple[Optional[dict[str, Any]], bool]:
    if kline is None:
        return None, True
    if isinstance(kline, Mapping):
        return dict(kline), True
    if isinstance(kline, BaseModel):
        if hasattr(kline, "model_dump"):
            return kline.model_dump(), True
        return kline.dict(), True
    return None, False


def _item_dict(item: Any) -> Optional[dict[str, Any]]:
    if isinstance(item, Mapping):
        return dict(item)
    if isinstance(item, BaseModel):
        if hasattr(item, "model_dump"):
            return item.model_dump()
        return item.dict()
    return None


def _kline_items(payload: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
    if payload is None or not isinstance(payload.get("items"), (list, tuple)):
        return []
    return [item for raw in payload.get("items", []) if (item := _item_dict(raw)) is not None]


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_non_negative_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _first_non_negative_int(*values: Any) -> Optional[int]:
    for value in values:
        parsed = _optional_non_negative_int(value)
        if parsed is not None:
            return parsed
    return None


def _optional_bool(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _source_from_payload(payload: Optional[Mapping[str, Any]]) -> DomainSource:
    raw_source = _optional_text(payload.get("source")) if payload is not None else None
    if raw_source is None:
        return DomainSource.MISSING
    return _LEGACY_KLINE_SOURCE_MAP.get(raw_source.upper(), DomainSource.MISSING)


def _freshness_from_payload(payload: Optional[Mapping[str, Any]]) -> DomainFreshness:
    raw_freshness = _optional_text(payload.get("freshness")) if payload is not None else None
    if raw_freshness is None:
        return DomainFreshness.MISSING
    return _LEGACY_KLINE_FRESHNESS_MAP.get(raw_freshness.upper(), DomainFreshness.MISSING)


def _valid_number(value: Any, *, positive: bool) -> bool:
    if value is None or isinstance(value, bool):
        return False
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False
    if not parsed.is_finite():
        return False
    return parsed > 0 if positive else parsed >= 0


def _bar_display_state(item: Any) -> tuple[str, list[str]]:
    bar = _item_dict(item)
    if bar is None:
        return "INVALID", []
    if _optional_non_negative_int(bar.get("open_time")) is None:
        return "INVALID", []
    if any(not _valid_number(bar.get(field), positive=True) for field in ("open", "high", "low", "close")):
        return "INVALID", []

    missing_fields: list[str] = []
    if _optional_non_negative_int(bar.get("close_time")) is None:
        missing_fields.append("close_time")
    for field in ("volume", "quote_volume"):
        if not _valid_number(bar.get(field), positive=False):
            missing_fields.append(field)
    return ("PARTIAL", missing_fields) if missing_fields else ("COMPLETE", [])


def _kline_completeness(
    payload: Optional[Mapping[str, Any]],
    *,
    payload_format_valid: bool,
) -> DomainCompleteness:
    if not payload_format_valid:
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            missing_fields=["items"],
            details={"reason": "kline_payload_not_mapping"},
        )
    if payload is None:
        return DomainCompleteness(
            status=DomainCompletenessStatus.EMPTY,
            has_data=False,
            item_count=0,
            missing_fields=["items"],
        )
    if "items" not in payload:
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            missing_fields=["items"],
            details={"reason": "kline_items_missing"},
        )

    raw_items = payload.get("items")
    if not isinstance(raw_items, (list, tuple)):
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            details={"reason": "kline_items_not_sequence"},
        )
    if not raw_items:
        return DomainCompleteness(
            status=DomainCompletenessStatus.EMPTY,
            has_data=False,
            item_count=0,
        )

    states = [_bar_display_state(item) for item in raw_items]
    invalid_count = sum(state == "INVALID" for state, _missing in states)
    partial_count = sum(state == "PARTIAL" for state, _missing in states)
    complete_count = sum(state == "COMPLETE" for state, _missing in states)
    missing_fields = sorted(
        {
            f"items[{index}].{field}"
            for index, (_state, fields) in enumerate(states)
            for field in fields
        }
    )
    if invalid_count:
        status = DomainCompletenessStatus.INVALID
    elif partial_count:
        status = DomainCompletenessStatus.PARTIAL
    else:
        status = DomainCompletenessStatus.COMPLETE
    return DomainCompleteness(
        status=status,
        has_data=complete_count + partial_count > 0,
        item_count=len(raw_items),
        missing_fields=missing_fields,
        details={
            "complete_count": complete_count,
            "partial_count": partial_count,
            "invalid_count": invalid_count,
        },
    )


def map_kline_domain_snapshot(
    *,
    symbol: str,
    interval: str,
    kline: Optional[KlinePayload],
    transport: DomainTransport = DomainTransport.NONE,
    cache_origin: DomainCacheOrigin = DomainCacheOrigin.NONE,
    provider: Optional[str] = None,
    provider_symbol: Optional[str] = None,
    source: Optional[DomainSource] = None,
    freshness: Optional[DomainFreshness] = None,
    fallback_reason: Optional[DomainFallbackReason] = None,
    provider_event_time_ms: Optional[int] = None,
    received_at_ms: Optional[int] = None,
    cache_updated_at_ms: Optional[int] = None,
    age_ms: Optional[int] = None,
    ttl_ms: Optional[int] = None,
    stale: Optional[bool] = None,
    provider_generation: Optional[int] = None,
    revision_epoch: Optional[int] = None,
    revision_sequence: Optional[int] = None,
    is_closed: Optional[bool] = None,
    close_state_source: Optional[str] = None,
    history_terminal: Optional[bool] = None,
    history_incomplete: Optional[bool] = None,
    terminal_reason: Optional[str] = None,
    earliest_available_time: Optional[int] = None,
    coverage_complete: Optional[bool] = None,
    continuity_valid: Optional[bool] = None,
    freshness_basis: DomainFreshnessBasis = DomainFreshnessBasis.NOT_APPLICABLE,
    emitted_at_ms: Optional[int] = None,
    snapshot_id: Optional[str] = None,
) -> KlineDomainSnapshot:
    """Wrap Kline data and metadata without applying lifecycle or revision logic."""

    payload, payload_format_valid = _payload_dict(kline)
    items = _kline_items(payload)
    resolved_source = source if source is not None else _source_from_payload(payload)
    resolved_freshness = (
        freshness if freshness is not None else _freshness_from_payload(payload)
    )
    emitted_at = (
        int(time.time() * 1000)
        if emitted_at_ms is None
        else _optional_non_negative_int(emitted_at_ms)
    )
    if emitted_at is None:
        raise ValueError("emitted_at_ms must be a non-negative integer")

    payload_stale = payload.get("stale") if payload is not None else None
    resolved_stale = (
        stale
        if isinstance(stale, bool)
        else payload_stale
        if isinstance(payload_stale, bool)
        else payload is None or not payload_format_valid
    )
    resolved_generation = _first_non_negative_int(
        provider_generation,
        payload.get("provider_generation") if payload is not None else None,
    )
    resolved_epoch = _first_non_negative_int(
        revision_epoch,
        payload.get("revision_epoch") if payload is not None else None,
    )
    resolved_sequence = _first_non_negative_int(
        revision_sequence,
        payload.get("revision_seq") if payload is not None else None,
        payload.get("revision_sequence") if payload is not None else None,
    )
    resolved_is_closed = (
        is_closed
        if isinstance(is_closed, bool)
        else (_optional_bool(payload.get("is_closed")) if payload is not None else None)
    )
    resolved_close_state_source = (
        _optional_text(close_state_source)
        if close_state_source is not None
        else (_optional_text(payload.get("close_state_source")) if payload is not None else None)
    )
    revision = (
        DomainRevision(
            epoch=resolved_epoch,
            sequence=resolved_sequence,
            is_closed=resolved_is_closed,
            close_state_source=resolved_close_state_source,
        )
        if any(
            value is not None
            for value in (
                resolved_epoch,
                resolved_sequence,
                resolved_is_closed,
                resolved_close_state_source,
            )
        )
        else None
    )

    payload_history_terminal = (
        _optional_bool(payload.get("history_terminal")) if payload is not None else None
    )
    payload_history_incomplete = (
        _optional_bool(payload.get("history_incomplete")) if payload is not None else None
    )
    payload_coverage_complete = (
        _optional_bool(payload.get("coverage_complete")) if payload is not None else None
    )
    payload_continuity_valid = (
        _optional_bool(payload.get("continuity_valid")) if payload is not None else None
    )

    metadata = KlineDomainSnapshotMetadata(
        domain=DomainName.KLINE,
        symbol=str(symbol),
        interval=str(interval),
        provider=(
            _optional_text(provider)
            if provider is not None
            else (_optional_text(payload.get("provider")) if payload is not None else None)
        ),
        provider_symbol=(
            _optional_text(provider_symbol)
            if provider_symbol is not None
            else (_optional_text(payload.get("provider_symbol")) if payload is not None else None)
        ),
        transport=transport,
        cache_origin=cache_origin,
        source=resolved_source,
        freshness=resolved_freshness,
        fallback_reason=fallback_reason,
        provider_event_time_ms=_first_non_negative_int(
            provider_event_time_ms,
            payload.get("provider_event_time_ms") if payload is not None else None,
            max(
                (
                    value
                    for item in items
                    if (value := _first_non_negative_int(item.get("provider_update_time_ms")))
                    is not None
                ),
                default=None,
            ),
        ),
        received_at_ms=_first_non_negative_int(
            received_at_ms,
            payload.get("received_at_ms") if payload is not None else None,
            payload.get("updated_at_ms") if payload is not None else None,
            max(
                (
                    value
                    for item in items
                    if (value := _first_non_negative_int(item.get("received_at_ms")))
                    is not None
                ),
                default=None,
            ),
        ),
        cache_updated_at_ms=_optional_non_negative_int(cache_updated_at_ms),
        age_ms=_optional_non_negative_int(age_ms),
        ttl_ms=_optional_non_negative_int(ttl_ms),
        stale=resolved_stale,
        provider_generation=resolved_generation,
        revision=revision,
        completeness=_kline_completeness(
            payload,
            payload_format_valid=payload_format_valid,
        ),
        freshness_basis=freshness_basis,
        history_terminal=(
            history_terminal if isinstance(history_terminal, bool) else payload_history_terminal
        ),
        history_incomplete=(
            history_incomplete
            if isinstance(history_incomplete, bool)
            else payload_history_incomplete
        ),
        terminal_reason=(
            _optional_text(terminal_reason)
            if terminal_reason is not None
            else (_optional_text(payload.get("terminal_reason")) if payload is not None else None)
        ),
        earliest_available_time=_first_non_negative_int(
            earliest_available_time,
            payload.get("earliest_available_time") if payload is not None else None,
        ),
        coverage_complete=(
            coverage_complete
            if isinstance(coverage_complete, bool)
            else payload_coverage_complete
        ),
        continuity_valid=(
            continuity_valid
            if isinstance(continuity_valid, bool)
            else payload_continuity_valid
        ),
    )
    return KlineDomainSnapshot(
        snapshot_id=snapshot_id or uuid4().hex,
        emitted_at_ms=emitted_at,
        data=payload,
        metadata=metadata,
    )
