from __future__ import annotations

import hashlib
import logging
import os
import random
import time
from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP, ROUND_UP
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.db.models.trading_pair import TradingPair
from app.services.itick_holiday_service import (
    MARKET_STATUS_CLOSED,
    MARKET_STATUS_UNKNOWN,
    ItickMarketStatus,
    itick_holiday_service,
)
from app.services.itick_market_service import (
    ItickMarketServiceError,
    itick_market_service,
)
from app.services.itick_quote_fields import ITICK_LATEST_PRICE_FIELDS

logger = logging.getLogger(__name__)

DATA_SOURCE_ITICK = "ITICK"
ASSET_TYPE_STOCK = "STOCK"
DEALER_MARKET_STATUS_ASSET_TYPES = {"STOCK", "INDEX", "FUTURES", "GOLD", "METAL", "COMMODITY", "FOREX"}
MARKET_MODE_DEALER = "DEALER"
_RNG = random.Random()
_PRICE_STATE: Dict[str, "StockDealerPriceState"] = {}


@dataclass(frozen=True)
class StockDealerPriceContext:
    ref_price: Decimal
    dealer_mid: Decimal
    spread_bps: Decimal
    best_bid: Decimal
    best_ask: Decimal
    offset_bps: Decimal
    source: str
    timestamp: int
    fetched_at: int
    cached_age_ms: int = 0


@dataclass
class StockDealerPriceState:
    offset_bps: Decimal
    cached_at: float = 0.0
    context: Optional[StockDealerPriceContext] = None
    last_good_ref_price: Optional[Decimal] = None
    last_good_best_bid: Optional[Decimal] = None
    last_good_best_ask: Optional[Decimal] = None
    last_good_ref_at: float = 0.0


def _normalize_upper(value: Any, default: str = "") -> str:
    return str(value or default).strip().upper()


def is_stock_dealer_price_pair(pair: TradingPair) -> bool:
    return (
        _normalize_upper(getattr(pair, "asset_type", None), "CRYPTO") in DEALER_MARKET_STATUS_ASSET_TYPES
        and _normalize_upper(getattr(pair, "data_source", None), "INTERNAL") == DATA_SOURCE_ITICK
        and _normalize_upper(getattr(pair, "market_mode", None), "INTERNAL") == MARKET_MODE_DEALER
    )


def _decimal_env(name: str, default: str) -> Decimal:
    try:
        value = Decimal(str(os.getenv(name, default)).strip())
    except Exception:
        value = Decimal(default)
    return value if value > 0 else Decimal(default)


def _float_env(name: str, default: str) -> float:
    try:
        value = float(str(os.getenv(name, default)).strip())
    except Exception:
        value = float(default)
    return value if value > 0 else float(default)


def _price_quant(pair: TradingPair) -> Decimal:
    precision = int(getattr(pair, "price_precision", 2) or 2)
    return Decimal("1").scaleb(-precision)


def _round_price(value: Decimal, pair: TradingPair, rounding) -> Decimal:
    return value.quantize(_price_quant(pair), rounding=rounding)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _external_symbol(pair: TradingPair) -> str:
    return _normalize_upper(getattr(pair, "external_symbol", None) or pair.symbol)


def _external_region(pair: TradingPair) -> str:
    return _normalize_upper(getattr(pair, "external_region", None), "US")


def _itick_region_for_pair(pair: TradingPair) -> str:
    asset_type = _normalize_upper(getattr(pair, "asset_type", None), "CRYPTO")
    return _session_code_for_pair(pair, asset_type) or _external_region(pair) or "US"


def _cache_key(pair: TradingPair) -> str:
    return f"{pair.symbol}:{_itick_region_for_pair(pair)}:{_external_symbol(pair)}"


def _pick_decimal(data: Dict[str, Any], keys: Iterable[str]) -> Optional[Decimal]:
    for key in keys:
        raw = data.get(key)
        if raw in (None, ""):
            continue
        try:
            value = Decimal(str(raw))
        except Exception:
            continue
        if value > 0:
            return value
    return None


def _pick_depth_side(data: Dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return []


def _extract_depth_sides(payload: Any) -> Tuple[Any, Any]:
    if not isinstance(payload, dict):
        return [], []

    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return [], []

    bids = _pick_depth_side(data, ("bids", "bid", "b", "buy", "buys"))
    asks = _pick_depth_side(data, ("asks", "ask", "a", "sell", "sells"))
    return bids, asks


def _normalize_depth_levels(raw_levels: Any) -> List[Tuple[Decimal, Decimal]]:
    if not isinstance(raw_levels, list):
        return []

    levels: List[Tuple[Decimal, Decimal]] = []
    for item in raw_levels:
        if isinstance(item, dict):
            price_raw = item.get("price") or item.get("p")
            amount_raw = item.get("amount") or item.get("volume") or item.get("v")
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            price_raw, amount_raw = item[0], item[1]
        else:
            continue

        try:
            price = Decimal(str(price_raw))
            amount = Decimal(str(amount_raw))
        except Exception:
            continue

        if price > 0 and amount > 0:
            levels.append((price, amount))

    return levels


def _fetch_depth_ref_price(pair: TradingPair) -> Optional[Decimal]:
    payload = itick_market_service.get_stock_depth(
        region=_itick_region_for_pair(pair),
        code=_external_symbol(pair),
        limit=5,
    )
    raw_bids, raw_asks = _extract_depth_sides(payload)
    bid_levels = _normalize_depth_levels(raw_bids)
    ask_levels = _normalize_depth_levels(raw_asks)
    if not bid_levels or not ask_levels:
        return None

    best_bid = max((price for price, _ in bid_levels), default=None)
    best_ask = min((price for price, _ in ask_levels), default=None)
    if best_bid is None or best_ask is None or best_bid <= 0 or best_ask <= 0:
        return None
    if best_bid >= best_ask:
        return None

    return (best_bid + best_ask) / Decimal("2")


def _fetch_quote_ref_price(pair: TradingPair) -> Optional[Decimal]:
    payload = itick_market_service.get_stock_quote(
        region=_itick_region_for_pair(pair),
        code=_external_symbol(pair),
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None

    return _pick_decimal(data, ITICK_LATEST_PRICE_FIELDS)


def _get_ref_price(pair: TradingPair, state: StockDealerPriceState, now: float) -> Tuple[Decimal, str]:
    if itick_market_service.is_quote_depth_cooldown_active():
        if state.last_good_ref_price is not None:
            return state.last_good_ref_price, "last_good_ref_cooldown"
        raise ItickMarketServiceError("iTick cooldown active")

    try:
        ref_price = _fetch_depth_ref_price(pair)
        if ref_price is not None:
            state.last_good_ref_price = ref_price
            state.last_good_ref_at = now
            return ref_price, "itick_depth_mid"
    except Exception as exc:
        logger.warning("stock_dealer_ref_depth_error symbol=%s error=%r", pair.symbol, exc)

    try:
        ref_price = _fetch_quote_ref_price(pair)
        if ref_price is not None:
            state.last_good_ref_price = ref_price
            state.last_good_ref_at = now
            return ref_price, "itick_quote"
    except Exception as exc:
        logger.warning("stock_dealer_ref_quote_error symbol=%s error=%r", pair.symbol, exc)

    stale_seconds = _float_env("STOCK_DEALER_REF_STALE_SECONDS", "60")
    if (
        state.last_good_ref_price is not None
        and now - state.last_good_ref_at <= stale_seconds
    ):
        return state.last_good_ref_price, "last_good_ref"

    raise ItickMarketServiceError("stock dealer reference price unavailable")


def _initial_offset(pair: TradingPair) -> Decimal:
    seed = f"{pair.symbol}:{_itick_region_for_pair(pair)}:{_external_symbol(pair)}".encode("utf-8")
    digest = hashlib.sha256(seed).hexdigest()
    bucket = Decimal(int(digest[:4], 16) % 1001) / Decimal("1000")
    max_offset = _decimal_env("STOCK_DEALER_MAX_OFFSET_BPS", "15")
    return ((bucket * Decimal("2")) - Decimal("1")) * min(max_offset, Decimal("2"))


def _get_state(pair: TradingPair) -> StockDealerPriceState:
    key = _cache_key(pair)
    state = _PRICE_STATE.get(key)
    if state is None:
        state = StockDealerPriceState(offset_bps=_initial_offset(pair))
        _PRICE_STATE[key] = state
    return state


def _next_offset_bps(pair: TradingPair, state: StockDealerPriceState) -> Decimal:
    step = _decimal_env("STOCK_DEALER_OFFSET_STEP_BPS", "0.5")
    max_offset = _decimal_env("STOCK_DEALER_MAX_OFFSET_BPS", "15")
    pullback = _decimal_env("STOCK_DEALER_OFFSET_PULLBACK_RATE", "0.08")
    delta = (Decimal(str(_RNG.uniform(-float(step), float(step))))).quantize(
        Decimal("0.0001"),
        rounding=ROUND_HALF_UP,
    )
    next_offset = (state.offset_bps * (Decimal("1") - pullback)) + delta
    if next_offset > max_offset:
        next_offset = max_offset
    elif next_offset < -max_offset:
        next_offset = -max_offset

    state.offset_bps = next_offset
    return next_offset


def _spread_bps(pair: TradingPair, offset_bps: Decimal) -> Decimal:
    min_spread = _decimal_env("STOCK_DEALER_MIN_SPREAD_BPS", "3")
    max_spread = _decimal_env("STOCK_DEALER_MAX_SPREAD_BPS", "8")
    if max_spread < min_spread:
        max_spread = min_spread

    seed = f"{pair.symbol}:spread".encode("utf-8")
    digest = hashlib.sha256(seed).hexdigest()
    bucket = Decimal(int(digest[:4], 16) % 1000) / Decimal("1000")
    base = min_spread + (max_spread - min_spread) * bucket
    drift_add = min(abs(offset_bps) / Decimal("5"), max_spread - min_spread)
    spread = base + drift_add
    return min(max(spread, min_spread), max_spread).quantize(
        Decimal("0.0001"),
        rounding=ROUND_HALF_UP,
    )


def _build_context(
    pair: TradingPair,
    *,
    ref_price: Decimal,
    offset_bps: Decimal,
    spread_bps: Decimal,
    source: str,
) -> StockDealerPriceContext:
    tick = _price_quant(pair)
    dealer_mid_raw = ref_price * (Decimal("1") + offset_bps / Decimal("10000"))
    dealer_mid = _round_price(dealer_mid_raw, pair, ROUND_HALF_UP)
    half_spread = spread_bps / Decimal("20000")
    best_bid = _round_price(dealer_mid_raw * (Decimal("1") - half_spread), pair, ROUND_DOWN)
    best_ask = _round_price(dealer_mid_raw * (Decimal("1") + half_spread), pair, ROUND_UP)

    if best_bid >= best_ask:
        best_bid = _round_price(dealer_mid - tick, pair, ROUND_DOWN)
        best_ask = _round_price(dealer_mid + tick, pair, ROUND_UP)

    if best_bid <= 0 or best_ask <= 0 or best_bid >= best_ask:
        raise ItickMarketServiceError("stock dealer BBO is invalid")

    timestamp = _now_ms()
    return StockDealerPriceContext(
        ref_price=_round_price(ref_price, pair, ROUND_HALF_UP),
        dealer_mid=dealer_mid,
        spread_bps=spread_bps,
        best_bid=best_bid,
        best_ask=best_ask,
        offset_bps=offset_bps.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP),
        source=source,
        timestamp=timestamp,
        fetched_at=timestamp,
    )


def _build_closed_context(
    pair: TradingPair,
    *,
    ref_price: Decimal,
    best_bid: Decimal,
    best_ask: Decimal,
    offset_bps: Decimal,
    spread_bps: Decimal,
    source: str,
) -> StockDealerPriceContext:
    tick = _price_quant(pair)
    best_bid = _round_price(best_bid, pair, ROUND_DOWN)
    best_ask = _round_price(best_ask, pair, ROUND_UP)
    if best_bid >= best_ask:
        mid = _round_price(ref_price, pair, ROUND_HALF_UP)
        best_bid = _round_price(mid - tick, pair, ROUND_DOWN)
        best_ask = _round_price(mid + tick, pair, ROUND_UP)
    if best_bid <= 0 or best_ask <= 0 or best_bid >= best_ask:
        raise ItickMarketServiceError("stock dealer closed BBO is invalid")

    timestamp = _now_ms()
    return StockDealerPriceContext(
        ref_price=_round_price(ref_price, pair, ROUND_HALF_UP),
        dealer_mid=_round_price((best_bid + best_ask) / Decimal("2"), pair, ROUND_HALF_UP),
        spread_bps=spread_bps,
        best_bid=best_bid,
        best_ask=best_ask,
        offset_bps=offset_bps.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP),
        source=source,
        timestamp=timestamp,
        fetched_at=timestamp,
    )


def _market_status_for_pair(pair: TradingPair) -> ItickMarketStatus:
    asset_type = _normalize_upper(getattr(pair, "asset_type", None), "CRYPTO")
    if asset_type == "FOREX":
        return itick_holiday_service.forex_24x5_status()
    region = _session_code_for_pair(pair, asset_type)
    if not region:
        return itick_holiday_service.crypto_open()
    try:
        return itick_holiday_service.get_market_status(region)
    except Exception as exc:
        logger.warning("stock_dealer_holiday_status_unavailable symbol=%s region=%s reason=%s", pair.symbol, region, exc)
        return itick_holiday_service.unknown(region, None, None)


def _market_is_closed(pair: TradingPair) -> bool:
    return _market_status_for_pair(pair).market_status == MARKET_STATUS_CLOSED


def _session_code_for_pair(pair: TradingPair, asset_type: str) -> str:
    region = _external_region(pair)
    if region and region not in ("FOREX", "GLOBAL"):
        return region
    if asset_type == "STOCK":
        return "US"
    if asset_type == "INDEX":
        symbol = _external_symbol(pair)
        if symbol in {"HSI", "HK50", "HKG33"}:
            return "HK"
        if symbol in {"DAX", "GER40", "DE40"}:
            return "DE"
        if symbol in {"N225", "NI225", "JP225", "NKY"}:
            return "JP"
        if symbol in {"STI", "SG30"}:
            return "SG"
        if symbol in {"ASX200", "AUS200"}:
            return "AU"
        if symbol in {"FTSE", "UK100"}:
            return "GB"
        if symbol in {"SSE", "CSI300", "CN50"}:
            return "CN"
        return "US"
    if asset_type in {"FUTURES", "GOLD", "METAL", "COMMODITY"}:
        return "GB"
    return ""


def _get_closed_price_context(
    pair: TradingPair,
    state: StockDealerPriceState,
    now: float,
) -> StockDealerPriceContext:
    if state.context is not None:
        cached_age_ms = int((now - state.cached_at) * 1000)
        return _with_cached_age(state.context, cached_age_ms)

    ref_price = state.last_good_ref_price
    ref_source = "last_good_ref_closed"
    if ref_price is None:
        ref_price, ref_source = _get_ref_price(pair, state, now)

    spread_bps = _spread_bps(pair, state.offset_bps)
    half_spread = spread_bps / Decimal("20000")
    best_bid = state.last_good_best_bid or (ref_price * (Decimal("1") - half_spread))
    best_ask = state.last_good_best_ask or (ref_price * (Decimal("1") + half_spread))
    context = _build_closed_context(
        pair,
        ref_price=ref_price,
        best_bid=best_bid,
        best_ask=best_ask,
        offset_bps=state.offset_bps,
        spread_bps=spread_bps,
        source=f"dealer_engine:{ref_source}:closed",
    )
    state.context = context
    state.cached_at = now
    state.last_good_ref_price = context.ref_price
    state.last_good_best_bid = context.best_bid
    state.last_good_best_ask = context.best_ask
    state.last_good_ref_at = now
    return context


def _with_cached_age(context: StockDealerPriceContext, cached_age_ms: int) -> StockDealerPriceContext:
    return StockDealerPriceContext(
        ref_price=context.ref_price,
        dealer_mid=context.dealer_mid,
        spread_bps=context.spread_bps,
        best_bid=context.best_bid,
        best_ask=context.best_ask,
        offset_bps=context.offset_bps,
        source=context.source,
        timestamp=context.timestamp,
        fetched_at=context.fetched_at,
        cached_age_ms=max(0, int(cached_age_ms)),
    )


def get_stock_dealer_price_context(
    db: Optional[Session],
    trading_pair: TradingPair,
) -> StockDealerPriceContext:
    del db

    if not is_stock_dealer_price_pair(trading_pair):
        raise ValueError("trading pair is not a stock dealer price pair")

    state = _get_state(trading_pair)
    ttl = _float_env("STOCK_DEALER_PRICE_TTL_SECONDS", "15")
    now = time.monotonic()

    market_status = _market_status_for_pair(trading_pair)
    if market_status.market_status == MARKET_STATUS_CLOSED:
        return _get_closed_price_context(trading_pair, state, now)

    if market_status.market_status == MARKET_STATUS_UNKNOWN and state.context is not None:
        cached_age_ms = int((now - state.cached_at) * 1000)
        return _with_cached_age(state.context, cached_age_ms)

    if state.context is not None and now - state.cached_at <= ttl:
        cached_age_ms = int((now - state.cached_at) * 1000)
        logger.info(
            "stock_dealer_price_context_cache_hit symbol=%s cached_age_ms=%s source=%s ref_price=%s dealer_mid=%s best_bid=%s best_ask=%s offset_bps=%s spread_bps=%s",
            trading_pair.symbol,
            cached_age_ms,
            state.context.source,
            state.context.ref_price,
            state.context.dealer_mid,
            state.context.best_bid,
            state.context.best_ask,
            state.context.offset_bps,
            state.context.spread_bps,
        )
        return _with_cached_age(state.context, cached_age_ms)

    if state.context is not None and itick_market_service.is_quote_depth_cooldown_active():
        cached_age_ms = int((now - state.cached_at) * 1000)
        return _with_cached_age(state.context, cached_age_ms)

    ref_price, ref_source = _get_ref_price(trading_pair, state, now)
    offset_bps = _next_offset_bps(trading_pair, state)
    spread_bps = _spread_bps(trading_pair, offset_bps)
    context = _build_context(
        trading_pair,
        ref_price=ref_price,
        offset_bps=offset_bps,
        spread_bps=spread_bps,
        source=f"dealer_engine:{ref_source}",
    )
    state.context = context
    state.cached_at = now
    state.last_good_ref_price = context.ref_price
    state.last_good_best_bid = context.best_bid
    state.last_good_best_ask = context.best_ask
    state.last_good_ref_at = now
    logger.info(
        "stock_dealer_price_context_fetched symbol=%s cached_age_ms=0 source=%s ref_price=%s dealer_mid=%s best_bid=%s best_ask=%s offset_bps=%s spread_bps=%s",
        trading_pair.symbol,
        context.source,
        context.ref_price,
        context.dealer_mid,
        context.best_bid,
        context.best_ask,
        context.offset_bps,
        context.spread_bps,
    )
    return context
