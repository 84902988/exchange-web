from __future__ import annotations

import hashlib
import logging
import os
import time
from dataclasses import dataclass, replace
from decimal import Decimal, ROUND_DOWN, ROUND_UP
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.db.models.trading_pair import TradingPair
from app.schemas.market import DepthItem, DepthResponse
from app.services.itick_market_service import (
    ItickMarketServiceError,
    itick_market_service,
)
from app.services.stock_dealer_price_engine import get_stock_dealer_price_context


DATA_SOURCE_ITICK = "ITICK"
ASSET_TYPE_STOCK = "STOCK"
MARKET_MODE_DEALER = "DEALER"
_QUOTE_CACHE: Dict[str, Tuple[float, Decimal]] = {}
_TRADE_CONTEXT_CACHE: Dict[str, Tuple[float, "StockTradeContext"]] = {}
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StockDealerMarketContext:
    best_bid: Decimal
    best_ask: Decimal
    mid_price: Decimal


@dataclass(frozen=True)
class StockTradeContext:
    last_price: Decimal
    mid_price: Decimal
    best_bid: Optional[Decimal]
    best_ask: Optional[Decimal]
    bids: List[DepthItem]
    asks: List[DepthItem]
    ref_price: Optional[Decimal]
    dealer_mid: Optional[Decimal]
    spread_bps: Optional[Decimal]
    offset_bps: Optional[Decimal]
    source: str
    timestamp: int
    fetched_at: int
    cached_age_ms: int = 0


def _normalize_upper(value: Any, default: str = "") -> str:
    return str(value or default).strip().upper()


def is_stock_dealer_pair(pair: TradingPair) -> bool:
    return (
        _normalize_upper(getattr(pair, "asset_type", None), "CRYPTO") == ASSET_TYPE_STOCK
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


def _now_ms() -> int:
    return int(time.time() * 1000)


def _depth_limit(limit: int = 20) -> int:
    return max(1, min(int(limit or 20), 20))


def _trade_context_cache_ttl_seconds() -> float:
    return _float_env("STOCK_TRADE_CONTEXT_TTL_SECONDS", "30")


def _trade_context_cache_key(pair: TradingPair) -> str:
    return f"{pair.symbol}:{_external_region(pair)}:{_external_symbol(pair)}"


def _price_quant(pair: TradingPair) -> Decimal:
    precision = int(getattr(pair, "price_precision", 2) or 2)
    return Decimal("1").scaleb(-precision)


def _amount_quant(pair: TradingPair) -> Decimal:
    precision = int(getattr(pair, "amount_precision", 6) or 6)
    return Decimal("1").scaleb(-precision)


def _round_price(value: Decimal, pair: TradingPair, rounding) -> Decimal:
    return value.quantize(_price_quant(pair), rounding=rounding)


def _round_amount(value: Decimal, pair: TradingPair) -> Decimal:
    return value.quantize(_amount_quant(pair), rounding=ROUND_DOWN)


def _external_symbol(pair: TradingPair) -> str:
    return _normalize_upper(getattr(pair, "external_symbol", None) or pair.symbol)


def _external_region(pair: TradingPair) -> str:
    return _normalize_upper(getattr(pair, "external_region", None), "US")


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


def get_stock_reference_quote(pair: TradingPair) -> Decimal:
    cache_key = f"{_external_region(pair)}:{_external_symbol(pair)}"
    cache_ttl = _decimal_env("STOCK_DEALER_QUOTE_TTL_SECONDS", "30")
    cached = _QUOTE_CACHE.get(cache_key)
    now = time.monotonic()
    if cached is not None and now - cached[0] <= float(cache_ttl):
        return cached[1]
    if cached is not None and itick_market_service.is_quote_depth_cooldown_active():
        return cached[1]
    if itick_market_service.is_quote_depth_cooldown_active():
        raise ItickMarketServiceError("iTick cooldown active")

    payload = itick_market_service.get_stock_quote(
        region=_external_region(pair),
        code=_external_symbol(pair),
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ItickMarketServiceError("iTick quote missing data")

    price = _pick_decimal(data, ("ld", "last", "price", "close", "c", "o"))
    if price is None:
        raise ItickMarketServiceError("iTick quote missing valid price")
    _QUOTE_CACHE[cache_key] = (now, price)
    return price


def _fetch_stock_quote_price(pair: TradingPair) -> Optional[Decimal]:
    payload = itick_market_service.get_stock_quote(
        region=_external_region(pair),
        code=_external_symbol(pair),
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None

    return _pick_decimal(data, ("ld", "last", "price", "close", "c", "o"))


def normalize_stock_depth_levels(raw_levels: Any) -> List[Tuple[Decimal, Decimal]]:
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
    if isinstance(data, dict):
        bids = _pick_depth_side(data, ("bids", "bid", "b", "buy", "buys"))
        asks = _pick_depth_side(data, ("asks", "ask", "a", "sell", "sells"))
        return bids, asks

    return [], []


def _is_dealer_depth_fallback_enabled() -> bool:
    return str(os.getenv("ENABLE_STOCK_DEALER_DEPTH_FALLBACK", "0")).strip() == "1"


def _empty_stock_depth(pair: TradingPair, limit: int = 20) -> DepthResponse:
    del limit
    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(getattr(pair, "price_precision", 2) or 2),
        bids=[],
        asks=[],
        ts=int(time.time() * 1000),
    )


def _payload_shape(value: Any, depth: int = 0) -> Any:
    if depth >= 3:
        return type(value).__name__
    if isinstance(value, dict):
        return {str(key): _payload_shape(child, depth + 1) for key, child in value.items()}
    if isinstance(value, list):
        if not value:
            return "list[0]"
        return {"list_len": len(value), "first": _payload_shape(value[0], depth + 1)}
    return type(value).__name__


def _depth_items_from_levels(
    levels: List[Tuple[Decimal, Decimal]],
    pair: TradingPair,
    *,
    side: str,
    limit: int,
) -> List[DepthItem]:
    reverse = side == "BID"
    sorted_levels = sorted(levels, key=lambda item: item[0], reverse=reverse)
    items: List[DepthItem] = []

    for price, amount in sorted_levels[:limit]:
        rounded_price = _round_price(
            price,
            pair,
            ROUND_DOWN if side == "BID" else ROUND_UP,
        )
        rounded_amount = _round_amount(amount, pair)
        if rounded_price <= 0 or rounded_amount <= 0:
            continue
        items.append(
            DepthItem(
                price=format(rounded_price, "f"),
                amount=format(rounded_amount, "f"),
            )
        )

    return items


def _extend_depth_side_from_top(
    *,
    pair: TradingPair,
    items: List[DepthItem],
    side: str,
    limit: int,
) -> List[DepthItem]:
    if len(items) != 1 or limit <= 1:
        return items[:limit]

    try:
        top_price = Decimal(str(items[0].price))
        top_amount = Decimal(str(items[0].amount))
    except Exception:
        return items[:limit]

    if top_price <= 0 or top_amount <= 0:
        return items[:limit]

    depth_limit = max(1, min(int(limit or 20), 20))
    tick = _price_quant(pair)
    level_spread = max(tick, _spread(pair, top_price) / Decimal("2"))
    extended = [items[0]]

    for idx in range(1, depth_limit):
        level = idx + 1
        if side == "BID":
            price = _round_price(top_price - level_spread * idx, pair, ROUND_DOWN)
        else:
            price = _round_price(top_price + level_spread * idx, pair, ROUND_UP)

        if price <= 0:
            continue

        amount = max(
            _round_amount(top_amount * (Decimal("1") + Decimal(idx) * Decimal("0.12")), pair),
            _stable_amount(pair, side, level),
        )
        extended.append(
            DepthItem(
                price=format(price, "f"),
                amount=format(amount, "f"),
            )
        )

    return extended


def get_stock_itick_depth(pair: TradingPair, limit: int = 20) -> DepthResponse:
    if not is_stock_dealer_pair(pair):
        raise ValueError("trading pair is not a stock dealer pair")

    depth_limit = max(1, min(int(limit or 20), 20))
    payload = itick_market_service.get_stock_depth(
        region=_external_region(pair),
        code=_external_symbol(pair),
        limit=depth_limit,
    )
    logger.debug(
        "itick_depth_raw_response_shape symbol=%s shape=%s",
        pair.symbol,
        _payload_shape(payload),
    )
    raw_bids, raw_asks = _extract_depth_sides(payload)
    bid_levels = normalize_stock_depth_levels(raw_bids)
    ask_levels = normalize_stock_depth_levels(raw_asks)

    bids = _depth_items_from_levels(
        bid_levels,
        pair,
        side="BID",
        limit=depth_limit,
    )
    asks = _depth_items_from_levels(
        ask_levels,
        pair,
        side="ASK",
        limit=depth_limit,
    )
    logger.info(
        "itick_depth_level_count symbol=%s bids=%s asks=%s",
        pair.symbol,
        len(bids),
        len(asks),
    )
    if len(bids) <= 1 or len(asks) <= 1:
        logger.info(
            "itick_depth_permission_or_plan_limited symbol=%s bids=%s asks=%s",
            pair.symbol,
            len(bids),
            len(asks),
        )

    if len(bids) == 1:
        bids = _extend_depth_side_from_top(
            pair=pair,
            items=bids,
            side="BID",
            limit=depth_limit,
        )
    if len(asks) == 1:
        asks = _extend_depth_side_from_top(
            pair=pair,
            items=asks,
            side="ASK",
            limit=depth_limit,
        )

    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(getattr(pair, "price_precision", 2) or 2),
        bids=bids,
        asks=asks,
        ts=_now_ms(),
    )


def _decimal_from_depth_item(item: DepthItem) -> Optional[Decimal]:
    try:
        value = Decimal(str(item.price))
    except Exception:
        return None

    return value if value > 0 else None


def _slice_trade_context(context: StockTradeContext, limit: int, cached_age_ms: int) -> StockTradeContext:
    depth_limit = _depth_limit(limit)
    return replace(
        context,
        bids=context.bids[:depth_limit],
        asks=context.asks[:depth_limit],
        cached_age_ms=max(0, int(cached_age_ms)),
    )


def _build_empty_trade_context(
    *,
    pair: TradingPair,
    quote_price: Optional[Decimal],
    source: str,
) -> StockTradeContext:
    timestamp = _now_ms()
    fallback_price = quote_price or Decimal("0")
    return StockTradeContext(
        last_price=fallback_price,
        mid_price=fallback_price,
        best_bid=None,
        best_ask=None,
        bids=[],
        asks=[],
        ref_price=fallback_price,
        dealer_mid=fallback_price,
        spread_bps=None,
        offset_bps=None,
        source=source,
        timestamp=timestamp,
        fetched_at=timestamp,
    )


def _build_trade_context_from_depth(
    *,
    pair: TradingPair,
    depth: DepthResponse,
    quote_price: Optional[Decimal],
    source: str,
) -> StockTradeContext:
    best_bid = _decimal_from_depth_item(depth.bids[0]) if depth.bids else None
    best_ask = _decimal_from_depth_item(depth.asks[0]) if depth.asks else None

    mid_price = quote_price or Decimal("0")
    if best_bid is not None and best_ask is not None:
        mid_price = (best_bid + best_ask) / Decimal("2")

    last_price = quote_price or mid_price
    timestamp = int(depth.ts or _now_ms())
    return StockTradeContext(
        last_price=last_price,
        mid_price=mid_price,
        best_bid=best_bid,
        best_ask=best_ask,
        bids=depth.bids,
        asks=depth.asks,
        ref_price=quote_price,
        dealer_mid=mid_price,
        spread_bps=None,
        offset_bps=None,
        source=source,
        timestamp=timestamp,
        fetched_at=_now_ms(),
    )


def _stock_depth_first_level_source() -> str:
    return _normalize_upper(os.getenv("STOCK_DEPTH_FIRST_LEVEL_SOURCE"), "DEALER")


def _dealer_depth_level_gap(pair: TradingPair, mid_price: Decimal) -> Decimal:
    tick = _price_quant(pair)
    level_bps = _decimal_env("STOCK_DEALER_DEPTH_LEVEL_BPS", "1")
    return max(tick, mid_price * level_bps / Decimal("10000"))


def _build_dealer_engine_depth(
    *,
    pair: TradingPair,
    best_bid: Decimal,
    best_ask: Decimal,
    dealer_mid: Decimal,
    limit: int,
) -> DepthResponse:
    depth_limit = _depth_limit(limit)
    level_gap = _dealer_depth_level_gap(pair, dealer_mid)
    bids: List[DepthItem] = []
    asks: List[DepthItem] = []

    for idx in range(depth_limit):
        level = idx + 1
        if idx == 0:
            bid_price = best_bid
            ask_price = best_ask
        else:
            bid_price = _round_price(best_bid - level_gap * idx, pair, ROUND_DOWN)
            ask_price = _round_price(best_ask + level_gap * idx, pair, ROUND_UP)

        if bid_price > 0:
            bids.append(
                DepthItem(
                    price=format(bid_price, "f"),
                    amount=format(_stable_amount(pair, "BID", level), "f"),
                )
            )
        if ask_price > 0:
            asks.append(
                DepthItem(
                    price=format(ask_price, "f"),
                    amount=format(_stable_amount(pair, "ASK", level), "f"),
                )
            )

    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(getattr(pair, "price_precision", 2) or 2),
        bids=bids,
        asks=asks,
        ts=_now_ms(),
    )


def get_stock_trade_context(
    db: Optional[Session],
    trading_pair: TradingPair,
    limit: int = 20,
) -> StockTradeContext:
    if not is_stock_dealer_pair(trading_pair):
        raise ValueError("trading pair is not a stock dealer pair")

    requested_limit = _depth_limit(limit)
    fetch_limit = max(requested_limit, 20)
    cache_key = _trade_context_cache_key(trading_pair)
    now = time.monotonic()
    cached = _TRADE_CONTEXT_CACHE.get(cache_key)

    if cached is not None:
        cached_at, cached_context = cached
        cached_age_ms = int((now - cached_at) * 1000)
        if now - cached_at <= _trade_context_cache_ttl_seconds():
            logger.info(
                "stock_trade_context_cache_hit symbol=%s cached_age_ms=%s source=%s best_bid=%s best_ask=%s",
                trading_pair.symbol,
                cached_age_ms,
                cached_context.source,
                cached_context.best_bid,
                cached_context.best_ask,
            )
            return _slice_trade_context(cached_context, requested_limit, cached_age_ms)
        if itick_market_service.is_quote_depth_cooldown_active():
            return _slice_trade_context(cached_context, requested_limit, cached_age_ms)

    if itick_market_service.is_quote_depth_cooldown_active():
        context = _build_empty_trade_context(
            pair=trading_pair,
            quote_price=None,
            source="itick_cooldown_active",
        )
        _TRADE_CONTEXT_CACHE[cache_key] = (now, context)
        return _slice_trade_context(context, requested_limit, 0)

    try:
        price_context = get_stock_dealer_price_context(db=db, trading_pair=trading_pair)
    except Exception as exc:
        if _is_dealer_depth_fallback_enabled():
            logger.warning(
                "stock_price_engine_error_fallback_dealer symbol=%s error=%r",
                trading_pair.symbol,
                exc,
            )
            depth = build_stock_dealer_depth(db=None, trading_pair=trading_pair, limit=fetch_limit)
            source = "dealer_fallback"
            context = _build_trade_context_from_depth(
                pair=trading_pair,
                depth=depth,
                quote_price=None,
                source=source,
            )
            _TRADE_CONTEXT_CACHE[cache_key] = (now, context)
            return _slice_trade_context(context, requested_limit, 0)
        else:
            logger.warning("stock_price_engine_error symbol=%s error=%r", trading_pair.symbol, exc)
            context = _build_empty_trade_context(
                pair=trading_pair,
                quote_price=None,
                source="stock_price_engine_error",
            )
            _TRADE_CONTEXT_CACHE[cache_key] = (now, context)
            return _slice_trade_context(context, requested_limit, 0)

    if _stock_depth_first_level_source() == "ITICK":
        try:
            depth = get_stock_itick_depth(trading_pair, limit=fetch_limit)
        except Exception as exc:
            logger.warning(
                "stock_depth_itick_display_error_fallback_dealer symbol=%s error=%r",
                trading_pair.symbol,
                exc,
            )
            depth = _build_dealer_engine_depth(
                pair=trading_pair,
                best_bid=price_context.best_bid,
                best_ask=price_context.best_ask,
                dealer_mid=price_context.dealer_mid,
                limit=fetch_limit,
            )
    else:
        depth = _build_dealer_engine_depth(
            pair=trading_pair,
            best_bid=price_context.best_bid,
            best_ask=price_context.best_ask,
            dealer_mid=price_context.dealer_mid,
            limit=fetch_limit,
        )

    context = StockTradeContext(
        last_price=price_context.dealer_mid,
        mid_price=price_context.dealer_mid,
        best_bid=price_context.best_bid,
        best_ask=price_context.best_ask,
        bids=depth.bids,
        asks=depth.asks,
        ref_price=price_context.ref_price,
        dealer_mid=price_context.dealer_mid,
        spread_bps=price_context.spread_bps,
        offset_bps=price_context.offset_bps,
        source=price_context.source,
        timestamp=price_context.timestamp,
        fetched_at=price_context.fetched_at,
        cached_age_ms=price_context.cached_age_ms,
    )
    _TRADE_CONTEXT_CACHE[cache_key] = (now, context)
    logger.info(
        "stock_trade_context_fetched symbol=%s cached_age_ms=%s source=%s ref_price=%s dealer_mid=%s best_bid=%s best_ask=%s offset_bps=%s spread_bps=%s",
        trading_pair.symbol,
        context.cached_age_ms,
        context.source,
        context.ref_price,
        context.dealer_mid,
        context.best_bid,
        context.best_ask,
        context.offset_bps,
        context.spread_bps,
    )
    return _slice_trade_context(context, requested_limit, context.cached_age_ms)


def get_stock_depth_with_fallback(pair: TradingPair, limit: int = 20) -> DepthResponse:
    context = get_stock_trade_context(db=None, trading_pair=pair, limit=limit)
    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(getattr(pair, "price_precision", 2) or 2),
        bids=context.bids,
        asks=context.asks,
        ts=context.timestamp,
        last_price=format(context.last_price, "f"),
        mid_price=format(context.mid_price, "f"),
        ref_price=format(context.ref_price, "f") if context.ref_price is not None else None,
        dealer_mid=format(context.dealer_mid, "f") if context.dealer_mid is not None else None,
        spread_bps=format(context.spread_bps, "f") if context.spread_bps is not None else None,
        offset_bps=format(context.offset_bps, "f") if context.offset_bps is not None else None,
        source=context.source,
        fetched_at=context.fetched_at,
    )


def _stable_amount(pair: TradingPair, side: str, level: int) -> Decimal:
    seed = f"{pair.symbol}:{side}:{level}".encode("utf-8")
    digest = hashlib.sha256(seed).hexdigest()
    bucket = int(digest[:8], 16) % 7000

    base_amount = _decimal_env("STOCK_DEALER_BASE_AMOUNT", "20")
    step_amount = _decimal_env("STOCK_DEALER_AMOUNT_STEP", "0.01")
    amount = base_amount + Decimal(bucket) * step_amount
    return max(_round_amount(amount, pair), _amount_quant(pair))


def _spread(pair: TradingPair, mid_price: Decimal) -> Decimal:
    absolute = _decimal_env("STOCK_DEALER_SPREAD_ABS", "0.01")
    rate = _decimal_env("STOCK_DEALER_SPREAD_RATE", "0.0001")
    tick = _price_quant(pair)
    return max(absolute, mid_price * rate, tick)


def build_stock_dealer_depth(
    db: Optional[Session],
    trading_pair: TradingPair,
    limit: int = 20,
) -> DepthResponse:
    del db

    if not is_stock_dealer_pair(trading_pair):
        raise ValueError("trading pair is not a stock dealer pair")

    depth_limit = max(1, min(int(limit or 20), 20))
    mid_price = get_stock_reference_quote(trading_pair)
    spread = _spread(trading_pair, mid_price)
    half_spread = spread / Decimal("2")
    tick = _price_quant(trading_pair)

    bids: List[DepthItem] = []
    asks: List[DepthItem] = []

    for idx in range(depth_limit):
        level = idx + 1
        bid_price = _round_price(
            mid_price - half_spread - tick * idx,
            trading_pair,
            ROUND_DOWN,
        )
        ask_price = _round_price(
            mid_price + half_spread + tick * idx,
            trading_pair,
            ROUND_UP,
        )

        if bid_price <= 0:
            continue

        bids.append(
            DepthItem(
                price=format(bid_price, "f"),
                amount=format(_stable_amount(trading_pair, "BID", level), "f"),
            )
        )
        asks.append(
            DepthItem(
                price=format(ask_price, "f"),
                amount=format(_stable_amount(trading_pair, "ASK", level), "f"),
            )
        )

    return DepthResponse(
        symbol=trading_pair.symbol,
        price_precision=int(getattr(trading_pair, "price_precision", 2) or 2),
        bids=bids,
        asks=asks,
        ts=_now_ms(),
    )


def _append_level(
    levels: Dict[Decimal, Decimal],
    item: DepthItem,
    pair: TradingPair,
) -> None:
    try:
        price = Decimal(str(item.price))
        amount = Decimal(str(item.amount))
    except Exception:
        return

    if price <= 0 or amount <= 0:
        return

    levels[price] = levels.get(price, Decimal("0")) + amount


def merge_stock_dealer_depth(
    *,
    trading_pair: TradingPair,
    dealer_depth: DepthResponse,
    internal_depth: DepthResponse,
    limit: int = 20,
) -> DepthResponse:
    if not dealer_depth.bids or not dealer_depth.asks:
        return internal_depth

    depth_limit = max(1, min(int(limit or 20), 20))
    best_bid = Decimal(str(dealer_depth.bids[0].price))
    best_ask = Decimal(str(dealer_depth.asks[0].price))

    bid_levels: Dict[Decimal, Decimal] = {}
    ask_levels: Dict[Decimal, Decimal] = {}

    for item in dealer_depth.bids:
        _append_level(bid_levels, item, trading_pair)
    for item in dealer_depth.asks:
        _append_level(ask_levels, item, trading_pair)

    for item in internal_depth.bids:
        try:
            price = Decimal(str(item.price))
        except Exception:
            continue
        if price <= best_bid:
            _append_level(bid_levels, item, trading_pair)

    for item in internal_depth.asks:
        try:
            price = Decimal(str(item.price))
        except Exception:
            continue
        if price >= best_ask:
            _append_level(ask_levels, item, trading_pair)

    bids = [
        DepthItem(
            price=format(price.quantize(_price_quant(trading_pair), rounding=ROUND_DOWN), "f"),
            amount=format(_round_amount(amount, trading_pair), "f"),
        )
        for price, amount in sorted(bid_levels.items(), key=lambda item: item[0], reverse=True)[
            :depth_limit
        ]
    ]
    asks = [
        DepthItem(
            price=format(price.quantize(_price_quant(trading_pair), rounding=ROUND_UP), "f"),
            amount=format(_round_amount(amount, trading_pair), "f"),
        )
        for price, amount in sorted(ask_levels.items(), key=lambda item: item[0])[:depth_limit]
    ]

    return DepthResponse(
        symbol=trading_pair.symbol,
        price_precision=dealer_depth.price_precision,
        bids=bids,
        asks=asks,
        ts=int(time.time() * 1000),
    )


def get_stock_dealer_market_context(pair: TradingPair) -> StockDealerMarketContext:
    context = get_stock_trade_context(db=None, trading_pair=pair, limit=1)
    if context.best_bid is None or context.best_ask is None:
        raise ItickMarketServiceError("stock dealer depth unavailable")

    return StockDealerMarketContext(
        best_bid=context.best_bid,
        best_ask=context.best_ask,
        mid_price=context.mid_price,
    )
