from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from enum import Enum
from threading import RLock
from typing import Any, Mapping

from app.services.spot_kline_bucket import spot_kline_bucket_start_ms


SUPPORTED_SPOT_CANDLE_PREVIEW_INTERVALS = frozenset({"1m"})
SPOT_CANDLE_PREVIEW_PROVIDER = "OKX_SPOT"


def _first_not_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _required_text(value: Any, *, field: str, uppercase: bool = False) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required")
    return text.upper() if uppercase else text


def _supported_symbol(value: Any) -> str:
    symbol = "".join(
        character
        for character in _required_text(value, field="symbol", uppercase=True)
        if character.isascii() and character.isalnum()
    )
    if not symbol:
        raise ValueError("symbol must contain at least one alphanumeric character")
    return symbol


def is_supported_spot_candle_preview_symbol(value: Any) -> bool:
    """Return whether a symbol can use the generic Spot preview contract."""
    try:
        _supported_symbol(value)
    except (TypeError, ValueError):
        return False
    return True


class _GenericSpotCandlePreviewSymbolScope:
    """Compatibility container for excluded shadow tooling; not a production allowlist."""

    def __contains__(self, value: Any) -> bool:
        return is_supported_spot_candle_preview_symbol(value)


SUPPORTED_SPOT_CANDLE_PREVIEW_SYMBOLS = _GenericSpotCandlePreviewSymbolScope()


def _supported_interval(value: Any) -> str:
    interval = _required_text(value, field="interval")
    if interval not in SUPPORTED_SPOT_CANDLE_PREVIEW_INTERVALS:
        raise ValueError(f"unsupported spot candle preview interval: {interval}")
    return interval


def _decimal(value: Any, *, field: str, positive: bool) -> Decimal:
    if isinstance(value, bool) or isinstance(value, float):
        raise TypeError(f"{field} must use Decimal-compatible input, not float")
    try:
        parsed = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{field} is invalid") from exc
    if not parsed.is_finite() or (parsed <= 0 if positive else parsed < 0):
        comparator = "positive" if positive else "non-negative"
        raise ValueError(f"{field} must be a {comparator} finite Decimal")
    return parsed


def _nonnegative_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or isinstance(value, float):
        raise TypeError(f"{field} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} is invalid") from exc
    if parsed < 0:
        raise ValueError(f"{field} must be non-negative")
    return parsed


def _required_bool(value: Any, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"{field} must be a bool")
    return value


@dataclass(frozen=True)
class SpotNativeKlineRevision:
    symbol: str
    interval: str
    provider: str
    open_time: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    quote_volume: Decimal
    revision_epoch: int
    revision_seq: int
    generation: int
    is_closed: bool

    @property
    def revision(self) -> tuple[int, int]:
        return self.revision_epoch, self.revision_seq

    @property
    def bucket_key(self) -> tuple[str, str, int]:
        return self.symbol, self.interval, self.open_time

    @property
    def content_signature(self) -> tuple[object, ...]:
        return (
            self.open,
            self.high,
            self.low,
            self.close,
            self.volume,
            self.quote_volume,
            self.revision_epoch,
            self.revision_seq,
            self.generation,
            self.is_closed,
        )


@dataclass(frozen=True)
class SpotAcceptedOkxTrade:
    symbol: str
    interval: str
    provider: str
    provider_trade_id: str
    price: Decimal
    size: Decimal
    event_time_ms: int
    generation: int

    @property
    def open_time(self) -> int:
        return spot_kline_bucket_start_ms(
            self.event_time_ms,
            self.interval,
            provider=self.provider,
        )

    @property
    def identity(self) -> tuple[str, str, str, int, str]:
        return (
            self.provider,
            self.symbol,
            self.interval,
            self.open_time,
            self.provider_trade_id,
        )

    @property
    def content_signature(self) -> tuple[Decimal, Decimal, int]:
        return self.price, self.size, self.event_time_ms


@dataclass(frozen=True)
class SpotCandlePreview:
    symbol: str
    interval: str
    provider: str
    open_time: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    quote_volume: Decimal
    revision_epoch: int
    revision_seq: int
    generation: int
    preview_seq: int = 0
    applied_trade_count: int = 0
    baseline_source: str = "NATIVE"
    baseline_anchor_open_time: int | None = None


class SpotNativePreviewStatus(str, Enum):
    BASELINE_CREATED = "BASELINE_CREATED"
    REBASED = "REBASED"
    DUPLICATE = "DUPLICATE"
    CLOSED = "CLOSED"
    TOMBSTONED = "TOMBSTONED"
    STALE = "STALE"
    CONFLICT = "CONFLICT"
    PROVIDER_SWITCHED = "PROVIDER_SWITCHED"
    UNSUPPORTED_PROVIDER = "UNSUPPORTED_PROVIDER"


class SpotPreviewTradeStatus(str, Enum):
    APPLIED = "APPLIED"
    DUPLICATE = "DUPLICATE"
    CONFLICT = "CONFLICT"
    NO_BASELINE = "NO_BASELINE"
    TOMBSTONED = "TOMBSTONED"
    PROVIDER_MISMATCH = "PROVIDER_MISMATCH"
    GENERATION_MISMATCH = "GENERATION_MISMATCH"
    OPEN_TIME_MISMATCH = "OPEN_TIME_MISMATCH"


@dataclass(frozen=True)
class SpotNativePreviewResult:
    status: SpotNativePreviewStatus
    revision: SpotNativeKlineRevision
    preview: SpotCandlePreview | None


@dataclass(frozen=True)
class SpotPreviewTradeResult:
    status: SpotPreviewTradeStatus
    trade: SpotAcceptedOkxTrade
    preview: SpotCandlePreview | None


@dataclass
class _ActivePreviewState:
    baseline: SpotNativeKlineRevision
    preview: SpotCandlePreview
    trade_seeded_rollover: bool = False


def normalize_spot_native_kline_revision(
    value: SpotNativeKlineRevision | Mapping[str, Any],
) -> SpotNativeKlineRevision:
    if isinstance(value, SpotNativeKlineRevision):
        raw: Mapping[str, Any] = value.__dict__
    elif isinstance(value, Mapping):
        raw = value
    else:
        raise TypeError("native kline revision must be a SpotNativeKlineRevision or mapping")

    provider = _required_text(raw.get("provider"), field="provider", uppercase=True)
    interval = _supported_interval(raw.get("interval"))
    open_time = _nonnegative_int(raw.get("open_time"), field="open_time")
    if open_time <= 0:
        raise ValueError("open_time must be positive")
    if spot_kline_bucket_start_ms(open_time, interval, provider=provider) != open_time:
        raise ValueError("open_time must be aligned to the preview interval")

    open_price = _decimal(raw.get("open"), field="open", positive=True)
    high_price = _decimal(raw.get("high"), field="high", positive=True)
    low_price = _decimal(raw.get("low"), field="low", positive=True)
    close_price = _decimal(raw.get("close"), field="close", positive=True)
    if high_price < max(open_price, low_price, close_price):
        raise ValueError("high must not be below open, low, or close")
    if low_price > min(open_price, high_price, close_price):
        raise ValueError("low must not be above open, high, or close")

    return SpotNativeKlineRevision(
        symbol=_supported_symbol(raw.get("symbol")),
        interval=interval,
        provider=provider,
        open_time=open_time,
        open=open_price,
        high=high_price,
        low=low_price,
        close=close_price,
        volume=_decimal(raw.get("volume"), field="volume", positive=False),
        quote_volume=_decimal(
            raw.get("quote_volume"),
            field="quote_volume",
            positive=False,
        ),
        revision_epoch=_nonnegative_int(
            raw.get("revision_epoch"),
            field="revision_epoch",
        ),
        revision_seq=_nonnegative_int(raw.get("revision_seq"), field="revision_seq"),
        generation=_nonnegative_int(
            _first_not_none(raw.get("generation"), raw.get("provider_generation")),
            field="generation",
        ),
        is_closed=_required_bool(raw.get("is_closed"), field="is_closed"),
    )


def normalize_spot_accepted_okx_trade(
    value: SpotAcceptedOkxTrade | Mapping[str, Any],
) -> SpotAcceptedOkxTrade:
    if isinstance(value, SpotAcceptedOkxTrade):
        raw: Mapping[str, Any] = value.__dict__
    elif isinstance(value, Mapping):
        raw = value
    else:
        raise TypeError("trade must be a SpotAcceptedOkxTrade or mapping")

    event_time_ms = _nonnegative_int(
        _first_not_none(raw.get("event_time_ms"), raw.get("ts")),
        field="event_time_ms",
    )
    if event_time_ms <= 0:
        raise ValueError("event_time_ms must be positive")

    return SpotAcceptedOkxTrade(
        symbol=_supported_symbol(raw.get("symbol")),
        interval=_supported_interval(raw.get("interval")),
        provider=_required_text(raw.get("provider"), field="provider", uppercase=True),
        provider_trade_id=_required_text(
            _first_not_none(
                raw.get("provider_trade_id"),
                raw.get("trade_id"),
                raw.get("id"),
            ),
            field="provider_trade_id",
        ),
        price=_decimal(raw.get("price"), field="price", positive=True),
        size=_decimal(
            _first_not_none(raw.get("size"), raw.get("amount"), raw.get("quantity")),
            field="size",
            positive=True,
        ),
        event_time_ms=event_time_ms,
        generation=_nonnegative_int(
            _first_not_none(raw.get("generation"), raw.get("provider_generation")),
            field="generation",
        ),
    )


class SpotCandlePreviewEngine:
    """Pure in-memory Native-baselined Spot candle preview domain.

    The engine owns no database, REST, TradingView, or Native Kline revision
    authority. Callers must pass already-accepted Native revisions and OKX trades.
    """

    def __init__(self) -> None:
        self._states: dict[tuple[str, str], _ActivePreviewState] = {}
        self._rollover_anchors: dict[tuple[str, str], SpotNativeKlineRevision] = {}
        self._tombstones: set[tuple[str, str, int]] = set()
        self._seen_trades: dict[
            tuple[str, str, str, int, str],
            tuple[Decimal, Decimal, int],
        ] = {}
        self._lock = RLock()

    def accept_native_revision(
        self,
        value: SpotNativeKlineRevision | Mapping[str, Any],
    ) -> SpotNativePreviewResult:
        revision = normalize_spot_native_kline_revision(value)
        state_key = (revision.symbol, revision.interval)

        with self._lock:
            current = self._states.get(state_key)
            if revision.provider != SPOT_CANDLE_PREVIEW_PROVIDER:
                anchor = self._rollover_anchors.get(state_key)
                switched = (
                    current is not None and current.baseline.provider != revision.provider
                ) or (
                    anchor is not None and anchor.provider != revision.provider
                )
                if switched:
                    self._states.pop(state_key, None)
                    self._rollover_anchors.pop(state_key, None)
                return SpotNativePreviewResult(
                    SpotNativePreviewStatus.PROVIDER_SWITCHED
                    if switched
                    else SpotNativePreviewStatus.UNSUPPORTED_PROVIDER,
                    revision,
                    None,
                )

            if revision.is_closed:
                return self._accept_native_close(revision, current)

            if revision.bucket_key in self._tombstones:
                return SpotNativePreviewResult(
                    SpotNativePreviewStatus.TOMBSTONED,
                    revision,
                    current.preview if current is not None else None,
                )

            status = SpotNativePreviewStatus.BASELINE_CREATED
            if current is not None:
                if current.baseline.provider != revision.provider:
                    self._states.pop(state_key, None)
                    status = SpotNativePreviewStatus.PROVIDER_SWITCHED
                elif revision.open_time < current.baseline.open_time:
                    return SpotNativePreviewResult(
                        SpotNativePreviewStatus.STALE,
                        revision,
                        current.preview,
                    )
                elif revision.generation < current.baseline.generation:
                    return SpotNativePreviewResult(
                        SpotNativePreviewStatus.STALE,
                        revision,
                        current.preview,
                    )
                elif (
                    current.trade_seeded_rollover
                    and revision.generation == current.baseline.generation
                    and revision.open_time == current.baseline.open_time
                ):
                    status = SpotNativePreviewStatus.REBASED
                elif revision.generation == current.baseline.generation:
                    if revision.open_time == current.baseline.open_time:
                        if revision.revision < current.baseline.revision:
                            return SpotNativePreviewResult(
                                SpotNativePreviewStatus.STALE,
                                revision,
                                current.preview,
                            )
                        if revision.revision == current.baseline.revision:
                            duplicate = (
                                revision.content_signature
                                == current.baseline.content_signature
                            )
                            return SpotNativePreviewResult(
                                SpotNativePreviewStatus.DUPLICATE
                                if duplicate
                                else SpotNativePreviewStatus.CONFLICT,
                                revision,
                                current.preview,
                            )
                        status = SpotNativePreviewStatus.REBASED
                    else:
                        self._tombstones.add(current.baseline.bucket_key)
                        self._forget_other_bucket_trades(
                            revision.symbol,
                            revision.interval,
                            revision.open_time,
                        )
                        status = SpotNativePreviewStatus.REBASED
                else:
                    if revision.open_time > current.baseline.open_time:
                        self._tombstones.add(current.baseline.bucket_key)
                        self._forget_other_bucket_trades(
                            revision.symbol,
                            revision.interval,
                            revision.open_time,
                        )
                    status = SpotNativePreviewStatus.REBASED

            preview = self._preview_from_native(revision)
            if (
                current is not None
                and current.baseline.provider == revision.provider
                and current.baseline.open_time == revision.open_time
                and current.baseline.generation == revision.generation
            ):
                # Keep accepted same-candle trade evidence across an OPEN Native
                # rebase. The provider Kline and trade streams are asynchronous;
                # a newer Kline revision can legitimately lag the trade stream.
                # CLOSED Native is handled above and remains final authority.
                previous = current.preview
                preview = replace(
                    preview,
                    high=max(preview.high, previous.high),
                    low=min(preview.low, previous.low),
                    close=previous.close,
                    volume=max(preview.volume, previous.volume),
                    quote_volume=max(preview.quote_volume, previous.quote_volume),
                )
            self._states[state_key] = _ActivePreviewState(
                baseline=revision,
                preview=preview,
            )
            self._rollover_anchors[state_key] = revision
            return SpotNativePreviewResult(status, revision, preview)

    def accept_trade(
        self,
        value: SpotAcceptedOkxTrade | Mapping[str, Any],
    ) -> SpotPreviewTradeResult:
        trade = normalize_spot_accepted_okx_trade(value)
        state_key = (trade.symbol, trade.interval)
        bucket_key = (trade.symbol, trade.interval, trade.open_time)

        with self._lock:
            current = self._states.get(state_key)
            if bucket_key in self._tombstones:
                return SpotPreviewTradeResult(
                    SpotPreviewTradeStatus.TOMBSTONED,
                    trade,
                    current.preview if current is not None else None,
                )
            if current is None:
                current = self._seed_contiguous_rollover(state_key, None, trade)
                if current is None:
                    return SpotPreviewTradeResult(
                        SpotPreviewTradeStatus.NO_BASELINE,
                        trade,
                        None,
                    )
                return SpotPreviewTradeResult(
                    SpotPreviewTradeStatus.APPLIED,
                    trade,
                    current.preview,
                )
            if (
                trade.provider != SPOT_CANDLE_PREVIEW_PROVIDER
                or trade.provider != current.baseline.provider
            ):
                return SpotPreviewTradeResult(
                    SpotPreviewTradeStatus.PROVIDER_MISMATCH,
                    trade,
                    current.preview,
                )
            if trade.generation != current.baseline.generation:
                return SpotPreviewTradeResult(
                    SpotPreviewTradeStatus.GENERATION_MISMATCH,
                    trade,
                    current.preview,
                )
            if trade.open_time != current.baseline.open_time:
                seeded = self._seed_contiguous_rollover(state_key, current, trade)
                if seeded is None:
                    return SpotPreviewTradeResult(
                        SpotPreviewTradeStatus.OPEN_TIME_MISMATCH,
                        trade,
                        current.preview,
                    )
                return SpotPreviewTradeResult(
                    SpotPreviewTradeStatus.APPLIED,
                    trade,
                    seeded.preview,
                )

            seen_signature = self._seen_trades.get(trade.identity)
            if seen_signature is not None:
                return SpotPreviewTradeResult(
                    SpotPreviewTradeStatus.DUPLICATE
                    if seen_signature == trade.content_signature
                    else SpotPreviewTradeStatus.CONFLICT,
                    trade,
                    current.preview,
                )

            next_preview = replace(
                current.preview,
                high=max(current.preview.high, trade.price),
                low=min(current.preview.low, trade.price),
                close=trade.price,
                volume=current.preview.volume + trade.size,
                quote_volume=current.preview.quote_volume + (trade.price * trade.size),
                preview_seq=current.preview.preview_seq + 1,
                applied_trade_count=current.preview.applied_trade_count + 1,
            )
            current.preview = next_preview
            self._seen_trades[trade.identity] = trade.content_signature
            return SpotPreviewTradeResult(
                SpotPreviewTradeStatus.APPLIED,
                trade,
                next_preview,
            )

    def _seed_contiguous_rollover(
        self,
        state_key: tuple[str, str],
        current: _ActivePreviewState | None,
        trade: SpotAcceptedOkxTrade,
    ) -> _ActivePreviewState | None:
        anchor = (
            current.baseline
            if current is not None and not current.trade_seeded_rollover
            else self._rollover_anchors.get(state_key)
        )
        if (
            anchor is None
            or trade.provider != SPOT_CANDLE_PREVIEW_PROVIDER
            or trade.provider != anchor.provider
            or trade.generation != anchor.generation
            or trade.open_time != anchor.open_time + 60_000
        ):
            return None
        if trade.identity in self._seen_trades:
            return None

        self._tombstones.add(anchor.bucket_key)
        self._forget_other_bucket_trades(
            trade.symbol,
            trade.interval,
            trade.open_time,
        )
        synthetic_baseline = replace(
            anchor,
            open_time=trade.open_time,
            open=trade.price,
            high=trade.price,
            low=trade.price,
            close=trade.price,
            volume=Decimal("0"),
            quote_volume=Decimal("0"),
            is_closed=False,
        )
        preview = SpotCandlePreview(
            symbol=trade.symbol,
            interval=trade.interval,
            provider=trade.provider,
            open_time=trade.open_time,
            open=trade.price,
            high=trade.price,
            low=trade.price,
            close=trade.price,
            volume=trade.size,
            quote_volume=trade.price * trade.size,
            revision_epoch=anchor.revision_epoch,
            revision_seq=anchor.revision_seq,
            generation=trade.generation,
            preview_seq=1,
            applied_trade_count=1,
            baseline_source="TRADE_ROLLOVER",
            baseline_anchor_open_time=anchor.open_time,
        )
        seeded = _ActivePreviewState(
            baseline=synthetic_baseline,
            preview=preview,
            trade_seeded_rollover=True,
        )
        self._states[state_key] = seeded
        self._seen_trades[trade.identity] = trade.content_signature
        return seeded

    def get_preview(self, symbol: str, interval: str = "1m") -> SpotCandlePreview | None:
        state_key = (_supported_symbol(symbol), _supported_interval(interval))
        with self._lock:
            state = self._states.get(state_key)
            return state.preview if state is not None else None

    def previews(self) -> tuple[SpotCandlePreview, ...]:
        with self._lock:
            return tuple(
                state.preview
                for _, state in sorted(self._states.items())
            )

    def is_tombstoned(
        self,
        *,
        symbol: str,
        interval: str,
        open_time: int,
    ) -> bool:
        bucket_key = (
            _supported_symbol(symbol),
            _supported_interval(interval),
            _nonnegative_int(open_time, field="open_time"),
        )
        with self._lock:
            return bucket_key in self._tombstones

    def _accept_native_close(
        self,
        revision: SpotNativeKlineRevision,
        current: _ActivePreviewState | None,
    ) -> SpotNativePreviewResult:
        if current is not None and current.baseline.open_time == revision.open_time:
            if (
                current.baseline.provider != revision.provider
                or current.baseline.generation != revision.generation
                or (
                    not current.trade_seeded_rollover
                    and revision.revision < current.baseline.revision
                )
            ):
                return SpotNativePreviewResult(
                    SpotNativePreviewStatus.STALE,
                    revision,
                    current.preview,
                )
            self._states.pop((revision.symbol, revision.interval), None)
        self._rollover_anchors[(revision.symbol, revision.interval)] = revision
        self._tombstones.add(revision.bucket_key)
        return SpotNativePreviewResult(
            SpotNativePreviewStatus.CLOSED,
            revision,
            None,
        )

    @staticmethod
    def _preview_from_native(revision: SpotNativeKlineRevision) -> SpotCandlePreview:
        return SpotCandlePreview(
            symbol=revision.symbol,
            interval=revision.interval,
            provider=revision.provider,
            open_time=revision.open_time,
            open=revision.open,
            high=revision.high,
            low=revision.low,
            close=revision.close,
            volume=revision.volume,
            quote_volume=revision.quote_volume,
            revision_epoch=revision.revision_epoch,
            revision_seq=revision.revision_seq,
            generation=revision.generation,
        )

    def _forget_other_bucket_trades(
        self,
        symbol: str,
        interval: str,
        open_time: int,
    ) -> None:
        for identity in [
            identity
            for identity in self._seen_trades
            if identity[1] == symbol
            and identity[2] == interval
            and identity[3] != open_time
        ]:
            self._seen_trades.pop(identity, None)


__all__ = [
    "SPOT_CANDLE_PREVIEW_PROVIDER",
    "SUPPORTED_SPOT_CANDLE_PREVIEW_INTERVALS",
    "SUPPORTED_SPOT_CANDLE_PREVIEW_SYMBOLS",
    "SpotAcceptedOkxTrade",
    "SpotCandlePreview",
    "SpotCandlePreviewEngine",
    "SpotNativeKlineRevision",
    "SpotNativePreviewResult",
    "SpotNativePreviewStatus",
    "SpotPreviewTradeResult",
    "SpotPreviewTradeStatus",
    "normalize_spot_accepted_okx_trade",
    "normalize_spot_native_kline_revision",
    "is_supported_spot_candle_preview_symbol",
]
