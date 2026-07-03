from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.schemas.contract_market import ContractDepthResponse, ContractMarketViewDetail, ContractQuoteResponse
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
from app.services.contract_market_view import apply_quote_driven_kline_overlays, build_contract_market_view
from app.services.contract_market_provider_ws import (
    force_stop_provider_ws_subscriptions_for_symbol,
    provider_ws_depth_enabled,
    provider_ws_kline_enabled,
    provider_ws_ticker_enabled,
    provider_ws_trades_enabled,
    select_fresh_provider_ws_depth,
    select_fresh_provider_ws_kline,
    select_fresh_provider_ws_ticker,
    select_fresh_provider_ws_trades,
)

logger = logging.getLogger(__name__)

CONTRACT_MARKET_WS_QUOTE_INTERVAL_SECONDS = 1.0
CONTRACT_MARKET_WS_DEPTH_LIMIT = 20
CONTRACT_MARKET_WS_TRADES_LIMIT = 30
CONTRACT_MARKET_WS_KLINE_LIMIT = 2
CONTRACT_MARKET_WS_DEPTH_FALLBACK_SLEEP_SECONDS = 1.0

CONTRACT_MARKET_CACHE_QUOTE = "contract:market:{symbol}:quote"
CONTRACT_MARKET_CACHE_DEPTH = "contract:market:{symbol}:depth"
CONTRACT_MARKET_CACHE_TRADES = "contract:market:{symbol}:trades"
CONTRACT_MARKET_CACHE_KLINE = "contract:market:{symbol}:kline:{interval}"
CONTRACT_MARKET_CACHE_STATE = "contract:market:{symbol}:state:{interval}"


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


def _latest_key(template: str, symbol: str, *, interval: str | None = None) -> str:
    normalized_symbol = normalize_contract_ws_symbol(symbol)
    if interval is None:
        return template.format(symbol=normalized_symbol)
    return template.format(symbol=normalized_symbol, interval=normalize_contract_ws_interval(interval))


def _normalize_trade(row: dict[str, Any], *, fallback_source: str | None = None) -> dict[str, Any]:
    price = row.get("price") or row.get("last_price")
    amount = row.get("qty") or row.get("amount") or row.get("quantity") or row.get("volume")
    is_buyer_maker = row.get("isBuyerMaker")
    side = row.get("side")
    if side is None and isinstance(is_buyer_maker, bool):
        side = "SELL" if is_buyer_maker else "BUY"
    return {
        **row,
        "price": str(price) if price is not None else "",
        "amount": str(amount) if amount is not None else "",
        "qty": str(amount) if amount is not None else "",
        "side": str(side or "").upper() or None,
        "source": row.get("source") or fallback_source,
    }


def _normalize_kline(row: dict[str, Any], *, source: str | None = None) -> dict[str, Any]:
    open_time = row.get("open_time") or row.get("time") or row.get("timestamp")
    open_time_ms = _timestamp_ms(open_time)
    return {
        **row,
        "time": int(open_time_ms / 1000),
        "open_time": open_time_ms,
        "open": str(row.get("open") or ""),
        "high": str(row.get("high") or ""),
        "low": str(row.get("low") or ""),
        "close": str(row.get("close") or ""),
        "volume": str(row.get("volume") or "0"),
        "is_final": bool(row.get("is_final", False)),
        "source": row.get("source") or source,
    }


class ContractMarketGateway:
    def __init__(self) -> None:
        self._latest: dict[str, Any] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._task_lock = asyncio.Lock()
        self._last_full_refresh_at: dict[str, float] = {}
        self._last_depth_broadcast_at: dict[str, float] = {}
        self._last_depth_signature: dict[str, str] = {}
        self._last_kline_broadcast_at: dict[tuple[str, str], float] = {}
        self._last_kline_signature: dict[tuple[str, str], str] = {}
        self._last_quote_signature: dict[str, str] = {}
        self._last_state_signature: dict[tuple[str, str], str] = {}
        self._last_trade_ids: dict[str, set[str]] = {}
        self._provider_ws_allowed_symbols: set[str] = set()
        self._state_lock = threading.RLock()

    async def ensure_symbol(self, symbol: str) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return
        with self._state_lock:
            self._provider_ws_allowed_symbols.add(normalized_symbol)
        async with self._task_lock:
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

    def snapshot_message(self, symbol: str, interval: str = "1m", *, status: str = "ok") -> dict[str, Any]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        latest_kline = self._get_latest(
            CONTRACT_MARKET_CACHE_KLINE,
            normalized_symbol,
            interval=normalized_interval,
        )
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
                    normalized_interval: self._kline_with_quote_driven_overlay(
                        normalized_symbol,
                        normalized_interval,
                        latest_kline,
                    )
                },
                "market_state": self._get_latest(
                    CONTRACT_MARKET_CACHE_STATE,
                    normalized_symbol,
                    interval=normalized_interval,
                ),
                "status": status,
            },
        }

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
                intervals = await contract_market_ws_manager.subscribed_intervals(symbol)
                now = time.monotonic()
                last_full_refresh_at = self._last_full_refresh_at.get(symbol, 0.0)
                should_refresh_all = now - last_full_refresh_at >= CONTRACT_MARKET_WS_QUOTE_INTERVAL_SECONDS
                try:
                    if should_refresh_all:
                        messages = await asyncio.to_thread(
                            self._refresh_symbol_once,
                            symbol,
                            intervals,
                            True,
                        )
                        messages.extend(await asyncio.to_thread(self._refresh_provider_ws_once, symbol, intervals))
                        self._last_full_refresh_at[symbol] = now
                    else:
                        messages = await asyncio.to_thread(self._refresh_provider_ws_once, symbol, intervals)
                except (ContractSymbolNotFound, ContractMarketError):
                    logger.debug("contract_market_gateway_refresh_unavailable symbol=%s", symbol, exc_info=True)
                    messages = [self._status_message(symbol, "unavailable")]
                except Exception:
                    logger.warning("contract_market_gateway_refresh_failed symbol=%s", symbol, exc_info=True)
                    messages = [self._status_message(symbol, "error")]

                for message in messages:
                    await contract_market_ws_manager.broadcast_to_symbol(symbol, message)

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
                stop_report = force_stop_provider_ws_subscriptions_for_symbol(symbol)
                logger.info(
                    "contract_market_gateway_refresh_loop_provider_stop_report symbol=%s report=%s",
                    symbol,
                    stop_report,
                )
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
            for key in [key for key in self._last_state_signature if key[0] == symbol]:
                self._last_state_signature.pop(key, None)
            self._last_quote_signature.pop(symbol, None)
            self._last_trade_ids.pop(symbol, None)

    def _refresh_symbol_once(
        self,
        symbol: str,
        intervals: list[str],
        ensure_provider_ws: bool = False,
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
                return self._load_symbol_state(
                    db,
                    normalized_symbol,
                    intervals,
                    ensure_provider_ws=ensure_provider_ws,
                )
            finally:
                db.close()
        finally:
            lock.release()

    def _load_symbol_state(
        self,
        db: Session,
        symbol: str,
        intervals: list[str],
        *,
        ensure_provider_ws: bool,
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
        self._set_latest(CONTRACT_MARKET_CACHE_QUOTE, symbol, quote)
        self._remember_quote_signature(symbol, quote)
        messages.append(self._quote_message(symbol, quote))

        depth_payload = self._load_depth_payload(
            db,
            symbol,
            allow_provider_ws=True,
            ensure_provider_ws=ensure_provider_ws,
        )
        depth = ContractDepthResponse(**contract_depth_to_response(depth_payload)).model_dump()
        self._set_latest(CONTRACT_MARKET_CACHE_DEPTH, symbol, depth)
        self._remember_depth_signature(symbol, depth)
        messages.append(self._depth_message(symbol, depth))

        trades = self._load_trades_payload(
            db,
            symbol,
            fallback_source=quote.get("source"),
            allow_provider_ws=True,
            ensure_provider_ws=ensure_provider_ws,
        )
        self._set_latest(CONTRACT_MARKET_CACHE_TRADES, symbol, trades)
        if trades:
            self._remember_trade_ids(symbol, trades)
            messages.append(self._trade_message(symbol, trades[0], quote.get("source")))

        for interval in sorted({normalize_contract_ws_interval(item) for item in intervals} or {"1m"}):
            latest_row = self._load_kline_payload(
                db,
                interval=interval,
                symbol=symbol,
                allow_provider_ws=True,
                ensure_provider_ws=ensure_provider_ws,
            )
            if isinstance(latest_row, dict):
                kline = _normalize_kline(latest_row, source=quote.get("source"))
                broadcast_kline = self._kline_with_quote_driven_overlay(symbol, interval, kline) or kline
                self._set_latest(CONTRACT_MARKET_CACHE_KLINE, symbol, kline, interval=interval)
                self._remember_kline_signature(symbol, interval, broadcast_kline)
                messages.append(self._kline_message(symbol, interval, broadcast_kline))
            state_message = self._state_message_from_latest(
                symbol,
                interval,
                contract_symbol=contract_symbol,
                force=True,
            )
            if state_message is not None:
                messages.append(state_message)

        return messages

    def _refresh_provider_ws_once(self, symbol: str, intervals: list[str] | None = None) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        messages.extend(self._refresh_provider_ws_depth_once(symbol))
        messages.extend(self._refresh_provider_ws_ticker_once(symbol))
        messages.extend(self._refresh_provider_ws_trades_once(symbol))
        messages.extend(self._refresh_provider_ws_klines_once(symbol, intervals or ["1m"]))
        messages.extend(self._state_messages_from_latest(symbol, intervals or ["1m"]))
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
        interval: str,
        *,
        contract_symbol: Any = None,
    ) -> dict[str, Any] | None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        quote = self._get_latest(CONTRACT_MARKET_CACHE_QUOTE, normalized_symbol)
        depth = self._get_latest(CONTRACT_MARKET_CACHE_DEPTH, normalized_symbol)
        latest_kline = self._get_latest(
            CONTRACT_MARKET_CACHE_KLINE,
            normalized_symbol,
            interval=normalized_interval,
        )
        if not isinstance(quote, dict) and not isinstance(depth, dict):
            return None
        view = build_contract_market_view(
            normalized_symbol,
            quote=quote if isinstance(quote, dict) else None,
            depth=depth if isinstance(depth, dict) else None,
            latest_kline=latest_kline if isinstance(latest_kline, dict) else None,
            latest_trade=self._latest_trade_tick_from_cache(normalized_symbol),
            contract_symbol=contract_symbol,
            interval=normalized_interval,
        )
        return ContractMarketViewDetail(**view).model_dump()

    def _state_message_from_latest(
        self,
        symbol: str,
        interval: str,
        *,
        contract_symbol: Any = None,
        force: bool = False,
    ) -> dict[str, Any] | None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        state = self._build_market_state_from_latest(
            normalized_symbol,
            normalized_interval,
            contract_symbol=contract_symbol,
        )
        if state is None:
            return None
        signature = self._state_signature(state)
        key = (normalized_symbol, normalized_interval)
        if not force and self._last_state_signature.get(key) == signature:
            return None
        self._set_latest(CONTRACT_MARKET_CACHE_STATE, normalized_symbol, state, interval=normalized_interval)
        self._last_state_signature[key] = signature
        return self._state_message(normalized_symbol, normalized_interval, state)

    def _state_messages_from_latest(self, symbol: str, intervals: list[str]) -> list[dict[str, Any]]:
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
        messages: list[dict[str, Any]] = []
        for interval in sorted({normalize_contract_ws_interval(item) for item in intervals} or {"1m"}):
            message = self._state_message_from_latest(
                normalized_symbol,
                interval,
                contract_symbol=contract_symbol,
            )
            if message is not None:
                messages.append(message)
        return messages

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
        self._set_latest(CONTRACT_MARKET_CACHE_QUOTE, normalized_symbol, quote)
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
        self._set_latest(CONTRACT_MARKET_CACHE_DEPTH, normalized_symbol, depth)
        self._last_depth_signature[normalized_symbol] = signature
        self._last_depth_broadcast_at[normalized_symbol] = time.monotonic()
        return [self._depth_message(normalized_symbol, depth)]

    def _refresh_provider_ws_trades_once(self, symbol: str) -> list[dict[str, Any]]:
        if not provider_ws_trades_enabled():
            return []
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        db = SessionLocal()
        try:
            trades = self._load_trades_payload(
                db,
                normalized_symbol,
                fallback_source=None,
                allow_provider_ws=True,
                allow_rest_fallback=False,
            )
        finally:
            db.close()
        if not trades:
            return []
        new_trades = self._filter_new_trades(normalized_symbol, trades)
        if not new_trades:
            return []
        self._set_latest(CONTRACT_MARKET_CACHE_TRADES, normalized_symbol, trades)
        self._remember_trade_ids(normalized_symbol, trades)
        return [self._trades_message(normalized_symbol, new_trades)]

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
                kline = _normalize_kline(payload, source=payload.get("source"))
                broadcast_kline = self._kline_with_quote_driven_overlay(normalized_symbol, interval, kline) or kline
                signature = self._kline_signature(broadcast_kline)
                if self._last_kline_signature.get(key) == signature:
                    continue
                self._set_latest(CONTRACT_MARKET_CACHE_KLINE, normalized_symbol, kline, interval=interval)
                self._last_kline_signature[key] = signature
                self._last_kline_broadcast_at[key] = time.monotonic()
                messages.append(self._kline_message(normalized_symbol, interval, broadcast_kline))
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
        latest_row = rows[-1] if rows else None
        return latest_row if isinstance(latest_row, dict) else None

    def _kline_with_quote_driven_overlay(
        self,
        symbol: str,
        interval: str,
        kline: Any,
    ) -> dict[str, Any] | None:
        if not isinstance(kline, dict):
            return None
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        normalized_interval = normalize_contract_ws_interval(interval)
        rows = apply_quote_driven_kline_overlays(
            normalized_symbol,
            normalized_interval,
            [kline],
            limit=1,
            include_missing=False,
        )
        return rows[0] if rows else dict(kline)

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
        fallback_source: Any = None,
        allow_provider_ws: bool,
        allow_rest_fallback: bool = True,
        ensure_provider_ws: bool = False,
    ) -> list[dict[str, Any]]:
        if allow_provider_ws and provider_ws_trades_enabled():
            payload = select_fresh_provider_ws_trades(
                db,
                symbol,
                max_age_ms=int(getattr(settings, "CONTRACT_PROVIDER_WS_TRADES_MAX_AGE_MS", 1500) or 1500),
                ensure_subscription=ensure_provider_ws,
            )
            if isinstance(payload, dict):
                trades = [
                    _normalize_trade(dict(item), fallback_source=payload.get("source") or fallback_source)
                    for item in payload.get("trades") or []
                    if isinstance(item, dict)
                ]
                if trades:
                    return trades[:CONTRACT_MARKET_WS_TRADES_LIMIT]
        if not allow_rest_fallback:
            return []
        return [
            _normalize_trade(dict(item), fallback_source=str(fallback_source or "") or None)
            for item in get_contract_recent_trades(db, symbol=symbol, limit=CONTRACT_MARKET_WS_TRADES_LIMIT)
            if isinstance(item, dict)
        ]

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
        return max(0.2, min(interval_ms / 1000, 5.0))

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
        ids = {str(item.get("id") or "") for item in trades if item.get("id") is not None}
        if ids:
            self._last_trade_ids[normalized_symbol] = ids

    def _filter_new_trades(self, symbol: str, trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        seen = self._last_trade_ids.get(normalized_symbol) or set()
        fresh: list[dict[str, Any]] = []
        for item in trades:
            trade_id = str(item.get("id") or "")
            if not trade_id or trade_id in seen:
                continue
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
                "kline_current_candle": state.get("kline_current_candle"),
            }
        )

    def _quote_message(self, symbol: str, quote: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "contract_quote",
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
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(depth.get("ts")),
            "data": depth,
            "depth": depth,
        }

    def _trade_message(self, symbol: str, trade: dict[str, Any], source: Any = None) -> dict[str, Any]:
        normalized_trade = _normalize_trade(trade, fallback_source=str(source or "") or None)
        return {
            "type": "contract_trade",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(normalized_trade.get("time") or normalized_trade.get("ts")),
            "source": normalized_trade.get("source"),
            "quote_source": normalized_trade.get("quote_source"),
            "data": normalized_trade,
            "trade": normalized_trade,
        }

    def _trades_message(self, symbol: str, trades: list[dict[str, Any]]) -> dict[str, Any]:
        normalized_trades = [_normalize_trade(dict(item), fallback_source=item.get("source")) for item in trades]
        return {
            "type": "contract_trade",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(normalized_trades[0].get("time") or normalized_trades[0].get("ts")) if normalized_trades else _utc_ms(),
            "source": normalized_trades[0].get("source") if normalized_trades else None,
            "quote_source": normalized_trades[0].get("quote_source") if normalized_trades else None,
            "data": normalized_trades,
            "trades": normalized_trades,
            "trade": normalized_trades[0] if normalized_trades else None,
        }

    def _kline_message(self, symbol: str, interval: str, kline: dict[str, Any]) -> dict[str, Any]:
        normalized_interval = normalize_contract_ws_interval(interval)
        return {
            "type": "contract_kline_update",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "interval": normalized_interval,
            "ts": _timestamp_ms(kline.get("open_time") or kline.get("time")),
            "source": kline.get("source"),
            "quote_source": kline.get("quote_source"),
            "data": kline,
            "kline": kline,
        }

    def _state_message(self, symbol: str, interval: str, state: dict[str, Any]) -> dict[str, Any]:
        normalized_interval = normalize_contract_ws_interval(interval)
        return {
            "type": "contract_market_state",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "interval": normalized_interval,
            "ts": _utc_ms(),
            "source": state.get("display_price_source"),
            "data": state,
            "market_state": state,
            "kline_current_candle": state.get("kline_current_candle"),
        }

    def _status_message(self, symbol: str, status: str) -> dict[str, Any]:
        return {
            "type": "contract_market_status",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _utc_ms(),
            "data": {"status": status},
        }

    def _set_latest(self, template: str, symbol: str, value: Any, *, interval: str | None = None) -> None:
        self._latest[_latest_key(template, symbol, interval=interval)] = _to_jsonable(value)

    def _get_latest(self, template: str, symbol: str, *, interval: str | None = None) -> Any:
        value = self._latest.get(_latest_key(template, symbol, interval=interval))
        return deepcopy(value)


contract_market_gateway = ContractMarketGateway()
