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
    DomainSnapshotMetadata,
    DomainSource,
    DomainTransport,
    TradesDomainSnapshot,
)


TradesPayload = Union[Mapping[str, Any], BaseModel]

# Fixed translations for legacy fields only. The mapper does not derive source
# or freshness from transport, provider, cache origin, age, or trade identity.
_LEGACY_TRADES_SOURCE_MAP = {
    "LIVE_WS": DomainSource.LIVE_WS,
    "REST_SNAPSHOT": DomainSource.REST_SNAPSHOT,
    "EXTERNAL": DomainSource.REST_SNAPSHOT,
    "BINANCE": DomainSource.REST_SNAPSHOT,
    "ITICK": DomainSource.REST_SNAPSHOT,
    "INTERNAL": DomainSource.INTERNAL,
    "LAST_GOOD": DomainSource.LAST_GOOD,
    "MISSING": DomainSource.MISSING,
}

_LEGACY_TRADES_FRESHNESS_MAP = {
    "LIVE": DomainFreshness.LIVE,
    "RECENT": DomainFreshness.RECENT,
    "STALE": DomainFreshness.STALE,
    "LAST_GOOD": DomainFreshness.LAST_GOOD,
    "LAST_VALID": DomainFreshness.LAST_GOOD,
    "MISSING": DomainFreshness.MISSING,
}


def _payload_dict(trades: Any) -> tuple[Optional[dict[str, Any]], bool]:
    if trades is None:
        return None, True
    if isinstance(trades, Mapping):
        return dict(trades), True
    if isinstance(trades, BaseModel):
        if hasattr(trades, "model_dump"):
            return trades.model_dump(), True
        return trades.dict(), True
    return None, False


def _item_dict(item: Any) -> Optional[dict[str, Any]]:
    if isinstance(item, Mapping):
        return dict(item)
    if isinstance(item, BaseModel):
        if hasattr(item, "model_dump"):
            return item.model_dump()
        return item.dict()
    return None


def _trade_items(payload: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
    if payload is None or not isinstance(payload.get("trades"), (list, tuple)):
        return []
    return [item for raw in payload.get("trades", []) if (item := _item_dict(raw)) is not None]


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


def _latest_item_time(items: list[dict[str, Any]], *fields: str) -> Optional[int]:
    values = [
        parsed
        for item in items
        for field in fields
        if (parsed := _optional_non_negative_int(item.get(field))) is not None
    ]
    return max(values) if values else None


def _common_item_text(items: list[dict[str, Any]], field: str) -> Optional[str]:
    values = {
        value
        for item in items
        if (value := _optional_text(item.get(field))) is not None
    }
    return next(iter(values)) if len(values) == 1 else None


def _source_value(
    payload: Optional[Mapping[str, Any]],
    items: list[dict[str, Any]],
) -> DomainSource:
    raw_source = _optional_text(payload.get("source")) if payload is not None else None
    if raw_source is None:
        raw_source = _common_item_text(items, "source")
    if raw_source is None:
        return DomainSource.MISSING
    return _LEGACY_TRADES_SOURCE_MAP.get(raw_source.upper(), DomainSource.MISSING)


def _freshness_value(
    payload: Optional[Mapping[str, Any]],
    items: list[dict[str, Any]],
) -> DomainFreshness:
    raw_freshness = _optional_text(payload.get("freshness")) if payload is not None else None
    if raw_freshness is None:
        raw_freshness = _common_item_text(items, "freshness")
    if raw_freshness is None:
        return DomainFreshness.MISSING
    return _LEGACY_TRADES_FRESHNESS_MAP.get(raw_freshness.upper(), DomainFreshness.MISSING)


def _positive_decimal(value: Any) -> bool:
    if value is None or isinstance(value, bool):
        return False
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return parsed.is_finite() and parsed > 0


def _trade_display_state(item: Any) -> tuple[str, list[str]]:
    trade = _item_dict(item)
    if trade is None:
        return "INVALID", []
    if not _positive_decimal(trade.get("price")) or not _positive_decimal(trade.get("amount")):
        return "INVALID", []

    missing_fields: list[str] = []
    if (_optional_text(trade.get("side")) or "").upper() not in {"BUY", "SELL"}:
        missing_fields.append("side")
    has_time = any(
        trade.get(field) is not None and trade.get(field) != ""
        for field in ("event_time_ms", "ts", "created_at")
    )
    if not has_time:
        missing_fields.append("event_time")
    return ("PARTIAL", missing_fields) if missing_fields else ("COMPLETE", [])


def _trades_completeness(
    payload: Optional[Mapping[str, Any]],
    *,
    payload_format_valid: bool,
) -> DomainCompleteness:
    if not payload_format_valid:
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            missing_fields=["trades"],
            details={"reason": "trades_payload_not_mapping"},
        )
    if payload is None:
        return DomainCompleteness(
            status=DomainCompletenessStatus.EMPTY,
            has_data=False,
            item_count=0,
            missing_fields=["trades"],
        )
    if "trades" not in payload:
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            missing_fields=["trades"],
            details={"reason": "trades_field_missing"},
        )

    raw_items = payload.get("trades")
    if not isinstance(raw_items, (list, tuple)):
        return DomainCompleteness(
            status=DomainCompletenessStatus.INVALID,
            has_data=False,
            item_count=0,
            details={"reason": "trades_not_sequence"},
        )
    if not raw_items:
        return DomainCompleteness(
            status=DomainCompletenessStatus.EMPTY,
            has_data=False,
            item_count=0,
        )

    states = [_trade_display_state(item) for item in raw_items]
    invalid_count = sum(state == "INVALID" for state, _missing in states)
    partial_count = sum(state == "PARTIAL" for state, _missing in states)
    complete_count = sum(state == "COMPLETE" for state, _missing in states)
    missing_fields = sorted(
        {
            f"trades[{index}].{field}"
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


def map_trades_domain_snapshot(
    *,
    symbol: str,
    trades: Optional[TradesPayload],
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
    freshness_basis: DomainFreshnessBasis = DomainFreshnessBasis.NOT_APPLICABLE,
    emitted_at_ms: Optional[int] = None,
    snapshot_id: Optional[str] = None,
) -> TradesDomainSnapshot:
    """Wrap a legacy trades batch without applying identity or dedupe logic."""

    payload, payload_format_valid = _payload_dict(trades)
    items = _trade_items(payload)
    resolved_source = source if source is not None else _source_value(payload, items)
    resolved_freshness = (
        freshness if freshness is not None else _freshness_value(payload, items)
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
    resolved_provider = (
        _optional_text(provider)
        if provider is not None
        else (_optional_text(payload.get("provider")) if payload is not None else None)
    )
    if resolved_provider is None:
        resolved_provider = _common_item_text(items, "provider")
    resolved_provider_symbol = (
        _optional_text(provider_symbol)
        if provider_symbol is not None
        else (_optional_text(payload.get("provider_symbol")) if payload is not None else None)
    )
    if resolved_provider_symbol is None:
        resolved_provider_symbol = _common_item_text(items, "provider_symbol")

    metadata = DomainSnapshotMetadata(
        domain=DomainName.TRADES,
        symbol=str(symbol),
        provider=resolved_provider,
        provider_symbol=resolved_provider_symbol,
        transport=transport,
        cache_origin=cache_origin,
        source=resolved_source,
        freshness=resolved_freshness,
        fallback_reason=fallback_reason,
        provider_event_time_ms=_first_non_negative_int(
            provider_event_time_ms,
            payload.get("provider_event_time_ms") if payload is not None else None,
            payload.get("event_time_ms") if payload is not None else None,
            _latest_item_time(items, "event_time_ms"),
        ),
        received_at_ms=_first_non_negative_int(
            received_at_ms,
            payload.get("received_at_ms") if payload is not None else None,
            payload.get("updated_at_ms") if payload is not None else None,
            _latest_item_time(items, "received_at_ms", "updated_at_ms"),
        ),
        cache_updated_at_ms=_optional_non_negative_int(cache_updated_at_ms),
        age_ms=_optional_non_negative_int(age_ms),
        ttl_ms=_optional_non_negative_int(ttl_ms),
        stale=resolved_stale,
        provider_generation=None,
        revision=None,
        completeness=_trades_completeness(
            payload,
            payload_format_valid=payload_format_valid,
        ),
        freshness_basis=freshness_basis,
    )
    return TradesDomainSnapshot(
        snapshot_id=snapshot_id or uuid4().hex,
        emitted_at_ms=emitted_at,
        data=payload,
        metadata=metadata,
    )
