from __future__ import annotations

import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from enum import Enum
from threading import RLock
from typing import Any, Mapping, Optional, Sequence, Union
from uuid import uuid4

from pydantic import BaseModel

from app.schemas.contract_market_domain_snapshot import (
    ContractDepthDomainSnapshot,
    ContractKlineDomainSnapshot,
    ContractMarketDomainCacheOrigin,
    ContractMarketDomainCompleteness,
    ContractMarketDomainCompletenessStatus,
    ContractMarketDomainFallbackReason,
    ContractMarketDomainFreshness,
    ContractMarketDomainName,
    ContractMarketDomainRevision,
    ContractMarketDomainSnapshot,
    ContractMarketDomainSnapshotMetadata,
    ContractMarketDomainSource,
    ContractMarketDomainTransport,
    ContractMarketKlineDomainSnapshotMetadata,
    ContractMarketKlineTerminalMetadata,
    ContractTickerDomainSnapshot,
    ContractTradesDomainSnapshot,
)
from app.services.contract_market_domain_freshness import (
    ContractMarketDomainFreshnessContext,
    resolve_contract_market_domain_freshness,
)


ContractMarketPayload = Union[Mapping[str, Any], BaseModel, Sequence[Mapping[str, Any]]]


class ContractMarketDomainSnapshotAuthorityDecision(str, Enum):
    ACCEPT = "ACCEPT"
    REJECT = "REJECT"


class ContractMarketDomainSnapshotAuthorityReason(str, Enum):
    BOOTSTRAP = "BOOTSTRAP"
    ACCEPTED = "ACCEPTED"
    INVALID_SNAPSHOT = "INVALID_SNAPSHOT"
    PROVIDER_SWITCH = "PROVIDER_SWITCH"
    NEW_GENERATION = "NEW_GENERATION"
    OLD_GENERATION = "OLD_GENERATION"
    STALE_SNAPSHOT = "STALE_SNAPSHOT"
    REVISION_ROLLBACK = "REVISION_ROLLBACK"
    REVISION_CONFLICT = "REVISION_CONFLICT"
    CLOSED_STATE_ROLLBACK = "CLOSED_STATE_ROLLBACK"
    IDENTITY_MISMATCH = "IDENTITY_MISMATCH"


@dataclass(frozen=True)
class ContractMarketDomainSnapshotAuthorityResult:
    decision: ContractMarketDomainSnapshotAuthorityDecision
    reason: ContractMarketDomainSnapshotAuthorityReason
    current: Optional[ContractMarketDomainSnapshot[Any]]
    incoming: ContractMarketDomainSnapshot[Any]

    @property
    def accepted(self) -> bool:
        return self.decision == ContractMarketDomainSnapshotAuthorityDecision.ACCEPT


def _snapshot_authority_key(
    snapshot: ContractMarketDomainSnapshot[Any],
) -> tuple[str, str, Optional[str]]:
    metadata = snapshot.metadata
    interval = _normalize_interval(metadata.interval)
    if metadata.domain != ContractMarketDomainName.KLINE:
        interval = None
    return metadata.domain.value, _normalize_symbol(metadata.symbol), interval


def _snapshot_observed_at_ms(
    snapshot: ContractMarketDomainSnapshot[Any],
) -> int:
    metadata = snapshot.metadata
    for value in (
        metadata.received_at_ms,
        metadata.cache_updated_at_ms,
        metadata.db_updated_at_ms,
        metadata.provider_event_time_ms,
    ):
        resolved = _optional_non_negative_int(value)
        if resolved is not None:
            return resolved
    return snapshot.emitted_at_ms


def _snapshot_is_stale(
    snapshot: ContractMarketDomainSnapshot[Any],
    *,
    now_ms: Optional[int] = None,
) -> bool:
    metadata = snapshot.metadata
    if metadata.freshness in {
        ContractMarketDomainFreshness.STALE,
        ContractMarketDomainFreshness.LAST_GOOD,
        ContractMarketDomainFreshness.MISSING,
    }:
        return True
    ttl_ms = _optional_non_negative_int(metadata.ttl_ms)
    if ttl_ms is None or now_ms is None:
        return False
    return now_ms - _snapshot_observed_at_ms(snapshot) > ttl_ms


def _authority_result(
    *,
    accepted: bool,
    reason: ContractMarketDomainSnapshotAuthorityReason,
    current: Optional[ContractMarketDomainSnapshot[Any]],
    incoming: ContractMarketDomainSnapshot[Any],
) -> ContractMarketDomainSnapshotAuthorityResult:
    return ContractMarketDomainSnapshotAuthorityResult(
        decision=(
            ContractMarketDomainSnapshotAuthorityDecision.ACCEPT
            if accepted
            else ContractMarketDomainSnapshotAuthorityDecision.REJECT
        ),
        reason=reason,
        current=current,
        incoming=incoming,
    )


def compare_contract_market_domain_snapshots(
    current: Optional[ContractMarketDomainSnapshot[Any]],
    incoming: ContractMarketDomainSnapshot[Any],
) -> ContractMarketDomainSnapshotAuthorityResult:
    """Compare one incoming domain winner against the current authority.

    Generation and revision evidence are only comparable inside the same
    provider lineage. Local observation time is the final ordering fallback.
    """

    incoming_metadata = incoming.metadata
    if (
        incoming_metadata.domain == ContractMarketDomainName.TRADES
        and incoming_metadata.completeness.status
        in {
            ContractMarketDomainCompletenessStatus.INVALID,
            ContractMarketDomainCompletenessStatus.PARTIAL,
        }
    ):
        return _authority_result(
            accepted=False,
            reason=ContractMarketDomainSnapshotAuthorityReason.INVALID_SNAPSHOT,
            current=current,
            incoming=incoming,
        )
    if current is None:
        return _authority_result(
            accepted=True,
            reason=ContractMarketDomainSnapshotAuthorityReason.BOOTSTRAP,
            current=None,
            incoming=incoming,
        )
    if _snapshot_authority_key(current) != _snapshot_authority_key(incoming):
        return _authority_result(
            accepted=False,
            reason=ContractMarketDomainSnapshotAuthorityReason.IDENTITY_MISMATCH,
            current=current,
            incoming=incoming,
        )

    current_metadata = current.metadata
    same_provider = current_metadata.provider == incoming_metadata.provider
    current_generation = current_metadata.provider_generation
    incoming_generation = incoming_metadata.provider_generation

    if (
        same_provider
        and current_generation is not None
        and incoming_generation is not None
    ):
        if incoming_generation < current_generation:
            return _authority_result(
                accepted=False,
                reason=ContractMarketDomainSnapshotAuthorityReason.OLD_GENERATION,
                current=current,
                incoming=incoming,
            )
        if incoming_generation > current_generation:
            return _authority_result(
                accepted=True,
                reason=ContractMarketDomainSnapshotAuthorityReason.NEW_GENERATION,
                current=current,
                incoming=incoming,
            )

    if (
        same_provider
        and current_generation is not None
        and incoming_generation is None
        and incoming_metadata.transport == ContractMarketDomainTransport.PROVIDER_WS
    ):
        return _authority_result(
            accepted=False,
            reason=ContractMarketDomainSnapshotAuthorityReason.OLD_GENERATION,
            current=current,
            incoming=incoming,
        )

    comparison_time_ms = incoming.emitted_at_ms
    if _snapshot_is_stale(incoming) and not _snapshot_is_stale(
        current,
        now_ms=comparison_time_ms,
    ):
        return _authority_result(
            accepted=False,
            reason=ContractMarketDomainSnapshotAuthorityReason.STALE_SNAPSHOT,
            current=current,
            incoming=incoming,
        )

    same_revision_lineage = same_provider and (
        current_generation == incoming_generation
        or (current_generation is None and incoming_generation is None)
    )
    if same_revision_lineage:
        current_revision = current_metadata.revision
        incoming_revision = incoming_metadata.revision
        if current_revision is not None:
            if incoming_revision is None:
                return _authority_result(
                    accepted=False,
                    reason=ContractMarketDomainSnapshotAuthorityReason.REVISION_ROLLBACK,
                    current=current,
                    incoming=incoming,
                )
            if (
                current_revision.epoch is not None
                and incoming_revision.epoch is not None
            ):
                if incoming_revision.epoch < current_revision.epoch:
                    return _authority_result(
                        accepted=False,
                        reason=ContractMarketDomainSnapshotAuthorityReason.REVISION_ROLLBACK,
                        current=current,
                        incoming=incoming,
                    )
                if incoming_revision.epoch > current_revision.epoch:
                    return _authority_result(
                        accepted=True,
                        reason=ContractMarketDomainSnapshotAuthorityReason.ACCEPTED,
                        current=current,
                        incoming=incoming,
                    )
            if current_revision.sequence is not None:
                if incoming_revision.sequence is None:
                    return _authority_result(
                        accepted=False,
                        reason=ContractMarketDomainSnapshotAuthorityReason.REVISION_ROLLBACK,
                        current=current,
                        incoming=incoming,
                    )
                if incoming_revision.sequence < current_revision.sequence:
                    return _authority_result(
                        accepted=False,
                        reason=ContractMarketDomainSnapshotAuthorityReason.REVISION_ROLLBACK,
                        current=current,
                        incoming=incoming,
                    )
                if incoming_revision.sequence > current_revision.sequence:
                    return _authority_result(
                        accepted=True,
                        reason=ContractMarketDomainSnapshotAuthorityReason.ACCEPTED,
                        current=current,
                        incoming=incoming,
                    )
            if current_revision.is_closed is True and incoming_revision.is_closed is False:
                return _authority_result(
                    accepted=False,
                    reason=ContractMarketDomainSnapshotAuthorityReason.CLOSED_STATE_ROLLBACK,
                    current=current,
                    incoming=incoming,
                )
            if (
                current_revision.sequence is not None
                and current_revision.sequence == incoming_revision.sequence
                and current_revision.checksum
                and incoming_revision.checksum
                and current_revision.checksum != incoming_revision.checksum
            ):
                return _authority_result(
                    accepted=False,
                    reason=ContractMarketDomainSnapshotAuthorityReason.REVISION_CONFLICT,
                    current=current,
                    incoming=incoming,
                )

    if _snapshot_observed_at_ms(incoming) < _snapshot_observed_at_ms(current):
        return _authority_result(
            accepted=False,
            reason=ContractMarketDomainSnapshotAuthorityReason.STALE_SNAPSHOT,
            current=current,
            incoming=incoming,
        )

    return _authority_result(
        accepted=True,
        reason=(
            ContractMarketDomainSnapshotAuthorityReason.ACCEPTED
            if same_provider
            else ContractMarketDomainSnapshotAuthorityReason.PROVIDER_SWITCH
        ),
        current=current,
        incoming=incoming,
    )


class ContractMarketDomainSnapshotAuthority:
    def __init__(self) -> None:
        self._latest: dict[
            tuple[str, str, Optional[str]],
            ContractMarketDomainSnapshot[Any],
        ] = {}
        self._lock = RLock()

    def accept(
        self,
        snapshot: ContractMarketDomainSnapshot[Any],
    ) -> ContractMarketDomainSnapshotAuthorityResult:
        key = _snapshot_authority_key(snapshot)
        with self._lock:
            current = self._latest.get(key)
            result = compare_contract_market_domain_snapshots(current, snapshot)
            if result.accepted:
                self._latest[key] = snapshot.model_copy(deep=True)
            return ContractMarketDomainSnapshotAuthorityResult(
                decision=result.decision,
                reason=result.reason,
                current=(
                    result.current.model_copy(deep=True)
                    if result.current is not None
                    else None
                ),
                incoming=result.incoming.model_copy(deep=True),
            )

    def get(
        self,
        domain: ContractMarketDomainName,
        symbol: str,
        *,
        interval: Optional[str] = None,
    ) -> Optional[ContractMarketDomainSnapshot[Any]]:
        normalized_interval = (
            _normalize_interval(interval)
            if domain == ContractMarketDomainName.KLINE
            else None
        )
        key = domain.value, _normalize_symbol(symbol), normalized_interval
        with self._lock:
            snapshot = self._latest.get(key)
            return snapshot.model_copy(deep=True) if snapshot is not None else None

    def clear_symbol(self, symbol: str) -> None:
        normalized_symbol = _normalize_symbol(symbol)
        with self._lock:
            for key in [key for key in self._latest if key[1] == normalized_symbol]:
                self._latest.pop(key, None)


@dataclass(frozen=True)
class ContractMarketDomainSnapshotContext:
    symbol: str
    interval: Optional[str] = None
    transport: ContractMarketDomainTransport = ContractMarketDomainTransport.NONE
    cache_origin: ContractMarketDomainCacheOrigin = ContractMarketDomainCacheOrigin.NONE
    source: Optional[ContractMarketDomainSource] = None
    provider: Optional[str] = None
    provider_symbol: Optional[str] = None
    fallback_reason: Optional[ContractMarketDomainFallbackReason] = None
    provider_event_time_ms: Optional[int] = None
    received_at_ms: Optional[int] = None
    cache_updated_at_ms: Optional[int] = None
    db_updated_at_ms: Optional[int] = None
    ttl_ms: Optional[int] = None
    provider_generation: Optional[int] = None
    revision: Optional[ContractMarketDomainRevision] = None
    emitted_at_ms: Optional[int] = None
    snapshot_id: Optional[str] = None


_LEGACY_SOURCE_MAP = {
    "LIVE_WS": ContractMarketDomainSource.LIVE_WS,
    "PROVIDER_WS": ContractMarketDomainSource.LIVE_WS,
    "PROVIDER_REST": ContractMarketDomainSource.REST_SNAPSHOT,
    "ITICK_TICK": ContractMarketDomainSource.REST_SNAPSHOT,
    "ITICK_QUOTE": ContractMarketDomainSource.REST_SNAPSHOT,
    "ITICK_DEPTH": ContractMarketDomainSource.REST_SNAPSHOT,
    "REST_SNAPSHOT": ContractMarketDomainSource.REST_SNAPSHOT,
    "EXTERNAL": ContractMarketDomainSource.REST_SNAPSHOT,
    "CONFIGURED": ContractMarketDomainSource.REST_SNAPSHOT,
    "BINANCE": ContractMarketDomainSource.REST_SNAPSHOT,
    "BINANCE_USDM": ContractMarketDomainSource.REST_SNAPSHOT,
    "OKX_SWAP": ContractMarketDomainSource.REST_SNAPSHOT,
    "BITGET_USDT_FUTURES": ContractMarketDomainSource.REST_SNAPSHOT,
    "ITICK": ContractMarketDomainSource.REST_SNAPSHOT,
    "REST_HISTORY": ContractMarketDomainSource.REST_HISTORY,
    "DB_CACHE": ContractMarketDomainSource.DB_CACHE,
    "STALE_CACHE": ContractMarketDomainSource.DB_CACHE,
    "PROCESS_CACHE": ContractMarketDomainSource.DB_CACHE,
    "INTERNAL": ContractMarketDomainSource.INTERNAL,
    "LAST_GOOD": ContractMarketDomainSource.LAST_GOOD,
    "LAST_VALID": ContractMarketDomainSource.LAST_GOOD,
    "LAST_GOOD_BBO": ContractMarketDomainSource.LAST_GOOD,
    "EMPTY": ContractMarketDomainSource.MISSING,
    "MISSING": ContractMarketDomainSource.MISSING,
    "SYNTHETIC_FROM_QUOTE": ContractMarketDomainSource.MISSING,
    "QUOTE_DRIVEN": ContractMarketDomainSource.MISSING,
}


def _normalize_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_interval(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    return "1M" if text == "1M" else text.lower()


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_bool(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _optional_non_negative_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _timestamp_ms(value: Any) -> Optional[int]:
    if value in (None, "") or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0, int(parsed.timestamp() * 1000))
    try:
        number = float(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0, int(parsed.timestamp() * 1000))
    if number < 0:
        return None
    return int(number if number > 10_000_000_000 else number * 1000)


def _copy_payload(
    payload: Any,
    *,
    allow_sequence: bool,
) -> tuple[Optional[Any], bool]:
    if payload is None:
        return None, True
    if isinstance(payload, BaseModel):
        if hasattr(payload, "model_dump"):
            return deepcopy(payload.model_dump()), True
        return deepcopy(payload.dict()), True
    if isinstance(payload, Mapping):
        return deepcopy(dict(payload)), True
    if allow_sequence and isinstance(payload, (list, tuple)):
        if not all(isinstance(item, Mapping) for item in payload):
            return None, False
        return [deepcopy(dict(item)) for item in payload], True
    return None, False


def _records(payload: Optional[Any]) -> list[Mapping[str, Any]]:
    if isinstance(payload, Mapping):
        result: list[Mapping[str, Any]] = [payload]
        for key in ("items", "trades", "rows", "klines"):
            values = payload.get(key)
            if isinstance(values, list):
                result.extend(item for item in values if isinstance(item, Mapping))
                break
        return result
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, Mapping)]
    return []


def _record_value(records: list[Mapping[str, Any]], *keys: str) -> Any:
    for record in records:
        for key in keys:
            value = record.get(key)
            if value not in (None, ""):
                return value
    return None


def _resolved_source(
    context: ContractMarketDomainSnapshotContext,
    records: list[Mapping[str, Any]],
) -> ContractMarketDomainSource:
    if context.source is not None:
        return context.source
    raw_source = _optional_text(
        _record_value(records, "source", "quote_source", "data_source")
    )
    if raw_source is None:
        return ContractMarketDomainSource.MISSING
    return _LEGACY_SOURCE_MAP.get(
        raw_source.upper(),
        ContractMarketDomainSource.MISSING,
    )


def _resolved_provider(
    context: ContractMarketDomainSnapshotContext,
    records: list[Mapping[str, Any]],
) -> Optional[str]:
    return _optional_text(context.provider) or _optional_text(
        _record_value(records, "provider")
    )


def _resolved_provider_symbol(
    context: ContractMarketDomainSnapshotContext,
    records: list[Mapping[str, Any]],
) -> Optional[str]:
    return _optional_text(context.provider_symbol) or _optional_text(
        _record_value(records, "provider_symbol", "exchange_symbol")
    )


def _resolved_generation(
    context: ContractMarketDomainSnapshotContext,
    records: list[Mapping[str, Any]],
) -> Optional[int]:
    explicit = _optional_non_negative_int(context.provider_generation)
    if explicit is not None:
        return explicit
    return _optional_non_negative_int(
        _record_value(records, "provider_generation", "generation")
    )


def _resolved_revision(
    context: ContractMarketDomainSnapshotContext,
    records: list[Mapping[str, Any]],
    *,
    provider_generation: Optional[int],
) -> Optional[ContractMarketDomainRevision]:
    if context.revision is not None:
        return context.revision.model_copy(deep=True)

    sequence = _optional_non_negative_int(
        _record_value(records, "revision_seq", "revision_sequence", "sequence")
    )
    epoch = _optional_non_negative_int(
        _record_value(records, "revision_epoch", "epoch")
    )
    if epoch is None and sequence is not None:
        epoch = provider_generation
    is_closed = _optional_bool(
        _record_value(records, "is_closed", "is_final")
    )
    close_state_source = _optional_text(
        _record_value(records, "close_state_source")
    )
    checksum = _optional_text(_record_value(records, "checksum"))
    if all(
        value is None
        for value in (epoch, sequence, is_closed, close_state_source, checksum)
    ):
        return None
    return ContractMarketDomainRevision(
        epoch=epoch,
        sequence=sequence,
        is_closed=is_closed,
        close_state_source=close_state_source,
        checksum=checksum,
    )


def _positive_decimal(value: Any, *, allow_zero: bool = False) -> bool:
    if value in (None, "") or isinstance(value, bool):
        return False
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return parsed >= 0 if allow_zero else parsed > 0


def _ticker_completeness(
    payload: Optional[Any],
    *,
    valid_container: bool,
) -> ContractMarketDomainCompleteness:
    if not valid_container:
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.INVALID,
            has_data=False,
            missing_fields=["ticker"],
        )
    if not isinstance(payload, Mapping):
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.EMPTY,
            has_data=False,
        )

    price_fields = (
        "last_price",
        "bid_price",
        "ask_price",
        "best_bid",
        "best_ask",
        "mark_price",
        "index_price",
    )
    present = {key: payload.get(key) for key in price_fields if payload.get(key) not in (None, "")}
    valid = {key for key, value in present.items() if _positive_decimal(value)}
    invalid = sorted(set(present) - valid)
    if not present:
        status = ContractMarketDomainCompletenessStatus.EMPTY
    elif not valid:
        status = ContractMarketDomainCompletenessStatus.INVALID
    elif invalid:
        status = ContractMarketDomainCompletenessStatus.PARTIAL
    else:
        status = ContractMarketDomainCompletenessStatus.COMPLETE
    return ContractMarketDomainCompleteness(
        status=status,
        has_data=bool(valid),
        item_count=len(valid),
        missing_fields=invalid,
        details={"price_fields": sorted(valid)},
    )


def _depth_level_valid(value: Any) -> bool:
    if isinstance(value, Mapping):
        price = value.get("price")
        amount = value.get("amount", value.get("qty", value.get("quantity")))
    elif isinstance(value, (list, tuple)) and len(value) >= 2:
        price, amount = value[0], value[1]
    else:
        return False
    return _positive_decimal(price) and _positive_decimal(amount, allow_zero=True)


def _depth_completeness(
    payload: Optional[Any],
    *,
    valid_container: bool,
) -> ContractMarketDomainCompleteness:
    if not valid_container or (payload is not None and not isinstance(payload, Mapping)):
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.INVALID,
            has_data=False,
            missing_fields=["depth"],
        )
    if payload is None:
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.EMPTY,
            has_data=False,
        )
    bids = payload.get("bids")
    asks = payload.get("asks")
    if not isinstance(bids, list) or not isinstance(asks, list):
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.INVALID,
            has_data=False,
            missing_fields=[
                key
                for key, value in (("bids", bids), ("asks", asks))
                if not isinstance(value, list)
            ],
        )
    valid_bids = sum(1 for item in bids if _depth_level_valid(item))
    valid_asks = sum(1 for item in asks if _depth_level_valid(item))
    invalid_count = len(bids) + len(asks) - valid_bids - valid_asks
    if not bids and not asks:
        status = ContractMarketDomainCompletenessStatus.EMPTY
    elif invalid_count and not (valid_bids or valid_asks):
        status = ContractMarketDomainCompletenessStatus.INVALID
    elif invalid_count or not valid_bids or not valid_asks:
        status = ContractMarketDomainCompletenessStatus.PARTIAL
    else:
        status = ContractMarketDomainCompletenessStatus.COMPLETE
    return ContractMarketDomainCompleteness(
        status=status,
        has_data=bool(valid_bids or valid_asks),
        item_count=valid_bids + valid_asks,
        missing_fields=[
            side
            for side, count in (("bids", valid_bids), ("asks", valid_asks))
            if count == 0
        ],
        details={
            "bid_count": valid_bids,
            "ask_count": valid_asks,
            "invalid_level_count": invalid_count,
        },
    )


def _trade_items(payload: Optional[Any]) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, Mapping)]
    if isinstance(payload, Mapping):
        for key in ("trades", "items", "rows"):
            values = payload.get(key)
            if isinstance(values, list):
                return [item for item in values if isinstance(item, Mapping)]
        if any(key in payload for key in ("price", "last_price")):
            return [payload]
    return []


_PROVIDER_WS_TRADE_SOURCES = {"LIVE_WS", "PROVIDER_WS"}
_PROVIDER_REST_TRADE_SOURCES = {"PROVIDER_REST", "ITICK_TICK"}
_REAL_TRADE_SOURCES = _PROVIDER_WS_TRADE_SOURCES | _PROVIDER_REST_TRADE_SOURCES


def _trade_valid(item: Mapping[str, Any], *, expected_symbol: str) -> bool:
    price = item.get("price", item.get("last_price"))
    amount = item.get("qty", item.get("amount", item.get("quantity", item.get("volume"))))
    item_symbol = _normalize_symbol(item.get("symbol"))
    source = str(item.get("source") or "").strip().upper()
    quote_source = str(item.get("quote_source") or source).strip().upper()
    freshness = str(item.get("freshness") or item.get("quote_freshness") or "").strip().upper()
    expected_freshness = (
        ContractMarketDomainFreshness.LIVE.value
        if source in _PROVIDER_WS_TRADE_SOURCES
        else ContractMarketDomainFreshness.RECENT.value
        if source in _PROVIDER_REST_TRADE_SOURCES
        else ""
    )
    synthetic = item.get("synthetic") is True or str(item.get("synthetic") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    event_time_ms = None
    for key in ("event_time_ms", "time", "ts", "exchange_ts"):
        event_time_ms = _timestamp_ms(item.get(key))
        if event_time_ms is not None and event_time_ms > 0:
            break
    return bool(
        item_symbol == _normalize_symbol(expected_symbol)
        and _positive_decimal(price)
        and _positive_decimal(amount)
        and event_time_ms is not None
        and event_time_ms > 0
        and str(item.get("price_source") or "").strip().upper() == "TRADE_TICK"
        and source in _REAL_TRADE_SOURCES
        and quote_source in _REAL_TRADE_SOURCES
        and freshness == expected_freshness
        and not synthetic
        and _optional_text(item.get("provider")) is not None
        and _optional_text(item.get("provider_symbol")) is not None
    )


def _trades_completeness(
    payload: Optional[Any],
    *,
    valid_container: bool,
    expected_symbol: str,
) -> ContractMarketDomainCompleteness:
    if not valid_container:
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.INVALID,
            has_data=False,
            missing_fields=["trades"],
        )
    items = _trade_items(payload)
    if not items:
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.EMPTY,
            has_data=False,
        )
    valid_count = sum(1 for item in items if _trade_valid(item, expected_symbol=expected_symbol))
    invalid_count = len(items) - valid_count
    if valid_count == 0:
        status = ContractMarketDomainCompletenessStatus.INVALID
    elif invalid_count:
        status = ContractMarketDomainCompletenessStatus.PARTIAL
    else:
        status = ContractMarketDomainCompletenessStatus.COMPLETE
    return ContractMarketDomainCompleteness(
        status=status,
        has_data=valid_count > 0,
        item_count=valid_count,
        details={"invalid_trade_count": invalid_count},
    )


def _kline_items(payload: Optional[Any]) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, Mapping)]
    if isinstance(payload, Mapping):
        for key in ("items", "klines", "rows"):
            values = payload.get(key)
            if isinstance(values, list):
                return [item for item in values if isinstance(item, Mapping)]
        if all(key in payload for key in ("open", "high", "low", "close")):
            return [payload]
    return []


def _kline_item_valid(item: Mapping[str, Any]) -> bool:
    return all(_positive_decimal(item.get(key)) for key in ("open", "high", "low", "close")) and (
        item.get("volume") in (None, "")
        or _positive_decimal(item.get("volume"), allow_zero=True)
    )


def _kline_completeness(
    payload: Optional[Any],
    *,
    valid_container: bool,
) -> ContractMarketDomainCompleteness:
    if not valid_container:
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.INVALID,
            has_data=False,
            missing_fields=["kline"],
        )
    items = _kline_items(payload)
    if not items:
        return ContractMarketDomainCompleteness(
            status=ContractMarketDomainCompletenessStatus.EMPTY,
            has_data=False,
        )
    valid_count = sum(1 for item in items if _kline_item_valid(item))
    invalid_count = len(items) - valid_count
    if valid_count == 0:
        status = ContractMarketDomainCompletenessStatus.INVALID
    elif invalid_count:
        status = ContractMarketDomainCompletenessStatus.PARTIAL
    else:
        status = ContractMarketDomainCompletenessStatus.COMPLETE
    return ContractMarketDomainCompleteness(
        status=status,
        has_data=valid_count > 0,
        item_count=valid_count,
        details={"invalid_bar_count": invalid_count},
    )


def _build_metadata(
    *,
    domain: ContractMarketDomainName,
    payload: Optional[Any],
    context: ContractMarketDomainSnapshotContext,
    completeness: ContractMarketDomainCompleteness,
    now_ms: int,
) -> ContractMarketDomainSnapshotMetadata:
    symbol = _normalize_symbol(context.symbol)
    if not symbol:
        raise ValueError("contract market domain snapshot symbol is required")
    records = _records(payload)
    source = _resolved_source(context, records)
    provider_generation = _resolved_generation(context, records)
    provider_event_time_ms = _timestamp_ms(context.provider_event_time_ms)
    if provider_event_time_ms is None:
        provider_event_time_keys = (
            ("provider_event_time_ms", "event_time_ms")
            if domain == ContractMarketDomainName.KLINE
            else ("provider_event_time_ms", "event_time_ms", "exchange_ts")
        )
        provider_event_time_ms = _timestamp_ms(
            _record_value(records, *provider_event_time_keys)
        )
    received_at_ms = _timestamp_ms(context.received_at_ms)
    if received_at_ms is None:
        received_at_ms = _timestamp_ms(_record_value(records, "received_at_ms"))
    cache_updated_at_ms = _timestamp_ms(context.cache_updated_at_ms)
    if cache_updated_at_ms is None:
        cache_updated_at_ms = _timestamp_ms(
            _record_value(records, "cache_updated_at_ms", "updated_at_ms", "updated_at")
        )
    db_updated_at_ms = _timestamp_ms(context.db_updated_at_ms)
    freshness = resolve_contract_market_domain_freshness(
        ContractMarketDomainFreshnessContext(
            domain=domain,
            symbol=symbol,
            interval=_normalize_interval(context.interval),
            transport=context.transport,
            cache_origin=context.cache_origin,
            source=source,
            fallback_reason=context.fallback_reason,
            provider_event_time_ms=provider_event_time_ms,
            received_at_ms=received_at_ms,
            cache_updated_at_ms=cache_updated_at_ms,
            db_updated_at_ms=db_updated_at_ms,
            ttl_ms=context.ttl_ms,
        ),
        now_ms=now_ms,
    )
    return ContractMarketDomainSnapshotMetadata(
        domain=domain,
        symbol=symbol,
        interval=(
            _normalize_interval(context.interval)
            if domain == ContractMarketDomainName.KLINE
            else None
        ),
        source=source,
        provider=_resolved_provider(context, records),
        provider_symbol=_resolved_provider_symbol(context, records),
        transport=context.transport,
        cache_origin=context.cache_origin,
        freshness=freshness.freshness,
        fallback_reason=context.fallback_reason,
        provider_event_time_ms=provider_event_time_ms,
        received_at_ms=received_at_ms,
        cache_updated_at_ms=cache_updated_at_ms,
        db_updated_at_ms=db_updated_at_ms,
        age_ms=freshness.age_ms,
        ttl_ms=freshness.ttl_ms,
        stale=freshness.stale,
        freshness_basis=freshness.freshness_basis,
        provider_generation=provider_generation,
        revision=_resolved_revision(
            context,
            records,
            provider_generation=provider_generation,
        ),
        completeness=completeness,
    )


def _snapshot_identity(
    context: ContractMarketDomainSnapshotContext,
) -> tuple[int, str]:
    emitted_at_ms = _optional_non_negative_int(context.emitted_at_ms)
    if emitted_at_ms is None:
        emitted_at_ms = int(time.time() * 1000)
    return emitted_at_ms, _optional_text(context.snapshot_id) or uuid4().hex


def _terminal_metadata(
    payload: Optional[Any],
    explicit: Optional[ContractMarketKlineTerminalMetadata],
) -> ContractMarketKlineTerminalMetadata:
    if explicit is not None:
        return explicit.model_copy(deep=True)
    records = _records(payload)
    history_terminal = _optional_bool(_record_value(records, "history_terminal"))
    terminal_reason = _optional_text(_record_value(records, "terminal_reason"))
    earliest_available_time = _timestamp_ms(
        _record_value(records, "earliest_available_time")
    )
    return ContractMarketKlineTerminalMetadata(
        history_terminal=history_terminal,
        history_incomplete=_optional_bool(
            _record_value(records, "history_incomplete")
        ),
        terminal_reason=terminal_reason,
        earliest_available_time=earliest_available_time,
        coverage_complete=_optional_bool(
            _record_value(records, "coverage_complete")
        ),
        continuity_valid=_optional_bool(
            _record_value(records, "continuity_valid")
        ),
        history_complete=_optional_bool(
            _record_value(records, "history_complete")
        ),
        has_more_before=_optional_bool(
            _record_value(records, "has_more_before")
        ),
        retryable=_optional_bool(_record_value(records, "retryable")),
        evidence_complete=bool(
            history_terminal is True
            and terminal_reason
            and earliest_available_time is not None
        ),
    )


def map_contract_ticker_domain_snapshot(
    *,
    context: ContractMarketDomainSnapshotContext,
    ticker: Optional[Union[Mapping[str, Any], BaseModel]],
    authority_payload: Optional[ContractMarketPayload] = None,
) -> ContractTickerDomainSnapshot:
    payload, valid_container = _copy_payload(ticker, allow_sequence=False)
    metadata_payload, _ = _copy_payload(
        authority_payload,
        allow_sequence=True,
    )
    if authority_payload is None:
        metadata_payload = payload
    emitted_at_ms, snapshot_id = _snapshot_identity(context)
    metadata = _build_metadata(
        domain=ContractMarketDomainName.TICKER,
        payload=metadata_payload,
        context=context,
        completeness=_ticker_completeness(payload, valid_container=valid_container),
        now_ms=emitted_at_ms,
    )
    return ContractTickerDomainSnapshot(
        snapshot_id=snapshot_id,
        emitted_at_ms=emitted_at_ms,
        data=payload,
        metadata=metadata,
    )


def map_contract_depth_domain_snapshot(
    *,
    context: ContractMarketDomainSnapshotContext,
    depth: Optional[Union[Mapping[str, Any], BaseModel]],
    authority_payload: Optional[ContractMarketPayload] = None,
) -> ContractDepthDomainSnapshot:
    payload, valid_container = _copy_payload(depth, allow_sequence=False)
    metadata_payload, _ = _copy_payload(
        authority_payload,
        allow_sequence=True,
    )
    if authority_payload is None:
        metadata_payload = payload
    emitted_at_ms, snapshot_id = _snapshot_identity(context)
    metadata = _build_metadata(
        domain=ContractMarketDomainName.DEPTH,
        payload=metadata_payload,
        context=context,
        completeness=_depth_completeness(payload, valid_container=valid_container),
        now_ms=emitted_at_ms,
    )
    return ContractDepthDomainSnapshot(
        snapshot_id=snapshot_id,
        emitted_at_ms=emitted_at_ms,
        data=payload,
        metadata=metadata,
    )


def map_contract_trades_domain_snapshot(
    *,
    context: ContractMarketDomainSnapshotContext,
    trades: Optional[ContractMarketPayload],
    authority_payload: Optional[ContractMarketPayload] = None,
) -> ContractTradesDomainSnapshot:
    payload, valid_container = _copy_payload(trades, allow_sequence=True)
    metadata_payload, _ = _copy_payload(
        authority_payload,
        allow_sequence=True,
    )
    if authority_payload is None:
        metadata_payload = payload
    emitted_at_ms, snapshot_id = _snapshot_identity(context)
    metadata = _build_metadata(
        domain=ContractMarketDomainName.TRADES,
        payload=metadata_payload,
        context=context,
        completeness=_trades_completeness(
            payload,
            valid_container=valid_container,
            expected_symbol=context.symbol,
        ),
        now_ms=emitted_at_ms,
    )
    return ContractTradesDomainSnapshot(
        snapshot_id=snapshot_id,
        emitted_at_ms=emitted_at_ms,
        data=payload,
        metadata=metadata,
    )


def map_contract_kline_domain_snapshot(
    *,
    context: ContractMarketDomainSnapshotContext,
    kline: Optional[ContractMarketPayload],
    terminal: Optional[ContractMarketKlineTerminalMetadata] = None,
    authority_payload: Optional[ContractMarketPayload] = None,
) -> ContractKlineDomainSnapshot:
    payload, valid_container = _copy_payload(kline, allow_sequence=True)
    metadata_payload, _ = _copy_payload(
        authority_payload,
        allow_sequence=True,
    )
    if authority_payload is None:
        metadata_payload = payload
    emitted_at_ms, snapshot_id = _snapshot_identity(context)
    base_metadata = _build_metadata(
        domain=ContractMarketDomainName.KLINE,
        payload=metadata_payload,
        context=context,
        completeness=_kline_completeness(payload, valid_container=valid_container),
        now_ms=emitted_at_ms,
    )
    metadata = ContractMarketKlineDomainSnapshotMetadata(
        **base_metadata.model_dump(),
        terminal=_terminal_metadata(metadata_payload, terminal),
    )
    return ContractKlineDomainSnapshot(
        snapshot_id=snapshot_id,
        emitted_at_ms=emitted_at_ms,
        data=payload,
        metadata=metadata,
    )


def unwrap_contract_market_domain_snapshot(
    snapshot: ContractMarketDomainSnapshot[Any],
) -> Any:
    """Return an isolated copy of legacy data without exposing metadata.

    Phase C-1 does not connect snapshots to existing routes. This helper makes
    the compatibility boundary explicit for later gateway shadow integration.
    """

    return deepcopy(snapshot.data)


__all__ = [
    "ContractMarketDomainSnapshotAuthority",
    "ContractMarketDomainSnapshotAuthorityDecision",
    "ContractMarketDomainSnapshotAuthorityReason",
    "ContractMarketDomainSnapshotAuthorityResult",
    "ContractMarketDomainSnapshotContext",
    "compare_contract_market_domain_snapshots",
    "map_contract_depth_domain_snapshot",
    "map_contract_kline_domain_snapshot",
    "map_contract_ticker_domain_snapshot",
    "map_contract_trades_domain_snapshot",
    "unwrap_contract_market_domain_snapshot",
]
