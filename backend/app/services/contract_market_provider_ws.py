from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

import websockets
from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.contract_market_provider_service import (
    PROVIDER_BITGET_USDT_FUTURES,
    PROVIDER_OKX_SWAP,
    enabled_contract_market_providers,
    is_contract_market_provider_in_cooldown,
    resolve_contract_provider_symbol,
)


logger = logging.getLogger(__name__)

CONTRACT_PROVIDER_WS_SOURCE = "LIVE_WS"
_SUPPORTED_DEPTH_WS_PROVIDERS = {PROVIDER_OKX_SWAP}
_SUPPORTED_TRADES_WS_PROVIDERS = {PROVIDER_OKX_SWAP}
_SUPPORTED_TICKER_WS_PROVIDERS = {PROVIDER_OKX_SWAP}
_SUPPORTED_KLINE_WS_PROVIDERS = {PROVIDER_OKX_SWAP}
_OKX_KLINE_CHANNELS = {
    "1m": "candle1m",
    "5m": "candle5m",
    "15m": "candle15m",
    "1h": "candle1H",
    "4h": "candle4H",
    "1d": "candle1D",
}


@dataclass(frozen=True)
class ProviderDepthSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    depth_limit: int


@dataclass(frozen=True)
class ProviderTradesSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    trades_limit: int


@dataclass(frozen=True)
class ProviderTickerSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str


@dataclass(frozen=True)
class ProviderKlineSubscription:
    local_symbol: str
    provider: str
    provider_symbol: str
    interval: str
    channel: str


def _normalize_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_interval(value: Any) -> str:
    return str(value or "1m").strip().lower() or "1m"


def _okx_kline_channel(interval: Any) -> Optional[str]:
    return _OKX_KLINE_CHANNELS.get(_normalize_interval(interval))


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _depth_limit() -> int:
    return max(5, min(int(getattr(settings, "CONTRACT_PROVIDER_WS_DEPTH_LIMIT", 20) or 20), 100))


def _trades_limit() -> int:
    return max(1, min(int(getattr(settings, "CONTRACT_PROVIDER_WS_TRADES_LIMIT", 30) or 30), 100))


def _max_age_ms(value: Optional[int] = None, *, setting_name: str = "CONTRACT_PROVIDER_WS_DEPTH_MAX_AGE_MS") -> int:
    configured = value if value is not None else getattr(settings, setting_name, 1500)
    return max(100, int(configured or 1500))


def provider_ws_depth_enabled() -> bool:
    return bool(
        getattr(settings, "CONTRACT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "CONTRACT_PROVIDER_WS_DEPTH_ENABLED", False)
    )


def provider_ws_trades_enabled() -> bool:
    return bool(
        getattr(settings, "CONTRACT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "CONTRACT_PROVIDER_WS_TRADES_ENABLED", False)
    )


def provider_ws_ticker_enabled() -> bool:
    return bool(
        getattr(settings, "CONTRACT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "CONTRACT_PROVIDER_WS_TICKER_ENABLED", False)
    )


def provider_ws_kline_enabled() -> bool:
    return bool(
        getattr(settings, "CONTRACT_PROVIDER_WS_ENABLED", False)
        and getattr(settings, "CONTRACT_PROVIDER_WS_KLINE_ENABLED", False)
    )


def _timestamp_ms_from_value(value: Any) -> int:
    if value in (None, ""):
        return int(time.time() * 1000)
    try:
        numeric = float(value)
    except Exception:
        return int(time.time() * 1000)
    if numeric <= 0:
        return int(time.time() * 1000)
    return int(numeric if numeric > 10_000_000_000 else numeric * 1000)


def _sort_depth_side(levels: dict[str, Decimal], *, side: str, limit: int) -> list[list[Decimal]]:
    reverse = side == "bids"
    prices = sorted((_to_decimal(price) for price in levels.keys()), reverse=reverse)
    rows: list[list[Decimal]] = []
    for price in prices:
        if price is None:
            continue
        quantity = levels.get(format(price, "f"))
        if quantity is None or quantity <= 0:
            continue
        rows.append([price, quantity])
        if len(rows) >= limit:
            break
    return rows


def _best_depth_price(levels: list[list[Decimal]], *, side: str) -> Optional[Decimal]:
    if not levels:
        return None
    prices = [item[0] for item in levels if item and item[0] > 0]
    if not prices:
        return None
    return max(prices) if side == "bids" else min(prices)


def _normalize_okx_side(levels: Any) -> dict[str, Decimal]:
    normalized: dict[str, Decimal] = {}
    if not isinstance(levels, list):
        return normalized
    for row in levels:
        if not isinstance(row, list) or len(row) < 2:
            continue
        price = _to_decimal(row[0])
        quantity = _to_decimal(row[1])
        if price is None or quantity is None or price <= 0:
            continue
        key = format(price, "f")
        if quantity <= 0:
            normalized.pop(key, None)
        else:
            normalized[key] = quantity
    return normalized


def _merge_okx_side(current: dict[str, Decimal], updates: Any) -> None:
    if not isinstance(updates, list):
        return
    for row in updates:
        if not isinstance(row, list) or len(row) < 2:
            continue
        price = _to_decimal(row[0])
        quantity = _to_decimal(row[1])
        if price is None or quantity is None or price <= 0:
            continue
        key = format(price, "f")
        if quantity <= 0:
            current.pop(key, None)
        else:
            current[key] = quantity


class ContractMarketProviderWsService:
    def __init__(self) -> None:
        self._depth_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._depth_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._depth_stops: dict[tuple[str, str], threading.Event] = {}
        self._depth_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._depth_generations: dict[tuple[str, str], int] = {}
        self._trades_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._trades_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._trades_stops: dict[tuple[str, str], threading.Event] = {}
        self._trades_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._trades_generations: dict[tuple[str, str], int] = {}
        self._ticker_cache: dict[tuple[str, str], dict[str, Any]] = {}
        self._ticker_tasks: dict[tuple[str, str], threading.Thread] = {}
        self._ticker_stops: dict[tuple[str, str], threading.Event] = {}
        self._ticker_connections: dict[tuple[str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._ticker_generations: dict[tuple[str, str], int] = {}
        self._kline_cache: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._kline_tasks: dict[tuple[str, str, str], threading.Thread] = {}
        self._kline_stops: dict[tuple[str, str, str], threading.Event] = {}
        self._kline_connections: dict[tuple[str, str, str], tuple[asyncio.AbstractEventLoop, Any]] = {}
        self._kline_generations: dict[tuple[str, str, str], int] = {}
        self._lock = threading.RLock()

    def get_fresh_provider_ws_depth(
        self,
        symbol: str,
        provider_code: Optional[str] = None,
        *,
        max_age_ms: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_provider = _normalize_symbol(provider_code) if provider_code else None
        now_ms = int(time.time() * 1000)
        allowed_age_ms = _max_age_ms(max_age_ms)
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._depth_cache.items()
                if local_symbol == normalized_symbol and (normalized_provider is None or provider == normalized_provider)
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return deepcopy(item)
        return None

    def get_fresh_provider_ws_trades(
        self,
        symbol: str,
        provider_code: Optional[str] = None,
        *,
        max_age_ms: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_provider = _normalize_symbol(provider_code) if provider_code else None
        now_ms = int(time.time() * 1000)
        allowed_age_ms = _max_age_ms(max_age_ms, setting_name="CONTRACT_PROVIDER_WS_TRADES_MAX_AGE_MS")
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._trades_cache.items()
                if local_symbol == normalized_symbol and (normalized_provider is None or provider == normalized_provider)
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return deepcopy(item)
        return None

    def get_fresh_provider_ws_ticker(
        self,
        symbol: str,
        provider_code: Optional[str] = None,
        *,
        max_age_ms: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_provider = _normalize_symbol(provider_code) if provider_code else None
        now_ms = int(time.time() * 1000)
        allowed_age_ms = _max_age_ms(max_age_ms, setting_name="CONTRACT_PROVIDER_WS_TICKER_MAX_AGE_MS")
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol), item in self._ticker_cache.items()
                if local_symbol == normalized_symbol and (normalized_provider is None or provider == normalized_provider)
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return deepcopy(item)
        return None

    def get_fresh_provider_ws_kline(
        self,
        symbol: str,
        interval: str,
        provider_code: Optional[str] = None,
        *,
        max_age_ms: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_interval = _normalize_interval(interval)
        normalized_provider = _normalize_symbol(provider_code) if provider_code else None
        now_ms = int(time.time() * 1000)
        allowed_age_ms = _max_age_ms(max_age_ms, setting_name="CONTRACT_PROVIDER_WS_KLINE_MAX_AGE_MS")
        with self._lock:
            candidates = [
                item
                for (provider, local_symbol, item_interval), item in self._kline_cache.items()
                if local_symbol == normalized_symbol
                and item_interval == normalized_interval
                and (normalized_provider is None or provider == normalized_provider)
            ]
            candidates.sort(key=lambda item: int(item.get("updated_at_ms") or 0), reverse=True)
            for item in candidates:
                updated_at_ms = int(item.get("updated_at_ms") or 0)
                if updated_at_ms <= 0 or now_ms - updated_at_ms > allowed_age_ms:
                    continue
                return deepcopy(item)
        return None

    def select_fresh_depth_for_enabled_providers(
        self,
        db: Session,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
        ensure_subscription: bool = False,
    ) -> Optional[dict[str, Any]]:
        if not provider_ws_depth_enabled():
            return None
        normalized_symbol = _normalize_symbol(symbol)
        for provider in enabled_contract_market_providers(db):
            provider_code = _normalize_symbol(provider.provider_code)
            if provider_code not in {PROVIDER_OKX_SWAP, PROVIDER_BITGET_USDT_FUTURES}:
                continue
            if is_contract_market_provider_in_cooldown(provider_code):
                logger.debug("contract_provider_ws_depth_skipped_cooldown provider=%s symbol=%s", provider_code, normalized_symbol)
                self.stop_depth_subscription(local_symbol=normalized_symbol, provider=provider_code)
                continue
            provider_symbol = resolve_contract_provider_symbol(
                db,
                provider_code=provider_code,
                local_symbol=normalized_symbol,
            )
            if ensure_subscription:
                self.ensure_depth_subscription(
                    local_symbol=normalized_symbol,
                    provider=provider_code,
                    provider_symbol=provider_symbol,
                    depth_limit=_depth_limit(),
                )
            depth = self.get_fresh_provider_ws_depth(
                normalized_symbol,
                provider_code,
                max_age_ms=max_age_ms,
            )
            if depth is not None:
                return depth
        return None

    def select_fresh_trades_for_enabled_providers(
        self,
        db: Session,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
        ensure_subscription: bool = False,
    ) -> Optional[dict[str, Any]]:
        if not provider_ws_trades_enabled():
            return None
        normalized_symbol = _normalize_symbol(symbol)
        for provider in enabled_contract_market_providers(db):
            provider_code = _normalize_symbol(provider.provider_code)
            if provider_code not in {PROVIDER_OKX_SWAP, PROVIDER_BITGET_USDT_FUTURES}:
                continue
            if is_contract_market_provider_in_cooldown(provider_code):
                logger.debug("contract_provider_ws_trades_skipped_cooldown provider=%s symbol=%s", provider_code, normalized_symbol)
                self.stop_trades_subscription(local_symbol=normalized_symbol, provider=provider_code)
                continue
            provider_symbol = resolve_contract_provider_symbol(
                db,
                provider_code=provider_code,
                local_symbol=normalized_symbol,
            )
            if ensure_subscription:
                self.ensure_trades_subscription(
                    local_symbol=normalized_symbol,
                    provider=provider_code,
                    provider_symbol=provider_symbol,
                    trades_limit=_trades_limit(),
                )
            trades = self.get_fresh_provider_ws_trades(
                normalized_symbol,
                provider_code,
                max_age_ms=max_age_ms,
            )
            if trades is not None:
                return trades
        return None

    def select_fresh_ticker_for_enabled_providers(
        self,
        db: Session,
        symbol: str,
        *,
        max_age_ms: Optional[int] = None,
        ensure_subscription: bool = False,
    ) -> Optional[dict[str, Any]]:
        if not provider_ws_ticker_enabled():
            return None
        normalized_symbol = _normalize_symbol(symbol)
        for provider in enabled_contract_market_providers(db):
            provider_code = _normalize_symbol(provider.provider_code)
            if provider_code not in {PROVIDER_OKX_SWAP, PROVIDER_BITGET_USDT_FUTURES}:
                continue
            if is_contract_market_provider_in_cooldown(provider_code):
                logger.debug("contract_provider_ws_ticker_skipped_cooldown provider=%s symbol=%s", provider_code, normalized_symbol)
                self.stop_ticker_subscription(local_symbol=normalized_symbol, provider=provider_code)
                continue
            provider_symbol = resolve_contract_provider_symbol(
                db,
                provider_code=provider_code,
                local_symbol=normalized_symbol,
            )
            if ensure_subscription:
                self.ensure_ticker_subscription(
                    local_symbol=normalized_symbol,
                    provider=provider_code,
                    provider_symbol=provider_symbol,
                )
            ticker = self.get_fresh_provider_ws_ticker(
                normalized_symbol,
                provider_code,
                max_age_ms=max_age_ms,
            )
            if ticker is not None:
                return ticker
        return None

    def select_fresh_kline_for_enabled_providers(
        self,
        db: Session,
        symbol: str,
        interval: str,
        *,
        max_age_ms: Optional[int] = None,
        ensure_subscription: bool = False,
    ) -> Optional[dict[str, Any]]:
        if not provider_ws_kline_enabled():
            return None
        normalized_symbol = _normalize_symbol(symbol)
        normalized_interval = _normalize_interval(interval)
        channel = _okx_kline_channel(normalized_interval)
        if not channel:
            return None
        for provider in enabled_contract_market_providers(db):
            provider_code = _normalize_symbol(provider.provider_code)
            if provider_code not in {PROVIDER_OKX_SWAP, PROVIDER_BITGET_USDT_FUTURES}:
                continue
            if is_contract_market_provider_in_cooldown(provider_code):
                logger.debug(
                    "contract_provider_ws_kline_skipped_cooldown provider=%s symbol=%s interval=%s",
                    provider_code,
                    normalized_symbol,
                    normalized_interval,
                )
                self.stop_kline_subscription(
                    local_symbol=normalized_symbol,
                    provider=provider_code,
                    interval=normalized_interval,
                )
                continue
            provider_symbol = resolve_contract_provider_symbol(
                db,
                provider_code=provider_code,
                local_symbol=normalized_symbol,
            )
            if ensure_subscription:
                self.ensure_kline_subscription(
                    local_symbol=normalized_symbol,
                    provider=provider_code,
                    provider_symbol=provider_symbol,
                    interval=normalized_interval,
                )
            kline = self.get_fresh_provider_ws_kline(
                normalized_symbol,
                normalized_interval,
                provider_code,
                max_age_ms=max_age_ms,
            )
            if kline is not None:
                return kline
        return None

    def ensure_depth_subscription(
        self,
        *,
        local_symbol: str,
        provider: str,
        provider_symbol: str,
        depth_limit: int,
    ) -> None:
        if not provider_ws_depth_enabled():
            return
        normalized_symbol = _normalize_symbol(local_symbol)
        provider_code = _normalize_symbol(provider)
        normalized_provider_symbol = _normalize_symbol(provider_symbol)
        if provider_code not in _SUPPORTED_DEPTH_WS_PROVIDERS:
            logger.debug("contract_provider_ws_depth_unsupported provider=%s symbol=%s", provider_code, normalized_symbol)
            return
        key = (provider_code, normalized_symbol)
        with self._lock:
            existing = self._depth_tasks.get(key)
            if existing is not None and existing.is_alive():
                return
            logger.info(
                "contract_provider_ws_depth_subscription_starting provider=%s symbol=%s provider_symbol=%s",
                provider_code,
                normalized_symbol,
                normalized_provider_symbol,
            )
            stop_event = threading.Event()
            generation = self._depth_generations.get(key, 0) + 1
            self._depth_generations[key] = generation
            subscription = ProviderDepthSubscription(
                local_symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=normalized_provider_symbol,
                depth_limit=max(5, min(int(depth_limit or 20), 100)),
            )
            thread = threading.Thread(
                target=self._run_depth_subscription_thread,
                args=(subscription, stop_event, generation),
                name=f"contract-provider-depth-ws-{provider_code}-{normalized_symbol}",
                daemon=True,
            )
            self._depth_stops[key] = stop_event
            self._depth_tasks[key] = thread
            thread.start()

    def ensure_trades_subscription(
        self,
        *,
        local_symbol: str,
        provider: str,
        provider_symbol: str,
        trades_limit: int,
    ) -> None:
        if not provider_ws_trades_enabled():
            return
        normalized_symbol = _normalize_symbol(local_symbol)
        provider_code = _normalize_symbol(provider)
        normalized_provider_symbol = _normalize_symbol(provider_symbol)
        if provider_code not in _SUPPORTED_TRADES_WS_PROVIDERS:
            logger.debug("contract_provider_ws_trades_unsupported provider=%s symbol=%s", provider_code, normalized_symbol)
            return
        key = (provider_code, normalized_symbol)
        with self._lock:
            existing = self._trades_tasks.get(key)
            if existing is not None and existing.is_alive():
                return
            logger.info(
                "contract_provider_ws_trades_subscription_starting provider=%s symbol=%s provider_symbol=%s",
                provider_code,
                normalized_symbol,
                normalized_provider_symbol,
            )
            stop_event = threading.Event()
            generation = self._trades_generations.get(key, 0) + 1
            self._trades_generations[key] = generation
            subscription = ProviderTradesSubscription(
                local_symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=normalized_provider_symbol,
                trades_limit=max(1, min(int(trades_limit or 30), 100)),
            )
            thread = threading.Thread(
                target=self._run_trades_subscription_thread,
                args=(subscription, stop_event, generation),
                name=f"contract-provider-trades-ws-{provider_code}-{normalized_symbol}",
                daemon=True,
            )
            self._trades_stops[key] = stop_event
            self._trades_tasks[key] = thread
            thread.start()

    def ensure_ticker_subscription(
        self,
        *,
        local_symbol: str,
        provider: str,
        provider_symbol: str,
    ) -> None:
        if not provider_ws_ticker_enabled():
            return
        normalized_symbol = _normalize_symbol(local_symbol)
        provider_code = _normalize_symbol(provider)
        normalized_provider_symbol = _normalize_symbol(provider_symbol)
        if provider_code not in _SUPPORTED_TICKER_WS_PROVIDERS:
            logger.debug("contract_provider_ws_ticker_unsupported provider=%s symbol=%s", provider_code, normalized_symbol)
            return
        key = (provider_code, normalized_symbol)
        with self._lock:
            existing = self._ticker_tasks.get(key)
            if existing is not None and existing.is_alive():
                return
            logger.info(
                "contract_provider_ws_ticker_subscription_starting provider=%s symbol=%s provider_symbol=%s",
                provider_code,
                normalized_symbol,
                normalized_provider_symbol,
            )
            stop_event = threading.Event()
            generation = self._ticker_generations.get(key, 0) + 1
            self._ticker_generations[key] = generation
            subscription = ProviderTickerSubscription(
                local_symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=normalized_provider_symbol,
            )
            thread = threading.Thread(
                target=self._run_ticker_subscription_thread,
                args=(subscription, stop_event, generation),
                name=f"contract-provider-ticker-ws-{provider_code}-{normalized_symbol}",
                daemon=True,
            )
            self._ticker_stops[key] = stop_event
            self._ticker_tasks[key] = thread
            thread.start()

    def ensure_kline_subscription(
        self,
        *,
        local_symbol: str,
        provider: str,
        provider_symbol: str,
        interval: str,
    ) -> None:
        if not provider_ws_kline_enabled():
            return
        normalized_symbol = _normalize_symbol(local_symbol)
        provider_code = _normalize_symbol(provider)
        normalized_provider_symbol = _normalize_symbol(provider_symbol)
        normalized_interval = _normalize_interval(interval)
        channel = _okx_kline_channel(normalized_interval)
        if provider_code not in _SUPPORTED_KLINE_WS_PROVIDERS or not channel:
            logger.debug(
                "contract_provider_ws_kline_unsupported provider=%s symbol=%s interval=%s",
                provider_code,
                normalized_symbol,
                normalized_interval,
            )
            return
        key = (provider_code, normalized_symbol, normalized_interval)
        with self._lock:
            existing = self._kline_tasks.get(key)
            if existing is not None and existing.is_alive():
                return
            logger.info(
                "contract_provider_ws_kline_subscription_starting provider=%s symbol=%s provider_symbol=%s interval=%s",
                provider_code,
                normalized_symbol,
                normalized_provider_symbol,
                normalized_interval,
            )
            stop_event = threading.Event()
            generation = self._kline_generations.get(key, 0) + 1
            self._kline_generations[key] = generation
            subscription = ProviderKlineSubscription(
                local_symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=normalized_provider_symbol,
                interval=normalized_interval,
                channel=channel,
            )
            thread = threading.Thread(
                target=self._run_kline_subscription_thread,
                args=(subscription, stop_event, generation),
                name=f"contract-provider-kline-ws-{provider_code}-{normalized_symbol}-{normalized_interval}",
                daemon=True,
            )
            self._kline_stops[key] = stop_event
            self._kline_tasks[key] = thread
            thread.start()

    def stop_depth_subscription(self, *, local_symbol: str, provider: str) -> None:
        key = (_normalize_symbol(provider), _normalize_symbol(local_symbol))
        with self._lock:
            stop_event = self._depth_stops.get(key)
            thread = self._depth_tasks.get(key)
            connection = self._depth_connections.get(key)
        if stop_event is None and connection is None and thread is None:
            logger.debug(
                "contract_provider_ws_depth_subscription_stop_noop provider=%s symbol=%s",
                key[0],
                key[1],
            )
            return
        logger.info(
            "contract_provider_ws_depth_subscription_stopping provider=%s symbol=%s",
            key[0],
            key[1],
        )
        if stop_event is not None:
            stop_event.set()
        self._close_depth_connection(key, connection)
        self._wait_for_depth_thread_exit(key, thread, timeout_seconds=2.0)
        self._clear_depth_subscription_state(key, remove_cache=False)

    def stop_trades_subscription(self, *, local_symbol: str, provider: str) -> None:
        key = (_normalize_symbol(provider), _normalize_symbol(local_symbol))
        with self._lock:
            stop_event = self._trades_stops.get(key)
            thread = self._trades_tasks.get(key)
            connection = self._trades_connections.get(key)
        if stop_event is None and connection is None and thread is None:
            logger.debug(
                "contract_provider_ws_trades_subscription_stop_noop provider=%s symbol=%s",
                key[0],
                key[1],
            )
            return
        logger.info(
            "contract_provider_ws_trades_subscription_stopping provider=%s symbol=%s",
            key[0],
            key[1],
        )
        if stop_event is not None:
            stop_event.set()
        self._close_ws_connection(key, connection, stream="trades")
        self._wait_for_ws_thread_exit(key, thread, timeout_seconds=2.0, stream="trades")
        self._clear_trades_subscription_state(key, remove_cache=False)

    def stop_ticker_subscription(self, *, local_symbol: str, provider: str) -> None:
        key = (_normalize_symbol(provider), _normalize_symbol(local_symbol))
        with self._lock:
            stop_event = self._ticker_stops.get(key)
            thread = self._ticker_tasks.get(key)
            connection = self._ticker_connections.get(key)
        if stop_event is None and connection is None and thread is None:
            logger.debug(
                "contract_provider_ws_ticker_subscription_stop_noop provider=%s symbol=%s",
                key[0],
                key[1],
            )
            return
        logger.info(
            "contract_provider_ws_ticker_subscription_stopping provider=%s symbol=%s",
            key[0],
            key[1],
        )
        if stop_event is not None:
            stop_event.set()
        self._close_ws_connection(key, connection, stream="ticker")
        self._wait_for_ws_thread_exit(key, thread, timeout_seconds=2.0, stream="ticker")
        self._clear_ticker_subscription_state(key, remove_cache=False)

    def stop_kline_subscription(self, *, local_symbol: str, provider: str, interval: str) -> None:
        key = (_normalize_symbol(provider), _normalize_symbol(local_symbol), _normalize_interval(interval))
        with self._lock:
            stop_event = self._kline_stops.get(key)
            thread = self._kline_tasks.get(key)
            connection = self._kline_connections.get(key)
        if stop_event is None and connection is None and thread is None:
            logger.debug(
                "contract_provider_ws_kline_subscription_stop_noop provider=%s symbol=%s interval=%s",
                key[0],
                key[1],
                key[2],
            )
            return
        logger.info(
            "contract_provider_ws_kline_subscription_stopping provider=%s symbol=%s interval=%s",
            key[0],
            key[1],
            key[2],
        )
        if stop_event is not None:
            stop_event.set()
        self._close_ws_connection(key, connection, stream="kline")
        self._wait_for_ws_thread_exit(key, thread, timeout_seconds=2.0, stream="kline")
        self._clear_kline_subscription_state(key, remove_cache=False)

    def stop_depth_subscriptions_for_symbol(self, local_symbol: str) -> None:
        self.force_stop_depth_subscriptions_for_symbol(local_symbol)

    def force_stop_depth_subscriptions_for_symbol(
        self,
        local_symbol: str,
        *,
        wait_seconds: float = 3.0,
    ) -> dict[str, Any]:
        normalized_symbol = _normalize_symbol(local_symbol)
        if not normalized_symbol:
            return {
                "symbol": normalized_symbol,
                "matched_keys": [],
                "closed_count": 0,
                "cancelled_count": 0,
                "alive_after_stop": [],
                "registry_after": self.debug_provider_ws_depth_subscriptions(),
            }
        depth_report = self._force_stop_stream_subscriptions_for_symbol(
            local_symbol=normalized_symbol,
            wait_seconds=wait_seconds,
            stream="depth",
        )
        trades_report = self._force_stop_stream_subscriptions_for_symbol(
            local_symbol=normalized_symbol,
            wait_seconds=wait_seconds,
            stream="trades",
        )
        ticker_report = self._force_stop_stream_subscriptions_for_symbol(
            local_symbol=normalized_symbol,
            wait_seconds=wait_seconds,
            stream="ticker",
        )
        kline_report = self._force_stop_stream_subscriptions_for_symbol(
            local_symbol=normalized_symbol,
            wait_seconds=wait_seconds,
            stream="kline",
        )
        report = {
            "symbol": normalized_symbol,
            "depth": depth_report,
            "trades": trades_report,
            "ticker": ticker_report,
            "kline": kline_report,
            "registry_after": self.debug_provider_ws_depth_subscriptions(),
        }
        logger.info("contract_provider_ws_subscription_force_stop_report %s", report)
        return report

    def stop_all(self) -> None:
        with self._lock:
            depth_symbols = {key[1] for key in set(self._depth_stops) | set(self._depth_tasks) | set(self._depth_connections)}
            trades_symbols = {key[1] for key in set(self._trades_stops) | set(self._trades_tasks) | set(self._trades_connections)}
            ticker_symbols = {key[1] for key in set(self._ticker_stops) | set(self._ticker_tasks) | set(self._ticker_connections)}
            kline_symbols = {key[1] for key in set(self._kline_stops) | set(self._kline_tasks) | set(self._kline_connections)}
            symbols = sorted(depth_symbols | trades_symbols | ticker_symbols | kline_symbols)
        for symbol in symbols:
            self.force_stop_depth_subscriptions_for_symbol(symbol)

    def _force_stop_stream_subscriptions_for_symbol(
        self,
        *,
        local_symbol: str,
        wait_seconds: float,
        stream: str,
    ) -> dict[str, Any]:
        normalized_symbol = _normalize_symbol(local_symbol)
        if stream == "depth":
            stops = self._depth_stops
            tasks = self._depth_tasks
            connections = self._depth_connections
            clear_state = self._clear_depth_subscription_state
        elif stream == "trades":
            stops = self._trades_stops
            tasks = self._trades_tasks
            connections = self._trades_connections
            clear_state = self._clear_trades_subscription_state
        elif stream == "ticker":
            stops = self._ticker_stops
            tasks = self._ticker_tasks
            connections = self._ticker_connections
            clear_state = self._clear_ticker_subscription_state
        elif stream == "kline":
            stops = self._kline_stops
            tasks = self._kline_tasks
            connections = self._kline_connections
            clear_state = self._clear_kline_subscription_state
        else:
            raise ValueError(f"unsupported provider ws stream: {stream}")
        if not normalized_symbol:
            return {
                "symbol": normalized_symbol,
                "stream": stream,
                "matched_keys": [],
                "closed_count": 0,
                "cancelled_count": 0,
                "alive_after_stop": [],
            }
        with self._lock:
            all_keys = set(stops.keys()) | set(tasks.keys()) | set(connections.keys())
            keys = [key for key in all_keys if key[1] == normalized_symbol]
            logger.info(
                "contract_provider_ws_%s_subscription_force_stop_for_symbol symbol=%s task_keys=%s connection_keys=%s matched_keys=%s stop_count=%s",
                stream,
                normalized_symbol,
                sorted(map(str, tasks.keys())),
                sorted(map(str, connections.keys())),
                sorted(map(str, keys)),
                len(keys),
            )
            stop_events = [stops.get(key) for key in keys]
            threads = [tasks.get(key) for key in keys]
            stream_connections = [connections.get(key) for key in keys]
        if not keys:
            logger.debug(
                "contract_provider_ws_%s_subscription_stop_miss symbol=%s",
                stream,
                normalized_symbol,
            )
            return {
                "symbol": normalized_symbol,
                "stream": stream,
                "matched_keys": [],
                "closed_count": 0,
                "cancelled_count": 0,
                "alive_after_stop": [],
            }
        closed_count = 0
        cancelled_count = 0
        for key, stop_event, connection in zip(keys, stop_events, stream_connections):
            logger.info(
                "contract_provider_ws_%s_subscription_stopping provider=%s symbol=%s",
                stream,
                key[0],
                key[1],
            )
            if stop_event is not None:
                stop_event.set()
                cancelled_count += 1
            self._close_ws_connection(key, connection, stream=stream)
            if connection is not None:
                closed_count += 1
        alive_after_stop: list[str] = []
        deadline = time.monotonic() + max(0.1, float(wait_seconds or 0))
        for key, thread in zip(keys, threads):
            remaining = max(0.0, deadline - time.monotonic())
            if not self._wait_for_ws_thread_exit(key, thread, timeout_seconds=remaining, stream=stream):
                alive_after_stop.append(str(key))
            clear_state(key, remove_cache=True)
        report = {
            "symbol": normalized_symbol,
            "stream": stream,
            "matched_keys": [str(key) for key in keys],
            "closed_count": closed_count,
            "cancelled_count": cancelled_count,
            "alive_after_stop": alive_after_stop,
        }
        logger.info("contract_provider_ws_%s_subscription_force_stop_report %s", stream, report)
        return report

    def _close_depth_connection(
        self,
        key: tuple[str, str],
        connection: Optional[tuple[asyncio.AbstractEventLoop, Any]],
    ) -> None:
        self._close_ws_connection(key, connection, stream="depth")

    def _close_ws_connection(
        self,
        key: tuple[str, str],
        connection: Optional[tuple[asyncio.AbstractEventLoop, Any]],
        *,
        stream: str,
    ) -> None:
        if connection is None:
            return
        loop, websocket = connection
        if loop.is_closed():
            logger.debug(
                "contract_provider_ws_%s_subscription_close_skipped_loop_closed provider=%s symbol=%s",
                stream,
                key[0],
                key[1],
            )
            return
        try:
            future = asyncio.run_coroutine_threadsafe(self._close_websocket(websocket), loop)
            future.result(timeout=2)
        except Exception:
            logger.info(
                "contract_provider_ws_%s_subscription_close_failed provider=%s symbol=%s",
                stream,
                key[0],
                key[1],
                exc_info=True,
            )

    async def _close_websocket(self, websocket: Any) -> None:
        close_task = asyncio.create_task(websocket.close())
        try:
            await asyncio.wait_for(close_task, timeout=1.0)
        except Exception:
            close_task.cancel()
            fail_connection = getattr(websocket, "fail_connection", None)
            if callable(fail_connection):
                fail_connection()
            transport = getattr(websocket, "transport", None)
            if transport is not None and not transport.is_closing():
                transport.close()
        wait_closed = getattr(websocket, "wait_closed", None)
        if callable(wait_closed):
            try:
                await asyncio.wait_for(wait_closed(), timeout=1.0)
            except Exception:
                transport = getattr(websocket, "transport", None)
                if transport is not None and not transport.is_closing():
                    transport.close()

    def _wait_for_depth_thread_exit(
        self,
        key: tuple[str, str],
        thread: Optional[threading.Thread],
        *,
        timeout_seconds: float,
    ) -> bool:
        return self._wait_for_ws_thread_exit(key, thread, timeout_seconds=timeout_seconds, stream="depth")

    def _wait_for_ws_thread_exit(
        self,
        key: tuple[str, str],
        thread: Optional[threading.Thread],
        *,
        timeout_seconds: float,
        stream: str,
    ) -> bool:
        if thread is None:
            return True
        if thread is threading.current_thread():
            return not thread.is_alive()
        if thread.is_alive():
            thread.join(timeout=max(0.0, timeout_seconds))
        alive = thread.is_alive()
        if alive:
            logger.warning(
                "contract_provider_ws_%s_subscription_thread_still_alive provider=%s symbol=%s",
                stream,
                key[0],
                key[1],
            )
        return not alive

    def _clear_depth_subscription_state(self, key: tuple[str, str], *, remove_cache: bool) -> None:
        with self._lock:
            self._depth_stops.pop(key, None)
            self._depth_tasks.pop(key, None)
            self._depth_connections.pop(key, None)
            self._depth_generations.pop(key, None)
            if remove_cache:
                self._depth_cache.pop(key, None)

    def _clear_trades_subscription_state(self, key: tuple[str, str], *, remove_cache: bool) -> None:
        with self._lock:
            self._trades_stops.pop(key, None)
            self._trades_tasks.pop(key, None)
            self._trades_connections.pop(key, None)
            self._trades_generations.pop(key, None)
            if remove_cache:
                self._trades_cache.pop(key, None)

    def _clear_ticker_subscription_state(self, key: tuple[str, str], *, remove_cache: bool) -> None:
        with self._lock:
            self._ticker_stops.pop(key, None)
            self._ticker_tasks.pop(key, None)
            self._ticker_connections.pop(key, None)
            self._ticker_generations.pop(key, None)
            if remove_cache:
                self._ticker_cache.pop(key, None)

    def _clear_kline_subscription_state(self, key: tuple[str, str, str], *, remove_cache: bool) -> None:
        with self._lock:
            self._kline_stops.pop(key, None)
            self._kline_tasks.pop(key, None)
            self._kline_connections.pop(key, None)
            self._kline_generations.pop(key, None)
            if remove_cache:
                self._kline_cache.pop(key, None)

    def debug_provider_ws_depth_subscriptions(self) -> dict[str, Any]:
        now_ms = int(time.time() * 1000)
        with self._lock:
            return {
                "tasks": {
                    str(key): bool(thread is not None and thread.is_alive())
                    for key, thread in self._depth_tasks.items()
                },
                "stops": {
                    str(key): bool(stop_event is not None and stop_event.is_set())
                    for key, stop_event in self._depth_stops.items()
                },
                "connections": sorted(map(str, self._depth_connections.keys())),
                "cache": {
                    str(key): {
                        "provider": key[0],
                        "local_symbol": key[1],
                        "age_ms": max(0, now_ms - int(item.get("updated_at_ms") or 0)),
                    }
                    for key, item in self._depth_cache.items()
                },
                "generations": {
                    str(key): generation
                    for key, generation in self._depth_generations.items()
                },
                "trades_tasks": {
                    str(key): bool(thread is not None and thread.is_alive())
                    for key, thread in self._trades_tasks.items()
                },
                "trades_stops": {
                    str(key): bool(stop_event is not None and stop_event.is_set())
                    for key, stop_event in self._trades_stops.items()
                },
                "trades_connections": sorted(map(str, self._trades_connections.keys())),
                "trades_cache": {
                    str(key): {
                        "provider": key[0],
                        "local_symbol": key[1],
                        "age_ms": max(0, now_ms - int(item.get("updated_at_ms") or 0)),
                        "count": len(item.get("trades") or []),
                    }
                    for key, item in self._trades_cache.items()
                },
                "trades_generations": {
                    str(key): generation
                    for key, generation in self._trades_generations.items()
                },
                "ticker_tasks": {
                    str(key): bool(thread is not None and thread.is_alive())
                    for key, thread in self._ticker_tasks.items()
                },
                "ticker_stops": {
                    str(key): bool(stop_event is not None and stop_event.is_set())
                    for key, stop_event in self._ticker_stops.items()
                },
                "ticker_connections": sorted(map(str, self._ticker_connections.keys())),
                "ticker_cache": {
                    str(key): {
                        "provider": key[0],
                        "local_symbol": key[1],
                        "age_ms": max(0, now_ms - int(item.get("updated_at_ms") or 0)),
                        "bid_price": str(item.get("bid_price") or ""),
                        "ask_price": str(item.get("ask_price") or ""),
                    }
                    for key, item in self._ticker_cache.items()
                },
                "ticker_generations": {
                    str(key): generation
                    for key, generation in self._ticker_generations.items()
                },
                "kline_tasks": {
                    str(key): bool(thread is not None and thread.is_alive())
                    for key, thread in self._kline_tasks.items()
                },
                "kline_stops": {
                    str(key): bool(stop_event is not None and stop_event.is_set())
                    for key, stop_event in self._kline_stops.items()
                },
                "kline_connections": sorted(map(str, self._kline_connections.keys())),
                "kline_cache": {
                    str(key): {
                        "provider": key[0],
                        "local_symbol": key[1],
                        "interval": key[2],
                        "age_ms": max(0, now_ms - int(item.get("updated_at_ms") or 0)),
                        "close": str(item.get("close") or ""),
                    }
                    for key, item in self._kline_cache.items()
                },
                "kline_generations": {
                    str(key): generation
                    for key, generation in self._kline_generations.items()
                },
            }

    def _run_depth_subscription_thread(
        self,
        subscription: ProviderDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._run_depth_subscription(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "contract_provider_ws_depth_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    def _run_trades_subscription_thread(
        self,
        subscription: ProviderTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._run_trades_subscription(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "contract_provider_ws_trades_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    def _run_ticker_subscription_thread(
        self,
        subscription: ProviderTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._run_ticker_subscription(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "contract_provider_ws_ticker_thread_failed provider=%s symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                exc_info=True,
            )

    def _run_kline_subscription_thread(
        self,
        subscription: ProviderKlineSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        try:
            asyncio.run(self._run_kline_subscription(subscription, stop_event, generation))
        except Exception:
            logger.warning(
                "contract_provider_ws_kline_thread_failed provider=%s symbol=%s interval=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.interval,
                exc_info=True,
            )

    async def _run_depth_subscription(
        self,
        subscription: ProviderDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if subscription.provider != PROVIDER_OKX_SWAP:
            return
        reconnect_delay = 1.0
        while not stop_event.is_set() and provider_ws_depth_enabled():
            try:
                await self._run_okx_depth_ws(subscription, stop_event, generation)
                reconnect_delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                if stop_event.is_set():
                    break
                logger.warning(
                    "contract_provider_ws_depth_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                try:
                    await asyncio.wait_for(asyncio.to_thread(stop_event.wait), timeout=reconnect_delay)
                    break
                except asyncio.TimeoutError:
                    pass
                reconnect_delay = min(reconnect_delay * 2, 15.0)
        logger.info(
            "contract_provider_ws_depth_subscription_thread_exiting provider=%s symbol=%s stop_requested=%s",
            subscription.provider,
            subscription.local_symbol,
            stop_event.is_set(),
        )

    async def _run_trades_subscription(
        self,
        subscription: ProviderTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if subscription.provider != PROVIDER_OKX_SWAP:
            return
        reconnect_delay = 1.0
        while not stop_event.is_set() and provider_ws_trades_enabled():
            try:
                await self._run_okx_trades_ws(subscription, stop_event, generation)
                reconnect_delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                if stop_event.is_set():
                    break
                logger.warning(
                    "contract_provider_ws_trades_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                try:
                    await asyncio.wait_for(asyncio.to_thread(stop_event.wait), timeout=reconnect_delay)
                    break
                except asyncio.TimeoutError:
                    pass
                reconnect_delay = min(reconnect_delay * 2, 15.0)
        logger.info(
            "contract_provider_ws_trades_subscription_thread_exiting provider=%s symbol=%s stop_requested=%s",
            subscription.provider,
            subscription.local_symbol,
            stop_event.is_set(),
        )

    async def _run_ticker_subscription(
        self,
        subscription: ProviderTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if subscription.provider != PROVIDER_OKX_SWAP:
            return
        reconnect_delay = 1.0
        while not stop_event.is_set() and provider_ws_ticker_enabled():
            try:
                await self._run_okx_ticker_ws(subscription, stop_event, generation)
                reconnect_delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                if stop_event.is_set():
                    break
                logger.warning(
                    "contract_provider_ws_ticker_disconnected provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    exc_info=True,
                )
                try:
                    await asyncio.wait_for(asyncio.to_thread(stop_event.wait), timeout=reconnect_delay)
                    break
                except asyncio.TimeoutError:
                    pass
                reconnect_delay = min(reconnect_delay * 2, 15.0)
        logger.info(
            "contract_provider_ws_ticker_subscription_thread_exiting provider=%s symbol=%s stop_requested=%s",
            subscription.provider,
            subscription.local_symbol,
            stop_event.is_set(),
        )

    async def _run_kline_subscription(
        self,
        subscription: ProviderKlineSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if subscription.provider != PROVIDER_OKX_SWAP:
            return
        reconnect_delay = 1.0
        while not stop_event.is_set() and provider_ws_kline_enabled():
            try:
                await self._run_okx_kline_ws(subscription, stop_event, generation)
                reconnect_delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                if stop_event.is_set():
                    break
                logger.warning(
                    "contract_provider_ws_kline_disconnected provider=%s symbol=%s provider_symbol=%s interval=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    subscription.interval,
                    exc_info=True,
                )
                try:
                    await asyncio.wait_for(asyncio.to_thread(stop_event.wait), timeout=reconnect_delay)
                    break
                except asyncio.TimeoutError:
                    pass
                reconnect_delay = min(reconnect_delay * 2, 15.0)
        logger.info(
            "contract_provider_ws_kline_subscription_thread_exiting provider=%s symbol=%s interval=%s stop_requested=%s",
            subscription.provider,
            subscription.local_symbol,
            subscription.interval,
            stop_event.is_set(),
        )

    async def _run_okx_depth_ws(
        self,
        subscription: ProviderDepthSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not provider_ws_depth_enabled():
            return
        url = str(getattr(settings, "CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL", "") or "").strip()
        if not url:
            raise ValueError("CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL is required")
        bids: dict[str, Decimal] = {}
        asks: dict[str, Decimal] = {}
        subscribe_payload = {
            "op": "subscribe",
            "args": [{"channel": "books", "instId": subscription.provider_symbol}],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not provider_ws_depth_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                current_generation = self._depth_generations.get(key)
                if current_generation != generation:
                    stop_event.set()
                    return
                self._depth_connections[key] = (loop, websocket)
            logger.info(
                "contract_provider_ws_depth_subscription_started provider=%s symbol=%s provider_symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                while not stop_event.is_set() and provider_ws_depth_enabled():
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    self._handle_okx_depth_message(subscription, raw_message, bids, asks)
            finally:
                with self._lock:
                    current = self._depth_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._depth_connections.pop(key, None)
                logger.info(
                    "contract_provider_ws_depth_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    async def _run_okx_trades_ws(
        self,
        subscription: ProviderTradesSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not provider_ws_trades_enabled():
            return
        url = str(getattr(settings, "CONTRACT_PROVIDER_WS_OKX_BUSINESS_URL", "") or "").strip()
        if not url:
            raise ValueError("CONTRACT_PROVIDER_WS_OKX_BUSINESS_URL is required")
        subscribe_payload = {
            "op": "subscribe",
            "args": [{"channel": "trades", "instId": subscription.provider_symbol}],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not provider_ws_trades_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                current_generation = self._trades_generations.get(key)
                if current_generation != generation:
                    stop_event.set()
                    return
                self._trades_connections[key] = (loop, websocket)
            logger.info(
                "contract_provider_ws_trades_subscription_started provider=%s symbol=%s provider_symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                while not stop_event.is_set() and provider_ws_trades_enabled():
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    self._handle_okx_trades_message(subscription, raw_message)
            finally:
                with self._lock:
                    current = self._trades_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._trades_connections.pop(key, None)
                logger.info(
                    "contract_provider_ws_trades_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    async def _run_okx_ticker_ws(
        self,
        subscription: ProviderTickerSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not provider_ws_ticker_enabled():
            return
        url = str(getattr(settings, "CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL", "") or "").strip()
        if not url:
            raise ValueError("CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL is required")
        subscribe_payload = {
            "op": "subscribe",
            "args": [{"channel": "tickers", "instId": subscription.provider_symbol}],
        }
        key = (subscription.provider, subscription.local_symbol)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not provider_ws_ticker_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                current_generation = self._ticker_generations.get(key)
                if current_generation != generation:
                    stop_event.set()
                    return
                self._ticker_connections[key] = (loop, websocket)
            logger.info(
                "contract_provider_ws_ticker_subscription_started provider=%s symbol=%s provider_symbol=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                while not stop_event.is_set() and provider_ws_ticker_enabled():
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    self._handle_okx_ticker_message(subscription, raw_message)
            finally:
                with self._lock:
                    current = self._ticker_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._ticker_connections.pop(key, None)
                logger.info(
                    "contract_provider_ws_ticker_subscription_stopped provider=%s symbol=%s provider_symbol=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                )

    async def _run_okx_kline_ws(
        self,
        subscription: ProviderKlineSubscription,
        stop_event: threading.Event,
        generation: int,
    ) -> None:
        if stop_event.is_set() or not provider_ws_kline_enabled():
            return
        url = str(getattr(settings, "CONTRACT_PROVIDER_WS_OKX_BUSINESS_URL", "") or "").strip()
        if not url:
            raise ValueError("CONTRACT_PROVIDER_WS_OKX_BUSINESS_URL is required")
        subscribe_payload = {
            "op": "subscribe",
            "args": [{"channel": subscription.channel, "instId": subscription.provider_symbol}],
        }
        key = (subscription.provider, subscription.local_symbol, subscription.interval)
        async with websockets.connect(url, ping_interval=20, ping_timeout=10, close_timeout=5) as websocket:
            if stop_event.is_set() or not provider_ws_kline_enabled():
                await websocket.close()
                return
            loop = asyncio.get_running_loop()
            with self._lock:
                current_generation = self._kline_generations.get(key)
                if current_generation != generation:
                    stop_event.set()
                    return
                self._kline_connections[key] = (loop, websocket)
            logger.info(
                "contract_provider_ws_kline_subscription_started provider=%s symbol=%s provider_symbol=%s interval=%s channel=%s",
                subscription.provider,
                subscription.local_symbol,
                subscription.provider_symbol,
                subscription.interval,
                subscription.channel,
            )
            try:
                await websocket.send(json.dumps(subscribe_payload, separators=(",", ":")))
                while not stop_event.is_set() and provider_ws_kline_enabled():
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    self._handle_okx_kline_message(subscription, raw_message)
            finally:
                with self._lock:
                    current = self._kline_connections.get(key)
                    if current is not None and current[1] is websocket:
                        self._kline_connections.pop(key, None)
                logger.info(
                    "contract_provider_ws_kline_subscription_stopped provider=%s symbol=%s provider_symbol=%s interval=%s",
                    subscription.provider,
                    subscription.local_symbol,
                    subscription.provider_symbol,
                    subscription.interval,
                )

    def _handle_okx_depth_message(
        self,
        subscription: ProviderDepthSubscription,
        raw_message: Any,
        bids: dict[str, Decimal],
        asks: dict[str, Decimal],
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("contract_provider_ws_okx_invalid_json symbol=%s", subscription.local_symbol)
            return
        if not isinstance(message, dict) or message.get("event"):
            return
        data = message.get("data")
        if not isinstance(data, list) or not data:
            return
        row = data[0]
        if not isinstance(row, dict):
            return
        action = str(message.get("action") or "").lower()
        if action == "snapshot" or not bids or not asks:
            bids.clear()
            asks.clear()
            bids.update(_normalize_okx_side(row.get("bids")))
            asks.update(_normalize_okx_side(row.get("asks")))
        else:
            _merge_okx_side(bids, row.get("bids"))
            _merge_okx_side(asks, row.get("asks"))
        self._set_depth_cache(
            subscription,
            bids=bids,
            asks=asks,
            sequence=row.get("seqId"),
            checksum=row.get("checksum"),
            exchange_ts=row.get("ts"),
        )

    def _handle_okx_trades_message(
        self,
        subscription: ProviderTradesSubscription,
        raw_message: Any,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("contract_provider_ws_okx_trades_invalid_json symbol=%s", subscription.local_symbol)
            return
        if not isinstance(message, dict) or message.get("event"):
            return
        data = message.get("data")
        if not isinstance(data, list) or not data:
            return
        trades: list[dict[str, Any]] = []
        for row in data:
            if not isinstance(row, dict):
                continue
            trade = self._normalize_okx_trade(subscription, row)
            if trade is not None:
                trades.append(trade)
        if trades:
            self._set_trades_cache(subscription, trades)

    def _handle_okx_ticker_message(
        self,
        subscription: ProviderTickerSubscription,
        raw_message: Any,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug("contract_provider_ws_okx_ticker_invalid_json symbol=%s", subscription.local_symbol)
            return
        if not isinstance(message, dict) or message.get("event"):
            return
        data = message.get("data")
        if not isinstance(data, list) or not data:
            return
        row = data[0]
        if not isinstance(row, dict):
            return
        payload = self._normalize_okx_ticker(subscription, row)
        if payload is not None:
            self._set_ticker_cache(subscription, payload)

    def _handle_okx_kline_message(
        self,
        subscription: ProviderKlineSubscription,
        raw_message: Any,
    ) -> None:
        try:
            message = json.loads(raw_message)
        except Exception:
            logger.debug(
                "contract_provider_ws_okx_kline_invalid_json symbol=%s interval=%s",
                subscription.local_symbol,
                subscription.interval,
            )
            return
        if not isinstance(message, dict) or message.get("event"):
            return
        data = message.get("data")
        if not isinstance(data, list) or not data:
            return
        row = data[0]
        if not isinstance(row, list):
            return
        payload = self._normalize_okx_kline(subscription, row)
        if payload is not None:
            self._set_kline_cache(subscription, payload)

    def _normalize_okx_trade(
        self,
        subscription: ProviderTradesSubscription,
        row: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        price = _to_decimal(row.get("px"))
        qty = _to_decimal(row.get("sz"))
        if price is None or qty is None or price <= 0 or qty <= 0:
            return None
        ts = _timestamp_ms_from_value(row.get("ts"))
        side_text = str(row.get("side") or "").strip().lower()
        is_buyer_maker = side_text == "sell"
        trade_id = row.get("tradeId") or f"{subscription.provider_symbol}:{ts}:{format(price, 'f')}:{format(qty, 'f')}"
        return {
            "id": str(trade_id),
            "symbol": subscription.local_symbol,
            "provider": subscription.provider,
            "provider_symbol": subscription.provider_symbol,
            "price": format(price, "f"),
            "qty": format(qty, "f"),
            "amount": format(qty, "f"),
            "quoteQty": format(price * qty, "f"),
            "time": ts,
            "ts": ts,
            "side": side_text.upper() if side_text else None,
            "isBuyerMaker": is_buyer_maker,
            "source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_freshness": "LIVE",
        }

    def _normalize_okx_ticker(
        self,
        subscription: ProviderTickerSubscription,
        row: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        bid_price = _to_decimal(row.get("bidPx"))
        ask_price = _to_decimal(row.get("askPx"))
        last_price = _to_decimal(row.get("last"))
        if bid_price is None or ask_price is None or bid_price <= 0 or ask_price <= 0:
            return None
        if last_price is None or last_price <= 0:
            last_price = (bid_price + ask_price) / Decimal("2")
        mark_price = (bid_price + ask_price) / Decimal("2")
        ts_ms = _timestamp_ms_from_value(row.get("ts"))
        ts = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        open_24h = _to_decimal(row.get("open24h"))
        high_24h = _to_decimal(row.get("high24h"))
        low_24h = _to_decimal(row.get("low24h"))
        base_volume_24h = _to_decimal(row.get("vol24h"))
        quote_volume_24h = _to_decimal(row.get("volCcy24h"))
        price_change_percent_24h = None
        if open_24h is not None and open_24h > 0 and last_price is not None:
            price_change_percent_24h = ((last_price - open_24h) / open_24h) * Decimal("100")
        return {
            "symbol": subscription.local_symbol,
            "provider": subscription.provider,
            "provider_symbol": subscription.provider_symbol,
            "bid_price": bid_price,
            "ask_price": ask_price,
            "best_bid": bid_price,
            "best_ask": ask_price,
            "raw_bid_price": bid_price,
            "raw_ask_price": ask_price,
            "bid_size": _to_decimal(row.get("bidSz")),
            "ask_size": _to_decimal(row.get("askSz")),
            "last_price": last_price,
            "mark_price": mark_price,
            "index_price": mark_price,
            "open_24h": open_24h,
            "high_24h": high_24h,
            "low_24h": low_24h,
            "base_volume_24h": base_volume_24h,
            "quote_volume_24h": quote_volume_24h,
            "price_change_percent_24h": price_change_percent_24h,
            "source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_freshness": "LIVE",
            "is_realtime": True,
            "executable": True,
            "ts": ts,
            "exchange_ts": row.get("ts"),
        }

    def _normalize_okx_kline(
        self,
        subscription: ProviderKlineSubscription,
        row: list[Any],
    ) -> Optional[dict[str, Any]]:
        if len(row) < 6:
            return None
        open_time_ms = _timestamp_ms_from_value(row[0])
        open_price = _to_decimal(row[1])
        high_price = _to_decimal(row[2])
        low_price = _to_decimal(row[3])
        close_price = _to_decimal(row[4])
        volume = _to_decimal(row[5])
        if (
            open_time_ms <= 0
            or open_price is None
            or high_price is None
            or low_price is None
            or close_price is None
        ):
            return None
        quote_volume = _to_decimal(row[7] if len(row) > 7 else None)
        confirm = str(row[8] if len(row) > 8 else "").strip()
        return {
            "symbol": subscription.local_symbol,
            "provider": subscription.provider,
            "provider_symbol": subscription.provider_symbol,
            "interval": subscription.interval,
            "open_time_ms": open_time_ms,
            "open_time": open_time_ms,
            "time": int(open_time_ms / 1000),
            "open": format(open_price, "f"),
            "high": format(high_price, "f"),
            "low": format(low_price, "f"),
            "close": format(close_price, "f"),
            "volume": format(volume or Decimal("0"), "f"),
            "quote_volume": format(quote_volume, "f") if quote_volume is not None else None,
            "is_closed": confirm == "1" if confirm else None,
            "is_final": confirm == "1" if confirm else False,
            "source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_freshness": "LIVE",
            "exchange_ts": row[0],
        }

    def _set_trades_cache(
        self,
        subscription: ProviderTradesSubscription,
        trades: list[dict[str, Any]],
    ) -> None:
        now_ms = int(time.time() * 1000)
        now = datetime.now(timezone.utc)
        key = (subscription.provider, subscription.local_symbol)
        with self._lock:
            previous = list(self._trades_cache.get(key, {}).get("trades") or [])
            seen: set[str] = set()
            merged: list[dict[str, Any]] = []
            for item in trades + previous:
                trade_id = str(item.get("id") or "")
                if not trade_id or trade_id in seen:
                    continue
                seen.add(trade_id)
                merged.append(item)
                if len(merged) >= subscription.trades_limit:
                    break
            self._trades_cache[key] = {
                "symbol": subscription.local_symbol,
                "provider": subscription.provider,
                "provider_symbol": subscription.provider_symbol,
                "trades": merged,
                "source": CONTRACT_PROVIDER_WS_SOURCE,
                "quote_source": CONTRACT_PROVIDER_WS_SOURCE,
                "quote_freshness": "LIVE",
                "ts": now,
                "updated_at": now,
                "updated_at_ms": now_ms,
            }

    def _set_ticker_cache(
        self,
        subscription: ProviderTickerSubscription,
        payload: dict[str, Any],
    ) -> None:
        now_ms = int(time.time() * 1000)
        now = datetime.now(timezone.utc)
        with self._lock:
            self._ticker_cache[(subscription.provider, subscription.local_symbol)] = {
                **payload,
                "updated_at": now,
                "updated_at_ms": now_ms,
            }

    def _set_kline_cache(
        self,
        subscription: ProviderKlineSubscription,
        payload: dict[str, Any],
    ) -> None:
        now_ms = int(time.time() * 1000)
        now = datetime.now(timezone.utc)
        key = (subscription.provider, subscription.local_symbol, subscription.interval)
        with self._lock:
            self._kline_cache[key] = {
                **payload,
                "updated_at": now,
                "updated_at_ms": now_ms,
                "ts": now,
            }

    def _set_depth_cache(
        self,
        subscription: ProviderDepthSubscription,
        *,
        bids: dict[str, Decimal],
        asks: dict[str, Decimal],
        sequence: Any = None,
        checksum: Any = None,
        exchange_ts: Any = None,
    ) -> None:
        bid_levels = _sort_depth_side(bids, side="bids", limit=subscription.depth_limit)
        ask_levels = _sort_depth_side(asks, side="asks", limit=subscription.depth_limit)
        if not bid_levels or not ask_levels:
            return
        now_ms = int(time.time() * 1000)
        now = datetime.now(timezone.utc)
        payload = {
            "symbol": subscription.local_symbol,
            "provider": subscription.provider,
            "provider_symbol": subscription.provider_symbol,
            "bids": bid_levels,
            "asks": ask_levels,
            "best_bid": _best_depth_price(bid_levels, side="bids"),
            "best_ask": _best_depth_price(ask_levels, side="asks"),
            "source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_source": CONTRACT_PROVIDER_WS_SOURCE,
            "quote_freshness": "LIVE",
            "is_realtime": True,
            "executable": True,
            "ts": now,
            "updated_at": now,
            "updated_at_ms": now_ms,
            "sequence": sequence,
            "checksum": checksum,
            "exchange_ts": exchange_ts,
        }
        with self._lock:
            self._depth_cache[(subscription.provider, subscription.local_symbol)] = payload


contract_market_provider_ws = ContractMarketProviderWsService()


def get_fresh_provider_ws_depth(
    symbol: str,
    provider_code: Optional[str] = None,
    *,
    max_age_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.get_fresh_provider_ws_depth(
        symbol,
        provider_code,
        max_age_ms=max_age_ms,
    )


def select_fresh_provider_ws_depth(
    db: Session,
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
    ensure_subscription: bool = False,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.select_fresh_depth_for_enabled_providers(
        db,
        symbol,
        max_age_ms=max_age_ms,
        ensure_subscription=ensure_subscription,
    )


def get_fresh_provider_ws_trades(
    symbol: str,
    provider_code: Optional[str] = None,
    *,
    max_age_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.get_fresh_provider_ws_trades(
        symbol,
        provider_code,
        max_age_ms=max_age_ms,
    )


def select_fresh_provider_ws_trades(
    db: Session,
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
    ensure_subscription: bool = False,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.select_fresh_trades_for_enabled_providers(
        db,
        symbol,
        max_age_ms=max_age_ms,
        ensure_subscription=ensure_subscription,
    )


def get_fresh_provider_ws_ticker(
    symbol: str,
    provider_code: Optional[str] = None,
    *,
    max_age_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.get_fresh_provider_ws_ticker(
        symbol,
        provider_code,
        max_age_ms=max_age_ms,
    )


def select_fresh_provider_ws_ticker(
    db: Session,
    symbol: str,
    *,
    max_age_ms: Optional[int] = None,
    ensure_subscription: bool = False,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.select_fresh_ticker_for_enabled_providers(
        db,
        symbol,
        max_age_ms=max_age_ms,
        ensure_subscription=ensure_subscription,
    )


def get_fresh_provider_ws_kline(
    symbol: str,
    interval: str,
    provider_code: Optional[str] = None,
    *,
    max_age_ms: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.get_fresh_provider_ws_kline(
        symbol,
        interval,
        provider_code,
        max_age_ms=max_age_ms,
    )


def select_fresh_provider_ws_kline(
    db: Session,
    symbol: str,
    interval: str,
    *,
    max_age_ms: Optional[int] = None,
    ensure_subscription: bool = False,
) -> Optional[dict[str, Any]]:
    return contract_market_provider_ws.select_fresh_kline_for_enabled_providers(
        db,
        symbol,
        interval,
        max_age_ms=max_age_ms,
        ensure_subscription=ensure_subscription,
    )


def stop_provider_ws_depth_subscriptions_for_symbol(symbol: str) -> None:
    contract_market_provider_ws.stop_depth_subscriptions_for_symbol(symbol)


def force_stop_provider_ws_depth_subscriptions_for_symbol(
    symbol: str,
    *,
    wait_seconds: float = 3.0,
) -> dict[str, Any]:
    return contract_market_provider_ws.force_stop_depth_subscriptions_for_symbol(
        symbol,
        wait_seconds=wait_seconds,
    )


def force_stop_provider_ws_subscriptions_for_symbol(
    symbol: str,
    *,
    wait_seconds: float = 3.0,
) -> dict[str, Any]:
    return contract_market_provider_ws.force_stop_depth_subscriptions_for_symbol(
        symbol,
        wait_seconds=wait_seconds,
    )


def debug_provider_ws_depth_subscriptions() -> dict[str, Any]:
    return contract_market_provider_ws.debug_provider_ws_depth_subscriptions()
