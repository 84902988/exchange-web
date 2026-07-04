from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional


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
