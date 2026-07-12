from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Literal, Optional, cast

from app.services.market_freshness import MarketFreshness, resolve_market_freshness


MarketDomain = Literal["ticker", "depth", "trades", "kline"]
_MARKET_DOMAINS = {"ticker", "depth", "trades", "kline"}


@dataclass(frozen=True)
class MarketDomainSnapshot:
    symbol: str
    domain: MarketDomain
    data: Any
    source: str
    provider: Optional[str]
    freshness: MarketFreshness
    updated_at: Optional[int]
    age_ms: Optional[int]
    version: str
    fallback_reason: Optional[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "domain": self.domain,
            "data": deepcopy(self.data),
            "source": self.source,
            "provider": self.provider,
            "freshness": self.freshness,
            "updated_at": self.updated_at,
            "age_ms": self.age_ms,
            "version": self.version,
            "fallback_reason": self.fallback_reason,
        }


def build_market_domain_snapshot(
    *,
    symbol: str,
    domain: str,
    data: Any,
    source: str,
    provider: Optional[str],
    updated_at: Optional[int],
    version: str,
    max_age_ms: int,
    fallback_reason: Optional[str] = None,
    now_ms: Optional[int] = None,
) -> MarketDomainSnapshot:
    normalized_symbol = str(symbol or "").strip().upper()
    if not normalized_symbol:
        raise ValueError("market domain snapshot symbol is required")

    normalized_domain = str(domain or "").strip().lower()
    if normalized_domain not in _MARKET_DOMAINS:
        raise ValueError("invalid market domain snapshot domain")

    normalized_source = str(source or "MISSING").strip() or "MISSING"
    normalized_updated_at = _positive_int(updated_at)
    resolved_freshness = resolve_market_freshness(
        source=normalized_source,
        updated_at=normalized_updated_at,
        max_age_ms=max_age_ms,
        now_ms=now_ms,
    )
    return MarketDomainSnapshot(
        symbol=normalized_symbol,
        domain=cast(MarketDomain, normalized_domain),
        data=deepcopy(data),
        source=normalized_source,
        provider=str(provider or "").strip() or None,
        freshness=resolved_freshness.freshness,
        updated_at=normalized_updated_at,
        age_ms=resolved_freshness.age_ms,
        version=str(version or "").strip(),
        fallback_reason=str(fallback_reason or "").strip() or None,
    )


def _positive_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


__all__ = [
    "MarketDomain",
    "MarketDomainSnapshot",
    "build_market_domain_snapshot",
]
