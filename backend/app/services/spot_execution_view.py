from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models.trading_pair import TradingPair
from app.schemas.market import DepthItem, DepthResponse
from app.services.contract_market_provider_service import (
    MARKET_TYPE_SPOT,
    MarketDataProviderConfig,
    enabled_spot_market_providers,
    mark_contract_market_provider_failure,
    mark_contract_market_provider_success,
    request_contract_market_provider_json,
    resolve_spot_provider_symbol,
)
from app.services.spot_market_gateway import spot_market_gateway
from app.services.spot_market_provider_ws import get_spot_provider_ws_depth


_EXECUTABLE_SOURCES = {"LIVE_WS", "REST"}
_EXECUTABLE_FRESHNESS = {"LIVE", "RECENT"}


class SpotExecutionUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class SpotExecutionSnapshot:
    symbol: str
    provider: str
    provider_symbol: str
    best_bid: Decimal
    best_ask: Decimal
    event_time_ms: int
    received_at_ms: int
    freshness: str
    source: str
    max_age_ms: int
    snapshot_id: str
    provider_generation: int


@dataclass(frozen=True)
class SpotExecutionGuardResult:
    executable: bool
    reject_reason: Optional[str]
    age_ms: int


def _now_ms() -> int:
    return int(time.time() * 1000)


def _max_age_ms() -> int:
    return max(100, int(getattr(settings, "SPOT_PROVIDER_WS_DEPTH_MAX_AGE_MS", 1500) or 1500))


def _decimal(value: Any) -> Optional[Decimal]:
    try:
        result = Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
    return result if result > 0 else None


def _best_prices(depth: DepthResponse) -> tuple[Optional[Decimal], Optional[Decimal]]:
    bid = _decimal(depth.bids[0].price) if depth.bids else None
    ask = _decimal(depth.asks[0].price) if depth.asks else None
    return bid, ask


def _snapshot_id(
    *,
    symbol: str,
    provider: str,
    provider_symbol: str,
    best_bid: Decimal,
    best_ask: Decimal,
    event_time_ms: int,
    received_at_ms: int,
    provider_generation: int,
) -> str:
    payload = json.dumps(
        {
            "symbol": symbol,
            "provider": provider,
            "provider_symbol": provider_symbol,
            "best_bid": format(best_bid, "f"),
            "best_ask": format(best_ask, "f"),
            "event_time_ms": event_time_ms,
            "received_at_ms": received_at_ms,
            "provider_generation": provider_generation,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _build_snapshot(
    *,
    symbol: str,
    provider: str,
    provider_symbol: str,
    depth: DepthResponse,
    event_time_ms: int,
    received_at_ms: int,
    freshness: str,
    source: str,
    provider_generation: int,
    max_age_ms: int,
    now_ms: Optional[int] = None,
) -> Optional[SpotExecutionSnapshot]:
    normalized_provider = str(provider or "").strip().upper()
    normalized_source = str(source or "").strip().upper()
    normalized_freshness = str(freshness or "").strip().upper()
    bid, ask = _best_prices(depth)
    current_ms = int(now_ms if now_ms is not None else _now_ms())
    received_at = int(received_at_ms or 0)
    if (
        bid is None
        or ask is None
        or ask < bid
        or not normalized_provider
        or not str(provider_symbol or "").strip()
        or int(event_time_ms or 0) <= 0
        or received_at <= 0
        or received_at > current_ms + 1000
        or current_ms - received_at > max_age_ms
        or normalized_source not in _EXECUTABLE_SOURCES
        or normalized_freshness not in _EXECUTABLE_FRESHNESS
        or int(provider_generation or 0) <= 0
    ):
        return None
    normalized_symbol = str(symbol or "").strip().upper()
    provider_symbol_value = str(provider_symbol or "").strip().upper()
    snapshot_hash = _snapshot_id(
        symbol=normalized_symbol,
        provider=normalized_provider,
        provider_symbol=provider_symbol_value,
        best_bid=bid,
        best_ask=ask,
        event_time_ms=int(event_time_ms),
        received_at_ms=received_at,
        provider_generation=int(provider_generation),
    )
    return SpotExecutionSnapshot(
        symbol=normalized_symbol,
        provider=normalized_provider,
        provider_symbol=provider_symbol_value,
        best_bid=bid,
        best_ask=ask,
        event_time_ms=int(event_time_ms),
        received_at_ms=received_at,
        freshness=normalized_freshness,
        source=normalized_source,
        max_age_ms=max_age_ms,
        snapshot_id=snapshot_hash,
        provider_generation=int(provider_generation),
    )


def _if_current_gateway_snapshot(
    snapshot: Optional[SpotExecutionSnapshot],
) -> Optional[SpotExecutionSnapshot]:
    if snapshot is None:
        return None
    active_provider, active_generation = spot_market_gateway.get_active_depth_provider(snapshot.symbol)
    if (
        str(active_provider or "").strip().upper() != snapshot.provider
        or int(active_generation or 0) != snapshot.provider_generation
    ):
        return None
    return snapshot


def guard_spot_execution_snapshot(
    snapshot: Optional[SpotExecutionSnapshot],
    *,
    now_ms: Optional[int] = None,
) -> SpotExecutionGuardResult:
    current_ms = int(now_ms if now_ms is not None else _now_ms())
    if snapshot is None:
        return SpotExecutionGuardResult(False, "SNAPSHOT_MISSING", 0)

    received_at_ms = int(snapshot.received_at_ms or 0)
    age_ms = current_ms - received_at_ms if received_at_ms > 0 else 0
    if received_at_ms <= 0:
        return SpotExecutionGuardResult(False, "RECEIVED_AT_MISSING", age_ms)
    if received_at_ms > current_ms + 1000:
        return SpotExecutionGuardResult(False, "RECEIVED_AT_IN_FUTURE", age_ms)
    if age_ms > int(snapshot.max_age_ms or 0):
        return SpotExecutionGuardResult(False, "SNAPSHOT_EXPIRED", age_ms)
    if (
        not snapshot.symbol
        or not snapshot.provider
        or not snapshot.provider_symbol
        or snapshot.event_time_ms <= 0
        or snapshot.provider_generation <= 0
        or snapshot.max_age_ms <= 0
    ):
        return SpotExecutionGuardResult(False, "SNAPSHOT_EVIDENCE_INVALID", age_ms)
    if (
        snapshot.best_bid <= 0
        or snapshot.best_ask <= 0
        or snapshot.best_ask < snapshot.best_bid
    ):
        return SpotExecutionGuardResult(False, "BBO_INVALID", age_ms)
    if snapshot.source not in _EXECUTABLE_SOURCES:
        return SpotExecutionGuardResult(False, "SOURCE_NOT_EXECUTABLE", age_ms)
    if snapshot.freshness not in _EXECUTABLE_FRESHNESS:
        return SpotExecutionGuardResult(False, "FRESHNESS_NOT_EXECUTABLE", age_ms)
    expected_snapshot_id = _snapshot_id(
        symbol=snapshot.symbol,
        provider=snapshot.provider,
        provider_symbol=snapshot.provider_symbol,
        best_bid=snapshot.best_bid,
        best_ask=snapshot.best_ask,
        event_time_ms=snapshot.event_time_ms,
        received_at_ms=snapshot.received_at_ms,
        provider_generation=snapshot.provider_generation,
    )
    if expected_snapshot_id != snapshot.snapshot_id:
        return SpotExecutionGuardResult(False, "SNAPSHOT_ID_MISMATCH", age_ms)

    state = spot_market_gateway.get_authoritative_depth(snapshot.symbol)
    if state is None:
        return SpotExecutionGuardResult(False, "AUTHORITATIVE_DEPTH_MISSING", age_ms)
    if state.provider != snapshot.provider:
        return SpotExecutionGuardResult(False, "PROVIDER_RETIRED", age_ms)
    if state.provider_generation != snapshot.provider_generation:
        return SpotExecutionGuardResult(False, "GENERATION_RETIRED", age_ms)
    state_bid, state_ask = _best_prices(state.depth)
    if state_bid is None or state_ask is None or state_ask < state_bid:
        return SpotExecutionGuardResult(False, "AUTHORITATIVE_BBO_INVALID", age_ms)
    if (
        state_bid != snapshot.best_bid
        or state_ask != snapshot.best_ask
        or state.event_time_ms != snapshot.event_time_ms
        or state.received_at_ms != snapshot.received_at_ms
        or state.source != snapshot.source
        or state.freshness != snapshot.freshness
    ):
        return SpotExecutionGuardResult(False, "SNAPSHOT_RETIRED", age_ms)
    if state.provider_symbol and state.provider_symbol != snapshot.provider_symbol:
        return SpotExecutionGuardResult(False, "PROVIDER_SYMBOL_MISMATCH", age_ms)
    return SpotExecutionGuardResult(True, None, age_ms)


def _provider_event_time_ms(provider_code: str, payload: Any) -> int:
    code = str(provider_code or "").strip().upper()
    data = payload.get("data") if isinstance(payload, dict) else None
    if code == "OKX_SPOT":
        row = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else {}
        value = row.get("ts")
    elif code == "BITGET_SPOT":
        row = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else data
        value = (row or {}).get("ts") if isinstance(row, dict) else None
        value = value or (payload.get("requestTime") if isinstance(payload, dict) else None)
    else:
        value = payload.get("E") if isinstance(payload, dict) else None
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _rest_depth(
    *,
    symbol: str,
    provider: MarketDataProviderConfig,
    provider_symbol: str,
    payload: Any,
    received_at_ms: int,
) -> tuple[DepthResponse, int]:
    code = str(provider.provider_code or "").strip().upper()
    data = payload.get("data") if isinstance(payload, dict) else payload
    if code == "OKX_SPOT":
        data = data[0] if isinstance(data, list) and data else None
    elif code == "BITGET_SPOT" and isinstance(data, list):
        data = data[0] if data else None
    bids_raw = data.get("bids") if isinstance(data, dict) else None
    asks_raw = data.get("asks") if isinstance(data, dict) else None

    def levels(rows: Any) -> list[DepthItem]:
        result: list[DepthItem] = []
        if not isinstance(rows, list):
            return result
        for row in rows[:5]:
            if not isinstance(row, list) or len(row) < 2:
                continue
            price = _decimal(row[0])
            amount = _decimal(row[1])
            if price is not None and amount is not None:
                result.append(DepthItem(price=format(price, "f"), amount=format(amount, "f")))
        return result

    depth = DepthResponse(
        symbol=symbol,
        bids=levels(bids_raw),
        asks=levels(asks_raw),
        ts=_provider_event_time_ms(code, payload),
        provider=code,
        stale=False,
        source="REST",
        freshness="RECENT",
        fetched_at=received_at_ms,
    )
    return depth, int(depth.ts or 0)


def _pair(db: Session, symbol: str) -> Optional[TradingPair]:
    return (
        db.query(TradingPair)
        .filter(TradingPair.symbol == str(symbol or "").strip().upper(), TradingPair.status == 1)
        .first()
    )


def get_spot_execution_snapshot(
    db: Session,
    symbol: str,
    require_executable: bool = True,
) -> Optional[SpotExecutionSnapshot]:
    normalized_symbol = str(symbol or "").strip().upper()
    pair = _pair(db, normalized_symbol)
    if pair is None or str(getattr(pair, "data_source", "") or "").strip().upper() != "BINANCE":
        if require_executable:
            raise SpotExecutionUnavailable("spot execution is unavailable for this symbol")
        return None

    providers = tuple(enabled_spot_market_providers(db))
    provider_by_code = {
        str(provider.provider_code or "").strip().upper(): provider
        for provider in providers
    }
    if not provider_by_code:
        if require_executable:
            raise SpotExecutionUnavailable("no enabled spot execution provider")
        return None

    max_age_ms = _max_age_ms()
    current_state = spot_market_gateway.get_authoritative_depth(normalized_symbol)
    active_provider, _ = spot_market_gateway.get_active_depth_provider(normalized_symbol)
    ordered_codes = [code for code in [active_provider] if code in provider_by_code]
    ordered_codes.extend(code for code in provider_by_code if code not in ordered_codes)

    if current_state is not None and current_state.provider in provider_by_code:
        provider_symbol = current_state.provider_symbol or resolve_spot_provider_symbol(
            db,
            provider_code=current_state.provider,
            local_symbol=normalized_symbol,
        )
        snapshot = _build_snapshot(
            symbol=normalized_symbol,
            provider=current_state.provider,
            provider_symbol=provider_symbol,
            depth=current_state.depth,
            event_time_ms=current_state.event_time_ms,
            received_at_ms=current_state.received_at_ms,
            freshness=current_state.freshness,
            source=current_state.source,
            provider_generation=current_state.provider_generation,
            max_age_ms=max_age_ms,
        )
        snapshot = _if_current_gateway_snapshot(snapshot)
        if snapshot is not None:
            return snapshot

    expected_provider = active_provider
    for provider_code in ordered_codes:
        provider = provider_by_code[provider_code]
        provider_symbol = resolve_spot_provider_symbol(
            db,
            provider_code=provider_code,
            local_symbol=normalized_symbol,
        )
        try:
            ws_depth = get_spot_provider_ws_depth(
                normalized_symbol,
                provider=provider_code,
                max_age_ms=max_age_ms,
                limit=5,
            )
        except Exception:
            ws_depth = None
        if ws_depth is not None:
            received_at_ms = int(getattr(ws_depth, "fetched_at", 0) or 0)
            active_code, active_generation = spot_market_gateway.get_active_depth_provider(normalized_symbol)
            target_generation = max(1, int(active_generation or 0))
            if active_code and active_code != provider_code:
                target_generation += 1
            provisional = _build_snapshot(
                symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=provider_symbol,
                depth=ws_depth,
                event_time_ms=int(getattr(ws_depth, "ts", 0) or 0),
                received_at_ms=received_at_ms,
                freshness=str(getattr(ws_depth, "freshness", None) or "LIVE"),
                source="LIVE_WS",
                provider_generation=target_generation,
                max_age_ms=max_age_ms,
            )
            if provisional is not None:
                state = spot_market_gateway.commit_authoritative_depth(
                    symbol=normalized_symbol,
                    provider=provider_code,
                    provider_symbol=provider_symbol,
                    depth=ws_depth,
                    event_time_ms=int(getattr(ws_depth, "ts", 0) or 0),
                    received_at_ms=received_at_ms,
                    freshness=str(getattr(ws_depth, "freshness", None) or "LIVE"),
                    source="LIVE_WS",
                    allow_switch=bool(expected_provider and provider_code != expected_provider),
                    expected_provider=expected_provider,
                )
            else:
                state = None
            if state is not None:
                snapshot = _build_snapshot(
                    symbol=normalized_symbol,
                    provider=state.provider,
                    provider_symbol=state.provider_symbol,
                    depth=state.depth,
                    event_time_ms=state.event_time_ms,
                    received_at_ms=state.received_at_ms,
                    freshness=state.freshness,
                    source=state.source,
                    provider_generation=state.provider_generation,
                    max_age_ms=max_age_ms,
                )
                snapshot = _if_current_gateway_snapshot(snapshot)
                if snapshot is not None:
                    return snapshot
        try:
            payload = request_contract_market_provider_json(provider, "depth", provider_symbol, limit=5)
            received_at_ms = _now_ms()
            rest_depth, event_time_ms = _rest_depth(
                symbol=normalized_symbol,
                provider=provider,
                provider_symbol=provider_symbol,
                payload=payload,
                received_at_ms=received_at_ms,
            )
            provisional = _build_snapshot(
                symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=provider_symbol,
                depth=rest_depth,
                event_time_ms=event_time_ms,
                received_at_ms=received_at_ms,
                freshness="RECENT",
                source="REST",
                provider_generation=max(1, spot_market_gateway.get_active_depth_provider(normalized_symbol)[1]),
                max_age_ms=max_age_ms,
            )
            if provisional is None:
                raise SpotExecutionUnavailable("provider returned non-executable depth")
            state = spot_market_gateway.commit_authoritative_depth(
                symbol=normalized_symbol,
                provider=provider_code,
                provider_symbol=provider_symbol,
                depth=rest_depth,
                event_time_ms=event_time_ms,
                received_at_ms=received_at_ms,
                freshness="RECENT",
                source="REST",
                allow_switch=bool(expected_provider and provider_code != expected_provider),
                expected_provider=expected_provider,
            )
            if state is None:
                continue
            mark_contract_market_provider_success(db, provider_code, market_type=MARKET_TYPE_SPOT)
            snapshot = _build_snapshot(
                symbol=normalized_symbol,
                provider=state.provider,
                provider_symbol=state.provider_symbol,
                depth=state.depth,
                event_time_ms=state.event_time_ms,
                received_at_ms=state.received_at_ms,
                freshness=state.freshness,
                source=state.source,
                provider_generation=state.provider_generation,
                max_age_ms=max_age_ms,
            )
            snapshot = _if_current_gateway_snapshot(snapshot)
            if snapshot is not None:
                return snapshot
        except Exception as exc:
            mark_contract_market_provider_failure(
                db,
                provider_code,
                exc,
                cooldown_seconds=int(provider.cooldown_seconds or 0),
                market_type=MARKET_TYPE_SPOT,
            )

    if require_executable:
        raise SpotExecutionUnavailable("fresh spot execution snapshot unavailable")
    return None
