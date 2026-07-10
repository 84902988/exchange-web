from __future__ import annotations

import time
from copy import deepcopy
from dataclasses import dataclass
from threading import RLock
from typing import Optional

from app.schemas.market import DepthResponse


@dataclass(frozen=True)
class SpotGatewayDomainKey:
    domain: str
    provider: str
    symbol: str
    interval: Optional[str] = None


def _normalize_symbol(value: object) -> str:
    raw = str(value or "").strip().upper()
    return "".join(ch for ch in raw if ch.isalnum())


def make_domain_key(
    domain: str,
    provider: str,
    symbol: str,
    interval: Optional[str] = None,
) -> SpotGatewayDomainKey:
    normalized_interval = str(interval or "").strip().lower() or None
    return SpotGatewayDomainKey(
        domain=str(domain or "").strip().lower(),
        provider=str(provider or "").strip().upper(),
        symbol=_normalize_symbol(symbol),
        interval=normalized_interval,
    )


class SpotGatewayBroadcastState:
    def __init__(self) -> None:
        self._last_signatures: dict[SpotGatewayDomainKey, str] = {}
        self._last_broadcast_at_ms: dict[SpotGatewayDomainKey, int] = {}
        self._seen_trade_signatures: dict[SpotGatewayDomainKey, list[str]] = {}

    def now_ms(self) -> int:
        return int(time.monotonic() * 1000)

    def should_broadcast_domain(
        self,
        domain_key: SpotGatewayDomainKey,
        signature: Optional[str],
        min_interval_ms: int,
        now_ms: Optional[int] = None,
    ) -> bool:
        current_ms = int(now_ms if now_ms is not None else self.now_ms())
        min_interval = max(0, int(min_interval_ms or 0))
        last_at = self._last_broadcast_at_ms.get(domain_key)
        if last_at is not None and current_ms - last_at < min_interval:
            return False
        if signature is not None and self._last_signatures.get(domain_key) == signature:
            return False
        return True

    def remember_broadcast(
        self,
        domain_key: SpotGatewayDomainKey,
        signature: Optional[str],
        now_ms: Optional[int] = None,
    ) -> None:
        current_ms = int(now_ms if now_ms is not None else self.now_ms())
        if signature is not None:
            self._last_signatures[domain_key] = signature
        self._last_broadcast_at_ms[domain_key] = current_ms

    def remember_trade_signatures(
        self,
        domain_key: SpotGatewayDomainKey,
        signatures: list[str],
        max_seen: int = 200,
    ) -> None:
        clean_signatures = [signature for signature in signatures if signature]
        if not clean_signatures:
            return
        retained = (self._seen_trade_signatures.get(domain_key, []) + clean_signatures)[-max_seen:]
        self._seen_trade_signatures[domain_key] = retained

    def has_seen_trade_signature(self, domain_key: SpotGatewayDomainKey, signature: str) -> bool:
        if not signature:
            return False
        return signature in set(self._seen_trade_signatures.get(domain_key, []))

    def clear_domain_key(self, domain_key: SpotGatewayDomainKey) -> None:
        self._last_signatures.pop(domain_key, None)
        self._last_broadcast_at_ms.pop(domain_key, None)
        self._seen_trade_signatures.pop(domain_key, None)

    def clear_symbol(self, symbol: str) -> None:
        normalized_symbol = _normalize_symbol(symbol)
        if not normalized_symbol:
            return
        for key in [key for key in self._last_signatures if key.symbol == normalized_symbol]:
            self._last_signatures.pop(key, None)
        for key in [key for key in self._last_broadcast_at_ms if key.symbol == normalized_symbol]:
            self._last_broadcast_at_ms.pop(key, None)
        for key in [key for key in self._seen_trade_signatures if key.symbol == normalized_symbol]:
            self._seen_trade_signatures.pop(key, None)


@dataclass(frozen=True)
class SpotGatewayDepthState:
    symbol: str
    provider: str
    provider_symbol: str
    depth: DepthResponse
    event_time_ms: int
    received_at_ms: int
    freshness: str
    source: str
    provider_generation: int
    fallback_active: bool = False


class SpotGatewayDepthAuthority:
    """Thread-safe authority for the display and execution depth provider."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._active_providers: dict[str, str] = {}
        self._generations: dict[str, int] = {}
        self._fallback_active: dict[str, bool] = {}
        self._states: dict[str, SpotGatewayDepthState] = {}

    def ensure_provider(self, symbol: str, provider: str) -> tuple[str, int]:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_provider = str(provider or "").strip().upper()
        if not normalized_symbol or not normalized_provider:
            return "", 0
        with self._lock:
            current = self._active_providers.get(normalized_symbol)
            if current is None:
                self._active_providers[normalized_symbol] = normalized_provider
                self._generations[normalized_symbol] = 1
                self._fallback_active[normalized_symbol] = False
            elif current != normalized_provider and not self._fallback_active.get(normalized_symbol, False):
                self._active_providers[normalized_symbol] = normalized_provider
                self._generations[normalized_symbol] = self._generations.get(normalized_symbol, 0) + 1
                self._states.pop(normalized_symbol, None)
            return self._active_providers[normalized_symbol], self._generations[normalized_symbol]

    def active_provider(self, symbol: str) -> Optional[str]:
        with self._lock:
            return self._active_providers.get(_normalize_symbol(symbol))

    def active_generation(self, symbol: str) -> int:
        with self._lock:
            return int(self._generations.get(_normalize_symbol(symbol), 0))

    def fallback_active(self, symbol: str) -> bool:
        with self._lock:
            return bool(self._fallback_active.get(_normalize_symbol(symbol), False))

    def snapshot(self, symbol: str) -> Optional[SpotGatewayDepthState]:
        with self._lock:
            state = self._states.get(_normalize_symbol(symbol))
            if state is None:
                return None
            return SpotGatewayDepthState(
                symbol=state.symbol,
                provider=state.provider,
                provider_symbol=state.provider_symbol,
                depth=deepcopy(state.depth),
                event_time_ms=state.event_time_ms,
                received_at_ms=state.received_at_ms,
                freshness=state.freshness,
                source=state.source,
                provider_generation=state.provider_generation,
                fallback_active=state.fallback_active,
            )

    def commit(
        self,
        *,
        symbol: str,
        provider: str,
        provider_symbol: str,
        depth: DepthResponse,
        event_time_ms: int,
        received_at_ms: int,
        freshness: str,
        source: str,
        allow_switch: bool = False,
        expected_provider: Optional[str] = None,
    ) -> Optional[SpotGatewayDepthState]:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_provider = str(provider or "").strip().upper()
        if not normalized_symbol or not normalized_provider:
            return None
        with self._lock:
            current_provider = self._active_providers.get(normalized_symbol)
            if current_provider is None:
                self._active_providers[normalized_symbol] = normalized_provider
                self._generations[normalized_symbol] = 1
                self._fallback_active[normalized_symbol] = False
                current_provider = normalized_provider
            if current_provider != normalized_provider:
                if not allow_switch:
                    return None
                expected = str(expected_provider or "").strip().upper()
                if expected and current_provider != expected:
                    return None
                self._active_providers[normalized_symbol] = normalized_provider
                self._generations[normalized_symbol] = self._generations.get(normalized_symbol, 0) + 1
                self._fallback_active[normalized_symbol] = True
                current_provider = normalized_provider
            generation = self._generations.get(normalized_symbol, 1)
            current_state = self._states.get(normalized_symbol)
            if current_state is not None and current_state.provider_generation == generation:
                incoming_event = int(event_time_ms or 0)
                current_event = int(current_state.event_time_ms or 0)
                if incoming_event and current_event and incoming_event < current_event:
                    return None
                if incoming_event == current_event and int(received_at_ms or 0) < current_state.received_at_ms:
                    return None
            state = SpotGatewayDepthState(
                symbol=normalized_symbol,
                provider=current_provider,
                provider_symbol=str(provider_symbol or "").strip().upper(),
                depth=deepcopy(depth),
                event_time_ms=int(event_time_ms or 0),
                received_at_ms=int(received_at_ms or 0),
                freshness=str(freshness or "").strip().upper(),
                source=str(source or "").strip().upper(),
                provider_generation=generation,
                fallback_active=bool(self._fallback_active.get(normalized_symbol, False)),
            )
            self._states[normalized_symbol] = state
            return self.snapshot(normalized_symbol)

    def clear_symbol(self, symbol: str) -> None:
        normalized_symbol = _normalize_symbol(symbol)
        with self._lock:
            self._active_providers.pop(normalized_symbol, None)
            self._generations.pop(normalized_symbol, None)
            self._fallback_active.pop(normalized_symbol, None)
            self._states.pop(normalized_symbol, None)
