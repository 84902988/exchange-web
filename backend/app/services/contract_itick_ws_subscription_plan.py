from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
from typing import Dict, FrozenSet, Tuple


ITICK_WS_STREAMS = frozenset({"quote", "tick", "depth", "kline@1"})


@dataclass(frozen=True)
class ItickWsSubscriptionKey:
    market: str
    symbol: str
    stream: str


@dataclass(frozen=True)
class ItickWsMarketPlan:
    market: str
    revision: int
    symbols_by_stream: Tuple[Tuple[str, Tuple[str, ...]], ...]

    def symbols_for(self, stream: str) -> Tuple[str, ...]:
        normalized = str(stream or "").strip().lower()
        for planned_stream, symbols in self.symbols_by_stream:
            if planned_stream == normalized:
                return symbols
        return ()


class ItickWsSubscriptionPlan:
    """Thread-safe logical subscriptions grouped by one physical market socket."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._references: Dict[ItickWsSubscriptionKey, int] = {}
        self._market_revisions: Dict[str, int] = {}

    @staticmethod
    def normalize_market(value: object) -> str:
        normalized = str(value or "").strip().lower()
        if normalized not in {"stock", "forex", "indices", "future"}:
            raise ValueError("unsupported iTick websocket market")
        return normalized

    @staticmethod
    def normalize_symbol(value: object) -> str:
        normalized = str(value or "").strip().upper()
        if not normalized:
            raise ValueError("iTick websocket symbol is required")
        return normalized

    @staticmethod
    def normalize_stream(value: object) -> str:
        normalized = str(value or "").strip().lower()
        if normalized not in ITICK_WS_STREAMS:
            raise ValueError("unsupported iTick websocket stream")
        return normalized

    def acquire(self, *, market: object, symbol: object, stream: object) -> int:
        key = ItickWsSubscriptionKey(
            market=self.normalize_market(market),
            symbol=self.normalize_symbol(symbol),
            stream=self.normalize_stream(stream),
        )
        with self._lock:
            previous = self._references.get(key, 0)
            self._references[key] = previous + 1
            if previous == 0:
                self._market_revisions[key.market] = self._market_revisions.get(key.market, 0) + 1
            return self._references[key]

    def release(self, *, market: object, symbol: object, stream: object) -> int:
        key = ItickWsSubscriptionKey(
            market=self.normalize_market(market),
            symbol=self.normalize_symbol(symbol),
            stream=self.normalize_stream(stream),
        )
        with self._lock:
            previous = self._references.get(key, 0)
            if previous <= 1:
                if previous == 1:
                    self._references.pop(key, None)
                    self._market_revisions[key.market] = self._market_revisions.get(key.market, 0) + 1
                return 0
            self._references[key] = previous - 1
            return self._references[key]

    def reference_count(self, *, market: object, symbol: object, stream: object) -> int:
        key = ItickWsSubscriptionKey(
            market=self.normalize_market(market),
            symbol=self.normalize_symbol(symbol),
            stream=self.normalize_stream(stream),
        )
        with self._lock:
            return self._references.get(key, 0)

    def market_plan(self, market: object) -> ItickWsMarketPlan:
        normalized_market = self.normalize_market(market)
        with self._lock:
            grouped: Dict[str, set[str]] = {stream: set() for stream in ITICK_WS_STREAMS}
            for key, references in self._references.items():
                if key.market == normalized_market and references > 0:
                    grouped[key.stream].add(key.symbol)
            symbols_by_stream = tuple(
                (stream, tuple(sorted(grouped[stream])))
                for stream in sorted(ITICK_WS_STREAMS)
                if grouped[stream]
            )
            return ItickWsMarketPlan(
                market=normalized_market,
                revision=self._market_revisions.get(normalized_market, 0),
                symbols_by_stream=symbols_by_stream,
            )

    def active_markets(self) -> FrozenSet[str]:
        with self._lock:
            return frozenset(key.market for key, references in self._references.items() if references > 0)
