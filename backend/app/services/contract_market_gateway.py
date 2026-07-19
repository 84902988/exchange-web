from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections import OrderedDict
from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.schemas.contract_market import ContractDepthResponse, ContractMarketViewDetail, ContractQuoteResponse
from app.schemas.contract_market_domain_snapshot import (
    ContractMarketDomainCacheOrigin,
    ContractMarketDomainCompletenessStatus,
    ContractMarketDomainFallbackReason,
    ContractMarketDomainName,
    ContractMarketDomainSnapshot,
    ContractMarketDomainSource,
    ContractMarketDomainTransport,
)
from app.services.contract_market_domain_snapshot import (
    ContractMarketDomainSnapshotAuthority,
    ContractMarketDomainSnapshotAuthorityResult,
    ContractMarketDomainSnapshotContext,
    map_contract_depth_domain_snapshot,
    map_contract_kline_domain_snapshot,
    map_contract_ticker_domain_snapshot,
    map_contract_trades_domain_snapshot,
)
from app.services.contract_market_service import (
    ContractMarketError,
    ContractSymbolNotFound,
    _contract_depth_with_status,
    _contract_quote_with_status,
    _load_contract_symbol,
    _market_status_for_contract_symbol,
    contract_depth_to_response,
    contract_quote_to_response,
    get_contract_depth,
    get_contract_klines,
    get_contract_quote,
    get_contract_recent_trades,
)
from app.services.contract_market_ws import (
    contract_market_ws_manager,
    normalize_contract_ws_interval,
    normalize_contract_ws_symbol,
)
from app.services.contract_market_view import build_contract_market_view
from app.services.contract_candle_preview import (
    SUPPORTED_CONTRACT_CANDLE_PREVIEW_INTERVALS,
    ContractCandlePreview,
    ContractCandlePreviewEngine,
    ContractPreviewTradeStatus,
)
from app.services.contract_market_provider_ws import (
    ContractProviderKlineRevisionAccepted,
    force_stop_provider_ws_subscriptions_for_symbol,
    get_contract_provider_ws_kline_generation,
    provider_ws_depth_enabled,
    provider_ws_kline_enabled,
    provider_ws_ticker_enabled,
    provider_ws_trades_enabled,
    select_fresh_provider_ws_depth,
    select_fresh_provider_ws_kline,
    select_fresh_provider_ws_ticker,
    select_fresh_provider_ws_trades,
    set_contract_provider_ws_kline_revision_listener,
)

logger = logging.getLogger(__name__)

CONTRACT_MARKET_WS_QUOTE_INTERVAL_SECONDS = 1.0
CONTRACT_MARKET_WS_DEPTH_LIMIT = 20
CONTRACT_MARKET_WS_TRADES_LIMIT = 30
CONTRACT_MARKET_WS_KLINE_LIMIT = 2
CONTRACT_MARKET_WS_DEPTH_FALLBACK_SLEEP_SECONDS = 1.0
CONTRACT_MARKET_WS_KLINE_REST_FALLBACK_INTERVAL_SECONDS = 10.0
CONTRACT_MARKET_WS_KLINE_BROADCAST_INTERVAL_MAX_MS = 200
CONTRACT_MARKET_WS_TRADE_DEDUPE_MAX_IDS = 4_096

CONTRACT_MARKET_CACHE_QUOTE = "contract:market:{symbol}:quote"
CONTRACT_MARKET_CACHE_DEPTH = "contract:market:{symbol}:depth"
CONTRACT_MARKET_CACHE_TRADES = "contract:market:{symbol}:trades"
CONTRACT_MARKET_CACHE_KLINE = "contract:market:{symbol}:kline:{interval}"
CONTRACT_MARKET_CACHE_STATE = "contract:market:{symbol}:state"

_CONTRACT_MARKET_DOMAIN_BY_CACHE = {
    CONTRACT_MARKET_CACHE_QUOTE: ContractMarketDomainName.TICKER,
    CONTRACT_MARKET_CACHE_DEPTH: ContractMarketDomainName.DEPTH,
    CONTRACT_MARKET_CACHE_TRADES: ContractMarketDomainName.TRADES,
    CONTRACT_MARKET_CACHE_KLINE: ContractMarketDomainName.KLINE,
}
_CONTRACT_MARKET_PROVIDER_WS_SOURCES = {"LIVE_WS", "PROVIDER_WS"}
_CONTRACT_MARKET_PROVIDER_REST_TRADE_SOURCES = {"PROVIDER_REST", "ITICK_TICK"}
_CONTRACT_MARKET_REAL_TRADE_SOURCES = (
    _CONTRACT_MARKET_PROVIDER_WS_SOURCES
    | _CONTRACT_MARKET_PROVIDER_REST_TRADE_SOURCES
)
_CONTRACT_MARKET_AUTHORITY_FIELDS = {
    "provider_generation",
    "revision_epoch",
    "revision_seq",
    "revision_sequence",
}
_CONTRACT_TRADE_EVIDENCE_FIELDS = (
    "provider",
    "provider_symbol",
    "source",
    "quote_source",
    "freshness",
    "quote_freshness",
    "price_source",
    "received_at_ms",
)


def _utc_ms() -> int:
    return int(time.time() * 1000)


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(item) for item in value]
    return value


def _timestamp_ms(value: Any) -> int:
    if value in (None, ""):
        return _utc_ms()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp() * 1000)
    numeric = None
    if isinstance(value, (int, float)):
        numeric = float(value)
    elif isinstance(value, str):
        try:
            numeric = float(value)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return int(parsed.timestamp() * 1000)
            except Exception:
                return _utc_ms()
    if numeric is None or numeric <= 0:
        return _utc_ms()
    return int(numeric if numeric > 10_000_000_000 else numeric * 1000)


def _market_symbol(symbol: str) -> str:
    return normalize_contract_ws_symbol(symbol).replace("_PERP", "")


def _json_signature(value: Any) -> str:
    return json.dumps(_to_jsonable(value), sort_keys=True, separators=(",", ":"))


def _authority_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                return item
    return {}


def _legacy_domain_value(value: Any) -> Any:
    legacy = _to_jsonable(value)
    if isinstance(legacy, dict):
        return {
            key: item
            for key, item in legacy.items()
            if key not in _CONTRACT_MARKET_AUTHORITY_FIELDS
        }
    if isinstance(legacy, list):
        return [
            {
                key: nested
                for key, nested in item.items()
                if key not in _CONTRACT_MARKET_AUTHORITY_FIELDS
            }
            if isinstance(item, dict)
            else item
            for item in legacy
        ]
    return legacy


def _latest_key(template: str, symbol: str, *, interval: str | None = None) -> str:
    normalized_symbol = normalize_contract_ws_symbol(symbol)
    if interval is None:
        return template.format(symbol=normalized_symbol)
    return template.format(symbol=normalized_symbol, interval=normalize_contract_ws_interval(interval))


def _normalize_trade(
    row: dict[str, Any],
    *,
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized = dict(row)
    if evidence:
        for field in _CONTRACT_TRADE_EVIDENCE_FIELDS:
            if normalized.get(field) in (None, "") and evidence.get(field) not in (None, ""):
                normalized[field] = evidence[field]
    price = row.get("price") or row.get("last_price")
    amount = row.get("qty") or row.get("amount") or row.get("quantity") or row.get("volume")
    is_buyer_maker = row.get("isBuyerMaker")
    side = row.get("side")
    if side is None and isinstance(is_buyer_maker, bool):
        side = "SELL" if is_buyer_maker else "BUY"
    return {
        **normalized,
        "price": str(price) if price is not None else "",
        "amount": str(amount) if amount is not None else "",
        "qty": str(amount) if amount is not None else "",
        "side": str(side or "").upper() or None,
        "source": normalized.get("source"),
    }


def _positive_trade_decimal(value: Any) -> bool:
    try:
        parsed = Decimal(str(value))
    except Exception:
        return False
    return parsed.is_finite() and parsed > 0


def _non_negative_kline_volume(value: Any) -> bool:
    if value in (None, "") or isinstance(value, bool):
        return False
    try:
        parsed = Decimal(str(value))
    except Exception:
        return False
    return parsed.is_finite() and parsed >= 0


def _optional_trade_timestamp_ms(value: Any) -> int | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        parsed = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        timestamp_ms = int(parsed.timestamp() * 1000)
    else:
        numeric: float | None = None
        if isinstance(value, (int, float)):
            numeric = float(value)
        elif isinstance(value, str):
            try:
                numeric = float(value)
            except ValueError:
                try:
                    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    timestamp_ms = int(parsed.timestamp() * 1000)
                except Exception:
                    return None
            else:
                timestamp_ms = int(numeric if numeric > 10_000_000_000 else numeric * 1000)
        else:
            return None
        if numeric is not None:
            timestamp_ms = int(numeric if numeric > 10_000_000_000 else numeric * 1000)
    if timestamp_ms <= 0 or timestamp_ms > _utc_ms() + 60_000:
        return None
    return timestamp_ms


def _trade_event_time_ms(row: dict[str, Any]) -> int | None:
    for key in ("event_time_ms", "time", "ts", "exchange_ts"):
        timestamp_ms = _optional_trade_timestamp_ms(row.get(key))
        if timestamp_ms is not None:
            return timestamp_ms
    return None


def _synthetic_trade(row: dict[str, Any]) -> bool:
    value = row.get("synthetic")
    return value is True or str(value or "").strip().lower() in {"1", "true", "yes"}


def _truthful_contract_trade(row: dict[str, Any], *, symbol: str) -> bool:
    expected_symbol = normalize_contract_ws_symbol(symbol)
    row_symbol_text = str(row.get("symbol") or "").strip()
    if not row_symbol_text:
        return False
    row_symbol = normalize_contract_ws_symbol(row_symbol_text)
    source = str(row.get("source") or "").strip().upper()
    quote_source = str(row.get("quote_source") or source).strip().upper()
    freshness = str(row.get("freshness") or row.get("quote_freshness") or "").strip().upper()
    expected_freshness = (
        "LIVE"
        if source in _CONTRACT_MARKET_PROVIDER_WS_SOURCES
        else "RECENT"
        if source in _CONTRACT_MARKET_PROVIDER_REST_TRADE_SOURCES
        else ""
    )
    return bool(
        row_symbol == expected_symbol
        and _positive_trade_decimal(row.get("price") or row.get("last_price"))
        and _positive_trade_decimal(
            row.get("qty") or row.get("amount") or row.get("quantity") or row.get("volume")
        )
        and _trade_event_time_ms(row) is not None
        and str(row.get("price_source") or "").strip().upper() == "TRADE_TICK"
        and source in _CONTRACT_MARKET_REAL_TRADE_SOURCES
        and quote_source in _CONTRACT_MARKET_REAL_TRADE_SOURCES
        and freshness == expected_freshness
        and not _synthetic_trade(row)
        and str(row.get("provider") or "").strip()
        and str(row.get("provider_symbol") or "").strip()
    )


def _truthful_contract_trades(
    rows: Any,
    *,
    symbol: str,
    evidence: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    truthful: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        normalized = _normalize_trade(dict(item), evidence=evidence)
        if _truthful_contract_trade(normalized, symbol=symbol):
            truthful.append(normalized)
    return truthful


def _normalize_kline(row: dict[str, Any], *, source: str | None = None) -> dict[str, Any]:
    open_time = row.get("open_time") or row.get("time") or row.get("timestamp")
    open_time_ms = _timestamp_ms(open_time)
    volume = row.get("volume")
    return {
        **row,
        "time": int(open_time_ms / 1000),
        "open_time": open_time_ms,
        "open": str(row.get("open") or ""),
        "high": str(row.get("high") or ""),
        "low": str(row.get("low") or ""),
        "close": str(row.get("close") or ""),
        "volume": str(volume) if volume not in (None, "") else None,
        "is_final": bool(row.get("is_final", False)),
        "source": row.get("source") or source,
    }


class ContractMarketGateway:
    def __init__(self) -> None:
        self._latest: dict[str, Any] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._kline_locks: dict[tuple[str, str], threading.Lock] = {}
        self._task_lock = asyncio.Lock()
        self._last_full_refresh_at: dict[str, float] = {}
        self._last_depth_broadcast_at: dict[str, float] = {}
        self._last_depth_signature: dict[str, str] = {}
        self._last_kline_broadcast_at: dict[tuple[str, str], float] = {}
        self._last_kline_signature: dict[tuple[str, str], str] = {}
        self._last_kline_rest_fallback_at: dict[tuple[str, str], float] = {}
        self._last_quote_signature: dict[str, str] = {}
        self._last_state_signature: dict[str, str] = {}
        self._last_trade_ids: dict[str, OrderedDict[str, None]] = {}
        self._provider_ws_allowed_symbols: set[str] = set()
        self._snapshot_authority = ContractMarketDomainSnapshotAuthority()
        self._candle_preview_engine = ContractCandlePreviewEngine()
        self._kline_event_loop: asyncio.AbstractEventLoop | None = None
        self._kline_event_tasks: dict[str, asyncio.Task[None]] = {}
        self._kline_wakeup_events: dict[str, asyncio.Event] = {}
        self._kline_refresh_locks: dict[str, asyncio.Lock] = {}
        self._pending_provider_kline_events: dict[
            tuple[str, str],
            ContractProviderKlineRevisionAccepted,
        ] = {}
        self._state_lock = threading.RLock()

    async def ensure_symbol(self, symbol: str) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return
        loop = asyncio.get_running_loop()
        with self._state_lock:
            self._provider_ws_allowed_symbols.add(normalized_symbol)
        async with self._task_lock:
            self._kline_event_loop = loop
            self._kline_wakeup_events.setdefault(normalized_symbol, asyncio.Event())
            self._kline_refresh_locks.setdefault(normalized_symbol, asyncio.Lock())
            event_task = self._kline_event_tasks.get(normalized_symbol)
            if event_task is None or event_task.done():
                self._kline_event_tasks[normalized_symbol] = asyncio.create_task(
                    self._kline_event_worker(normalized_symbol)
                )
            task = self._tasks.get(normalized_symbol)
            if task is not None and not task.done():
                return
            self._tasks[normalized_symbol] = asyncio.create_task(self._refresh_loop(normalized_symbol))

    async def release_symbol_if_idle(self, symbol: str) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return
        subscriber_count = await contract_market_ws_manager.subscriber_count(normalized_symbol)
        logger.info(
            "contract_market_gateway_release_symbol_if_idle called symbol=%s subscriber_count=%s",
            normalized_symbol,
            subscriber_count,
        )
        if subscriber_count > 0:
            logger.info(
                "contract_market_gateway_release_symbol_if_idle_keep symbol=%s subscriber_count=%s",
                normalized_symbol,
                subscriber_count,
            )
            return
        cancelled_task = False
        with self._state_lock:
            self._provider_ws_allowed_symbols.discard(normalized_symbol)
        async with self._task_lock:
            task = self._tasks.pop(normalized_symbol, None)
            if task is not None and not task.done():
                task.cancel()
                cancelled_task = True
            event_task = self._kline_event_tasks.pop(normalized_symbol, None)
            if event_task is not None and not event_task.done():
                event_task.cancel()
        self._kline_wakeup_events.pop(normalized_symbol, None)
        self._kline_refresh_locks.pop(normalized_symbol, None)
        for key in [
            key for key in self._pending_provider_kline_events if key[0] == normalized_symbol
        ]:
            self._pending_provider_kline_events.pop(key, None)
        self._candle_preview_engine.clear_symbol(normalized_symbol)
        logger.info(
            "contract_market_gateway_release_symbol_if_idle_stop symbol=%s cancelled_task=%s",
            normalized_symbol,
            cancelled_task,
        )
        # Provider-native market cache is process-local. Multi-worker deployments
        # keep one provider WS owner per worker until a shared owner/pubsub is added.
        stop_report = force_stop_provider_ws_subscriptions_for_symbol(normalized_symbol)
        logger.info(
            "contract_market_gateway_release_symbol_if_idle_provider_stop_report symbol=%s report=%s",
            normalized_symbol,
            stop_report,
        )

    async def snapshot(self, symbol: str, interval: str = "1m") -> dict[str, Any]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        status = "ok"
        try:
            await asyncio.to_thread(self._refresh_symbol_once, normalized_symbol, [normalized_interval])
        except (ContractSymbolNotFound, ContractMarketError):
            status = "unavailable"
            logger.debug("contract_market_gateway_snapshot_unavailable symbol=%s", normalized_symbol, exc_info=True)
        except Exception:
            status = "error"
            logger.warning("contract_market_gateway_snapshot_failed symbol=%s", normalized_symbol, exc_info=True)
        return self.snapshot_message(normalized_symbol, normalized_interval, status=status)

    async def market_snapshot(self, symbol: str) -> dict[str, Any]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        status = "ok"
        try:
            await asyncio.to_thread(self._refresh_market_once, normalized_symbol)
        except (ContractSymbolNotFound, ContractMarketError):
            status = "unavailable"
            logger.debug("contract_market_gateway_market_snapshot_unavailable symbol=%s", normalized_symbol, exc_info=True)
        except Exception:
            status = "error"
            logger.warning("contract_market_gateway_market_snapshot_failed symbol=%s", normalized_symbol, exc_info=True)
        return self.market_snapshot_message(normalized_symbol, status=status)

    async def kline_snapshot(self, symbol: str, interval: str = "1m") -> dict[str, Any]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        status = "ok"
        try:
            await asyncio.to_thread(self._refresh_kline_once, normalized_symbol, normalized_interval)
        except (ContractSymbolNotFound, ContractMarketError):
            status = "unavailable"
            logger.debug(
                "contract_market_gateway_kline_snapshot_unavailable symbol=%s interval=%s",
                normalized_symbol,
                normalized_interval,
                exc_info=True,
            )
        except Exception:
            status = "error"
            logger.warning(
                "contract_market_gateway_kline_snapshot_failed symbol=%s interval=%s",
                normalized_symbol,
                normalized_interval,
                exc_info=True,
            )
        return self.kline_snapshot_message(normalized_symbol, normalized_interval, status=status)

    def snapshot_message(self, symbol: str, interval: str = "1m", *, status: str = "ok") -> dict[str, Any]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        resolved_kline = self._kline_authority_payload(normalized_symbol, normalized_interval)
        authoritative_kline = resolved_kline[0] if resolved_kline is not None else None
        return {
            "type": "contract_market_snapshot",
            "symbol": normalized_symbol,
            "market_symbol": _market_symbol(normalized_symbol),
            "interval": normalized_interval,
            "ts": _utc_ms(),
            "data": {
                "quote": self._get_latest(CONTRACT_MARKET_CACHE_QUOTE, normalized_symbol),
                "depth": self._get_latest(CONTRACT_MARKET_CACHE_DEPTH, normalized_symbol),
                "trades": self._get_latest(CONTRACT_MARKET_CACHE_TRADES, normalized_symbol) or [],
                "klines": {
                    normalized_interval: authoritative_kline
                },
                "market_state": self._get_latest(
                    CONTRACT_MARKET_CACHE_STATE,
                    normalized_symbol,
                ),
                "status": status,
            },
        }

    def market_snapshot_message(self, symbol: str, *, status: str = "ok") -> dict[str, Any]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        return {
            "type": "contract_market_snapshot",
            "domain": "market",
            "symbol": normalized_symbol,
            "market_symbol": _market_symbol(normalized_symbol),
            "ts": _utc_ms(),
            "data": {
                "quote": self._get_latest(CONTRACT_MARKET_CACHE_QUOTE, normalized_symbol),
                "depth": self._get_latest(CONTRACT_MARKET_CACHE_DEPTH, normalized_symbol),
                "trades": self._get_latest(CONTRACT_MARKET_CACHE_TRADES, normalized_symbol) or [],
                "market_state": self._get_latest(CONTRACT_MARKET_CACHE_STATE, normalized_symbol),
                "status": status,
            },
        }

    def kline_snapshot_message(
        self,
        symbol: str,
        interval: str = "1m",
        *,
        status: str = "ok",
    ) -> dict[str, Any]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        message = self._kline_message(normalized_symbol, normalized_interval)
        if message is None:
            return {
                "type": "contract_kline_snapshot",
                "domain": "kline",
                "symbol": normalized_symbol,
                "market_symbol": _market_symbol(normalized_symbol),
                "interval": normalized_interval,
                "ts": _utc_ms(),
                "status": status if status != "ok" else "unavailable",
                "data": None,
                "kline": None,
            }
        return {
            **message,
            "type": "contract_kline_snapshot",
            "status": status,
        }

    def notify_provider_kline_revision(
        self,
        event: ContractProviderKlineRevisionAccepted,
    ) -> None:
        loop = self._kline_event_loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._enqueue_provider_kline_revision, event)

    def _is_current_provider_kline_event(
        self,
        event: ContractProviderKlineRevisionAccepted,
    ) -> bool:
        symbol = normalize_contract_ws_symbol(event.symbol)
        interval = normalize_contract_ws_interval(event.interval)
        with self._state_lock:
            if symbol not in self._provider_ws_allowed_symbols:
                return False
        return get_contract_provider_ws_kline_generation(
            symbol,
            interval,
            provider=event.provider,
        ) == event.generation

    def _enqueue_provider_kline_revision(
        self,
        event: ContractProviderKlineRevisionAccepted,
    ) -> None:
        if not self._is_current_provider_kline_event(event):
            return
        key = (
            normalize_contract_ws_symbol(event.symbol),
            normalize_contract_ws_interval(event.interval),
        )
        current = self._pending_provider_kline_events.get(key)
        if (
            current is not None
            and current.generation == event.generation
            and current.revision >= event.revision
        ):
            return
        self._pending_provider_kline_events[key] = event
        wakeup = self._kline_wakeup_events.get(key[0])
        if wakeup is not None:
            wakeup.set()

    async def _kline_event_worker(self, symbol: str) -> None:
        current_task = asyncio.current_task()
        wakeup = self._kline_wakeup_events[symbol]
        try:
            while True:
                await wakeup.wait()
                wakeup.clear()
                subscribed_intervals = {
                    normalize_contract_ws_interval(item)
                    for item in await contract_market_ws_manager.subscribed_intervals(symbol)
                }
                retry_delay: float | None = None
                for key in sorted(
                    [key for key in self._pending_provider_kline_events if key[0] == symbol]
                ):
                    event = self._pending_provider_kline_events.pop(key)
                    if key[1] not in subscribed_intervals:
                        continue
                    if not self._is_current_provider_kline_event(event):
                        continue
                    remaining = (
                        self._provider_ws_kline_broadcast_interval_seconds()
                        - (time.monotonic() - self._last_kline_broadcast_at.get(key, 0.0))
                    )
                    if remaining > 0:
                        self._pending_provider_kline_events[key] = event
                        retry_delay = remaining if retry_delay is None else min(retry_delay, remaining)
                        continue
                    async with self._kline_refresh_locks.setdefault(
                        symbol,
                        asyncio.Lock(),
                    ):
                        messages = await asyncio.to_thread(
                            self._refresh_provider_ws_klines_once,
                            symbol,
                            [key[1]],
                        )
                        for message in messages:
                            await contract_market_ws_manager.broadcast_to_symbol(symbol, message)
                if any(key[0] == symbol for key in self._pending_provider_kline_events):
                    if retry_delay is not None:
                        await asyncio.sleep(max(0.01, retry_delay + 0.001))
                    wakeup.set()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.warning(
                "contract_market_gateway_kline_event_worker_failed symbol=%s",
                symbol,
                exc_info=True,
            )
        finally:
            async with self._task_lock:
                if self._kline_event_tasks.get(symbol) is current_task:
                    self._kline_event_tasks.pop(symbol, None)

    async def _refresh_loop(self, symbol: str) -> None:
        current_task = asyncio.current_task()
        try:
            while True:
                subscriber_count = await contract_market_ws_manager.subscriber_count(symbol)
                if subscriber_count <= 0:
                    logger.info(
                        "contract_market_gateway_refresh_loop_no_subscribers symbol=%s",
                        symbol,
                    )
                    break
                with self._state_lock:
                    self._provider_ws_allowed_symbols.add(symbol)
                market_subscriber_count = await contract_market_ws_manager.market_subscriber_count(symbol)
                intervals = await contract_market_ws_manager.subscribed_intervals(symbol)
                now = time.monotonic()
                last_full_refresh_at = self._last_full_refresh_at.get(symbol, 0.0)
                should_refresh_all = now - last_full_refresh_at >= CONTRACT_MARKET_WS_QUOTE_INTERVAL_SECONDS
                if intervals:
                    async with self._kline_refresh_locks.setdefault(
                        symbol,
                        asyncio.Lock(),
                    ):
                        await self._refresh_and_broadcast_cycle(
                            symbol,
                            intervals,
                            market_subscriber_count=market_subscriber_count,
                            should_refresh_all=should_refresh_all,
                        )
                else:
                    await self._refresh_and_broadcast_cycle(
                        symbol,
                        intervals,
                        market_subscriber_count=market_subscriber_count,
                        should_refresh_all=should_refresh_all,
                    )

                if should_refresh_all:
                    self._last_full_refresh_at[symbol] = now

                await asyncio.sleep(self._refresh_loop_sleep_seconds())
        except asyncio.CancelledError:
            raise
        finally:
            async with self._task_lock:
                task = self._tasks.get(symbol)
                if task is current_task:
                    self._tasks.pop(symbol, None)
            subscriber_count = await contract_market_ws_manager.subscriber_count(symbol)
            if subscriber_count <= 0:
                # broadcast_to_symbol can discover dead sockets and remove the
                # last subscriber without going through release_symbol_if_idle.
                logger.info(
                    "contract_market_gateway_refresh_loop_stop_provider_ws symbol=%s subscriber_count=%s",
                    symbol,
                    subscriber_count,
                )
                with self._state_lock:
                    self._provider_ws_allowed_symbols.discard(symbol)
                async with self._task_lock:
                    event_task = self._kline_event_tasks.pop(symbol, None)
                    if event_task is not None and not event_task.done():
                        event_task.cancel()
                self._kline_wakeup_events.pop(symbol, None)
                self._kline_refresh_locks.pop(symbol, None)
                for key in [
                    key for key in self._pending_provider_kline_events if key[0] == symbol
                ]:
                    self._pending_provider_kline_events.pop(key, None)
                self._candle_preview_engine.clear_symbol(symbol)
                stop_report = force_stop_provider_ws_subscriptions_for_symbol(symbol)
                logger.info(
                    "contract_market_gateway_refresh_loop_provider_stop_report symbol=%s report=%s",
                    symbol,
                    stop_report,
                )
                self._snapshot_authority.clear_symbol(symbol)
            else:
                logger.info(
                    "contract_market_gateway_refresh_loop_keep_provider_ws symbol=%s subscriber_count=%s",
                    symbol,
                    subscriber_count,
                )
            self._last_full_refresh_at.pop(symbol, None)
            self._last_depth_broadcast_at.pop(symbol, None)
            self._last_depth_signature.pop(symbol, None)
            for key in [key for key in self._last_kline_signature if key[0] == symbol]:
                self._last_kline_signature.pop(key, None)
            for key in [key for key in self._last_kline_broadcast_at if key[0] == symbol]:
                self._last_kline_broadcast_at.pop(key, None)
            for key in [key for key in self._last_kline_rest_fallback_at if key[0] == symbol]:
                self._last_kline_rest_fallback_at.pop(key, None)
            self._last_state_signature.pop(symbol, None)
            for key in [key for key in self._kline_locks if key[0] == symbol]:
                self._kline_locks.pop(key, None)
            self._last_quote_signature.pop(symbol, None)
            self._last_trade_ids.pop(symbol, None)

    async def _refresh_and_broadcast_cycle(
        self,
        symbol: str,
        intervals: list[str],
        *,
        market_subscriber_count: int,
        should_refresh_all: bool,
    ) -> None:
        # Establish and publish the provider Kline baseline before any ticker or
        # trade from this cycle can advance visible market price. This ordering
        # is capability-based (provider + interval), so every listed symbol
        # receives the same settlement contract.
        kline_messages: list[dict[str, Any]] = []
        if intervals:
            try:
                if should_refresh_all:
                    kline_messages.extend(await asyncio.to_thread(
                        self._refresh_klines_once,
                        symbol,
                        intervals,
                        True,
                    ))
                kline_messages.extend(await asyncio.to_thread(
                    self._refresh_provider_ws_klines_once,
                    symbol,
                    intervals,
                ))
            except (ContractSymbolNotFound, ContractMarketError):
                logger.debug(
                    "contract_market_gateway_kline_refresh_unavailable symbol=%s intervals=%s",
                    symbol,
                    intervals,
                    exc_info=True,
                )
            except Exception:
                logger.warning(
                    "contract_market_gateway_kline_refresh_failed symbol=%s intervals=%s",
                    symbol,
                    intervals,
                    exc_info=True,
                )

        for message in kline_messages:
            await contract_market_ws_manager.broadcast_to_symbol(symbol, message)

        market_messages: list[dict[str, Any]] = []
        if market_subscriber_count > 0:
            try:
                if should_refresh_all:
                    market_messages = await asyncio.to_thread(
                        self._refresh_market_once,
                        symbol,
                        True,
                        intervals,
                    )
                else:
                    market_messages = await asyncio.to_thread(
                        self._refresh_provider_ws_market_once,
                        symbol,
                        intervals,
                    )
            except (ContractSymbolNotFound, ContractMarketError):
                logger.debug(
                    "contract_market_gateway_market_refresh_unavailable symbol=%s",
                    symbol,
                    exc_info=True,
                )
                market_messages = [self._status_message(symbol, "unavailable")]
            except Exception:
                logger.warning(
                    "contract_market_gateway_market_refresh_failed symbol=%s",
                    symbol,
                    exc_info=True,
                )
                market_messages = [self._status_message(symbol, "error")]

        for message in market_messages:
            await contract_market_ws_manager.broadcast_to_symbol(symbol, message)

    def _refresh_symbol_once(
        self,
        symbol: str,
        intervals: list[str],
        ensure_provider_ws: bool = False,
    ) -> list[dict[str, Any]]:
        messages = self._refresh_market_once(
            symbol,
            ensure_provider_ws=ensure_provider_ws,
            intervals=intervals,
        )
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        for interval in sorted({normalize_contract_ws_interval(item) for item in intervals} or {"1m"}):
            kline = self._refresh_kline_once(
                normalized_symbol,
                interval,
                ensure_provider_ws=ensure_provider_ws,
            )
            if isinstance(kline, dict):
                message = self._kline_message(normalized_symbol, interval)
                if message is not None:
                    messages.append(message)
        return messages

    def _refresh_market_once(
        self,
        symbol: str,
        ensure_provider_ws: bool = False,
        intervals: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if ensure_provider_ws:
            with self._state_lock:
                ensure_provider_ws = normalized_symbol in self._provider_ws_allowed_symbols
        lock = self._locks.setdefault(normalized_symbol, threading.Lock())
        if not lock.acquire(blocking=False):
            return []
        try:
            # This function runs in a worker thread; use a thread-local DB session
            # and the in-memory latest state as the gateway handoff.
            db = SessionLocal()
            try:
                return self._load_market_state(
                    db,
                    normalized_symbol,
                    ensure_provider_ws=ensure_provider_ws,
                    intervals=intervals or [],
                )
            finally:
                db.close()
        finally:
            lock.release()

    def _refresh_kline_once(
        self,
        symbol: str,
        interval: str,
        ensure_provider_ws: bool = False,
    ) -> dict[str, Any] | None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        if ensure_provider_ws:
            with self._state_lock:
                ensure_provider_ws = normalized_symbol in self._provider_ws_allowed_symbols
        lock = self._kline_locks.setdefault((normalized_symbol, normalized_interval), threading.Lock())
        if not lock.acquire(blocking=False):
            return None
        try:
            db = SessionLocal()
            try:
                latest_row = self._load_kline_payload(
                    db,
                    interval=normalized_interval,
                    symbol=normalized_symbol,
                    allow_provider_ws=True,
                    allow_rest_fallback=False,
                    ensure_provider_ws=ensure_provider_ws,
                )
                if isinstance(latest_row, dict):
                    self._last_kline_rest_fallback_at.pop(
                        (normalized_symbol, normalized_interval),
                        None,
                    )
                elif self._should_refresh_kline_rest_fallback(
                    normalized_symbol,
                    normalized_interval,
                ):
                    self._last_kline_rest_fallback_at[(normalized_symbol, normalized_interval)] = time.monotonic()
                    latest_row = self._load_kline_payload(
                        db,
                        interval=normalized_interval,
                        symbol=normalized_symbol,
                        allow_provider_ws=False,
                        allow_rest_fallback=True,
                        ensure_provider_ws=False,
                    )
            finally:
                db.close()
            if not isinstance(latest_row, dict):
                return None
            kline = _normalize_kline(latest_row, source=latest_row.get("source"))
            key = (normalized_symbol, normalized_interval)
            signature = self._kline_signature(kline)
            duplicate = self._last_kline_signature.get(key) == signature
            accepted = self._set_latest(
                CONTRACT_MARKET_CACHE_KLINE,
                normalized_symbol,
                kline,
                interval=normalized_interval,
                authority_payload=latest_row,
            )
            if not accepted:
                return None
            self._accept_candle_preview_native(
                normalized_symbol,
                normalized_interval,
                {**latest_row, **kline},
            )
            if duplicate:
                return None
            self._last_kline_signature[key] = signature
            self._last_kline_broadcast_at[key] = time.monotonic()
            return kline
        finally:
            lock.release()

    def _refresh_klines_once(
        self,
        symbol: str,
        intervals: list[str],
        ensure_provider_ws: bool = False,
    ) -> list[dict[str, Any]]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        messages: list[dict[str, Any]] = []
        for interval in sorted({normalize_contract_ws_interval(item) for item in intervals}):
            kline = self._refresh_kline_once(
                normalized_symbol,
                interval,
                ensure_provider_ws=ensure_provider_ws,
            )
            if isinstance(kline, dict):
                message = self._kline_message(normalized_symbol, interval)
                if message is not None:
                    messages.append(message)
        return messages

    def _load_market_state(
        self,
        db: Session,
        symbol: str,
        *,
        ensure_provider_ws: bool,
        intervals: list[str],
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        contract_symbol = _load_contract_symbol(db, symbol)

        quote_payload = self._load_quote_payload(
            db,
            symbol,
            allow_provider_ws=True,
            ensure_provider_ws=ensure_provider_ws,
        )
        quote = ContractQuoteResponse(**contract_quote_to_response(quote_payload)).model_dump()
        if self._set_latest(
            CONTRACT_MARKET_CACHE_QUOTE,
            symbol,
            quote,
            authority_payload=quote_payload,
        ):
            self._remember_quote_signature(symbol, quote)
            messages.append(self._quote_message(symbol, quote))

        depth_payload = self._load_depth_payload(
            db,
            symbol,
            allow_provider_ws=True,
            ensure_provider_ws=ensure_provider_ws,
        )
        depth = ContractDepthResponse(**contract_depth_to_response(depth_payload)).model_dump()
        if self._set_latest(
            CONTRACT_MARKET_CACHE_DEPTH,
            symbol,
            depth,
            authority_payload=depth_payload,
        ):
            self._remember_depth_signature(symbol, depth)
            messages.append(self._depth_message(symbol, depth))

        try:
            trades, trades_authority = self._load_trades_payload(
                db,
                symbol,
                allow_provider_ws=True,
                ensure_provider_ws=ensure_provider_ws,
            )
        except ContractMarketError:
            logger.debug(
                "contract_market_gateway_trades_refresh_unavailable symbol=%s",
                symbol,
                exc_info=True,
            )
        except Exception:
            logger.warning(
                "contract_market_gateway_trades_refresh_failed symbol=%s",
                symbol,
                exc_info=True,
            )
        else:
            new_trades = self._filter_new_trades(symbol, trades)
            trades_accepted = self._set_latest(
                CONTRACT_MARKET_CACHE_TRADES,
                symbol,
                trades,
                authority_payload=trades_authority,
            )
            if trades and trades_accepted:
                self._remember_trade_ids(symbol, trades)
                if new_trades:
                    messages.extend(self._trade_preview_settlement_messages(
                        symbol,
                        intervals,
                        new_trades,
                        trades_authority,
                    ))

        state_message = self._state_message_from_latest(
            symbol,
            contract_symbol=contract_symbol,
            force=True,
        )
        if state_message is not None:
            messages.append(state_message)

        return messages

    def _refresh_provider_ws_once(self, symbol: str, intervals: list[str] | None = None) -> list[dict[str, Any]]:
        messages = self._refresh_provider_ws_market_once(symbol, intervals)
        messages.extend(self._refresh_provider_ws_klines_once(symbol, intervals or []))
        return messages

    def _refresh_provider_ws_market_once(
        self,
        symbol: str,
        intervals: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        messages.extend(self._refresh_provider_ws_depth_once(symbol))
        messages.extend(self._refresh_provider_ws_ticker_once(symbol))
        messages.extend(self._refresh_provider_ws_trades_once(symbol, intervals))
        messages.extend(self._state_messages_from_latest(symbol, []))
        return messages

    def _latest_trade_tick_from_cache(self, symbol: str) -> dict[str, Any] | None:
        trades = self._get_latest(CONTRACT_MARKET_CACHE_TRADES, symbol) or []
        if not isinstance(trades, list):
            return None
        for item in trades:
            if not isinstance(item, dict):
                continue
            if str(item.get("price_source") or "").strip().upper() == "TRADE_TICK":
                return item
        return None

    def _build_market_state_from_latest(
        self,
        symbol: str,
        *,
        contract_symbol: Any = None,
    ) -> dict[str, Any] | None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        quote = self._get_latest(CONTRACT_MARKET_CACHE_QUOTE, normalized_symbol)
        depth = self._get_latest(CONTRACT_MARKET_CACHE_DEPTH, normalized_symbol)
        if not isinstance(quote, dict) and not isinstance(depth, dict):
            return None
        view = build_contract_market_view(
            normalized_symbol,
            quote=quote if isinstance(quote, dict) else None,
            depth=depth if isinstance(depth, dict) else None,
            latest_kline=None,
            latest_trade=self._latest_trade_tick_from_cache(normalized_symbol),
            contract_symbol=contract_symbol,
        )
        state = ContractMarketViewDetail(**view).model_dump()
        state.pop("kline_current_candle", None)
        return state

    def _state_message_from_latest(
        self,
        symbol: str,
        *,
        contract_symbol: Any = None,
        force: bool = False,
    ) -> dict[str, Any] | None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        state = self._build_market_state_from_latest(
            normalized_symbol,
            contract_symbol=contract_symbol,
        )
        if state is None:
            return None
        signature = self._state_signature(state)
        if not force and self._last_state_signature.get(normalized_symbol) == signature:
            return None
        self._set_latest(CONTRACT_MARKET_CACHE_STATE, normalized_symbol, state)
        self._last_state_signature[normalized_symbol] = signature
        return self._state_message(normalized_symbol, state)

    def _state_messages_from_latest(self, symbol: str, _intervals: list[str]) -> list[dict[str, Any]]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return []
        db = SessionLocal()
        try:
            try:
                contract_symbol = _load_contract_symbol(db, normalized_symbol)
            except Exception:
                contract_symbol = None
        finally:
            db.close()
        message = self._state_message_from_latest(
            normalized_symbol,
            contract_symbol=contract_symbol,
        )
        return [message] if message is not None else []

    def _refresh_provider_ws_ticker_once(self, symbol: str) -> list[dict[str, Any]]:
        if not provider_ws_ticker_enabled():
            return []
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        with self._state_lock:
            ensure_provider_ws = normalized_symbol in self._provider_ws_allowed_symbols
        if not ensure_provider_ws:
            return []
        db = SessionLocal()
        try:
            quote_payload = self._load_quote_payload(
                db,
                normalized_symbol,
                allow_provider_ws=True,
                allow_rest_fallback=False,
                ensure_provider_ws=True,
            )
        finally:
            db.close()
        if quote_payload is None:
            return []
        quote = ContractQuoteResponse(**contract_quote_to_response(quote_payload)).model_dump()
        signature = self._quote_signature(quote)
        if self._last_quote_signature.get(normalized_symbol) == signature:
            return []
        if not self._set_latest(
            CONTRACT_MARKET_CACHE_QUOTE,
            normalized_symbol,
            quote,
            authority_payload=quote_payload,
        ):
            return []
        self._last_quote_signature[normalized_symbol] = signature
        return [self._quote_message(normalized_symbol, quote)]

    def _refresh_provider_ws_depth_once(self, symbol: str) -> list[dict[str, Any]]:
        if not provider_ws_depth_enabled():
            return []
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        min_interval_seconds = self._provider_ws_depth_broadcast_interval_seconds()
        last_broadcast_at = self._last_depth_broadcast_at.get(normalized_symbol, 0.0)
        if time.monotonic() - last_broadcast_at < min_interval_seconds:
            return []
        db = SessionLocal()
        try:
            depth_payload = self._load_depth_payload(
                db,
                normalized_symbol,
                allow_provider_ws=True,
                allow_rest_fallback=False,
            )
        finally:
            db.close()
        if depth_payload is None:
            return []
        depth = ContractDepthResponse(**contract_depth_to_response(depth_payload)).model_dump()
        signature = self._depth_signature(depth)
        if self._last_depth_signature.get(normalized_symbol) == signature:
            return []
        if not self._set_latest(
            CONTRACT_MARKET_CACHE_DEPTH,
            normalized_symbol,
            depth,
            authority_payload=depth_payload,
        ):
            return []
        self._last_depth_signature[normalized_symbol] = signature
        self._last_depth_broadcast_at[normalized_symbol] = time.monotonic()
        return [self._depth_message(normalized_symbol, depth)]

    def _refresh_provider_ws_trades_once(
        self,
        symbol: str,
        intervals: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        if not provider_ws_trades_enabled():
            return []
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        db = SessionLocal()
        try:
            try:
                trades, trades_authority = self._load_trades_payload(
                    db,
                    normalized_symbol,
                    allow_provider_ws=True,
                    allow_rest_fallback=False,
                )
            except Exception:
                logger.debug(
                    "contract_market_gateway_provider_ws_trades_unavailable symbol=%s",
                    normalized_symbol,
                    exc_info=True,
                )
                return []
        finally:
            db.close()
        if not trades:
            return []
        new_trades = self._filter_new_trades(normalized_symbol, trades)
        if not new_trades:
            return []
        if not self._set_latest(
            CONTRACT_MARKET_CACHE_TRADES,
            normalized_symbol,
            trades,
            authority_payload=trades_authority,
        ):
            return []
        self._remember_trade_ids(normalized_symbol, trades)
        return self._trade_preview_settlement_messages(
            normalized_symbol,
            intervals or [],
            new_trades,
            trades_authority,
        )

    def _trade_preview_settlement_messages(
        self,
        symbol: str,
        intervals: list[str],
        trades: list[dict[str, Any]],
        authority_payload: Any,
    ) -> list[dict[str, Any]]:
        preview_messages = self._candle_preview_messages(
            symbol,
            intervals,
            trades,
            authority_payload,
        )
        settlement_trade_id = (
            preview_messages[-1].get("settlement_trade_id")
            if preview_messages
            else None
        )
        trade_message = self._trades_message(
            symbol,
            trades,
            preferred_trade_id=settlement_trade_id,
        )
        if preview_messages:
            # Keep the legacy top-level preview frames for kline-only clients,
            # while embedding the same evidence in the trade frame so market
            # and TradingView consumers can settle before the next paint.
            trade_message["candle_previews"] = preview_messages
            trade_message["settlement_revision"] = preview_messages[-1].get(
                "settlement_revision"
            )
        return [trade_message, *preview_messages]

    def _candle_preview_messages(
        self,
        symbol: str,
        intervals: list[str],
        trades: list[dict[str, Any]],
        authority_payload: Any,
    ) -> list[dict[str, Any]]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        active_intervals = sorted(
            {
                normalize_contract_ws_interval(item)
                for item in intervals
                if normalize_contract_ws_interval(item)
                in SUPPORTED_CONTRACT_CANDLE_PREVIEW_INTERVALS
            }
        )
        if not active_intervals:
            return []
        authority = _authority_mapping(authority_payload)
        provider = str(authority.get("provider") or "").strip().upper()
        if provider != "OKX_SWAP":
            return []

        ordered_trades = sorted(
            (item for item in trades if isinstance(item, dict)),
            key=lambda item: _trade_event_time_ms(item) or 0,
        )
        accepted_by_interval: dict[
            str,
            tuple[ContractCandlePreview, int, str, str],
        ] = {}
        for interval in active_intervals:
            try:
                generation = int(
                    get_contract_provider_ws_kline_generation(
                        normalized_symbol,
                        interval,
                        provider=provider,
                    )
                    or 0
                )
            except Exception:
                logger.warning(
                    "contract_candle_preview_generation_read_failed "
                    "provider=%s symbol=%s interval=%s",
                    provider,
                    normalized_symbol,
                    interval,
                    exc_info=True,
                )
                continue
            if generation <= 0:
                continue
            for trade in ordered_trades:
                event_time_ms = _trade_event_time_ms(trade)
                if event_time_ms is None:
                    continue
                trade_provider = str(
                    trade.get("provider") or provider
                ).strip().upper()
                if trade_provider != provider:
                    continue
                try:
                    result = self._candle_preview_engine.accept_trade(
                        {
                            "symbol": normalized_symbol,
                            "interval": interval,
                            "provider": trade_provider,
                            "provider_trade_id": trade.get("id") or trade.get("trade_id"),
                            "price": trade.get("price") or trade.get("last_price"),
                            "size": (
                                trade.get("qty")
                                or trade.get("amount")
                                or trade.get("quantity")
                            ),
                            "event_time_ms": event_time_ms,
                            "generation": generation,
                        }
                    )
                except (TypeError, ValueError):
                    continue
                if result.status is ContractPreviewTradeStatus.APPLIED and result.preview is not None:
                    received_at_ms = int(
                        authority.get("received_at_ms")
                        or _utc_ms()
                    )
                    accepted_by_interval[interval] = (
                        result.preview,
                        received_at_ms,
                        result.trade.provider_trade_id,
                        format(result.trade.price, "f"),
                    )
        return [
            self._candle_preview_message(
                preview,
                received_at_ms=received_at_ms,
                settlement_trade_id=settlement_trade_id,
                settlement_trade_price=settlement_trade_price,
            )
            for _, (
                preview,
                received_at_ms,
                settlement_trade_id,
                settlement_trade_price,
            ) in sorted(accepted_by_interval.items())
        ]

    @staticmethod
    def _candle_preview_message(
        preview: ContractCandlePreview,
        *,
        received_at_ms: int,
        settlement_trade_id: str,
        settlement_trade_price: str,
    ) -> dict[str, Any]:
        trade_seeded_rollover = preview.baseline_source == "TRADE_ROLLOVER"
        settlement_revision = (
            f"contract:{preview.symbol}:{preview.interval}:"
            f"{preview.generation}:{preview.open_time}:"
            f"{preview.revision_epoch}:{preview.revision_sequence}:"
            f"{preview.preview_sequence}"
        )
        preview_payload = {
            "symbol": preview.symbol,
            "interval": preview.interval,
            "provider": preview.provider,
            "open_time": preview.open_time,
            "open_time_ms": preview.open_time,
            "time": int(preview.open_time / 1000),
            "open": format(preview.open, "f"),
            "high": format(preview.high, "f"),
            "low": format(preview.low, "f"),
            "close": format(preview.close, "f"),
            "volume": format(preview.volume, "f"),
            "quote_volume": (
                format(preview.quote_volume, "f")
                if preview.quote_volume is not None
                else None
            ),
            "source": "TRADE_PREVIEW",
            "freshness": "LIVE",
            "transport": "PROVIDER_WS",
            "kline_mode": (
                "TRADE_SEEDED_ROLLOVER_PREVIEW"
                if trade_seeded_rollover
                else "NATIVE_BASELINED_TRADE_PREVIEW"
            ),
            "price_source": "TRADE_TICK",
            "baseline_source": preview.baseline_source,
            "baseline_anchor_open_time": preview.baseline_anchor_open_time,
            "provider_generation": preview.generation,
            "revision_epoch": preview.revision_epoch,
            "revision_sequence": preview.revision_sequence,
            "preview_sequence": preview.preview_sequence,
            "applied_trade_count": preview.applied_trade_count,
            "settlement_trade_id": settlement_trade_id,
            "settlement_trade_price": settlement_trade_price,
            "received_at_ms": received_at_ms,
            "is_closed": False,
            "is_final": False,
        }
        return {
            "type": "contract_candle_preview_update",
            "domain": "kline",
            "symbol": preview.symbol,
            "market_symbol": _market_symbol(preview.symbol),
            "interval": preview.interval,
            "provider": preview.provider,
            "source": "TRADE_PREVIEW",
            "freshness": "LIVE",
            "baseline_source": preview.baseline_source,
            "baseline_anchor_open_time": preview.baseline_anchor_open_time,
            "provider_generation": preview.generation,
            "received_at_ms": received_at_ms,
            "preview_sequence": preview.preview_sequence,
            "base_native_revision": {
                "epoch": preview.revision_epoch,
                "sequence": preview.revision_sequence,
            },
            "settlement_revision": settlement_revision,
            "settlement_trade_id": settlement_trade_id,
            "settlement_trade_price": settlement_trade_price,
            "preview": preview_payload,
            "data": preview_payload,
        }

    def _accept_candle_preview_native(
        self,
        symbol: str,
        interval: str,
        payload: dict[str, Any],
    ) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        if normalized_interval not in SUPPORTED_CONTRACT_CANDLE_PREVIEW_INTERVALS:
            return
        provider = str(payload.get("provider") or "").strip().upper()
        generation = int(payload.get("provider_generation") or 0)
        if provider != "OKX_SWAP" or generation <= 0:
            return
        closed_value = payload.get("is_closed")
        is_closed = (
            closed_value is True
            or closed_value == 1
            or str(closed_value or "").strip().lower() in {"1", "true", "closed"}
        )
        try:
            self._candle_preview_engine.accept_native_revision(
                {
                    "symbol": normalized_symbol,
                    "interval": normalized_interval,
                    "provider": provider,
                    "open_time": payload.get("open_time") or payload.get("open_time_ms"),
                    "open": payload.get("open"),
                    "high": payload.get("high"),
                    "low": payload.get("low"),
                    "close": payload.get("close"),
                    "volume": payload.get("volume"),
                    "quote_volume": payload.get("quote_volume"),
                    "revision_epoch": payload.get("revision_epoch"),
                    "revision_sequence": (
                        payload.get("revision_sequence") or payload.get("revision_seq")
                    ),
                    "generation": generation,
                    "is_closed": is_closed,
                }
            )
        except (TypeError, ValueError):
            logger.debug(
                "contract_candle_preview_native_rejected provider=%s symbol=%s interval=%s",
                provider,
                normalized_symbol,
                normalized_interval,
                exc_info=True,
            )

    def _refresh_provider_ws_klines_once(self, symbol: str, intervals: list[str]) -> list[dict[str, Any]]:
        if not provider_ws_kline_enabled():
            return []
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        with self._state_lock:
            ensure_provider_ws = normalized_symbol in self._provider_ws_allowed_symbols
        if not ensure_provider_ws:
            return []
        messages: list[dict[str, Any]] = []
        db = SessionLocal()
        try:
            normalized_intervals = sorted({normalize_contract_ws_interval(item) for item in intervals} or {"1m"})
            for interval in normalized_intervals:
                key = (normalized_symbol, interval)
                last_broadcast_at = self._last_kline_broadcast_at.get(key, 0.0)
                if time.monotonic() - last_broadcast_at < self._provider_ws_kline_broadcast_interval_seconds():
                    continue
                payload = self._load_kline_payload(
                    db,
                    normalized_symbol,
                    interval=interval,
                    allow_provider_ws=True,
                    allow_rest_fallback=False,
                    ensure_provider_ws=True,
                )
                if not isinstance(payload, dict):
                    continue
                kline = _normalize_kline(payload, source=payload.get("source") or "LIVE_WS")
                signature = self._kline_signature(kline)
                if self._last_kline_signature.get(key) == signature:
                    continue
                if not self._set_latest(
                    CONTRACT_MARKET_CACHE_KLINE,
                    normalized_symbol,
                    kline,
                    interval=interval,
                    authority_payload=payload,
                ):
                    continue
                self._accept_candle_preview_native(
                    normalized_symbol,
                    interval,
                    {**payload, **kline},
                )
                self._last_kline_signature[key] = signature
                self._last_kline_broadcast_at[key] = time.monotonic()
                message = self._kline_message(normalized_symbol, interval)
                if message is not None:
                    messages.append(message)
        finally:
            db.close()
        return messages

    def _load_kline_payload(
        self,
        db: Session,
        symbol: str,
        *,
        interval: str,
        allow_provider_ws: bool,
        allow_rest_fallback: bool = True,
        ensure_provider_ws: bool = False,
    ) -> dict[str, Any] | None:
        normalized_interval = normalize_contract_ws_interval(interval)
        if allow_provider_ws and provider_ws_kline_enabled():
            payload = select_fresh_provider_ws_kline(
                db,
                symbol,
                normalized_interval,
                ensure_subscription=ensure_provider_ws,
            )
            if isinstance(payload, dict):
                return payload
        if not allow_rest_fallback:
            return None
        rows = get_contract_klines(
            db,
            symbol=symbol,
            interval=normalized_interval,
            limit=CONTRACT_MARKET_WS_KLINE_LIMIT,
        )
        if bool(getattr(rows, "history_incomplete", False)):
            return None
        latest_row = rows[-1] if rows else None
        if not isinstance(latest_row, dict):
            return None
        result_origin = str(getattr(rows, "origin", "") or "").strip().upper()
        source = {
            "DB_CACHE": "DB_CACHE",
            "PROCESS_CACHE": "PROCESS_CACHE",
            "STALE_CACHE": "STALE_CACHE",
        }.get(result_origin, "PROVIDER_REST")
        contract_symbol = None
        try:
            contract_symbol = _load_contract_symbol(db, symbol)
        except Exception:
            pass
        received_at_ms = latest_row.get("received_at_ms")
        if received_at_ms in (None, "") and source == "PROVIDER_REST":
            received_at_ms = _utc_ms()
        return {
            **latest_row,
            "source": source,
            "provider": latest_row.get("provider") or getattr(contract_symbol, "provider", None),
            "provider_symbol": (
                latest_row.get("provider_symbol")
                or getattr(contract_symbol, "provider_symbol", None)
            ),
            "fallback_reason": ContractMarketDomainFallbackReason.WS_MISS.value,
            "received_at_ms": received_at_ms,
        }

    def _load_depth_payload(
        self,
        db: Session,
        symbol: str,
        *,
        allow_provider_ws: bool,
        allow_rest_fallback: bool = True,
        ensure_provider_ws: bool = False,
    ) -> dict[str, Any] | None:
        if allow_provider_ws and provider_ws_depth_enabled():
            depth = select_fresh_provider_ws_depth(
                db,
                symbol,
                max_age_ms=int(getattr(settings, "CONTRACT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500) or 1500),
                ensure_subscription=ensure_provider_ws,
            )
            if depth is not None:
                prepared_depth = self._prepare_provider_ws_depth_payload(db, symbol, depth)
                if prepared_depth is not None:
                    return prepared_depth
        if not allow_rest_fallback:
            return None
        return get_contract_depth(db, symbol, limit=CONTRACT_MARKET_WS_DEPTH_LIMIT)

    def _load_quote_payload(
        self,
        db: Session,
        symbol: str,
        *,
        allow_provider_ws: bool,
        allow_rest_fallback: bool = True,
        ensure_provider_ws: bool = False,
    ) -> dict[str, Any] | None:
        if allow_provider_ws and provider_ws_ticker_enabled():
            payload = select_fresh_provider_ws_ticker(
                db,
                symbol,
                max_age_ms=int(getattr(settings, "CONTRACT_PROVIDER_WS_TICKER_MAX_AGE_MS", 1500) or 1500),
                ensure_subscription=ensure_provider_ws,
            )
            if isinstance(payload, dict):
                prepared_quote = self._prepare_provider_ws_quote_payload(db, symbol, payload)
                if prepared_quote is not None:
                    return prepared_quote
        if not allow_rest_fallback:
            return None
        return get_contract_quote(db, symbol)

    def _prepare_provider_ws_quote_payload(
        self,
        db: Session,
        symbol: str,
        quote: dict[str, Any],
    ) -> dict[str, Any] | None:
        try:
            prepared = deepcopy(quote)
            if not prepared.get("bid_price") or not prepared.get("ask_price"):
                return None
            contract_symbol = _load_contract_symbol(db, symbol)
            market_status = _market_status_for_contract_symbol(contract_symbol)
            prepared["symbol"] = normalize_contract_ws_symbol(prepared.get("symbol") or symbol)
            prepared["price_precision"] = int(
                getattr(contract_symbol, "price_precision", None) or prepared.get("price_precision") or 8
            )
            return _contract_quote_with_status(prepared, market_status, contract_symbol)
        except Exception:
            logger.debug(
                "contract_market_gateway_provider_ws_quote_prepare_failed symbol=%s",
                symbol,
                exc_info=True,
            )
            return None

    def _prepare_provider_ws_depth_payload(
        self,
        db: Session,
        symbol: str,
        depth: dict[str, Any],
    ) -> dict[str, Any] | None:
        try:
            prepared = deepcopy(depth)
            if not prepared.get("bids") or not prepared.get("asks"):
                return None
            contract_symbol = _load_contract_symbol(db, symbol)
            market_status = _market_status_for_contract_symbol(contract_symbol)
            prepared["symbol"] = normalize_contract_ws_symbol(prepared.get("symbol") or symbol)
            prepared["price_precision"] = int(
                getattr(contract_symbol, "price_precision", None) or prepared.get("price_precision") or 8
            )
            if prepared.get("raw_bids") is None:
                prepared["raw_bids"] = deepcopy(prepared.get("bids") or [])
            if prepared.get("raw_asks") is None:
                prepared["raw_asks"] = deepcopy(prepared.get("asks") or [])
            if prepared.get("raw_best_bid") is None:
                prepared["raw_best_bid"] = prepared.get("best_bid")
            if prepared.get("raw_best_ask") is None:
                prepared["raw_best_ask"] = prepared.get("best_ask")
            return _contract_depth_with_status(prepared, market_status, contract_symbol)
        except Exception:
            logger.debug(
                "contract_market_gateway_provider_ws_depth_prepare_failed symbol=%s",
                symbol,
                exc_info=True,
            )
            return None

    def _load_trades_payload(
        self,
        db: Session,
        symbol: str,
        *,
        allow_provider_ws: bool,
        allow_rest_fallback: bool = True,
        ensure_provider_ws: bool = False,
    ) -> tuple[list[dict[str, Any]], Any]:
        if allow_provider_ws and provider_ws_trades_enabled():
            payload = select_fresh_provider_ws_trades(
                db,
                symbol,
                max_age_ms=int(getattr(settings, "CONTRACT_PROVIDER_WS_TRADES_MAX_AGE_MS", 1500) or 1500),
                ensure_subscription=ensure_provider_ws,
            )
            if isinstance(payload, dict):
                trades = _truthful_contract_trades(
                    payload.get("trades") or [],
                    symbol=symbol,
                    evidence=payload,
                )
                if trades:
                    return trades[:CONTRACT_MARKET_WS_TRADES_LIMIT], payload
        if not allow_rest_fallback:
            return [], None
        trades = _truthful_contract_trades(
            get_contract_recent_trades(db, symbol=symbol, limit=CONTRACT_MARKET_WS_TRADES_LIMIT),
            symbol=symbol,
        )
        return trades, trades

    def _refresh_loop_sleep_seconds(self) -> float:
        if (
            provider_ws_depth_enabled()
            or provider_ws_trades_enabled()
            or provider_ws_ticker_enabled()
            or provider_ws_kline_enabled()
        ):
            return self._provider_ws_depth_broadcast_interval_seconds()
        return CONTRACT_MARKET_WS_DEPTH_FALLBACK_SLEEP_SECONDS

    def _provider_ws_depth_broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "CONTRACT_PROVIDER_WS_DEPTH_BROADCAST_INTERVAL_MS", 200) or 200)
        return max(0.1, min(interval_ms / 1000, 0.3))

    def _provider_ws_kline_broadcast_interval_seconds(self) -> float:
        interval_ms = int(getattr(settings, "CONTRACT_PROVIDER_WS_ITICK_KLINE_BROADCAST_INTERVAL_MS", 1000) or 1000)
        return max(
            0.1,
            min(interval_ms, CONTRACT_MARKET_WS_KLINE_BROADCAST_INTERVAL_MAX_MS) / 1000,
        )

    def _should_refresh_kline_rest_fallback(
        self,
        symbol: str,
        interval: str,
        *,
        now: float | None = None,
    ) -> bool:
        key = (
            normalize_contract_ws_symbol(symbol),
            normalize_contract_ws_interval(interval),
        )
        current = time.monotonic() if now is None else float(now)
        last_refresh = self._last_kline_rest_fallback_at.get(key)
        return (
            last_refresh is None
            or current - last_refresh >= CONTRACT_MARKET_WS_KLINE_REST_FALLBACK_INTERVAL_SECONDS
        )

    def _remember_depth_signature(self, symbol: str, depth: dict[str, Any]) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        self._last_depth_signature[normalized_symbol] = self._depth_signature(depth)
        self._last_depth_broadcast_at[normalized_symbol] = time.monotonic()

    def _remember_quote_signature(self, symbol: str, quote: dict[str, Any]) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        self._last_quote_signature[normalized_symbol] = self._quote_signature(quote)

    def _remember_kline_signature(self, symbol: str, interval: str, kline: dict[str, Any]) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        self._last_kline_signature[(normalized_symbol, normalized_interval)] = self._kline_signature(kline)
        self._last_kline_broadcast_at[(normalized_symbol, normalized_interval)] = time.monotonic()

    def _remember_trade_ids(self, symbol: str, trades: list[dict[str, Any]]) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        seen = self._last_trade_ids.setdefault(normalized_symbol, OrderedDict())
        for item in trades:
            trade_id = str(item.get("id") or "")
            if not trade_id:
                continue
            seen[trade_id] = None
            seen.move_to_end(trade_id)
        while len(seen) > CONTRACT_MARKET_WS_TRADE_DEDUPE_MAX_IDS:
            seen.popitem(last=False)
        if not seen:
            self._last_trade_ids.pop(normalized_symbol, None)

    def _filter_new_trades(self, symbol: str, trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        seen = self._last_trade_ids.get(normalized_symbol) or {}
        batch_seen: set[str] = set()
        fresh: list[dict[str, Any]] = []
        for item in trades:
            trade_id = str(item.get("id") or "")
            if not trade_id or trade_id in seen or trade_id in batch_seen:
                continue
            batch_seen.add(trade_id)
            fresh.append(item)
        return fresh

    def _depth_signature(self, depth: dict[str, Any]) -> str:
        return _json_signature(
            {
                "provider": depth.get("provider"),
                "provider_symbol": depth.get("provider_symbol"),
                "bids": depth.get("bids") or [],
                "asks": depth.get("asks") or [],
                "source": depth.get("source"),
                "depth_mode": depth.get("depth_mode"),
            }
        )

    def _quote_signature(self, quote: dict[str, Any]) -> str:
        return _json_signature(
            {
                "provider": quote.get("provider"),
                "provider_symbol": quote.get("provider_symbol"),
                "bid_price": quote.get("bid_price"),
                "ask_price": quote.get("ask_price"),
                "last_price": quote.get("last_price"),
                "mark_price": quote.get("mark_price"),
                "open_24h": quote.get("open_24h"),
                "price_change_24h": quote.get("price_change_24h"),
                "price_change_percent_24h": quote.get("price_change_percent_24h"),
                "high_24h": quote.get("high_24h"),
                "low_24h": quote.get("low_24h"),
                "base_volume_24h": quote.get("base_volume_24h"),
                "quote_volume_24h": quote.get("quote_volume_24h"),
                "source": quote.get("source"),
            }
        )

    def _kline_signature(self, kline: dict[str, Any]) -> str:
        return _json_signature(
            {
                "open_time": kline.get("open_time") or kline.get("open_time_ms") or kline.get("time"),
                "open": kline.get("open"),
                "high": kline.get("high"),
                "low": kline.get("low"),
                "close": kline.get("close"),
                "volume": kline.get("volume"),
                "source": kline.get("source"),
                "provider": kline.get("provider"),
                "provider_generation": kline.get("provider_generation"),
                "revision_epoch": kline.get("revision_epoch"),
                "revision_sequence": kline.get("revision_sequence") or kline.get("revision_seq"),
                "is_closed": kline.get("is_closed"),
                "close_state_source": kline.get("close_state_source"),
            }
        )

    def _state_signature(self, state: dict[str, Any]) -> str:
        return _json_signature(
            {
                "display_price": state.get("display_price"),
                "display_price_source": state.get("display_price_source"),
                "current_price_source": state.get("current_price_source"),
                "best_bid": state.get("best_bid"),
                "best_ask": state.get("best_ask"),
                "execution_bid": state.get("execution_bid"),
                "execution_ask": state.get("execution_ask"),
                "display_state": state.get("display_state"),
                "executable": state.get("executable"),
                "ticker_24h": {
                    key: (state.get("ticker") or {}).get(key)
                    for key in (
                        "open_24h",
                        "price_change_24h",
                        "price_change_percent_24h",
                        "high_24h",
                        "low_24h",
                        "base_volume_24h",
                        "quote_volume_24h",
                    )
                },
            }
        )

    def _quote_message(self, symbol: str, quote: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "contract_quote",
            "domain": "market",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(quote.get("ts")),
            "source": quote.get("source"),
            "quote_source": quote.get("quote_source"),
            "data": quote,
            "quote": quote,
        }

    def _depth_message(self, symbol: str, depth: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "contract_depth",
            "domain": "market",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(depth.get("ts")),
            "data": depth,
            "depth": depth,
        }

    def _trade_message(self, symbol: str, trade: dict[str, Any]) -> dict[str, Any]:
        normalized_trade = _normalize_trade(trade)
        return {
            "type": "contract_trade",
            "domain": "market",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(normalized_trade.get("time") or normalized_trade.get("ts")),
            "source": normalized_trade.get("source"),
            "quote_source": normalized_trade.get("quote_source"),
            "freshness": normalized_trade.get("freshness") or normalized_trade.get("quote_freshness"),
            "quote_freshness": normalized_trade.get("quote_freshness"),
            "price_source": normalized_trade.get("price_source"),
            "provider": normalized_trade.get("provider"),
            "provider_symbol": normalized_trade.get("provider_symbol"),
            "data": normalized_trade,
            "trade": normalized_trade,
        }

    def _trades_message(
        self,
        symbol: str,
        trades: list[dict[str, Any]],
        *,
        preferred_trade_id: Any = None,
    ) -> dict[str, Any]:
        normalized_preferred_trade_id = str(preferred_trade_id or "")
        indexed_trades = [
            (index, _normalize_trade(dict(item)))
            for index, item in enumerate(trades)
        ]
        indexed_trades.sort(
            key=lambda item: (
                str(item[1].get("id") or "") == normalized_preferred_trade_id,
                _trade_event_time_ms(item[1]) or 0,
                item[0],
            ),
            reverse=True,
        )
        normalized_trades = [item for _, item in indexed_trades]
        latest_trade = normalized_trades[0] if normalized_trades else {}
        return {
            "type": "contract_trade",
            "domain": "market",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(normalized_trades[0].get("time") or normalized_trades[0].get("ts")) if normalized_trades else _utc_ms(),
            "source": latest_trade.get("source"),
            "quote_source": latest_trade.get("quote_source"),
            "freshness": latest_trade.get("freshness") or latest_trade.get("quote_freshness"),
            "quote_freshness": latest_trade.get("quote_freshness"),
            "price_source": latest_trade.get("price_source"),
            "provider": latest_trade.get("provider"),
            "provider_symbol": latest_trade.get("provider_symbol"),
            "data": normalized_trades,
            "trades": normalized_trades,
            "trade": normalized_trades[0] if normalized_trades else None,
        }

    def _kline_authority_payload(
        self,
        symbol: str,
        interval: str,
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        snapshot = self.get_domain_snapshot(
            ContractMarketDomainName.KLINE,
            normalized_symbol,
            interval=normalized_interval,
        )
        if snapshot is None or not isinstance(snapshot.data, dict):
            return None
        metadata = snapshot.metadata
        observed_at_ms = (
            metadata.received_at_ms
            or metadata.cache_updated_at_ms
            or metadata.db_updated_at_ms
        )
        expired = bool(
            observed_at_ms is None
            or metadata.ttl_ms is None
            or _utc_ms() - observed_at_ms > metadata.ttl_ms
        )
        if (
            metadata.stale
            or expired
            or metadata.source == ContractMarketDomainSource.MISSING
            or metadata.completeness.status != ContractMarketDomainCompletenessStatus.COMPLETE
            or not _non_negative_kline_volume(snapshot.data.get("volume"))
        ):
            return None
        revision = metadata.revision
        revision_payload = revision.model_dump() if revision is not None else None
        authority = {
            "source": metadata.source.value,
            "provider": metadata.provider,
            "provider_symbol": metadata.provider_symbol,
            "freshness": metadata.freshness.value,
            "transport": metadata.transport.value,
            "cache_origin": metadata.cache_origin.value,
            "fallback_reason": (
                metadata.fallback_reason.value
                if metadata.fallback_reason is not None
                else None
            ),
            "provider_generation": metadata.provider_generation,
            "revision": revision_payload,
            "revision_epoch": revision.epoch if revision is not None else None,
            "revision_sequence": revision.sequence if revision is not None else None,
            "is_closed": revision.is_closed if revision is not None else None,
            "close_state_source": revision.close_state_source if revision is not None else None,
            "provider_event_time_ms": metadata.provider_event_time_ms,
            "received_at_ms": metadata.received_at_ms,
            "stale": metadata.stale,
            "snapshot_id": snapshot.snapshot_id,
        }
        present_authority = {
            key: value
            for key, value in authority.items()
            if value is not None
        }
        return ({**snapshot.data, **present_authority}, present_authority)

    def _kline_message(
        self,
        symbol: str,
        interval: str,
    ) -> dict[str, Any] | None:
        normalized_interval = normalize_contract_ws_interval(interval)
        resolved = self._kline_authority_payload(symbol, normalized_interval)
        if resolved is None:
            return None
        payload, authority = resolved
        return {
            "type": "contract_kline_update",
            "domain": "kline",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "interval": normalized_interval,
            "ts": _timestamp_ms(payload.get("open_time") or payload.get("time")),
            **authority,
            "data": payload,
            "kline": payload,
        }

    def _state_message(self, symbol: str, state: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "contract_market_state",
            "domain": "market",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _utc_ms(),
            "source": state.get("display_price_source"),
            "data": state,
            "market_state": state,
        }

    def _status_message(self, symbol: str, status: str) -> dict[str, Any]:
        return {
            "type": "contract_market_status",
            "domain": "market",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _utc_ms(),
            "data": {"status": status},
        }

    def _domain_snapshot_ttl_ms(
        self,
        domain: ContractMarketDomainName,
        *,
        provider: Any = None,
    ) -> int:
        if (
            domain == ContractMarketDomainName.KLINE
            and str(provider or "").strip().upper() == "ITICK"
        ):
            return max(
                100,
                int(
                    getattr(
                        settings,
                        "CONTRACT_PROVIDER_WS_ITICK_KLINE_MAX_AGE_MS",
                        90000,
                    )
                    or 90000
                ),
            )
        setting_name = {
            ContractMarketDomainName.TICKER: "CONTRACT_PROVIDER_WS_TICKER_MAX_AGE_MS",
            ContractMarketDomainName.DEPTH: "CONTRACT_PROVIDER_WS_DEPTH_MAX_AGE_MS",
            ContractMarketDomainName.TRADES: "CONTRACT_PROVIDER_WS_TRADES_MAX_AGE_MS",
            ContractMarketDomainName.KLINE: "CONTRACT_PROVIDER_WS_KLINE_MAX_AGE_MS",
        }[domain]
        return max(100, int(getattr(settings, setting_name, 1500) or 1500))

    def _build_domain_snapshot(
        self,
        *,
        template: str,
        symbol: str,
        value: Any,
        interval: str | None,
        authority_payload: Any,
    ) -> ContractMarketDomainSnapshot[Any] | None:
        domain = _CONTRACT_MARKET_DOMAIN_BY_CACHE.get(template)
        if domain is None:
            return None
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = (
            normalize_contract_ws_interval(interval or "1m")
            if domain == ContractMarketDomainName.KLINE
            else None
        )
        metadata_payload = authority_payload if authority_payload is not None else value
        metadata = _authority_mapping(metadata_payload)
        source = str(metadata.get("source") or metadata.get("quote_source") or "").upper()
        provider_generation = metadata.get("provider_generation")
        provider_ws_authority = (
            source in _CONTRACT_MARKET_PROVIDER_WS_SOURCES
            or provider_generation is not None
        )
        cache_authority = {
            "DB_CACHE": (
                ContractMarketDomainTransport.CACHE_READ,
                ContractMarketDomainCacheOrigin.DATABASE,
            ),
            "PROCESS_CACHE": (
                ContractMarketDomainTransport.CACHE_READ,
                ContractMarketDomainCacheOrigin.PROCESS_MEMORY,
            ),
            "STALE_CACHE": (
                ContractMarketDomainTransport.CACHE_READ,
                ContractMarketDomainCacheOrigin.LAST_GOOD_MEMORY,
            ),
        }.get(source)
        received_at_ms = metadata.get("received_at_ms") or metadata.get("updated_at_ms")
        if received_at_ms in (None, "") and cache_authority is None:
            received_at_ms = _utc_ms()
        context_source = (
            ContractMarketDomainSource.REST_SNAPSHOT
            if source == "PROVIDER_REST"
            else None
        )
        raw_fallback_reason = str(metadata.get("fallback_reason") or "").strip().upper()
        try:
            fallback_reason = (
                ContractMarketDomainFallbackReason(raw_fallback_reason)
                if raw_fallback_reason
                else None
            )
        except ValueError:
            fallback_reason = ContractMarketDomainFallbackReason.UNKNOWN
        context = ContractMarketDomainSnapshotContext(
            symbol=normalized_symbol,
            interval=normalized_interval,
            transport=(
                ContractMarketDomainTransport.PROVIDER_WS
                if provider_ws_authority
                else cache_authority[0]
                if cache_authority is not None
                else ContractMarketDomainTransport.PROVIDER_REST
            ),
            cache_origin=(
                ContractMarketDomainCacheOrigin.PROVIDER_MEMORY
                if provider_ws_authority
                else cache_authority[1]
                if cache_authority is not None
                else ContractMarketDomainCacheOrigin.NONE
            ),
            source=context_source,
            fallback_reason=fallback_reason,
            received_at_ms=received_at_ms,
            ttl_ms=self._domain_snapshot_ttl_ms(
                domain,
                provider=metadata.get("provider"),
            ),
            emitted_at_ms=_utc_ms(),
        )
        legacy_value = _legacy_domain_value(value)
        if domain == ContractMarketDomainName.TICKER:
            return map_contract_ticker_domain_snapshot(
                context=context,
                ticker=legacy_value,
                authority_payload=metadata_payload,
            )
        if domain == ContractMarketDomainName.DEPTH:
            return map_contract_depth_domain_snapshot(
                context=context,
                depth=legacy_value,
                authority_payload=metadata_payload,
            )
        if domain == ContractMarketDomainName.TRADES:
            return map_contract_trades_domain_snapshot(
                context=context,
                trades=legacy_value,
                authority_payload=metadata_payload,
            )
        return map_contract_kline_domain_snapshot(
            context=context,
            kline=legacy_value,
            authority_payload=metadata_payload,
        )

    def _accept_domain_snapshot(
        self,
        snapshot: ContractMarketDomainSnapshot[Any],
    ) -> ContractMarketDomainSnapshotAuthorityResult:
        result = self._snapshot_authority.accept(snapshot)
        if not result.accepted:
            logger.debug(
                "contract_market_gateway_domain_snapshot_rejected "
                "domain=%s symbol=%s interval=%s reason=%s "
                "generation=%s revision=%s",
                snapshot.metadata.domain.value,
                snapshot.metadata.symbol,
                snapshot.metadata.interval,
                result.reason.value,
                snapshot.metadata.provider_generation,
                snapshot.metadata.revision.model_dump()
                if snapshot.metadata.revision is not None
                else None,
            )
        return result

    def get_domain_snapshot(
        self,
        domain: ContractMarketDomainName,
        symbol: str,
        *,
        interval: str | None = None,
    ) -> ContractMarketDomainSnapshot[Any] | None:
        return self._snapshot_authority.get(
            domain,
            normalize_contract_ws_symbol(symbol),
            interval=(
                normalize_contract_ws_interval(interval or "1m")
                if domain == ContractMarketDomainName.KLINE
                else None
            ),
        )

    def _set_latest(
        self,
        template: str,
        symbol: str,
        value: Any,
        *,
        interval: str | None = None,
        authority_payload: Any = None,
    ) -> bool:
        if template == CONTRACT_MARKET_CACHE_KLINE:
            kline = _authority_mapping(value)
            if not kline or not _non_negative_kline_volume(kline.get("volume")):
                return False
        if template == CONTRACT_MARKET_CACHE_TRADES:
            if not isinstance(value, list):
                return False
            truthful_trades = _truthful_contract_trades(value, symbol=symbol)
            if len(truthful_trades) != len(value):
                return False
            value = truthful_trades
        try:
            snapshot = self._build_domain_snapshot(
                template=template,
                symbol=symbol,
                value=value,
                interval=interval,
                authority_payload=authority_payload,
            )
            if snapshot is not None and not self._accept_domain_snapshot(snapshot).accepted:
                return False
        except Exception:
            # C-2 authority is additive. A metadata mapping failure must not
            # break the legacy API/cache path while producers are migrated.
            logger.warning(
                "contract_market_gateway_domain_snapshot_build_failed template=%s symbol=%s interval=%s",
                template,
                symbol,
                interval,
                exc_info=True,
            )
        self._latest[_latest_key(template, symbol, interval=interval)] = _legacy_domain_value(value)
        return True

    def _get_latest(self, template: str, symbol: str, *, interval: str | None = None) -> Any:
        value = self._latest.get(_latest_key(template, symbol, interval=interval))
        return deepcopy(value)


contract_market_gateway = ContractMarketGateway()
set_contract_provider_ws_kline_revision_listener(
    contract_market_gateway.notify_provider_kline_revision
)
