from __future__ import annotations

import asyncio
import logging
import threading
import time
from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.schemas.contract_market import ContractDepthResponse, ContractQuoteResponse
from app.services.contract_market_service import (
    ContractMarketError,
    ContractSymbolNotFound,
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

logger = logging.getLogger(__name__)

CONTRACT_MARKET_WS_QUOTE_INTERVAL_SECONDS = 1.0
CONTRACT_MARKET_WS_DEPTH_LIMIT = 20
CONTRACT_MARKET_WS_TRADES_LIMIT = 30
CONTRACT_MARKET_WS_KLINE_LIMIT = 2

CONTRACT_MARKET_CACHE_QUOTE = "contract:market:{symbol}:quote"
CONTRACT_MARKET_CACHE_DEPTH = "contract:market:{symbol}:depth"
CONTRACT_MARKET_CACHE_TRADES = "contract:market:{symbol}:trades"
CONTRACT_MARKET_CACHE_KLINE = "contract:market:{symbol}:kline:{interval}"


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

    async def ensure_symbol(self, symbol: str) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return
        async with self._task_lock:
            task = self._tasks.get(normalized_symbol)
            if task is not None and not task.done():
                return
            self._tasks[normalized_symbol] = asyncio.create_task(self._refresh_loop(normalized_symbol))

    async def release_symbol_if_idle(self, symbol: str) -> None:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        if not normalized_symbol:
            return
        if await contract_market_ws_manager.has_subscribers(normalized_symbol):
            return
        async with self._task_lock:
            task = self._tasks.pop(normalized_symbol, None)
            if task is not None and not task.done():
                task.cancel()

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
                    normalized_interval: self._get_latest(
                        CONTRACT_MARKET_CACHE_KLINE,
                        normalized_symbol,
                        interval=normalized_interval,
                    )
                },
                "status": status,
            },
        }

    async def _refresh_loop(self, symbol: str) -> None:
        current_task = asyncio.current_task()
        try:
            while await contract_market_ws_manager.has_subscribers(symbol):
                intervals = await contract_market_ws_manager.subscribed_intervals(symbol)
                try:
                    messages = await asyncio.to_thread(self._refresh_symbol_once, symbol, intervals)
                except (ContractSymbolNotFound, ContractMarketError):
                    logger.debug("contract_market_gateway_refresh_unavailable symbol=%s", symbol, exc_info=True)
                    messages = [self._status_message(symbol, "unavailable")]
                except Exception:
                    logger.warning("contract_market_gateway_refresh_failed symbol=%s", symbol, exc_info=True)
                    messages = [self._status_message(symbol, "error")]

                for message in messages:
                    await contract_market_ws_manager.broadcast_to_symbol(symbol, message)

                await asyncio.sleep(CONTRACT_MARKET_WS_QUOTE_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
        finally:
            async with self._task_lock:
                task = self._tasks.get(symbol)
                if task is current_task:
                    self._tasks.pop(symbol, None)

    def _refresh_symbol_once(self, symbol: str, intervals: list[str]) -> list[dict[str, Any]]:
        normalized_symbol = normalize_contract_ws_symbol(symbol)
        lock = self._locks.setdefault(normalized_symbol, threading.Lock())
        if not lock.acquire(blocking=False):
            return []
        try:
            # This function runs in a worker thread; use a thread-local DB session
            # and the in-memory latest state as the gateway handoff.
            db = SessionLocal()
            try:
                return self._load_symbol_state(db, normalized_symbol, intervals)
            finally:
                db.close()
        finally:
            lock.release()

    def _load_symbol_state(self, db: Session, symbol: str, intervals: list[str]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []

        quote_payload = get_contract_quote(db, symbol)
        quote = ContractQuoteResponse(**contract_quote_to_response(quote_payload)).model_dump()
        self._set_latest(CONTRACT_MARKET_CACHE_QUOTE, symbol, quote)
        messages.append(self._quote_message(symbol, quote))

        depth_payload = get_contract_depth(db, symbol, limit=CONTRACT_MARKET_WS_DEPTH_LIMIT)
        depth = ContractDepthResponse(**contract_depth_to_response(depth_payload)).model_dump()
        self._set_latest(CONTRACT_MARKET_CACHE_DEPTH, symbol, depth)
        messages.append(self._depth_message(symbol, depth))

        trades = [
            _normalize_trade(dict(item), fallback_source=quote.get("source"))
            for item in get_contract_recent_trades(db, symbol=symbol, limit=CONTRACT_MARKET_WS_TRADES_LIMIT)
            if isinstance(item, dict)
        ]
        self._set_latest(CONTRACT_MARKET_CACHE_TRADES, symbol, trades)
        if trades:
            messages.append(self._trade_message(symbol, trades[0], quote.get("source")))

        for interval in sorted({normalize_contract_ws_interval(item) for item in intervals} or {"1m"}):
            rows = get_contract_klines(
                db,
                symbol=symbol,
                interval=interval,
                limit=CONTRACT_MARKET_WS_KLINE_LIMIT,
            )
            latest_row = rows[-1] if rows else None
            if isinstance(latest_row, dict):
                kline = _normalize_kline(latest_row, source=quote.get("source"))
                self._set_latest(CONTRACT_MARKET_CACHE_KLINE, symbol, kline, interval=interval)
                messages.append(self._kline_message(symbol, interval, kline))

        return messages

    def _quote_message(self, symbol: str, quote: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "contract_quote",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "ts": _timestamp_ms(quote.get("ts")),
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
            "data": normalized_trade,
            "trade": normalized_trade,
        }

    def _kline_message(self, symbol: str, interval: str, kline: dict[str, Any]) -> dict[str, Any]:
        normalized_interval = normalize_contract_ws_interval(interval)
        return {
            "type": "contract_kline_update",
            "symbol": normalize_contract_ws_symbol(symbol),
            "market_symbol": _market_symbol(symbol),
            "interval": normalized_interval,
            "ts": _timestamp_ms(kline.get("open_time") or kline.get("time")),
            "data": kline,
            "kline": kline,
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
