"""Pure same-bucket Kline revision comparison primitives.

The module owns no cache or I/O. A positive ``revision_seq`` is authoritative
within an epoch and provider generation; zero explicitly means that no local
sequence evidence is available, allowing transport priority as a final fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Optional, Tuple, Union


DecimalValue = Union[Decimal, str, int, float]


class KlineRevisionDecision(str, Enum):
    ACCEPT = "ACCEPT"
    REJECT = "REJECT"
    NO_CHANGE = "NO_CHANGE"


class KlineRevisionReason(str, Enum):
    NEW_BUCKET = "NEW_BUCKET"
    IDENTITY_MISMATCH = "IDENTITY_MISMATCH"
    STALE_EPOCH = "STALE_EPOCH"
    PROVIDER_SWITCH_BOOTSTRAP = "PROVIDER_SWITCH_BOOTSTRAP"
    PROVIDER_MISMATCH = "PROVIDER_MISMATCH"
    STALE_GENERATION = "STALE_GENERATION"
    NEW_GENERATION = "NEW_GENERATION"
    CLOSED_UPGRADE = "CLOSED_UPGRADE"
    CLOSED_DOWNGRADE = "CLOSED_DOWNGRADE"
    OLDER_PROVIDER_UPDATE = "OLDER_PROVIDER_UPDATE"
    NEWER_PROVIDER_UPDATE = "NEWER_PROVIDER_UPDATE"
    STALE_REVISION = "STALE_REVISION"
    NEWER_REVISION = "NEWER_REVISION"
    ACTIVE_WS_OVER_REST = "ACTIVE_WS_OVER_REST"
    HIGHER_TRANSPORT_PRIORITY = "HIGHER_TRANSPORT_PRIORITY"
    LOWER_TRANSPORT_PRIORITY = "LOWER_TRANSPORT_PRIORITY"
    DUPLICATE = "DUPLICATE"
    RECEIVED_AT_ONLY = "RECEIVED_AT_ONLY"
    REVISION_CONFLICT = "REVISION_CONFLICT"
    REST_COLD_START = "REST_COLD_START"
    REST_HISTORICAL_BUCKET = "REST_HISTORICAL_BUCKET"
    REST_NEW_BUCKET = "REST_NEW_BUCKET"
    REST_ACTIVE_WS_CURRENT = "REST_ACTIVE_WS_CURRENT"
    REST_WATERMARK_ADVANCED = "REST_WATERMARK_ADVANCED"
    REST_PROVIDER_SWITCH = "REST_PROVIDER_SWITCH"
    REST_AUTHORITY_UNAVAILABLE = "REST_AUTHORITY_UNAVAILABLE"
    REST_FINAL_RECONCILIATION = "REST_FINAL_RECONCILIATION"


class KlineTransport(str, Enum):
    DB = "DB"
    REST = "REST"
    WS = "WS"


class KlineCloseStateSource(str, Enum):
    UNKNOWN = "UNKNOWN"
    TIME_DERIVED = "TIME_DERIVED"
    PROVIDER_CONFIRMED = "PROVIDER_CONFIRMED"


class KlineCloseState(str, Enum):
    UNKNOWN = "UNKNOWN"
    OPEN = "OPEN"
    CLOSED_TIME_DERIVED = "CLOSED_TIME_DERIVED"
    CLOSED_PROVIDER_CONFIRMED = "CLOSED_PROVIDER_CONFIRMED"


_CLOSE_STATE_RANK = {
    KlineCloseState.UNKNOWN: 0,
    KlineCloseState.OPEN: 1,
    KlineCloseState.CLOSED_TIME_DERIVED: 2,
    KlineCloseState.CLOSED_PROVIDER_CONFIRMED: 3,
}

_TRANSPORT_RANK = {
    KlineTransport.DB: 1,
    KlineTransport.REST: 2,
    KlineTransport.WS: 3,
}

_PROVIDER_CONFIRMED_SOURCES = {
    "PROVIDER",
    "PROVIDER_CONFIRM",
    "PROVIDER_CONFIRMED",
    "OKX_CONFIRM",
}

_TIME_DERIVED_SOURCES = {
    "TIME_BOUNDARY",
    "TIME_DERIVED",
}


def _normalize_decimal(value: DecimalValue, field_name: str) -> Decimal:
    try:
        normalized = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field_name}") from exc
    if not normalized.is_finite():
        raise ValueError(f"invalid {field_name}")
    return normalized


def _normalize_non_negative_int(value: object, field_name: str) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field_name}") from exc
    if normalized < 0:
        raise ValueError(f"invalid {field_name}")
    return normalized


def _normalize_transport(value: Union[KlineTransport, str]) -> KlineTransport:
    if isinstance(value, KlineTransport):
        return value
    try:
        return KlineTransport(str(value or "").strip().upper())
    except ValueError as exc:
        raise ValueError("invalid transport") from exc


def _normalize_close_state_source(
    value: Optional[Union[KlineCloseStateSource, str]],
) -> KlineCloseStateSource:
    if isinstance(value, KlineCloseStateSource):
        return value
    normalized = str(value or "").strip().upper()
    if normalized in _PROVIDER_CONFIRMED_SOURCES:
        return KlineCloseStateSource.PROVIDER_CONFIRMED
    if normalized in _TIME_DERIVED_SOURCES:
        return KlineCloseStateSource.TIME_DERIVED
    return KlineCloseStateSource.UNKNOWN


@dataclass(frozen=True)
class KlineRevisionCandidate:
    symbol: str
    interval: str
    open_time: int
    open: DecimalValue
    high: DecimalValue
    low: DecimalValue
    close: DecimalValue
    volume: DecimalValue
    provider: str
    source: str
    transport: Union[KlineTransport, str]
    provider_generation: int
    revision_epoch: int
    revision_seq: int
    received_at_ms: int
    is_closed: Optional[bool]
    close_state_source: Optional[Union[KlineCloseStateSource, str]]
    provider_update_time_ms: Optional[int] = None
    quote_volume: Optional[DecimalValue] = None

    def __post_init__(self) -> None:
        symbol = "".join(ch for ch in str(self.symbol or "").strip().upper() if ch.isalnum())
        interval = str(self.interval or "").strip()
        provider = str(self.provider or "").strip().upper()
        source = str(self.source or "").strip().upper()
        if not symbol:
            raise ValueError("invalid symbol")
        if not interval:
            raise ValueError("invalid interval")
        if not provider:
            raise ValueError("invalid provider")
        if not source:
            raise ValueError("invalid source")
        if self.is_closed is not None and not isinstance(self.is_closed, bool):
            raise ValueError("invalid is_closed")

        open_time = _normalize_non_negative_int(self.open_time, "open_time")
        if open_time <= 0:
            raise ValueError("invalid open_time")

        provider_update_time_ms = self.provider_update_time_ms
        if provider_update_time_ms is not None:
            provider_update_time_ms = _normalize_non_negative_int(
                provider_update_time_ms,
                "provider_update_time_ms",
            )

        quote_volume = self.quote_volume
        if quote_volume is not None:
            quote_volume = _normalize_decimal(quote_volume, "quote_volume")

        object.__setattr__(self, "symbol", symbol)
        object.__setattr__(self, "interval", interval)
        object.__setattr__(self, "open_time", open_time)
        object.__setattr__(self, "open", _normalize_decimal(self.open, "open"))
        object.__setattr__(self, "high", _normalize_decimal(self.high, "high"))
        object.__setattr__(self, "low", _normalize_decimal(self.low, "low"))
        object.__setattr__(self, "close", _normalize_decimal(self.close, "close"))
        object.__setattr__(self, "volume", _normalize_decimal(self.volume, "volume"))
        object.__setattr__(self, "quote_volume", quote_volume)
        object.__setattr__(self, "provider", provider)
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "transport", _normalize_transport(self.transport))
        object.__setattr__(
            self,
            "provider_generation",
            _normalize_non_negative_int(self.provider_generation, "provider_generation"),
        )
        object.__setattr__(
            self,
            "revision_epoch",
            _normalize_non_negative_int(self.revision_epoch, "revision_epoch"),
        )
        object.__setattr__(
            self,
            "revision_seq",
            _normalize_non_negative_int(self.revision_seq, "revision_seq"),
        )
        object.__setattr__(
            self,
            "received_at_ms",
            _normalize_non_negative_int(self.received_at_ms, "received_at_ms"),
        )
        object.__setattr__(self, "close_state_source", _normalize_close_state_source(self.close_state_source))
        object.__setattr__(self, "provider_update_time_ms", provider_update_time_ms)


@dataclass(frozen=True)
class KlineRevisionComparison:
    decision: KlineRevisionDecision
    reason: KlineRevisionReason


@dataclass(frozen=True)
class KlineRestWatermark:
    """Immutable request-time snapshot of the active WS candle authority."""

    provider: str
    revision_epoch: int
    revision_seq: int
    winner: Optional[KlineRevisionCandidate] = None

    def __post_init__(self) -> None:
        provider = str(self.provider or "").strip().upper()
        if not provider:
            raise ValueError("invalid provider")
        revision_epoch = _normalize_non_negative_int(self.revision_epoch, "revision_epoch")
        revision_seq = _normalize_non_negative_int(self.revision_seq, "revision_seq")
        if self.winner is not None:
            if self.winner.provider != provider:
                raise ValueError("watermark provider mismatch")
            if self.winner.revision_epoch != revision_epoch:
                raise ValueError("watermark epoch mismatch")
            if self.winner.revision_seq != revision_seq:
                raise ValueError("watermark revision mismatch")
        object.__setattr__(self, "provider", provider)
        object.__setattr__(self, "revision_epoch", revision_epoch)
        object.__setattr__(self, "revision_seq", revision_seq)


def normalize_close_state(
    is_closed: Optional[bool],
    close_state_source: Optional[Union[KlineCloseStateSource, str]],
) -> KlineCloseState:
    if is_closed is None:
        return KlineCloseState.UNKNOWN
    if not is_closed:
        return KlineCloseState.OPEN
    source = _normalize_close_state_source(close_state_source)
    if source == KlineCloseStateSource.PROVIDER_CONFIRMED:
        return KlineCloseState.CLOSED_PROVIDER_CONFIRMED
    return KlineCloseState.CLOSED_TIME_DERIVED


def close_state_rank(close_state: Union[KlineCloseState, str]) -> int:
    if not isinstance(close_state, KlineCloseState):
        try:
            close_state = KlineCloseState(str(close_state or "").strip().upper())
        except ValueError as exc:
            raise ValueError("invalid close state") from exc
    return _CLOSE_STATE_RANK[close_state]


def kline_identity_key(candidate: KlineRevisionCandidate) -> Tuple[str, str, int]:
    return candidate.symbol, candidate.interval, candidate.open_time


def _close_state(candidate: KlineRevisionCandidate) -> KlineCloseState:
    return normalize_close_state(candidate.is_closed, candidate.close_state_source)


def _content_key(candidate: KlineRevisionCandidate) -> Tuple[object, ...]:
    return (
        candidate.open,
        candidate.high,
        candidate.low,
        candidate.close,
        candidate.volume,
        candidate.quote_volume,
    )


def _same_content_and_close(
    existing: KlineRevisionCandidate,
    incoming: KlineRevisionCandidate,
) -> bool:
    return _content_key(existing) == _content_key(incoming) and _close_state(existing) == _close_state(incoming)


def is_same_kline_revision(
    existing: KlineRevisionCandidate,
    incoming: KlineRevisionCandidate,
) -> bool:
    """Return whether two candidates describe the same semantic revision.

    Local receive time is deliberately excluded: receiving the same provider
    revision again does not create a new candle revision.
    """

    return (
        kline_identity_key(existing) == kline_identity_key(incoming)
        and _same_content_and_close(existing, incoming)
        and existing.provider == incoming.provider
        and existing.source == incoming.source
        and existing.transport == incoming.transport
        and existing.provider_generation == incoming.provider_generation
        and existing.revision_epoch == incoming.revision_epoch
        and existing.revision_seq == incoming.revision_seq
        and existing.provider_update_time_ms == incoming.provider_update_time_ms
    )


def _comparison(
    decision: KlineRevisionDecision,
    reason: KlineRevisionReason,
) -> KlineRevisionComparison:
    return KlineRevisionComparison(decision=decision, reason=reason)


def compare_kline_revision(
    existing: Optional[KlineRevisionCandidate],
    incoming: KlineRevisionCandidate,
) -> KlineRevisionComparison:
    if existing is None:
        return _comparison(KlineRevisionDecision.ACCEPT, KlineRevisionReason.NEW_BUCKET)

    if kline_identity_key(existing) != kline_identity_key(incoming):
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.IDENTITY_MISMATCH)

    if incoming.revision_epoch < existing.revision_epoch:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.STALE_EPOCH)
    if incoming.revision_epoch > existing.revision_epoch:
        return _comparison(
            KlineRevisionDecision.ACCEPT,
            KlineRevisionReason.PROVIDER_SWITCH_BOOTSTRAP,
        )

    if incoming.provider != existing.provider:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.PROVIDER_MISMATCH)

    if incoming.provider_generation < existing.provider_generation:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.STALE_GENERATION)

    existing_close_rank = close_state_rank(_close_state(existing))
    incoming_close_rank = close_state_rank(_close_state(incoming))
    if incoming_close_rank < existing_close_rank:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.CLOSED_DOWNGRADE)

    if incoming.provider_generation > existing.provider_generation:
        return _comparison(KlineRevisionDecision.ACCEPT, KlineRevisionReason.NEW_GENERATION)

    if incoming_close_rank > existing_close_rank:
        return _comparison(KlineRevisionDecision.ACCEPT, KlineRevisionReason.CLOSED_UPGRADE)

    if existing.provider_update_time_ms is not None and incoming.provider_update_time_ms is not None:
        if incoming.provider_update_time_ms < existing.provider_update_time_ms:
            return _comparison(
                KlineRevisionDecision.REJECT,
                KlineRevisionReason.OLDER_PROVIDER_UPDATE,
            )
        if incoming.provider_update_time_ms > existing.provider_update_time_ms:
            return _comparison(
                KlineRevisionDecision.ACCEPT,
                KlineRevisionReason.NEWER_PROVIDER_UPDATE,
            )

    if existing.revision_seq > 0 and incoming.revision_seq > 0:
        if incoming.revision_seq < existing.revision_seq:
            return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.STALE_REVISION)
    elif existing.revision_seq > 0 and incoming.revision_seq == 0:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.STALE_REVISION)

    if incoming.revision_seq > 0 and existing.revision_seq == 0:
        return _comparison(KlineRevisionDecision.ACCEPT, KlineRevisionReason.NEWER_REVISION)

    if incoming.revision_seq > existing.revision_seq:
        return _comparison(KlineRevisionDecision.ACCEPT, KlineRevisionReason.NEWER_REVISION)

    if incoming.revision_seq > 0 and incoming.revision_seq == existing.revision_seq:
        if _same_content_and_close(existing, incoming):
            return _comparison(KlineRevisionDecision.NO_CHANGE, KlineRevisionReason.DUPLICATE)
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.REVISION_CONFLICT)

    incoming_transport_rank = _TRANSPORT_RANK[incoming.transport]
    existing_transport_rank = _TRANSPORT_RANK[existing.transport]
    if incoming_transport_rank > existing_transport_rank:
        reason = (
            KlineRevisionReason.ACTIVE_WS_OVER_REST
            if incoming.transport == KlineTransport.WS and existing.transport == KlineTransport.REST
            else KlineRevisionReason.HIGHER_TRANSPORT_PRIORITY
        )
        return _comparison(KlineRevisionDecision.ACCEPT, reason)
    if incoming_transport_rank < existing_transport_rank:
        return _comparison(
            KlineRevisionDecision.REJECT,
            KlineRevisionReason.LOWER_TRANSPORT_PRIORITY,
        )

    if _same_content_and_close(existing, incoming):
        return _comparison(KlineRevisionDecision.NO_CHANGE, KlineRevisionReason.DUPLICATE)

    if incoming.received_at_ms > existing.received_at_ms:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.RECEIVED_AT_ONLY)

    return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.REVISION_CONFLICT)


def reconcile_rest_kline_candidate(
    request_watermark: KlineRestWatermark,
    current_watermark: KlineRestWatermark,
    incoming: KlineRevisionCandidate,
) -> KlineRevisionComparison:
    """Decide whether a REST candle may enter cache/DB after a request race.

    ``received_at_ms`` is deliberately absent from every authority comparison.
    Different buckets are reconciled independently; the active WS bucket only
    protects its own revision while older buckets remain eligible as history.
    """

    if incoming.transport != KlineTransport.REST:
        raise ValueError("REST reconciliation requires REST transport")
    if incoming.provider != request_watermark.provider:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.REST_PROVIDER_SWITCH)
    if current_watermark.provider != request_watermark.provider:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.REST_PROVIDER_SWITCH)

    current = current_watermark.winner
    requested = request_watermark.winner
    if current is None:
        if requested is None:
            return _comparison(KlineRevisionDecision.ACCEPT, KlineRevisionReason.REST_COLD_START)
        return _comparison(
            KlineRevisionDecision.REJECT,
            KlineRevisionReason.REST_AUTHORITY_UNAVAILABLE,
        )
    if requested is not None and request_watermark.revision_epoch != current_watermark.revision_epoch:
        return _comparison(
            KlineRevisionDecision.REJECT,
            KlineRevisionReason.REST_PROVIDER_SWITCH,
        )

    if incoming.open_time < current.open_time:
        return _comparison(
            KlineRevisionDecision.ACCEPT,
            KlineRevisionReason.REST_HISTORICAL_BUCKET,
        )
    if incoming.open_time > current.open_time:
        return _comparison(KlineRevisionDecision.ACCEPT, KlineRevisionReason.REST_NEW_BUCKET)

    if requested is None:
        return _comparison(
            KlineRevisionDecision.REJECT,
            KlineRevisionReason.REST_WATERMARK_ADVANCED,
        )
    if (
        requested.open_time != current.open_time
        or request_watermark.revision_epoch != current_watermark.revision_epoch
        or request_watermark.revision_seq != current_watermark.revision_seq
    ):
        return _comparison(
            KlineRevisionDecision.REJECT,
            KlineRevisionReason.REST_WATERMARK_ADVANCED,
        )

    existing_close_rank = close_state_rank(_close_state(current))
    incoming_close_rank = close_state_rank(_close_state(incoming))
    if incoming_close_rank < existing_close_rank:
        return _comparison(KlineRevisionDecision.REJECT, KlineRevisionReason.CLOSED_DOWNGRADE)
    if existing_close_rank < close_state_rank(KlineCloseState.CLOSED_TIME_DERIVED):
        return _comparison(
            KlineRevisionDecision.REJECT,
            KlineRevisionReason.REST_ACTIVE_WS_CURRENT,
        )

    return _comparison(
        KlineRevisionDecision.ACCEPT,
        KlineRevisionReason.REST_FINAL_RECONCILIATION,
    )


def merge_kline_revision(
    existing: Optional[KlineRevisionCandidate],
    incoming: KlineRevisionCandidate,
) -> Optional[KlineRevisionCandidate]:
    comparison = compare_kline_revision(existing, incoming)
    if comparison.decision == KlineRevisionDecision.ACCEPT:
        return incoming
    if comparison.decision == KlineRevisionDecision.NO_CHANGE:
        return existing
    if comparison.reason in {
        KlineRevisionReason.IDENTITY_MISMATCH,
        KlineRevisionReason.PROVIDER_MISMATCH,
        KlineRevisionReason.REVISION_CONFLICT,
    }:
        return None
    return existing


__all__ = [
    "KlineCloseState",
    "KlineCloseStateSource",
    "KlineRevisionCandidate",
    "KlineRevisionComparison",
    "KlineRevisionDecision",
    "KlineRevisionReason",
    "KlineRestWatermark",
    "KlineTransport",
    "close_state_rank",
    "compare_kline_revision",
    "is_same_kline_revision",
    "kline_identity_key",
    "merge_kline_revision",
    "normalize_close_state",
    "reconcile_rest_kline_candidate",
]
