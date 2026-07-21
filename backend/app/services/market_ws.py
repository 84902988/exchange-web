from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Dict, Set, Any, Optional

from fastapi import WebSocket
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketState

from app.db.session import SessionLocal
from app.services.market import get_market_depth
from app.services.spot_kline_bucket import normalize_spot_kline_bucket_interval
from app.services.spot_kline_realtime import apply_spot_trade_to_klines
from app.services.spot_market_view import (
    build_empty_spot_market_view,
    build_spot_market_snapshot_payload,
    get_spot_market_snapshot_payload,
)


logger = logging.getLogger(__name__)
SPOT_SNAPSHOT_BUILD_TIMEOUT_SECONDS = 3.0
SPOT_SNAPSHOT_VIEW_BUDGET_SECONDS = 2.2
SPOT_SNAPSHOT_TIMEOUT_LOG_THROTTLE_SECONDS = 30.0
SPOT_WS_SLOW_SEND_THRESHOLD_MS = 500.0
SPOT_WS_FANOUT_SLOW_LOG_THROTTLE_SECONDS = 30.0
SPOT_WS_CLIENT_SEND_QUEUE_MAX_SIZE = 32
SPOT_WS_CLIENT_TRADE_QUEUE_MAX_SIZE = 1024
SPOT_WS_CLIENT_TRADE_BACKLOG_WARNING_RATIO = 0.75
SPOT_WS_CLIENT_TRADE_MAX_AGE_SECONDS = 5.0
SPOT_WS_CLIENT_SEND_TIMEOUT_SECONDS = 1.0
SPOT_WS_CLIENT_CLOSE_TIMEOUT_SECONDS = 1.0
_SPOT_SNAPSHOT_TIMEOUT_LOG_LAST_AT: dict[str, float] = {}


def _normalize_symbol(symbol: str) -> str:
    raw = str(symbol or "").upper().strip()
    return "".join(ch for ch in raw if ch.isalnum())


def _normalize_interval(interval: str | None) -> str:
    normalized = normalize_spot_kline_bucket_interval(interval)
    if normalized in {"1m", "5m", "15m", "1h", "4h", "1d", "1Dutc", "1w", "1Wutc", "1M", "1Mutc"}:
        return normalized
    return "1m"


def _to_str(v: Any) -> str:
    if v is None:
        return "0"
    if isinstance(v, Decimal):
        return format(v, "f")
    return str(v)


def _spot_snapshot_fallback_payload(symbol: str, reason: str) -> dict:
    view = build_empty_spot_market_view(symbol=symbol, warnings=[reason])
    return build_spot_market_snapshot_payload(view)


def _log_spot_snapshot_timeout(symbol: str) -> None:
    now = time.monotonic()
    last_at = _SPOT_SNAPSHOT_TIMEOUT_LOG_LAST_AT.get(symbol)
    if last_at is not None and now - last_at < SPOT_SNAPSHOT_TIMEOUT_LOG_THROTTLE_SECONDS:
        return
    _SPOT_SNAPSHOT_TIMEOUT_LOG_LAST_AT[symbol] = now
    logger.warning("spot_market_snapshot_timeout symbol=%s", symbol)


def _build_spot_snapshot_payload(symbol: str) -> dict:
    db = SessionLocal()
    try:
        return get_spot_market_snapshot_payload(
            db=db,
            symbol=symbol,
            total_budget_seconds=SPOT_SNAPSHOT_VIEW_BUDGET_SECONDS,
            fast_external=True,
        )
    finally:
        db.close()


@dataclass(frozen=True)
class ClientSendMailboxItem:
    first_sequence: int
    latest_sequence: int
    symbol: str
    event_type: str
    domain: str
    text: str
    enqueue_time: float
    enqueue_monotonic: float
    kline_key: Optional[tuple[Any, ...]] = None
    revision_epoch: Optional[int] = None
    revision_seq: Optional[int] = None
    is_closed: Optional[bool] = None
    preview_key: Optional[tuple[Any, ...]] = None
    preview_seq: Optional[int] = None

    @property
    def sequence(self) -> int:
        return self.latest_sequence


MAILBOX_ENQUEUED = "enqueued"
MAILBOX_TRADE_BACKLOG_WARNING = "trade_backlog_warning"
MAILBOX_DEPTH_COALESCED = "depth_coalesced"
MAILBOX_TICKER_COALESCED = "ticker_coalesced"
MAILBOX_KLINE_REPLACED = "kline_replaced"
MAILBOX_KLINE_STALE_REJECTED = "kline_stale_rejected"
MAILBOX_PREVIEW_REPLACED = "preview_replaced"
MAILBOX_PREVIEW_STALE_REJECTED = "preview_stale_rejected"


class TradeBacklogFull(Exception):
    pass


class TradeBacklogExpired(Exception):
    pass


def _client_send_domain(event_type: str) -> str:
    normalized = str(event_type or "").strip().lower()
    if normalized == "spot_trade":
        return "trade"
    if normalized == "spot_depth_update":
        return "depth"
    if normalized == "spot_ticker_update":
        return "ticker"
    if normalized == "spot_kline_update":
        return "kline"
    if normalized == "spot_candle_preview_update":
        return "preview"
    return "control"


def _optional_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "closed"}:
        return True
    if normalized in {"0", "false", "no", "open"}:
        return False
    return None


def _spot_candle_preview_message(
    symbol: str,
    interval: str,
    preview: Any,
    *,
    received_at_ms: Any = None,
) -> dict[str, Any]:
    raw_preview = (
        preview.model_dump()
        if hasattr(preview, "model_dump")
        else dict(getattr(preview, "__dict__", preview) or {})
    )
    preview_payload = {
        key: _to_str(value) if isinstance(value, Decimal) else value
        for key, value in raw_preview.items()
    }
    revision_epoch = _optional_int(preview_payload.get("revision_epoch"))
    revision_seq = _optional_int(preview_payload.get("revision_seq"))
    generation = _optional_int(preview_payload.get("generation"))
    preview_seq = _optional_int(preview_payload.get("preview_seq"))
    baseline_source = str(preview_payload.get("baseline_source") or "NATIVE")
    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = _normalize_interval(str(interval or "1m"))
    settlement_revision = (
        f"spot:{normalized_symbol}:{normalized_interval}:"
        f"{generation}:{preview_payload.get('open_time')}:"
        f"{revision_epoch}:{revision_seq}:{preview_seq}"
    )
    return {
        "type": "spot_candle_preview_update",
        "symbol": normalized_symbol,
        "interval": normalized_interval,
        "preview": preview_payload,
        "source": "CANDLE_PREVIEW",
        "baseline_source": baseline_source,
        "baseline_anchor_open_time": preview_payload.get("baseline_anchor_open_time"),
        "provider": preview_payload.get("provider"),
        "provider_generation": generation,
        "base_native_revision": {
            "epoch": revision_epoch,
            "sequence": revision_seq,
        },
        "preview_seq": preview_seq,
        "received_at_ms": received_at_ms,
        "settlement_revision": settlement_revision,
    }


def _client_send_mailbox_item(
    *,
    sequence: int,
    symbol: str,
    event_type: str,
    text: str,
    payload: Any,
) -> ClientSendMailboxItem:
    domain = _client_send_domain(event_type)
    kline_key: Optional[tuple[Any, ...]] = None
    revision_epoch: Optional[int] = None
    revision_seq: Optional[int] = None
    is_closed: Optional[bool] = None
    preview_key: Optional[tuple[Any, ...]] = None
    preview_seq: Optional[int] = None
    if domain == "kline" and isinstance(payload, dict):
        kline = payload.get("kline")
        kline_payload = kline if isinstance(kline, dict) else {}
        interval = _normalize_interval(str(payload.get("interval") or "1m"))
        open_time = _optional_int(kline_payload.get("open_time"))
        if open_time is not None:
            kline_key = (symbol, interval, open_time)
        revision_epoch = _optional_int(
            kline_payload.get("revision_epoch", payload.get("revision_epoch"))
        )
        revision_seq = _optional_int(
            kline_payload.get("revision_seq", payload.get("revision_seq"))
        )
        is_closed = _optional_bool(
            kline_payload.get("is_closed", payload.get("is_closed"))
        )
    elif domain == "preview" and isinstance(payload, dict):
        preview = payload.get("preview")
        preview_payload = preview if isinstance(preview, dict) else {}
        interval = _normalize_interval(str(payload.get("interval") or "1m"))
        open_time = _optional_int(preview_payload.get("open_time"))
        if open_time is not None:
            preview_key = (symbol, interval, open_time)
        preview_seq = _optional_int(
            preview_payload.get("preview_seq", payload.get("preview_seq"))
        )
    return ClientSendMailboxItem(
        first_sequence=sequence,
        latest_sequence=sequence,
        symbol=symbol,
        event_type=event_type,
        domain=domain,
        text=text,
        enqueue_time=time.time(),
        enqueue_monotonic=time.monotonic(),
        kline_key=kline_key,
        revision_epoch=revision_epoch,
        revision_seq=revision_seq,
        is_closed=is_closed,
        preview_key=preview_key,
        preview_seq=preview_seq,
    )


@dataclass
class ClientSendMailbox:
    maxsize: int
    trade_capacity: int = SPOT_WS_CLIENT_TRADE_QUEUE_MAX_SIZE
    trade_warning_ratio: float = SPOT_WS_CLIENT_TRADE_BACKLOG_WARNING_RATIO
    trade_max_age_seconds: float = SPOT_WS_CLIENT_TRADE_MAX_AGE_SECONDS
    control_queue: deque[ClientSendMailboxItem] = field(default_factory=deque)
    trade_queue: deque[ClientSendMailboxItem] = field(default_factory=deque)
    depth_slot: Optional[ClientSendMailboxItem] = None
    ticker_slot: Optional[ClientSendMailboxItem] = None
    kline_pending: dict[tuple[Any, ...], ClientSendMailboxItem] = field(default_factory=dict)
    preview_pending: dict[tuple[Any, ...], ClientSendMailboxItem] = field(default_factory=dict)
    trade_queue_high_watermark: int = 0
    trade_warning_active: bool = False
    _ready: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def qsize(self) -> int:
        return len(self.trade_queue) + self.non_trade_qsize()

    def non_trade_qsize(self) -> int:
        return (
            len(self.control_queue)
            + (1 if self.depth_slot is not None else 0)
            + (1 if self.ticker_slot is not None else 0)
            + len(self.kline_pending)
            + len(self.preview_pending)
        )

    @property
    def trade_warning_threshold(self) -> int:
        return max(1, int(self.trade_capacity * self.trade_warning_ratio))

    def oldest_trade_age_ms(self, *, now: Optional[float] = None) -> float:
        if not self.trade_queue:
            return 0.0
        current = time.monotonic() if now is None else now
        return max(0.0, (current - self.trade_queue[0].enqueue_monotonic) * 1000)

    def trade_backlog_expired(self, *, now: Optional[float] = None) -> bool:
        if self.trade_max_age_seconds <= 0 or not self.trade_queue:
            return False
        return self.oldest_trade_age_ms(now=now) > self.trade_max_age_seconds * 1000

    def empty(self) -> bool:
        return self.qsize() == 0

    def domain_depths(self) -> dict[str, int]:
        return {
            "control": len(self.control_queue),
            "trade": len(self.trade_queue),
            "depth": 1 if self.depth_slot is not None else 0,
            "ticker": 1 if self.ticker_slot is not None else 0,
            "kline": len(self.kline_pending),
            "preview": len(self.preview_pending),
        }

    def put_nowait(self, item: ClientSendMailboxItem) -> str:
        if item.domain == "trade":
            if len(self.trade_queue) >= self.trade_capacity:
                raise TradeBacklogFull
            if self.trade_backlog_expired(now=item.enqueue_monotonic):
                raise TradeBacklogExpired
            self.trade_queue.append(item)
            self.trade_queue_high_watermark = max(
                self.trade_queue_high_watermark,
                len(self.trade_queue),
            )
            if (
                not self.trade_warning_active
                and len(self.trade_queue) >= self.trade_warning_threshold
            ):
                self.trade_warning_active = True
                self._ready.set()
                return MAILBOX_TRADE_BACKLOG_WARNING
        elif item.domain == "depth":
            if self.depth_slot is not None:
                self.depth_slot = replace(
                    item,
                    first_sequence=self.depth_slot.first_sequence,
                )
                self._ready.set()
                return MAILBOX_DEPTH_COALESCED
            self._ensure_capacity()
            self.depth_slot = item
        elif item.domain == "ticker":
            if self.ticker_slot is not None:
                self.ticker_slot = replace(
                    item,
                    first_sequence=self.ticker_slot.first_sequence,
                )
                self._ready.set()
                return MAILBOX_TICKER_COALESCED
            self._ensure_capacity()
            self.ticker_slot = item
        elif item.domain == "kline":
            key = item.kline_key or (item.symbol, "unkeyed", item.latest_sequence)
            existing = self.kline_pending.get(key)
            if existing is not None:
                if not self._should_replace_kline(existing, item):
                    return MAILBOX_KLINE_STALE_REJECTED
                self.kline_pending[key] = replace(
                    item,
                    first_sequence=existing.first_sequence,
                    kline_key=key,
                )
                self._ready.set()
                return MAILBOX_KLINE_REPLACED
            self._ensure_capacity()
            self.kline_pending[key] = replace(item, kline_key=key)
        elif item.domain == "preview":
            key = item.preview_key or (item.symbol, "unkeyed", item.latest_sequence)
            existing = self.preview_pending.get(key)
            if existing is not None:
                if (
                    existing.preview_seq is not None
                    and (
                        item.preview_seq is None
                        or item.preview_seq <= existing.preview_seq
                    )
                ):
                    return MAILBOX_PREVIEW_STALE_REJECTED
                self.preview_pending[key] = replace(
                    item,
                    first_sequence=existing.first_sequence,
                    preview_key=key,
                )
                self._ready.set()
                return MAILBOX_PREVIEW_REPLACED
            self._ensure_capacity()
            self.preview_pending[key] = replace(item, preview_key=key)
        else:
            self._ensure_capacity()
            self.control_queue.append(item)
        self._ready.set()
        return MAILBOX_ENQUEUED

    def _ensure_capacity(self) -> None:
        if self.non_trade_qsize() >= self.maxsize:
            raise asyncio.QueueFull

    @staticmethod
    def _revision(item: ClientSendMailboxItem) -> Optional[tuple[int, int]]:
        if item.revision_epoch is None or item.revision_seq is None:
            return None
        return item.revision_epoch, item.revision_seq

    @classmethod
    def _should_replace_kline(
        cls,
        existing: ClientSendMailboxItem,
        incoming: ClientSendMailboxItem,
    ) -> bool:
        existing_revision = cls._revision(existing)
        incoming_revision = cls._revision(incoming)
        if existing_revision is not None and incoming_revision is None:
            return False
        if (
            existing_revision is not None
            and incoming_revision is not None
            and incoming_revision < existing_revision
        ):
            return False
        if existing.is_closed is True and incoming.is_closed is not True:
            return False
        if existing_revision is None and incoming_revision is not None:
            return True
        if (
            existing_revision is not None
            and incoming_revision is not None
            and incoming_revision > existing_revision
        ):
            return True
        if existing.is_closed is not True and incoming.is_closed is True:
            return True
        return incoming.latest_sequence > existing.latest_sequence

    def _oldest_candidates(self) -> list[tuple[str, ClientSendMailboxItem]]:
        candidates: list[tuple[str, ClientSendMailboxItem]] = []
        if self.control_queue:
            candidates.append(("control", self.control_queue[0]))
        if self.trade_queue:
            candidates.append(("trade", self.trade_queue[0]))
        if self.depth_slot is not None:
            candidates.append(("depth", self.depth_slot))
        if self.ticker_slot is not None:
            candidates.append(("ticker", self.ticker_slot))
        if self.kline_pending:
            candidates.append(
                (
                    "kline",
                    min(
                        self.kline_pending.values(),
                        key=lambda item: item.first_sequence,
                    ),
                )
            )
        if self.preview_pending:
            candidates.append(
                (
                    "preview",
                    min(
                        self.preview_pending.values(),
                        key=lambda item: item.first_sequence,
                    ),
                )
            )
        return candidates

    def _pop_domain(self, domain: str) -> ClientSendMailboxItem:
        if domain == "control":
            return self.control_queue.popleft()
        if domain == "trade":
            item = self.trade_queue.popleft()
            if len(self.trade_queue) < self.trade_warning_threshold:
                self.trade_warning_active = False
            return item
        if domain == "depth":
            item = self.depth_slot
            self.depth_slot = None
        elif domain == "ticker":
            item = self.ticker_slot
            self.ticker_slot = None
        elif domain == "kline":
            key, item = min(
                self.kline_pending.items(),
                key=lambda pair: pair[1].first_sequence,
            )
            self.kline_pending.pop(key, None)
            return item
        else:
            key, item = min(
                self.preview_pending.items(),
                key=lambda pair: pair[1].first_sequence,
            )
            self.preview_pending.pop(key, None)
            return item
        if item is None:
            raise asyncio.QueueEmpty
        return item

    async def get(self) -> ClientSendMailboxItem:
        while True:
            candidates = self._oldest_candidates()
            if candidates:
                domain, _item = min(
                    candidates,
                    key=lambda candidate: candidate[1].first_sequence,
                )
                item = self._pop_domain(domain)
                if self.empty():
                    self._ready.clear()
                return item
            self._ready.clear()
            if not self.empty():
                continue
            await self._ready.wait()

    def drain(self) -> None:
        self.control_queue.clear()
        self.trade_queue.clear()
        self.depth_slot = None
        self.ticker_slot = None
        self.kline_pending.clear()
        self.preview_pending.clear()
        self.trade_warning_active = False
        self._ready.clear()


@dataclass
class ClientSendState:
    websocket: WebSocket
    mailbox: ClientSendMailbox
    sender_task: Optional[asyncio.Task[None]] = None
    closing: bool = False
    connected_at: float = 0.0
    last_enqueue_at: Optional[float] = None
    last_send_started_at: Optional[float] = None
    last_send_completed_at: Optional[float] = None
    queue_high_watermark: int = 0
    queue_full_count: int = 0
    send_timeout_count: int = 0
    slow_disconnect_count: int = 0
    last_send_duration_ms: Optional[float] = None
    slow: bool = False
    cleanup_reason: Optional[str] = None
    cleanup_scheduled: bool = False
    cleanup_completed: bool = False

    @property
    def queue_depth(self) -> int:
        return self.mailbox.qsize()


class MarketWsManager:
    def __init__(self) -> None:
        self._symbol_rooms: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._connection_kline_intervals: Dict[WebSocket, Set[str]] = {}
        self._client_send_states: Dict[WebSocket, ClientSendState] = {}
        self._lock = asyncio.Lock()
        self._fanout_lock = asyncio.Lock()
        self._send_sequence = 0
        self._queue_full_count = 0
        self._send_timeout_count = 0
        self._slow_disconnect_count = 0
        self._depth_coalesced_count = 0
        self._ticker_coalesced_count = 0
        self._kline_revision_replace_count = 0
        self._kline_stale_replace_reject_count = 0
        self._preview_replace_count = 0
        self._preview_stale_replace_reject_count = 0
        self._trade_queue_high_watermark = 0
        self._trade_backlog_warning_count = 0
        self._trade_backlog_disconnect_count = 0
        self._cleanup_reason_counts: dict[str, int] = defaultdict(int)
        self._slow_clients_active = 0
        self._cleanup_count = 0
        self._queue_high_watermark = 0
        self._last_send_duration_ms: Optional[float] = None
        self._cleanup_tasks: Set[asyncio.Task[None]] = set()
        self._connect_count = 0
        self._disconnect_count = 0
        self._dead_cleanup_count = 0
        self._last_connect_at: dict[str, float] = {}
        self._last_disconnect_at: dict[str, float] = {}
        self._fanout_metrics: dict[str, dict[str, Any]] = {}
        self._last_slow_fanout_log_at: dict[str, float] = {}

    async def connect(
        self,
        symbol: str,
        websocket: WebSocket,
        *,
        accepted: bool = False,
        interval: str | None = None,
    ) -> None:
        if not accepted and websocket.application_state == WebSocketState.CONNECTING:
            await websocket.accept()
        symbol = _normalize_symbol(symbol)
        normalized_interval = _normalize_interval(interval) if interval else None
        async with self._lock:
            room = self._symbol_rooms[symbol]
            added = websocket not in room
            room.add(websocket)
            if added:
                self._connect_count += 1
            state = self._client_send_states.get(websocket)
            if state is None or state.closing or state.sender_task is None or state.sender_task.done():
                state = ClientSendState(
                    websocket=websocket,
                    mailbox=ClientSendMailbox(maxsize=SPOT_WS_CLIENT_SEND_QUEUE_MAX_SIZE),
                    connected_at=time.time(),
                )
                state.sender_task = asyncio.create_task(self._client_sender(state))
                self._client_send_states[websocket] = state
            intervals = self._connection_kline_intervals.setdefault(websocket, set())
            if normalized_interval:
                intervals.add(normalized_interval)
            self._last_connect_at[symbol] = time.time()
            subscriber_count = len(self._symbol_rooms.get(symbol, set()))
            total_connections = self._total_connection_count_locked()
        logger.info(
            "spot_ws_connect symbol=%s subscriber_count=%s total_connections=%s",
            symbol,
            subscriber_count,
            total_connections,
        )
        await self._ensure_spot_provider_depth(symbol, normalized_interval)

    async def disconnect(self, symbol: str, websocket: WebSocket) -> None:
        symbol = _normalize_symbol(symbol)
        subscriber_count, total_connections, should_release = await self._remove_clients(
            symbol,
            [websocket],
            dead=False,
        )
        logger.info(
            "spot_ws_disconnect symbol=%s subscriber_count=%s total_connections=%s",
            symbol,
            subscriber_count,
            total_connections,
        )
        if should_release:
            await self._release_spot_provider_depth_if_idle(symbol)

    async def _get_connections(self, symbol: str):
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            return list(self._symbol_rooms.get(symbol, set()))

    async def subscriber_count(self, symbol: str) -> int:
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            return len(self._symbol_rooms.get(symbol, set()))

    async def kline_intervals(self, symbol: str) -> list[str]:
        symbol = _normalize_symbol(symbol)
        async with self._lock:
            intervals = {
                interval
                for ws in self._symbol_rooms.get(symbol, set())
                for interval in self._connection_kline_intervals.get(ws, set())
            }
        return sorted(interval for interval in intervals if interval)

    @staticmethod
    def _drain_send_mailbox(state: ClientSendState) -> None:
        state.mailbox.drain()

    def _schedule_client_cleanup(
        self,
        state: ClientSendState,
        *,
        symbol: str,
        slow: bool,
        close_code: int,
    ) -> None:
        if state.cleanup_scheduled:
            return
        state.cleanup_scheduled = True
        state.closing = True
        cleanup_reason = state.cleanup_reason or ("slow_client" if slow else "send_exception")
        state.cleanup_reason = cleanup_reason
        self._cleanup_reason_counts[cleanup_reason] += 1
        if slow:
            state.slow = True
            state.slow_disconnect_count += 1
            self._slow_disconnect_count += 1
            self._slow_clients_active += 1
        task = asyncio.create_task(
            self._run_client_cleanup(
                state,
                symbol=symbol,
                close_code=close_code,
            )
        )
        self._cleanup_tasks.add(task)
        task.add_done_callback(self._consume_cleanup_task_result)

    def _consume_cleanup_task_result(self, task: asyncio.Task[None]) -> None:
        self._cleanup_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.warning("spot_ws_client_cleanup_failed", exc_info=True)

    async def _run_client_cleanup(
        self,
        state: ClientSendState,
        *,
        symbol: str,
        close_code: int,
    ) -> None:
        should_release = False
        try:
            _subscriber_count, _total_connections, should_release = await self._remove_clients(
                symbol,
                [state.websocket],
                dead=True,
            )
            close = getattr(state.websocket, "close", None)
            if callable(close):
                try:
                    await asyncio.wait_for(
                        close(code=close_code),
                        timeout=SPOT_WS_CLIENT_CLOSE_TIMEOUT_SECONDS,
                    )
                except Exception:
                    logger.debug("spot_ws_client_close_failed symbol=%s", symbol, exc_info=True)
            if should_release:
                await self._release_spot_provider_depth_if_idle(symbol)
        finally:
            if not state.cleanup_completed:
                state.cleanup_completed = True
                self._cleanup_count += 1
                if state.slow:
                    self._slow_clients_active = max(0, self._slow_clients_active - 1)

    def _mark_queue_full(self, state: ClientSendState, *, symbol: str) -> None:
        state.queue_full_count += 1
        self._queue_full_count += 1
        state.cleanup_reason = "queue_full"
        self._schedule_client_cleanup(
            state,
            symbol=symbol,
            slow=True,
            close_code=1013,
        )

    def _mark_trade_backlog(
        self,
        state: ClientSendState,
        *,
        symbol: str,
        reason: str,
    ) -> None:
        if state.cleanup_scheduled:
            return
        self._trade_backlog_disconnect_count += 1
        state.cleanup_reason = reason
        self._schedule_client_cleanup(
            state,
            symbol=symbol,
            slow=True,
            close_code=1013,
        )

    def _remember_mailbox_put_result(
        self,
        state: ClientSendState,
        item: ClientSendMailboxItem,
        result: str,
    ) -> None:
        if item.domain == "trade":
            self._trade_queue_high_watermark = max(
                self._trade_queue_high_watermark,
                state.mailbox.trade_queue_high_watermark,
            )
        if result == MAILBOX_TRADE_BACKLOG_WARNING:
            self._trade_backlog_warning_count += 1
        if result == MAILBOX_DEPTH_COALESCED:
            self._depth_coalesced_count += 1
        elif result == MAILBOX_TICKER_COALESCED:
            self._ticker_coalesced_count += 1
        elif result == MAILBOX_KLINE_REPLACED:
            self._kline_revision_replace_count += 1
        elif result == MAILBOX_KLINE_STALE_REJECTED:
            self._kline_stale_replace_reject_count += 1
        elif result == MAILBOX_PREVIEW_REPLACED:
            self._preview_replace_count += 1
        elif result == MAILBOX_PREVIEW_STALE_REJECTED:
            self._preview_stale_replace_reject_count += 1

    async def _remove_clients(
        self,
        symbol: str,
        websockets: list[WebSocket],
        *,
        dead: bool,
    ) -> tuple[int, int, bool]:
        symbol = _normalize_symbol(symbol)
        states: list[ClientSendState] = []
        removed_count = 0
        should_release = False
        async with self._lock:
            room = self._symbol_rooms.get(symbol, set())
            for websocket in websockets:
                if websocket in room:
                    room.remove(websocket)
                    removed_count += 1
                    if not dead:
                        self._disconnect_count += 1
                self._connection_kline_intervals.pop(websocket, None)
                state = self._client_send_states.pop(websocket, None)
                if state is not None:
                    state.closing = True
                    states.append(state)
            if dead:
                self._dead_cleanup_count += removed_count
            if not room and symbol in self._symbol_rooms:
                self._symbol_rooms.pop(symbol, None)
                should_release = True
            self._last_disconnect_at[symbol] = time.time()
            subscriber_count = len(self._symbol_rooms.get(symbol, set()))
            total_connections = self._total_connection_count_locked()

        current_task = asyncio.current_task()
        tasks_to_wait: list[asyncio.Task[None]] = []
        for state in states:
            sender_task = state.sender_task
            if sender_task is not None and sender_task is not current_task and not sender_task.done():
                sender_task.cancel()
                tasks_to_wait.append(sender_task)
            self._drain_send_mailbox(state)
        if tasks_to_wait:
            await asyncio.gather(*tasks_to_wait, return_exceptions=True)
        return subscriber_count, total_connections, should_release

    async def _client_sender(self, state: ClientSendState) -> None:
        try:
            while True:
                item = await state.mailbox.get()
                send_started_at = time.perf_counter()
                state.last_send_started_at = time.time()
                try:
                    await self._send_text_with_timeout(state.websocket, item.text)
                except asyncio.CancelledError:
                    raise
                except asyncio.TimeoutError:
                    send_duration_ms = (time.perf_counter() - send_started_at) * 1000
                    state.last_send_completed_at = time.time()
                    state.last_send_duration_ms = send_duration_ms
                    state.send_timeout_count += 1
                    self._last_send_duration_ms = send_duration_ms
                    self._send_timeout_count += 1
                    self._remember_send_result(
                        symbol=item.symbol,
                        event_type=item.event_type,
                        send_duration_ms=send_duration_ms,
                        success=False,
                    )
                    state.cleanup_reason = "send_timeout"
                    self._schedule_client_cleanup(
                        state,
                        symbol=item.symbol,
                        slow=True,
                        close_code=1013,
                    )
                    return
                except Exception:
                    send_duration_ms = (time.perf_counter() - send_started_at) * 1000
                    state.last_send_completed_at = time.time()
                    state.last_send_duration_ms = send_duration_ms
                    self._last_send_duration_ms = send_duration_ms
                    self._remember_send_result(
                        symbol=item.symbol,
                        event_type=item.event_type,
                        send_duration_ms=send_duration_ms,
                        success=False,
                    )
                    state.cleanup_reason = "send_exception"
                    self._schedule_client_cleanup(
                        state,
                        symbol=item.symbol,
                        slow=False,
                        close_code=1011,
                    )
                    return
                else:
                    send_duration_ms = (time.perf_counter() - send_started_at) * 1000
                    state.last_send_completed_at = time.time()
                    state.last_send_duration_ms = send_duration_ms
                    self._last_send_duration_ms = send_duration_ms
                    self._remember_send_result(
                        symbol=item.symbol,
                        event_type=item.event_type,
                        send_duration_ms=send_duration_ms,
                        success=True,
                    )
                    if state.mailbox.trade_backlog_expired():
                        self._mark_trade_backlog(
                            state,
                            symbol=item.symbol,
                            reason="trade_backlog_expired",
                        )
                        return
        except asyncio.CancelledError:
            return

    @staticmethod
    async def _send_text_with_timeout(websocket: WebSocket, text: str) -> None:
        send_task = asyncio.create_task(websocket.send_text(text))
        try:
            done, _pending = await asyncio.wait(
                {send_task},
                timeout=SPOT_WS_CLIENT_SEND_TIMEOUT_SECONDS,
            )
            if send_task not in done:
                send_task.cancel()
                await asyncio.gather(send_task, return_exceptions=True)
                raise asyncio.TimeoutError
            await send_task
        except asyncio.CancelledError:
            if not send_task.done():
                send_task.cancel()
            await asyncio.gather(send_task, return_exceptions=True)
            raise

    async def get_metrics_snapshot(self) -> dict[str, Any]:
        async with self._lock:
            symbols = sorted(self._symbol_rooms.keys())
            per_symbol = {}
            total_kline_interval_subscriptions = 0
            for symbol in symbols:
                room = self._symbol_rooms.get(symbol, set())
                interval_counts: dict[str, int] = defaultdict(int)
                for ws in room:
                    for interval in self._connection_kline_intervals.get(ws, set()):
                        interval_counts[interval] += 1
                        total_kline_interval_subscriptions += 1
                per_symbol[symbol] = {
                    "subscriber_count": len(room),
                    "kline_interval_subscriber_count": dict(sorted(interval_counts.items())),
                    "last_connect_at": self._last_connect_at.get(symbol),
                    "last_disconnect_at": self._last_disconnect_at.get(symbol),
                }
            total_active_connections = self._total_connection_count_locked()
            queue_depths = [state.queue_depth for state in self._client_send_states.values()]
            pending_depth_slot = sum(
                1
                for state in self._client_send_states.values()
                if state.mailbox.depth_slot is not None
            )
            pending_ticker_slot = sum(
                1
                for state in self._client_send_states.values()
                if state.mailbox.ticker_slot is not None
            )
            pending_kline_count = sum(
                len(state.mailbox.kline_pending)
                for state in self._client_send_states.values()
            )
            pending_preview_count = sum(
                len(state.mailbox.preview_pending)
                for state in self._client_send_states.values()
            )
            trade_queue_depth = sum(
                len(state.mailbox.trade_queue)
                for state in self._client_send_states.values()
            )
            oldest_trade_age_ms = max(
                (
                    state.mailbox.oldest_trade_age_ms()
                    for state in self._client_send_states.values()
                ),
                default=0.0,
            )
            active_sender_tasks = sum(
                1
                for state in self._client_send_states.values()
                if state.sender_task is not None and not state.sender_task.done()
            )
            fanout = {key: dict(value) for key, value in self._fanout_metrics.items()}
            fanout_count = sum(int(item.get("fanout_count") or 0) for item in fanout.values())
            send_count = sum(int(item.get("send_count") or 0) for item in fanout.values())
            successful_send_count = sum(
                int(item.get("successful_send_count") or 0) for item in fanout.values()
            )
            failed_send_count = sum(
                int(item.get("failed_send_count") or 0) for item in fanout.values()
            )
            slow_send_count = sum(int(item.get("slow_send_count") or 0) for item in fanout.values())
            total_fanout_duration_ms = sum(
                float(item.get("total_fanout_duration_ms") or 0.0) for item in fanout.values()
            )
            max_fanout_duration_ms = max(
                (float(item.get("max_fanout_duration_ms") or 0.0) for item in fanout.values()),
                default=0.0,
            )
            max_send_duration_ms = max(
                (float(item.get("max_send_duration_ms") or 0.0) for item in fanout.values()),
                default=0.0,
            )
            return {
                "total_active_connections": total_active_connections,
                "active_rooms": len(self._symbol_rooms),
                "symbols": per_symbol,
                "dead_websocket_cleanup_count": self._dead_cleanup_count,
                "fanout": fanout,
                "connections": {
                    "active": total_active_connections,
                    "created": self._connect_count,
                    "disconnected": self._disconnect_count,
                },
                "rooms": {
                    "active": len(self._symbol_rooms),
                },
                "subscriptions": {
                    "symbol": total_active_connections,
                    "kline_interval": total_kline_interval_subscriptions,
                    "total": total_active_connections + total_kline_interval_subscriptions,
                },
                "send_queues": {
                    "active": len(self._client_send_states),
                    "active_sender_tasks": active_sender_tasks,
                    "active_senders": active_sender_tasks,
                    "capacity_per_client": (
                        SPOT_WS_CLIENT_SEND_QUEUE_MAX_SIZE
                        + SPOT_WS_CLIENT_TRADE_QUEUE_MAX_SIZE
                    ),
                    "non_trade_capacity_per_client": SPOT_WS_CLIENT_SEND_QUEUE_MAX_SIZE,
                    "trade_capacity_per_client": SPOT_WS_CLIENT_TRADE_QUEUE_MAX_SIZE,
                    "total_depth": sum(queue_depths),
                    "queue_depth": sum(queue_depths),
                    "max_depth": max(queue_depths, default=0),
                    "queue_high_watermark": self._queue_high_watermark,
                    "queue_full_count": self._queue_full_count,
                    "send_timeout_count": self._send_timeout_count,
                    "slow_disconnect_count": self._slow_disconnect_count,
                    "depth_coalesced_count": self._depth_coalesced_count,
                    "ticker_coalesced_count": self._ticker_coalesced_count,
                    "kline_revision_replace_count": self._kline_revision_replace_count,
                    "kline_stale_replace_reject_count": self._kline_stale_replace_reject_count,
                    "preview_replace_count": self._preview_replace_count,
                    "preview_stale_replace_reject_count": self._preview_stale_replace_reject_count,
                    "pending_depth_slot": pending_depth_slot,
                    "pending_ticker_slot": pending_ticker_slot,
                    "pending_kline_count": pending_kline_count,
                    "pending_preview_count": pending_preview_count,
                    "trade_queue_depth": trade_queue_depth,
                    "trade_queue_high_watermark": self._trade_queue_high_watermark,
                    "trade_backlog_warning_count": self._trade_backlog_warning_count,
                    "trade_backlog_disconnect_count": self._trade_backlog_disconnect_count,
                    "oldest_trade_age_ms": round(oldest_trade_age_ms, 3),
                    "slow_clients": self._slow_clients_active,
                    "cleanup_count": self._cleanup_count,
                    "active_cleanup_tasks": sum(
                        1 for task in self._cleanup_tasks if not task.done()
                    ),
                    "last_send_duration_ms": (
                        round(self._last_send_duration_ms, 3)
                        if self._last_send_duration_ms is not None
                        else None
                    ),
                },
                "fanout_summary": {
                    "count": fanout_count,
                    "send_count": send_count,
                    "success": successful_send_count,
                    "failed": failed_send_count,
                    "slow_send_count": slow_send_count,
                },
                "latency": {
                    "total_fanout_duration_ms": round(total_fanout_duration_ms, 3),
                    "average_fanout_duration_ms": round(
                        total_fanout_duration_ms / fanout_count,
                        3,
                    ) if fanout_count else 0.0,
                    "max_fanout_duration_ms": round(max_fanout_duration_ms, 3),
                    "max_send_duration_ms": round(max_send_duration_ms, 3),
                },
                "cleanup": {
                    "disconnected_clients": self._disconnect_count,
                    "dead_websocket_cleanup_count": self._dead_cleanup_count,
                    "reason_counts": dict(sorted(self._cleanup_reason_counts.items())),
                },
            }

    async def set_kline_subscription(
        self,
        symbol: str,
        websocket: WebSocket,
        interval: str | None,
        *,
        subscribed: bool,
    ) -> None:
        symbol = _normalize_symbol(symbol)
        normalized_interval = _normalize_interval(interval)
        if not symbol:
            return

        should_ensure = False
        async with self._lock:
            if websocket not in self._symbol_rooms.get(symbol, set()):
                return
            intervals = self._connection_kline_intervals.setdefault(websocket, set())
            if subscribed:
                if normalized_interval not in intervals:
                    intervals.add(normalized_interval)
                    should_ensure = True
            else:
                intervals.discard(normalized_interval)

        if subscribed and should_ensure:
            await self._ensure_spot_provider_depth(symbol, normalized_interval)

    async def _cleanup_dead(self, symbol: str, dead: list[WebSocket]) -> None:
        if not dead:
            return

        symbol = _normalize_symbol(symbol)
        _subscriber_count, _total_connections, should_release = await self._remove_clients(
            symbol,
            dead,
            dead=True,
        )
        if should_release:
            await self._release_spot_provider_depth_if_idle(symbol)

    async def _send_payload(self, symbol: str, payload: dict) -> None:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        async with self._fanout_lock:
            states = await self._get_payload_recipient_states(symbol, payload)
            if not states:
                return

            text = json.dumps(payload, ensure_ascii=False)
            event_type = str(payload.get("type") or "unknown")
            fanout_started_at = time.perf_counter()
            self._send_sequence += 1
            item = _client_send_mailbox_item(
                sequence=self._send_sequence,
                symbol=symbol,
                event_type=event_type,
                text=text,
                payload=payload,
            )
            queue_full_count = 0
            for state in states:
                if state.closing:
                    continue
                try:
                    put_result = state.mailbox.put_nowait(item)
                except TradeBacklogFull:
                    self._mark_trade_backlog(
                        state,
                        symbol=symbol,
                        reason="trade_backlog_full",
                    )
                except TradeBacklogExpired:
                    self._mark_trade_backlog(
                        state,
                        symbol=symbol,
                        reason="trade_backlog_expired",
                    )
                except asyncio.QueueFull:
                    queue_full_count += 1
                    self._mark_queue_full(state, symbol=symbol)
                else:
                    self._remember_mailbox_put_result(state, item, put_result)
                    if put_result not in {
                        MAILBOX_KLINE_STALE_REJECTED,
                        MAILBOX_PREVIEW_STALE_REJECTED,
                    }:
                        state.last_enqueue_at = item.enqueue_time
                        state.queue_high_watermark = max(
                            state.queue_high_watermark,
                            state.mailbox.qsize(),
                        )
                        self._queue_high_watermark = max(
                            self._queue_high_watermark,
                            state.queue_high_watermark,
                        )

            fanout_duration_ms = (time.perf_counter() - fanout_started_at) * 1000
            self._remember_fanout_metric(
                symbol=symbol,
                event_type=event_type,
                subscriber_count=len(states),
                fanout_duration_ms=fanout_duration_ms,
                slow_send_count=0,
                failed_send_count=queue_full_count,
                cleaned_dead_ws_count=0,
                max_send_duration_ms=0.0,
            )
            self._log_slow_fanout_if_needed(
                symbol=symbol,
                event_type=event_type,
                subscriber_count=len(states),
                fanout_duration_ms=fanout_duration_ms,
                slow_send_count=0,
                failed_send_count=queue_full_count,
                cleaned_dead_ws_count=0,
            )

    async def enqueue_to_client(
        self,
        websocket: WebSocket,
        payload: Any,
        *,
        symbol: str,
        event_type: Optional[str] = None,
    ) -> bool:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return False

        async with self._fanout_lock:
            async with self._lock:
                state = self._client_send_states.get(websocket)
                if state is None or state.closing:
                    return False

            text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
            normalized_event_type = str(
                event_type
                or (payload.get("type") if isinstance(payload, dict) else None)
                or "direct"
            )
            fanout_started_at = time.perf_counter()
            self._send_sequence += 1
            item = _client_send_mailbox_item(
                sequence=self._send_sequence,
                symbol=symbol,
                event_type=normalized_event_type,
                text=text,
                payload=payload,
            )
            queue_full_count = 0
            mailbox_rejected = False
            try:
                put_result = state.mailbox.put_nowait(item)
            except TradeBacklogFull:
                mailbox_rejected = True
                self._mark_trade_backlog(
                    state,
                    symbol=symbol,
                    reason="trade_backlog_full",
                )
            except TradeBacklogExpired:
                mailbox_rejected = True
                self._mark_trade_backlog(
                    state,
                    symbol=symbol,
                    reason="trade_backlog_expired",
                )
            except asyncio.QueueFull:
                mailbox_rejected = True
                queue_full_count = 1
                self._mark_queue_full(state, symbol=symbol)
            else:
                self._remember_mailbox_put_result(state, item, put_result)
                if put_result != MAILBOX_KLINE_STALE_REJECTED:
                    state.last_enqueue_at = item.enqueue_time
                    state.queue_high_watermark = max(
                        state.queue_high_watermark,
                        state.mailbox.qsize(),
                    )
                    self._queue_high_watermark = max(
                        self._queue_high_watermark,
                        state.queue_high_watermark,
                    )

            fanout_duration_ms = (time.perf_counter() - fanout_started_at) * 1000
            self._remember_fanout_metric(
                symbol=symbol,
                event_type=normalized_event_type,
                subscriber_count=1,
                fanout_duration_ms=fanout_duration_ms,
                slow_send_count=0,
                failed_send_count=queue_full_count,
                cleaned_dead_ws_count=0,
                max_send_duration_ms=0.0,
            )
            return queue_full_count == 0 and not mailbox_rejected

    async def _get_payload_recipient_states(
        self,
        symbol: str,
        payload: dict,
    ) -> list[ClientSendState]:
        symbol = _normalize_symbol(symbol)
        payload_type = str(payload.get("type") or "")
        interval = (
            _normalize_interval(str(payload.get("interval") or "1m"))
            if payload_type in {"spot_kline_update", "spot_candle_preview_update"}
            else None
        )
        async with self._lock:
            result = []
            for websocket in self._symbol_rooms.get(symbol, set()):
                if interval is not None and interval not in self._connection_kline_intervals.get(
                    websocket,
                    set(),
                ):
                    continue
                state = self._client_send_states.get(websocket)
                if state is not None and not state.closing:
                    result.append(state)
            return result

    async def _get_payload_recipients(self, symbol: str, payload: dict) -> list[WebSocket]:
        symbol = _normalize_symbol(symbol)
        payload_type = str(payload.get("type") or "")
        if payload_type not in {"spot_kline_update", "spot_candle_preview_update"}:
            return await self._get_connections(symbol)

        interval = _normalize_interval(str(payload.get("interval") or "1m"))
        async with self._lock:
            return [
                ws
                for ws in self._symbol_rooms.get(symbol, set())
                if interval in self._connection_kline_intervals.get(ws, set())
            ]

    async def _ensure_spot_provider_depth(self, symbol: str, interval: str | None = None) -> None:
        try:
            from app.services.spot_market_gateway import spot_market_gateway

            await spot_market_gateway.ensure_symbol(
                symbol,
                interval=_normalize_interval(interval) if interval else None,
            )
        except Exception:
            logger.warning("spot_market_ws_provider_depth_ensure_failed symbol=%s", symbol, exc_info=True)

    async def _release_spot_provider_depth_if_idle(self, symbol: str) -> None:
        try:
            from app.services.spot_market_gateway import spot_market_gateway

            await spot_market_gateway.release_symbol_if_idle(symbol)
        except Exception:
            logger.warning("spot_market_ws_provider_depth_release_failed symbol=%s", symbol, exc_info=True)

    def _total_connection_count_locked(self) -> int:
        return sum(len(room) for room in self._symbol_rooms.values())

    def _remember_fanout_metric(
        self,
        *,
        symbol: str,
        event_type: str,
        subscriber_count: int,
        fanout_duration_ms: float,
        slow_send_count: int,
        failed_send_count: int,
        cleaned_dead_ws_count: int,
        max_send_duration_ms: float,
    ) -> None:
        metric_key = f"{symbol}:{event_type}"
        existing = self._fanout_metrics.get(metric_key, {})
        previous_fanout_count = int(existing.get("fanout_count") or 0)
        next_fanout_count = previous_fanout_count + 1
        total_fanout_duration_ms = float(existing.get("total_fanout_duration_ms") or 0.0) + fanout_duration_ms
        self._fanout_metrics[metric_key] = {
            "symbol": symbol,
            "event_type": event_type,
            "subscriber_count": subscriber_count,
            "fanout_count": next_fanout_count,
            "send_count": int(existing.get("send_count") or 0) + subscriber_count,
            "successful_send_count": int(existing.get("successful_send_count") or 0),
            "last_fanout_at": time.time(),
            "last_fanout_duration_ms": round(fanout_duration_ms, 3),
            "total_fanout_duration_ms": round(total_fanout_duration_ms, 3),
            "average_fanout_duration_ms": round(total_fanout_duration_ms / next_fanout_count, 3),
            "max_fanout_duration_ms": round(
                max(float(existing.get("max_fanout_duration_ms") or 0.0), fanout_duration_ms),
                3,
            ),
            "last_max_send_duration_ms": round(max_send_duration_ms, 3),
            "max_send_duration_ms": round(
                max(float(existing.get("max_send_duration_ms") or 0.0), max_send_duration_ms),
                3,
            ),
            "slow_send_count": int(existing.get("slow_send_count") or 0) + slow_send_count,
            "failed_send_count": int(existing.get("failed_send_count") or 0) + failed_send_count,
            "cleaned_dead_ws_count": int(existing.get("cleaned_dead_ws_count") or 0) + cleaned_dead_ws_count,
        }

    def _remember_send_result(
        self,
        *,
        symbol: str,
        event_type: str,
        send_duration_ms: float,
        success: bool,
    ) -> None:
        metric_key = f"{symbol}:{event_type}"
        existing = self._fanout_metrics.get(metric_key)
        if existing is None:
            return
        is_slow = send_duration_ms >= SPOT_WS_SLOW_SEND_THRESHOLD_MS
        if success:
            existing["successful_send_count"] = int(existing.get("successful_send_count") or 0) + 1
        else:
            existing["failed_send_count"] = int(existing.get("failed_send_count") or 0) + 1
            existing["cleaned_dead_ws_count"] = int(existing.get("cleaned_dead_ws_count") or 0) + 1
        if is_slow:
            existing["slow_send_count"] = int(existing.get("slow_send_count") or 0) + 1
        existing["last_max_send_duration_ms"] = round(send_duration_ms, 3)
        existing["max_send_duration_ms"] = round(
            max(float(existing.get("max_send_duration_ms") or 0.0), send_duration_ms),
            3,
        )

    def _log_slow_fanout_if_needed(
        self,
        *,
        symbol: str,
        event_type: str,
        subscriber_count: int,
        fanout_duration_ms: float,
        slow_send_count: int,
        failed_send_count: int,
        cleaned_dead_ws_count: int,
    ) -> None:
        if slow_send_count <= 0 and fanout_duration_ms < SPOT_WS_SLOW_SEND_THRESHOLD_MS:
            return
        metric_key = f"{symbol}:{event_type}"
        now = time.monotonic()
        last_at = self._last_slow_fanout_log_at.get(metric_key)
        if last_at is not None and now - last_at < SPOT_WS_FANOUT_SLOW_LOG_THROTTLE_SECONDS:
            return
        self._last_slow_fanout_log_at[metric_key] = now
        logger.warning(
            "spot_ws_fanout_slow symbol=%s event_type=%s duration_ms=%.1f subscribers=%s "
            "slow_send_count=%s failed_send_count=%s cleaned_dead_ws_count=%s",
            symbol,
            event_type,
            fanout_duration_ms,
            subscriber_count,
            slow_send_count,
            failed_send_count,
            cleaned_dead_ws_count,
        )

    def _depth_update_payload(self, symbol: str, depth: Any) -> dict:
        bids = [
            item.model_dump() if hasattr(item, "model_dump") else item.dict()
            for item in getattr(depth, "bids", [])
        ]
        asks = [
            item.model_dump() if hasattr(item, "model_dump") else item.dict()
            for item in getattr(depth, "asks", [])
        ]
        has_depth_levels = bool(bids or asks)
        explicit_source = str(getattr(depth, "source", None) or "").strip().upper()
        explicit_freshness = str(getattr(depth, "freshness", None) or "").strip().upper()
        depth_payload = {
            "symbol": getattr(depth, "symbol", symbol),
            "bids": bids,
            "asks": asks,
            "ts": getattr(depth, "ts", None),
            "source": explicit_source or ("INTERNAL" if has_depth_levels else "MISSING"),
            "freshness": explicit_freshness or ("RECENT" if has_depth_levels else "MISSING"),
            "stale": bool(getattr(depth, "stale", False)) if has_depth_levels else False,
        }
        for key in (
            "price_precision",
            "amount_precision",
            "provider",
            "updated_at",
            "last_price",
            "mid_price",
            "fetched_at",
        ):
            value = getattr(depth, key, None)
            if value is not None:
                depth_payload[key] = value
        return {
            "type": "spot_depth_update",
            "symbol": _normalize_symbol(symbol),
            "depth": depth_payload,
        }

    def _ticker_update_payload(self, symbol: str, ticker: dict[str, Any]) -> dict:
        ticker_payload = dict(ticker or {})
        ticker_payload["symbol"] = _normalize_symbol(ticker_payload.get("symbol") or symbol)
        return {
            "type": "spot_ticker_update",
            "symbol": _normalize_symbol(symbol),
            "ticker": ticker_payload,
        }

    async def broadcast_depth_update(self, symbol: str, depth: Any) -> None:
        await self._send_payload(symbol, self._depth_update_payload(symbol, depth))

    async def broadcast_ticker_update(self, symbol: str, ticker: dict[str, Any]) -> None:
        await self._send_payload(symbol, self._ticker_update_payload(symbol, ticker))

    async def broadcast_provider_kline_update(
        self,
        symbol: str,
        interval: str,
        kline: Any,
        *,
        source: str = "LIVE_WS",
        updated_at: Any = None,
        revision_epoch: Any = None,
        revision_seq: Any = None,
        is_closed: Any = None,
        close_state_source: Any = None,
        provider_generation: Any = None,
    ) -> None:
        kline_payload = kline.model_dump() if hasattr(kline, "model_dump") else dict(kline or {})
        revision_fields = {
            "revision_epoch": revision_epoch,
            "revision_seq": revision_seq,
            "is_closed": is_closed,
            "close_state_source": close_state_source,
            "provider_generation": provider_generation,
        }
        for key, value in revision_fields.items():
            if value is not None:
                kline_payload[key] = value
        await self._send_payload(
            symbol,
            {
                "type": "spot_kline_update",
                "symbol": _normalize_symbol(symbol),
                "interval": _normalize_interval(str(interval or "1m")),
                "kline": kline_payload,
                "source": source,
                "updated_at": updated_at,
                "provider_generation": provider_generation,
            },
        )

    async def broadcast_spot_candle_preview_update(
        self,
        symbol: str,
        interval: str,
        preview: Any,
        *,
        received_at_ms: Any = None,
    ) -> None:
        await self._send_payload(
            symbol,
            _spot_candle_preview_message(
                symbol,
                interval,
                preview,
                received_at_ms=received_at_ms,
            ),
        )

    async def _snapshot_payload(self, symbol: str) -> dict:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return _spot_snapshot_fallback_payload(symbol, "invalid_symbol")

        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_build_spot_snapshot_payload, symbol),
                timeout=SPOT_SNAPSHOT_BUILD_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            _log_spot_snapshot_timeout(symbol)
            return _spot_snapshot_fallback_payload(symbol, "snapshot_timeout")
        except Exception as exc:
            logger.warning("spot_market_snapshot_failed symbol=%s error=%s", symbol, exc)
            return _spot_snapshot_fallback_payload(symbol, f"snapshot_unavailable:{exc}")

    async def send_snapshot(self, db: Session, symbol: str) -> None:
        """
        全量快照：用于撮合/下单/撤单后向当前 symbol room 广播。
        """
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return
        payload = await self._snapshot_payload(symbol)

        await self._send_payload(symbol, payload)

    async def send_snapshot_to_client(
        self,
        db: Session,
        symbol: str,
        websocket: WebSocket,
    ) -> None:
        """连接建立或切换 symbol 时，仅向当前客户端发送一次全量快照。"""
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return
        payload = await self._snapshot_payload(symbol)
        await self.enqueue_to_client(
            websocket,
            payload,
            symbol=symbol,
            event_type=str(payload.get("type") or "spot_market_snapshot"),
        )

    async def send_trade(
        self,
        *,
        symbol: str,
        price: Any,
        amount: Any,
        side: str,
        ts: int,
        id: Any = None,
        trade_id: Any = None,
        provider: Any = None,
        provider_symbol: Any = None,
        provider_trade_id: Any = None,
        source: Any = None,
        freshness: Any = None,
        updated_at_ms: Any = None,
        event_time_ms: Any = None,
        received_at_ms: Any = None,
        time_origin: Any = None,
        created_at: Any = None,
        candle_preview: Any = None,
        candle_preview_received_at_ms: Any = None,
    ) -> None:
        """
        增量推送：单笔成交
        """
        symbol = _normalize_symbol(symbol)
        item_id = id if id is not None else trade_id
        normalized_trade_id = trade_id if trade_id is not None else item_id
        normalized_provider_trade_id = provider_trade_id
        if normalized_provider_trade_id is None:
            normalized_provider_trade_id = normalized_trade_id
        if normalized_provider_trade_id is None:
            normalized_provider_trade_id = item_id
        trade_payload = {
            "id": item_id,
            "trade_id": normalized_trade_id,
            "provider_trade_id": normalized_provider_trade_id,
            "price": _to_str(price),
            "amount": _to_str(amount),
            "side": (side or "").upper(),
            "ts": ts,
            "event_time_ms": event_time_ms,
            "received_at_ms": received_at_ms,
            "time_origin": time_origin,
            "created_at": created_at,
            "provider": str(provider) if provider is not None else None,
            "provider_symbol": str(provider_symbol) if provider_symbol is not None else None,
            "source": str(source) if source is not None else None,
            "freshness": str(freshness) if freshness is not None else None,
        }
        if updated_at_ms is not None:
            trade_payload["updated_at_ms"] = updated_at_ms

        payload = {
            "type": "spot_trade",
            "symbol": symbol,
            "trade_id": normalized_trade_id,
            "provider_trade_id": normalized_provider_trade_id,
            "ts": ts,
            "event_time_ms": event_time_ms,
            "received_at_ms": received_at_ms,
            "time_origin": time_origin,
            "trade": trade_payload,
        }
        if provider is not None:
            payload["provider"] = str(provider)
        if provider_symbol is not None:
            payload["provider_symbol"] = str(provider_symbol)
        if source is not None:
            payload["source"] = str(source)
        if freshness is not None:
            payload["freshness"] = str(freshness)
        if updated_at_ms is not None:
            payload["updated_at_ms"] = updated_at_ms
        if candle_preview is not None:
            preview_interval = str(getattr(candle_preview, "interval", "1m") or "1m")
            preview_message = _spot_candle_preview_message(
                symbol,
                preview_interval,
                candle_preview,
                received_at_ms=candle_preview_received_at_ms,
            )
            payload["candle_preview"] = preview_message
            payload["settlement_revision"] = preview_message["settlement_revision"]
        await self._send_payload(symbol, payload)

    async def send_kline_update(
        self,
        *,
        db: Session,
        symbol: str,
        price: Any,
        amount: Any,
        ts: int,
    ) -> None:
        """
        Incremental authoritative spot kline updates generated from completed trades.
        """
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return

        try:
            payloads = apply_spot_trade_to_klines(
                db,
                symbol=symbol,
                trade_price=price,
                trade_amount=amount,
                trade_ts_ms=ts,
            )
        except Exception as exc:
            logger.warning("spot_kline_update_failed symbol=%s error=%s", symbol, exc)
            return

        for payload in payloads:
            await self._send_payload(symbol, payload)

    async def send_depth_update(
        self,
        *,
        db: Session,
        symbol: str,
        limit: int = 20,
    ) -> None:
        """
        增量推送：最新盘口
        当前先推“最新 depth 快照”
        后面如果你想升级成真正 diff，再继续拆
        """
        symbol = _normalize_symbol(symbol)
        depth = get_market_depth(db=db, symbol=symbol, limit=limit)

        await self.broadcast_depth_update(symbol, depth)


market_ws_manager = MarketWsManager()
