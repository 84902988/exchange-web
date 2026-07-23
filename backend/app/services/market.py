import logging
import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, List, Optional, Tuple

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.datetime_utils import spot_trade_utc_isoformat, spot_trade_utc_timestamp_ms
from app.db.models.contract_symbol import ContractSymbol
from app.db.models.market_kline import MarketKline
from app.db.models.order import Order
from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair
from app.schemas.market import (
    DepthItem,
    DepthResponse,
    TickerItem,
    TickerListResponse,
    TradeItem,
    TradesResponse,
)
from app.schemas.market_external import ExternalTickerResponse
from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainFallbackReason,
    DomainName,
    DomainSource,
    DomainTransport,
)
from app.services.binance_market_service import (
    BinanceMarketServiceError,
    binance_market_service,
)
from app.services.itick_market_service import (
    ItickMarketServiceError,
    itick_market_service,
)
from app.services.itick_quote_fields import (
    ITICK_LATEST_PRICE_FIELDS,
    ITICK_OPEN_PRICE_FIELDS,
    ITICK_PREVIOUS_CLOSE_FIELDS,
)
from app.services.itick_holiday_service import itick_holiday_service
from app.services.market_domain_snapshot import (
    MarketDomainSnapshot,
    build_market_domain_snapshot,
)
from app.services.market_kline_cache import (
    KLINE_CACHE_ORIGIN_DB_CACHE,
    KLINE_CACHE_ORIGIN_EMPTY,
    KLINE_CACHE_ORIGIN_REST_FETCH,
    KLINE_CACHE_ORIGIN_STALE_CACHE,
    KLINE_PROVIDER_ERROR_COOLDOWN,
    KLINE_PROVIDER_ERROR_EMPTY,
    KLINE_PROVIDER_ERROR_HTTP,
    KLINE_PROVIDER_ERROR_TIMEOUT,
    KLINE_PROVIDER_ERROR_UNKNOWN,
    KLINE_HISTORY_BOUNDARY_SCOPE_INTERNAL,
    KlineCacheResult,
    KlineProviderFetchError,
    KlineProviderHistoryBoundary,
    LATEST_KLINE_REFRESH_TTL_SECONDS,
    MarketKlineCacheMetadata,
    build_market_kline_cache_metadata,
    get_cached_internal_kline_history_boundary_result,
    get_klines_cache_first,
    remember_internal_kline_history_boundary,
)
from app.services.spot_kline_bucket import (
    normalize_spot_kline_bucket_interval,
    okx_spot_open_time_validator,
)
from app.services.spot_kline_response import build_spot_kline_terminal_metadata
from app.services.spot_kline_revision import (
    KlineRestWatermark,
    KlineRevisionCandidate,
    KlineRevisionDecision,
    reconcile_rest_kline_candidate,
)
from app.services.contract_market_provider_service import (
    MarketDataProviderConfig,
    MarketDataProviderError,
    ProviderCooldownError,
    PROVIDER_BINANCE_SPOT,
    PROVIDER_BITGET_SPOT,
    PROVIDER_OKX_SPOT,
    contract_market_last_good_enabled,
    enabled_spot_market_providers,
    mark_contract_market_provider_failure,
    mark_contract_market_provider_success,
    request_contract_market_provider_json,
    resolve_spot_provider_symbol,
)
from app.services.stock_dealer_depth_service import (
    get_stock_depth_with_fallback,
    get_stock_trade_context,
    is_stock_dealer_pair,
)
from app.services.spot_kline_realtime import SPOT_KLINE_SOURCE_INTERNAL_TRADE
from app.services.spot_market_provider_ws import (
    get_spot_provider_ws_depth,
    get_spot_provider_ws_kline_revisions,
    get_spot_provider_ws_klines,
    get_spot_provider_ws_ticker,
    get_spot_provider_ws_trades,
    spot_provider_ws_supports_provider,
)
from app.services.market_depth_cache import (
    SPOT_DEPTH_SHARED_CACHE_TTL_MS,
    SpotDepthCacheHit,
    get_spot_depth_with_shared_cache,
)
from app.services.market_ticker_cache import get_spot_ticker_with_shared_cache
from app.services.market_ticker_cache import (
    SPOT_TICKER_SHARED_CACHE_TTL_MS,
    SpotTickerCacheHit,
)
from app.services.market_trades_cache import (
    SPOT_TRADES_SHARED_CACHE_TTL_MS,
    SpotTradesCacheHit,
    get_spot_trades_with_shared_cache,
)
from app.services.shared_market_cache import CACHE_VERSION
from app.services.spot_domain_snapshot_freshness import DomainSnapshotContext

logger = logging.getLogger(__name__)

OPEN_STATUSES = ["OPEN", "PARTIALLY_FILLED"]

DATA_SOURCE_INTERNAL = "INTERNAL"
DATA_SOURCE_BINANCE = "BINANCE"
DATA_SOURCE_ITICK = "ITICK"
PAIR_PAGE_SIZE_DEFAULT = 50
PAIR_PAGE_SIZE_MAX = 100
ITICK_STOCK_QUOTE_BATCH_SIZE = 20

ITICK_KLINE_TYPES = {
    "1m": 1,
    "5m": 2,
    "15m": 3,
    "30m": 4,
    "1h": 5,
    "1d": 8,
    "1w": 9,
    "1M": 10,
}

_ITICK_LAST_GOOD_PRICE: Dict[str, Decimal] = {}
_ITICK_TICKER_CACHE: Dict[str, Tuple[float, TickerItem]] = {}
_ITICK_TICKER_CACHE_TTL_SECONDS = 15
_SPOT_LAST_GOOD_TICKERS: Dict[str, TickerItem] = {}
_SPOT_LAST_GOOD_DEPTHS: Dict[str, DepthResponse] = {}
_SPOT_LAST_GOOD_TRADES: Dict[str, TradesResponse] = {}
_CONTRACT_AUTHORITY_SESSION_CACHE_KEY = "market_contract_authority_v2"
_SPOT_LAST_GOOD_KLINES: Dict[tuple[str, str], dict[str, Any]] = {}
_SPOT_PROVIDER_LOG_THROTTLE: Dict[tuple[str, str, str, str], float] = {}
_SPOT_PROVIDER_LOG_THROTTLE_SECONDS = 60
_SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS = 2500
_SPOT_PROVIDER_FAST_TIMEOUT_CAP_MS = 800
_SPOT_KLINE_FAST_TIMEOUT_CAP_MS = 1200
_SPOT_PRICE_PRECISION_METADATA_CACHE: Dict[Tuple[str, str], Tuple[float, Dict[str, Any]]] = {}
_SPOT_PRICE_PRECISION_METADATA_MISS_CACHE: Dict[Tuple[str, str], Tuple[float, Dict[str, Any]]] = {}
_SPOT_PRICE_PRECISION_METADATA_TTL_SECONDS = 1800
_SPOT_PRICE_PRECISION_METADATA_MISS_TTL_SECONDS = 60
_SPOT_DISPLAY_PRICE_PRECISION_FALLBACK = 2
_SPOT_DISPLAY_PRICE_PRECISION_MAX = 12
_SPOT_PRICE_PRECISION_PAYLOAD_KEYS = {
    "price_tick_size",
    "display_price_precision",
    "price_precision_source",
    "price_precision_provider",
}
_INTERVAL_SECONDS = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 4 * 3600,
    "1d": 86400,
    "1Dutc": 86400,
    "1w": 7 * 86400,
    "1Wutc": 7 * 86400,
    "1M": 30 * 86400,
    "1Mutc": 30 * 86400,
}
_INTERNAL_SPOT_KLINE_UTC_AGGREGATE_INTERVALS = {"1Dutc", "1Wutc", "1Mutc"}
_INTERNAL_SPOT_KLINE_SUPPORTED_INTERVALS = {
    "1m",
    "5m",
    "15m",
    "1h",
    "4h",
    "1d",
    *_INTERNAL_SPOT_KLINE_UTC_AGGREGATE_INTERVALS,
}
_INTERNAL_SPOT_KLINE_AGGREGATE_SOURCE_INTERVALS = ("1m", "5m", "15m", "1h", "4h")
_INTERNAL_SPOT_KLINE_AGGREGATE_SOURCE_ROW_LIMIT = 50_000
_INTERNAL_SPOT_KLINE_AGGREGATE_SOURCES = {SPOT_KLINE_SOURCE_INTERNAL_TRADE, "INTERNAL"}

MAINSTREAM_PAIR_BASES = {"BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"}
PLATFORM_PAIR_BASES = {"MFC", "RCB"}
RWA_PAIR_BASES = {"MFC", "IGC", "CREG", "BON"}
CONTRACT_PAIR_CATEGORIES = {"CONTRACT", "FOREX", "METAL", "COMMODITY", "INDEX", "ETF"}
MOBILE_OVERVIEW_SYMBOLS = ["BTCUSDT", "RCBUSDT", "NAS100", "XAUUSD", "ETHUSDT", "EURUSD"]
MOBILE_OVERVIEW_SECTION_LIMIT = 5


def _decimal_to_str(v) -> str:
    if v is None:
        return "0"
    if not isinstance(v, Decimal):
        v = Decimal(str(v))
    return format(v, "f")


def _to_decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    if value in (None, ""):
        return default
    try:
        return Decimal(str(value))
    except Exception:
        return default


def _to_optional_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _format_percent(v: Decimal) -> str:
    return format(v.quantize(Decimal("0.01")), "f")


def _bitget_spot_change_ratio(row: Dict[str, Any]) -> Optional[Decimal]:
    return _to_optional_decimal(row.get("change24h"))


def _bitget_spot_open_24h(
    row: Dict[str, Any],
    last_price: Decimal,
    change_ratio: Optional[Decimal],
) -> Decimal:
    open_24h = _to_optional_decimal(row.get("open") or row.get("open24h"))
    if open_24h is not None and open_24h > 0:
        return open_24h
    if change_ratio is not None and change_ratio != Decimal("-1"):
        inferred_open = last_price / (Decimal("1") + change_ratio)
        if inferred_open > 0:
            return inferred_open
    return last_price


def _bitget_spot_price_change_24h(
    *,
    last_price: Decimal,
    open_24h: Decimal,
    change_ratio: Optional[Decimal],
) -> Decimal:
    if change_ratio is not None and change_ratio != Decimal("-1"):
        return last_price * change_ratio / (Decimal("1") + change_ratio)
    if open_24h > 0:
        return last_price - open_24h
    return Decimal("0")


def _bitget_spot_price_change_percent(
    open_24h: Decimal,
    price_change_24h: Decimal,
    change_ratio: Optional[Decimal],
) -> Decimal:
    if change_ratio is not None:
        return change_ratio * Decimal("100")
    if open_24h > 0:
        return (price_change_24h / open_24h) * Decimal("100")
    return Decimal("0")


def _normalize_data_source(pair: TradingPair) -> str:
    return str(getattr(pair, "data_source", None) or DATA_SOURCE_INTERNAL).strip().upper()


def _normalize_asset_type(pair: TradingPair) -> str:
    return str(getattr(pair, "asset_type", None) or "CRYPTO").strip().upper()


def _normalize_market_category(pair: TradingPair) -> str:
    return str(getattr(pair, "market_category", None) or "CRYPTO").strip().upper()


def _normalize_market_sub_category(pair: TradingPair) -> Optional[str]:
    value = str(getattr(pair, "market_sub_category", None) or "").strip().upper()
    if value:
        return value
    if _normalize_market_category(pair) == "STOCK":
        symbol = str(getattr(pair, "symbol", "") or "").strip().upper()
        base_symbol = _asset_symbol(getattr(pair, "base_asset", None))
        if symbol.endswith("ONUSDT") or base_symbol.endswith("ON"):
            return "STOCK_TOKEN"
        return "US_STOCK"
    return None


def _normalize_display_category(pair: TradingPair) -> Optional[str]:
    value = str(getattr(pair, "display_category", None) or "").strip().upper()
    return value or None


def _normalize_market_mode(pair: TradingPair) -> str:
    return str(getattr(pair, "market_mode", None) or "INTERNAL").strip().upper()


def _price_quant(pair: TradingPair) -> Decimal:
    precision = int(getattr(pair, "price_precision", 2) or 2)
    return Decimal("1").scaleb(-precision)


def _amount_quant(pair: TradingPair) -> Decimal:
    precision = int(getattr(pair, "amount_precision", 6) or 6)
    return Decimal("1").scaleb(-precision)


def _round_price(pair: TradingPair, value: Decimal) -> Decimal:
    return Decimal(str(value)).quantize(_price_quant(pair))


def _round_amount(pair: TradingPair, value: Decimal) -> Decimal:
    return Decimal(str(value)).quantize(_amount_quant(pair))


def _format_price_for_pair(pair: TradingPair, value: Any) -> str:
    return _decimal_to_str(_round_price(pair, _to_decimal(value)))


def _format_amount_for_pair(pair: TradingPair, value: Any) -> str:
    return _decimal_to_str(_round_amount(pair, _to_decimal(value)))


def _format_depth_for_pair(pair: TradingPair, depth: DepthResponse, limit: Optional[int] = None) -> DepthResponse:
    depth_limit = max(1, int(limit or max(len(depth.bids), len(depth.asks), 20)))

    def adapt(levels: Any) -> list[DepthItem]:
        items: list[DepthItem] = []
        if not isinstance(levels, list):
            return items
        for item in levels[:depth_limit]:
            price = _to_decimal(getattr(item, "price", None))
            amount = _to_decimal(getattr(item, "amount", None))
            if price <= 0 or amount <= 0:
                continue
            items.append(
                DepthItem(
                    price=_format_price_for_pair(pair, price),
                    amount=_format_amount_for_pair(pair, amount),
                )
            )
        return items

    data = depth.model_dump() if hasattr(depth, "model_dump") else depth.dict()
    data.update(
        {
            "symbol": pair.symbol,
            "price_precision": int(getattr(pair, "price_precision", 8) or 8),
            **_spot_pair_price_precision_metadata(pair),
            "amount_precision": int(getattr(pair, "amount_precision", 8) or 8),
            "bids": adapt(getattr(depth, "bids", [])),
            "asks": adapt(getattr(depth, "asks", [])),
        }
    )
    if getattr(depth, "last_price", None) is not None:
        data["last_price"] = _format_price_for_pair(pair, getattr(depth, "last_price"))
    if getattr(depth, "mid_price", None) is not None:
        data["mid_price"] = _format_price_for_pair(pair, getattr(depth, "mid_price"))
    return DepthResponse(**data)


def _format_trades_for_pair(pair: TradingPair, trades: TradesResponse, limit: Optional[int] = None) -> TradesResponse:
    trade_limit = max(1, int(limit or len(trades.trades) or 50))
    items: list[TradeItem] = []
    for item in list(getattr(trades, "trades", []) or [])[:trade_limit]:
        price = _to_decimal(getattr(item, "price", None))
        amount = _to_decimal(getattr(item, "amount", None))
        if price <= 0 or amount <= 0:
            continue
        items.append(
            TradeItem(
                id=getattr(item, "id", None),
                trade_id=getattr(item, "trade_id", None),
                provider_trade_id=getattr(item, "provider_trade_id", None),
                price=_format_price_for_pair(pair, price),
                amount=_format_amount_for_pair(pair, amount),
                side="SELL" if str(getattr(item, "side", "")).upper() == "SELL" else "BUY",
                ts=int(getattr(item, "ts", 0) or 0),
                provider=getattr(item, "provider", None) or getattr(trades, "provider", None),
                provider_symbol=getattr(item, "provider_symbol", None) or getattr(trades, "provider_symbol", None),
                source=getattr(item, "source", None) or getattr(trades, "source", None),
                freshness=getattr(item, "freshness", None) or getattr(trades, "freshness", None),
                updated_at_ms=getattr(item, "updated_at_ms", None) or getattr(trades, "updated_at_ms", None),
                created_at=getattr(item, "created_at", None),
                event_time_ms=getattr(item, "event_time_ms", None),
                received_at_ms=(
                    getattr(item, "received_at_ms", None)
                    or getattr(trades, "received_at_ms", None)
                    or getattr(trades, "updated_at_ms", None)
                ),
                time_origin=getattr(item, "time_origin", None),
            )
        )
    data = trades.model_dump() if hasattr(trades, "model_dump") else trades.dict()
    data.update({"symbol": pair.symbol, "trades": items[:trade_limit]})
    return TradesResponse(**data)


def _default_itick_price(pair: TradingPair) -> Decimal:
    category = _normalize_market_category(pair)
    if category == "INDEX":
        return Decimal("1000")
    if category == "FOREX":
        return Decimal("1")
    if category == "METAL":
        return Decimal("1000")
    if category == "COMMODITY":
        return Decimal("100")
    return Decimal("100")


def _default_internal_price(pair: TradingPair) -> Decimal:
    base_symbol = _asset_symbol(getattr(pair, "base_asset", None))
    if base_symbol == "MFC":
        return Decimal("10")
    if base_symbol == "RCB":
        return Decimal("0.1")
    return Decimal("1")


def _stable_unit(symbol: str, salt: str, modulo: int = 10000) -> Decimal:
    seed = f"{symbol}:{salt}".encode("utf-8")
    value = sum((idx + 1) * byte for idx, byte in enumerate(seed)) % modulo
    return Decimal(value) / Decimal(modulo)


def _build_internal_ticker_fallback(pair: TradingPair, last_price: Decimal) -> Dict[str, Decimal]:
    price = last_price if last_price > 0 else _round_price(pair, _default_internal_price(pair))
    abs_change = Decimal("1.2")
    change_percent = (_stable_unit(pair.symbol, "internal-change") * abs_change * Decimal("2")) - abs_change
    distance = abs(change_percent) / Decimal("100") + Decimal("0.003")
    high_24h = _round_price(pair, max(price * (Decimal("1") + distance), price))
    low_24h = _round_price(pair, max(price * (Decimal("1") - distance), _price_quant(pair)))

    base_symbol = _asset_symbol(getattr(pair, "base_asset", None))
    if base_symbol == "MFC":
        min_volume, max_volume = Decimal("10000"), Decimal("100000")
    elif base_symbol == "RCB":
        min_volume, max_volume = Decimal("5000"), Decimal("50000")
    else:
        min_volume, max_volume = Decimal("3000"), Decimal("30000")

    quote_volume = min_volume + _stable_unit(pair.symbol, "internal-quote-volume") * (max_volume - min_volume)
    quote_volume = quote_volume.quantize(Decimal("0.01"))

    return {
        "last_price": price,
        "open_24h": _round_price(pair, price / (Decimal("1") + change_percent / Decimal("100")))
        if change_percent > Decimal("-99")
        else price,
        "high_24h": high_24h,
        "low_24h": low_24h,
        "volume_24h": (quote_volume / price).quantize(_amount_quant(pair)) if price > 0 else Decimal("0"),
        "quote_volume_24h": quote_volume,
        "price_change_percent": change_percent,
    }


def _itick_market_name(pair: TradingPair) -> str:
    asset_type = _normalize_asset_type(pair)
    market_category = _normalize_market_category(pair)
    if asset_type == "INDEX" or market_category == "INDEX":
        return "indices"
    if asset_type == "FOREX" or market_category == "FOREX":
        return "forex"
    if asset_type == "METAL" or market_category == "METAL":
        return "forex"
    if asset_type == "COMMODITY" or market_category == "COMMODITY":
        return "forex"
    return "stock"


def _itick_region(pair: TradingPair) -> str:
    market_name = _itick_market_name(pair)
    region = _external_region(pair)
    if market_name in ("indices", "forex") and region in ("", "US", "FOREX", "GLOBAL"):
        return "GB"
    if market_name == "future" and region in ("", "FOREX", "GLOBAL"):
        return "US"
    return region


def _get_itick_quote_payload(pair: TradingPair) -> Any:
    market_name = _itick_market_name(pair)
    if market_name == "stock":
        return itick_market_service.get_stock_quote(
            region=_itick_region(pair),
            code=_external_symbol(pair),
        )
    return itick_market_service.get_market_quote(
        market=market_name,
        region=_itick_region(pair),
        code=_external_symbol(pair),
    )


def _get_itick_kline_payload(pair: TradingPair, k_type: int, limit: int) -> Any:
    market_name = _itick_market_name(pair)
    if market_name == "stock":
        return itick_market_service.get_stock_kline(
            region=_itick_region(pair),
            code=_external_symbol(pair),
            kType=k_type,
            limit=limit,
        )
    return itick_market_service.get_market_kline(
        market=market_name,
        region=_itick_region(pair),
        code=_external_symbol(pair),
        kType=k_type,
        limit=limit,
    )


def _iter_chunks(items: List[Any], size: int):
    for idx in range(0, len(items), size):
        yield items[idx : idx + size]


def _extract_itick_batch_items(payload: Any) -> List[Dict[str, Any]]:
    data = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        items: List[Dict[str, Any]] = []
        for key, value in data.items():
            if isinstance(value, dict):
                merged = dict(value)
                merged.setdefault("s", key)
                merged.setdefault("code", key)
                items.append(merged)
        return items
    return []


def _fetch_itick_quote_batch(pairs: List[TradingPair]) -> Dict[str, Dict[str, Any]]:
    stock_grouped: Dict[str, List[TradingPair]] = {}
    grouped: Dict[Tuple[str, str], List[TradingPair]] = {}
    logger.debug(
        "itick ticker batch pairs_count=%s requested_symbols=%s",
        len(pairs),
        [str(getattr(pair, "symbol", "") or "") for pair in pairs],
    )
    for pair in pairs:
        if _is_itick_stock_pair(pair):
            stock_grouped.setdefault(_itick_region(pair), []).append(pair)
            continue
        grouped.setdefault((_itick_market_name(pair), _itick_region(pair)), []).append(pair)

    quote_by_symbol: Dict[str, Dict[str, Any]] = {}
    for region, group_pairs in stock_grouped.items():
        codes = [_external_symbol(pair) for pair in group_pairs]
        logger.debug(
            "itick stock batch codes region=%s count=%s batch_size=%s codes=%s",
            region,
            len(codes),
            ITICK_STOCK_QUOTE_BATCH_SIZE,
            codes,
        )
        item_by_code: Dict[str, Dict[str, Any]] = {}
        for code_chunk in _iter_chunks(codes, ITICK_STOCK_QUOTE_BATCH_SIZE):
            try:
                item_by_code.update(
                    itick_market_service.get_stock_quotes(
                        region=region,
                        codes=code_chunk,
                    )
                )
            except Exception as exc:
                logger.warning(
                    "itick stock batch quote fetch failed region=%s count=%s error=%s",
                    region,
                    len(code_chunk),
                    exc,
                )

        for pair in group_pairs:
            code = _external_symbol(pair)
            lookup_codes = [code, code.replace(".", ""), code.replace(":", ""), code.replace("-", "")]
            if code.endswith("ON"):
                lookup_codes.append(code[:-2])
            item = next((item_by_code.get(lookup_code) for lookup_code in lookup_codes if item_by_code.get(lookup_code)), None)
            if item:
                quote_by_symbol[pair.symbol] = item
            logger.debug(
                "itick stock batch quote map pair=%s external_symbol=%s matched=%s p=%s ch=%s chp=%s tu=%s",
                pair.symbol,
                code,
                bool(item),
                item.get("p") if item else None,
                item.get("ch") if item else None,
                item.get("chp") if item else None,
                item.get("tu") if item else None,
            )

    for (market_name, region), group_pairs in grouped.items():
        for chunk in _iter_chunks(group_pairs, 10):
            codes = ",".join(_external_symbol(pair) for pair in chunk)
            try:
                payload = itick_market_service.get_market_quotes(
                    market=market_name,
                    region=region,
                    codes=codes,
                )
            except Exception as exc:
                logger.warning(
                    "itick batch quote fetch failed market=%s region=%s count=%s error=%s",
                    market_name,
                    region,
                    len(chunk),
                    exc,
                )
                continue

            items = _extract_itick_batch_items(payload)
            item_by_code = {
                str(item.get("s") or item.get("code") or item.get("symbol") or "").upper(): item
                for item in items
            }
            for pair in chunk:
                code = _external_symbol(pair)
                item = item_by_code.get(code)
                if item:
                    quote_by_symbol[pair.symbol] = item

    return quote_by_symbol


def _empty_itick_stock_ticker_dict(pair: TradingPair) -> Dict[str, Any]:
    item = {
        "symbol": pair.symbol,
        "last_price": None,
        "change_24h": None,
        "price_change_percent_24h": None,
        "price_change_24h": None,
        "high_24h": None,
        "low_24h": None,
        "volume_24h": None,
        "base_volume_24h": None,
        "quote_volume_24h": None,
        "source": "itick",
        "quote_freshness": "FALLBACK",
        "ts": None,
        **_ticker_metadata(pair),
    }
    item.update(_market_status_payload_for_pair(pair))
    return item


def _itick_ref_price(pair: TradingPair, *, allow_upstream: bool = True) -> Decimal:
    cache_key = pair.symbol

    if allow_upstream and is_stock_dealer_pair(pair):
        try:
            context_price = get_stock_trade_context(db=None, trading_pair=pair, limit=1).mid_price
            if context_price and context_price > 0:
                price = _round_price(pair, Decimal(str(context_price)))
                _ITICK_LAST_GOOD_PRICE[cache_key] = price
                return price
        except Exception as exc:
            logger.warning("itick stock dealer reference fallback for %s: %s", pair.symbol, exc)

    if allow_upstream:
        try:
            payload = _get_itick_quote_payload(pair)
            data = payload.get("data") if isinstance(payload, dict) else None
            if isinstance(data, dict):
                raw_price = next(
                    (
                        data.get(field)
                        for field in ITICK_LATEST_PRICE_FIELDS
                        if data.get(field) not in (None, "")
                    ),
                    None,
                )
                price = Decimal(str(raw_price or "0"))
                if price > 0:
                    price = _round_price(pair, price)
                    _ITICK_LAST_GOOD_PRICE[cache_key] = price
                    return price
        except Exception as exc:
            logger.warning("itick reference quote fallback for %s: %s", pair.symbol, exc)

    cached_price = _ITICK_LAST_GOOD_PRICE.get(cache_key)
    if cached_price and cached_price > 0:
        return _round_price(pair, cached_price)

    base_price = _default_itick_price(pair)
    drift = (_stable_unit(pair.symbol, "default-price") - Decimal("0.5")) / Decimal("50")
    fallback = base_price * (Decimal("1") + drift)
    price = _round_price(pair, max(fallback, _price_quant(pair)))
    _ITICK_LAST_GOOD_PRICE[cache_key] = price
    return price


def _sort_order(pair: TradingPair) -> int:
    try:
        return int(getattr(pair, "sort_order", 0) or 0)
    except Exception:
        return 0


def _is_hot(pair: TradingPair) -> bool:
    return bool(getattr(pair, "is_hot", False))


def _ticker_metadata(pair: TradingPair) -> Dict[str, Any]:
    price_precision_metadata = _spot_pair_price_precision_metadata(pair)
    base_asset = getattr(pair, "base_asset", None)
    return {
        "display_symbol": _display_symbol(pair),
        "base_asset": _asset_symbol(base_asset),
        "quote_asset": _asset_symbol(getattr(pair, "quote_asset", None)),
        "base_asset_logo_url": str(getattr(base_asset, "icon_url", None) or "").strip() or None,
        "price_precision": int(getattr(pair, "price_precision", 8) or 8),
        **price_precision_metadata,
        "amount_precision": int(getattr(pair, "amount_precision", 8) or 8),
        "asset_type": _normalize_asset_type(pair),
        "data_source": _normalize_data_source(pair),
        "market_mode": _normalize_market_mode(pair),
        "external_symbol": str(getattr(pair, "external_symbol", None) or "").strip().upper() or None,
        "external_region": str(getattr(pair, "external_region", None) or "").strip().upper() or None,
        "market_category": _normalize_market_category(pair),
        "market_sub_category": _normalize_market_sub_category(pair),
        "display_category": _normalize_display_category(pair),
        "display_group": str(getattr(pair, "display_group", None) or "").strip() or None,
        "sort_order": _sort_order(pair),
        "is_hot": _is_hot(pair),
        "show_spot_logo": bool(getattr(pair, "show_spot_logo", False)),
        "spot_logo_url": str(getattr(pair, "spot_logo_url", None) or "").strip() or None,
        "spot_logo_alt": str(getattr(pair, "spot_logo_alt", None) or "").strip() or None,
    }


def _ticker_to_dict(ticker: TickerItem) -> Dict[str, Any]:
    if hasattr(ticker, "model_dump"):
        return ticker.model_dump()
    return ticker.dict()


def _with_pair_metadata(ticker: TickerItem, pair: TradingPair) -> TickerItem:
    ticker_data = _ticker_to_dict(ticker)
    data = {**ticker_data, **_ticker_metadata(pair)}
    for key in _SPOT_PRICE_PRECISION_PAYLOAD_KEYS:
        if ticker_data.get(key) not in (None, ""):
            data[key] = ticker_data.get(key)
    data.update(_market_status_payload_for_pair(pair))
    data["quote_freshness"] = data.get("quote_freshness") or _quote_freshness(
        str(data.get("source") or ""),
        _normalize_quote_ts(data.get("ts")),
    )
    return TickerItem(**data)


def _is_itick_stock_pair(pair: TradingPair) -> bool:
    return (
        _normalize_asset_type(pair) == "STOCK"
        and _normalize_data_source(pair) == DATA_SOURCE_ITICK
    )


def _normalize_quote_ts(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        return value
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 100000000000:
            timestamp = timestamp / 1000
        try:
            return datetime.utcfromtimestamp(timestamp)
        except Exception:
            return None
    if isinstance(value, str):
        text_value = value.strip()
        if not text_value:
            return None
        try:
            return _normalize_quote_ts(float(text_value))
        except Exception:
            pass
        try:
            parsed = datetime.fromisoformat(text_value.replace("Z", "+00:00"))
        except Exception:
            return None
        if parsed.tzinfo is not None:
            return parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    return None


def _quote_ts_from_itick_data(data: Optional[Dict[str, Any]]) -> Optional[datetime]:
    if not isinstance(data, dict):
        return None
    return _normalize_quote_ts(data.get("t") or data.get("timestamp") or data.get("time") or data.get("ts"))


def _quote_freshness(source: str, ts: Optional[datetime]) -> str:
    normalized_source = str(source or "").strip().upper()
    if "FALLBACK" in normalized_source:
        return "FALLBACK"
    if "LAST_VALID" in normalized_source:
        return "LAST_VALID"
    if ts is None:
        return "FALLBACK"
    age_seconds = (datetime.utcnow() - ts).total_seconds()
    if age_seconds <= 30:
        return "LIVE"
    if age_seconds <= 300:
        return "STALE"
    return "LAST_VALID"


def _market_status_payload_for_pair(pair: TradingPair) -> Dict[str, Any]:
    if _is_itick_stock_pair(pair):
        return itick_holiday_service.get_us_stock_regular_status().to_payload()
    return itick_holiday_service.crypto_open().to_payload()


def _external_symbol(pair: TradingPair) -> str:
    return str(getattr(pair, "external_symbol", None) or pair.symbol or "").strip().upper()


def _external_region(pair: TradingPair) -> str:
    return str(getattr(pair, "external_region", None) or "US").strip().upper()


def _asset_symbol(asset: Any) -> str:
    return str(getattr(asset, "symbol", "") or "").strip().upper()


def _display_symbol(pair: TradingPair) -> str:
    base_symbol = _asset_symbol(getattr(pair, "base_asset", None))
    quote_symbol = _asset_symbol(getattr(pair, "quote_asset", None))
    if base_symbol and quote_symbol:
        return f"{base_symbol}/{quote_symbol}"
    return pair.symbol


def _is_contract_pair(pair: TradingPair) -> bool:
    symbol = str(getattr(pair, "symbol", "") or "").strip().upper()
    asset_type = _normalize_asset_type(pair)
    market_category = _normalize_market_category(pair)
    market_sub_category = _normalize_market_sub_category(pair) or ""
    if any(token in symbol for token in ("PERP", "SWAP", "FUTURES")):
        return True
    if asset_type in CONTRACT_PAIR_CATEGORIES or market_category in CONTRACT_PAIR_CATEGORIES:
        return True
    return "CONTRACT" in market_sub_category


def _contract_pair_symbol_candidate(pair: TradingPair) -> str:
    symbol = str(getattr(pair, "symbol", "") or "").strip().upper()
    if not symbol:
        return ""
    return symbol if symbol.endswith("_PERP") else f"{symbol}_PERP"


def _contract_symbol_row_value(row: Any, name: str, index: int) -> str:
    value = getattr(row, name, None)
    if value in (None, ""):
        try:
            value = row[index]
        except (IndexError, KeyError, TypeError):
            value = None
    return str(value or "").strip().upper()


def _contract_authority(
    db: Session,
    symbol_candidates: set[str],
    provider_candidates: set[str],
) -> Tuple[Dict[str, bool], Dict[str, bool]]:
    session_info = getattr(db, "info", None)
    cached: Dict[str, Any] = {}
    if isinstance(session_info, dict):
        cached_value = session_info.get(_CONTRACT_AUTHORITY_SESSION_CACHE_KEY)
        if isinstance(cached_value, dict):
            cached = cached_value

    symbol_authority = cached.setdefault("symbols", {})
    provider_authority = cached.setdefault("providers", {})
    covered_symbols = cached.setdefault("covered_symbols", set())
    covered_providers = cached.setdefault("covered_providers", set())
    missing_symbols = symbol_candidates - covered_symbols
    missing_providers = provider_candidates - covered_providers

    if missing_symbols or missing_providers:
        clauses = []
        if missing_symbols:
            clauses.append(ContractSymbol.symbol.in_(missing_symbols))
        if missing_providers:
            clauses.append(ContractSymbol.provider_symbol.in_(missing_providers))
        rows = (
            db.query(
                ContractSymbol.symbol,
                ContractSymbol.provider_symbol,
                ContractSymbol.status,
            )
            .filter(or_(*clauses))
            .all()
        )
        for row in rows:
            symbol = _contract_symbol_row_value(row, "symbol", 0)
            provider_symbol = _contract_symbol_row_value(row, "provider_symbol", 1)
            status = _contract_symbol_row_value(row, "status", 2) == "1"
            if symbol:
                symbol_authority[symbol] = status
            if provider_symbol:
                provider_authority[provider_symbol] = (
                    provider_authority.get(provider_symbol, False) or status
                )
        covered_symbols.update(missing_symbols)
        covered_providers.update(missing_providers)

    if isinstance(session_info, dict):
        session_info[_CONTRACT_AUTHORITY_SESSION_CACHE_KEY] = cached
    return symbol_authority, provider_authority


def filter_contract_authorized_trading_pairs(
    db: Session,
    pairs: List[TradingPair],
) -> List[TradingPair]:
    """Keep spot/unconfigured pairs and exclude explicitly disabled contracts."""
    normalized_pairs = list(pairs)
    contract_pairs = [pair for pair in normalized_pairs if _is_contract_pair(pair)]
    if not contract_pairs:
        return normalized_pairs

    symbol_candidates = {
        candidate
        for pair in contract_pairs
        if (candidate := _contract_pair_symbol_candidate(pair))
    }
    provider_candidates = {
        provider_symbol
        for pair in contract_pairs
        if (provider_symbol := _external_symbol(pair))
    }
    symbol_authority, provider_authority = _contract_authority(
        db,
        symbol_candidates,
        provider_candidates,
    )

    def is_authorized(pair: TradingPair) -> bool:
        if not _is_contract_pair(pair):
            return True
        symbol_candidate = _contract_pair_symbol_candidate(pair)
        if symbol_candidate in symbol_authority:
            return symbol_authority[symbol_candidate]
        provider_symbol = _external_symbol(pair)
        if provider_symbol in provider_authority:
            return provider_authority[provider_symbol]
        return True

    filtered_pairs = [
        pair
        for pair in normalized_pairs
        if is_authorized(pair)
    ]
    if len(filtered_pairs) != len(normalized_pairs):
        logger.debug(
            "market_contract_membership_pruned requested=%s retained=%s",
            len(normalized_pairs),
            len(filtered_pairs),
        )
    return filtered_pairs


def _pair_base_quote(pair: TradingPair) -> Tuple[str, str]:
    return (
        _asset_symbol(getattr(pair, "base_asset", None)),
        _asset_symbol(getattr(pair, "quote_asset", None)),
    )


def _normalize_pair_search_text(value: Any) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum())


def _pair_matches_keyword(pair: TradingPair, keyword: str) -> bool:
    normalized_keyword = _normalize_pair_search_text(keyword)
    if not normalized_keyword:
        return True
    base, quote = _pair_base_quote(pair)
    values = [
        getattr(pair, "symbol", None),
        _display_symbol(pair),
        base,
        quote,
        getattr(pair, "external_symbol", None),
        getattr(pair, "asset_type", None),
        getattr(pair, "market_category", None),
        getattr(pair, "market_sub_category", None),
        getattr(pair, "display_category", None),
        getattr(pair, "display_group", None),
    ]
    return any(normalized_keyword in _normalize_pair_search_text(value) for value in values)


def _pair_matches_rwa(pair: TradingPair) -> bool:
    base, _ = _pair_base_quote(pair)
    if _normalize_asset_type(pair) == "RWA" or base in RWA_PAIR_BASES:
        return True
    values = [
        getattr(pair, "symbol", None),
        _display_symbol(pair),
        getattr(pair, "market_category", None),
        getattr(pair, "market_sub_category", None),
        getattr(pair, "display_group", None),
    ]
    return any("RWA" in str(value or "").upper() for value in values)


def _pair_matches_category(pair: TradingPair, category: str) -> bool:
    normalized_category = str(category or "all").strip().lower()
    if normalized_category in ("", "all"):
        return True

    if normalized_category == "spot":
        return not _is_contract_pair(pair)

    display_category = _normalize_display_category(pair)
    display_category_map = {
        "mainstream": "MAINSTREAM",
        "stock": "STOCK",
        "platform": "PLATFORM",
        "rwa": "RWA",
        "metal": "METAL",
        "commodity": "COMMODITY",
        "index": "INDEX",
        "forex": "FOREX",
        "etf": "ETF",
    }
    expected_display_category = display_category_map.get(normalized_category)
    if expected_display_category:
        if display_category == expected_display_category:
            return True

    base, _ = _pair_base_quote(pair)
    asset_type = _normalize_asset_type(pair)
    market_category = _normalize_market_category(pair)

    if normalized_category == "mainstream":
        return (not asset_type or asset_type == "CRYPTO") and (
            base in MAINSTREAM_PAIR_BASES or str(pair.symbol).upper() in {"BTCUSDT", "ETHUSDT"}
        )
    if normalized_category == "stock":
        return asset_type == "STOCK" or market_category == "STOCK"
    if normalized_category == "platform":
        return asset_type == "PLATFORM" or base in PLATFORM_PAIR_BASES
    if normalized_category == "rwa":
        return _pair_matches_rwa(pair)
    if normalized_category == "metal":
        return asset_type == "METAL" or market_category == "METAL"
    if normalized_category == "commodity":
        return asset_type == "COMMODITY" or market_category == "COMMODITY"
    if normalized_category == "index":
        return asset_type == "INDEX" or market_category == "INDEX"
    if normalized_category == "forex":
        return asset_type == "FOREX" or market_category == "FOREX"
    if normalized_category == "etf":
        return asset_type == "ETF" or market_category == "ETF"

    return True


def _now_ms() -> int:
    return int(time.time() * 1000)


def _get_active_pair(db: Session, symbol: str) -> TradingPair:
    normalized_symbol = symbol.upper().strip()
    pair = (
        db.query(TradingPair)
        .filter(TradingPair.symbol == normalized_symbol, TradingPair.status == 1)
        .first()
    )
    if not pair:
        raise ValueError("trading pair not found")
    return pair


def _get_internal_depth(db: Session, pair: TradingPair, limit: int = 20) -> DepthResponse:
    remaining_expr = Order.amount - Order.filled_amount

    bid_rows = (
        db.query(
            Order.price.label("price"),
            func.sum(remaining_expr).label("amount"),
        )
        .filter(
            Order.trading_pair_id == pair.id,
            Order.side == "BUY",
            Order.status.in_(OPEN_STATUSES),
            remaining_expr > 0,
        )
        .group_by(Order.price)
        .order_by(Order.price.desc())
        .limit(limit)
        .all()
    )

    ask_rows = (
        db.query(
            Order.price.label("price"),
            func.sum(remaining_expr).label("amount"),
        )
        .filter(
            Order.trading_pair_id == pair.id,
            Order.side == "SELL",
            Order.status.in_(OPEN_STATUSES),
            remaining_expr > 0,
        )
        .group_by(Order.price)
        .order_by(Order.price.asc())
        .limit(limit)
        .all()
    )

    bids = [
        DepthItem(price=_format_price_for_pair(pair, row.price), amount=_format_amount_for_pair(pair, row.amount))
        for row in bid_rows
        if row.amount is not None
    ]
    asks = [
        DepthItem(price=_format_price_for_pair(pair, row.price), amount=_format_amount_for_pair(pair, row.amount))
        for row in ask_rows
        if row.amount is not None
    ]

    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        bids=bids,
        asks=asks,
        ts=_now_ms(),
        provider=None,
        stale=False,
        # An empty internal order book is still an authoritative, current
        # snapshot.  Marking it MISSING makes clients preserve stale levels
        # instead of clearing fully filled/cancelled price levels.
        source="INTERNAL",
        freshness="RECENT",
    )


def _get_binance_depth(pair: TradingPair, limit: int = 20) -> DepthResponse:
    payload = binance_market_service.get_depth(_external_symbol(pair), limit=limit)
    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        bids=[
            DepthItem(price=_format_price_for_pair(pair, item.price), amount=_format_amount_for_pair(pair, item.amount))
            for item in payload.bids
        ],
        asks=[
            DepthItem(price=_format_price_for_pair(pair, item.price), amount=_format_amount_for_pair(pair, item.amount))
            for item in payload.asks
        ],
        ts=payload.ts,
    )


def _stable_depth_amount(pair: TradingPair, side: str, level: int) -> Decimal:
    base = Decimal("5") + _stable_unit(pair.symbol, f"{side}:{level}", 5000) * Decimal("25")
    return max(_round_amount(pair, base), _amount_quant(pair))


def _build_itick_fallback_depth(pair: TradingPair, limit: int = 20) -> DepthResponse:
    depth_limit = max(1, min(int(limit or 20), 20))
    mid_price = _itick_ref_price(pair, allow_upstream=False)
    tick = _price_quant(pair)
    spread_rate = Decimal("0.0004")
    half_spread = max(mid_price * spread_rate / Decimal("2"), tick)
    step = max(mid_price * Decimal("0.0002"), tick)

    bids: List[DepthItem] = []
    asks: List[DepthItem] = []
    for idx in range(depth_limit):
        level = idx + 1
        bid_price = _round_price(pair, mid_price - half_spread - step * idx)
        ask_price = _round_price(pair, mid_price + half_spread + step * idx)
        if bid_price <= 0:
            continue
        if ask_price <= bid_price:
            ask_price = _round_price(pair, bid_price + tick)

        bids.append(
            DepthItem(
                price=_decimal_to_str(bid_price),
                amount=_decimal_to_str(_stable_depth_amount(pair, "BID", level)),
            )
        )
        asks.append(
            DepthItem(
                price=_decimal_to_str(ask_price),
                amount=_decimal_to_str(_stable_depth_amount(pair, "ASK", level)),
            )
        )

    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(getattr(pair, "price_precision", 2) or 2),
        amount_precision=int(getattr(pair, "amount_precision", 6) or 6),
        bids=bids,
        asks=asks,
        ts=_now_ms(),
        last_price=_decimal_to_str(mid_price),
        mid_price=_decimal_to_str(mid_price),
        source="itick_fallback_depth",
        fetched_at=_now_ms(),
    )


def get_depth(db: Session, symbol: str, limit: int = 20, *, fast: bool = False) -> DepthResponse:
    pair = _get_active_pair(db, symbol)
    data_source = _normalize_data_source(pair)

    if data_source == DATA_SOURCE_BINANCE:
        return _get_external_spot_depth_cached(db, pair, limit=limit, fast=fast)

    internal_depth = _get_internal_depth(db, pair, limit=limit)

    if data_source == DATA_SOURCE_ITICK:
        if is_stock_dealer_pair(pair):
            depth = get_stock_depth_with_fallback(pair, limit=limit)
            if depth.bids and depth.asks:
                return depth
            return _build_itick_fallback_depth(pair, limit=limit)
        depth = _get_internal_depth(db, pair, limit=limit)
        if depth.bids and depth.asks:
            return depth
        return _build_itick_fallback_depth(pair, limit=limit)

    return internal_depth


def _get_internal_trades(db: Session, pair: TradingPair, limit: int = 50) -> TradesResponse:
    rows = (
        db.query(Trade)
        .filter(Trade.trading_pair_id == pair.id)
        .order_by(Trade.created_at.desc())
        .limit(limit)
        .all()
    )

    trades: List[TradeItem] = []
    for row in rows:
        trade_side = "BUY"
        if getattr(row, "taker_order_id", None):
            taker_order = db.query(Order).filter(Order.id == row.taker_order_id).first()
            if taker_order and taker_order.side:
                trade_side = taker_order.side

        trade_time_ms = spot_trade_utc_timestamp_ms(row.created_at)
        trade_id = str(row.id) if getattr(row, "id", None) is not None else None
        trades.append(
            TradeItem(
                id=trade_id,
                trade_id=trade_id,
                provider_trade_id=None,
                price=_decimal_to_str(row.price),
                amount=_decimal_to_str(row.amount),
                side=trade_side,
                ts=trade_time_ms,
                event_time_ms=trade_time_ms,
                received_at_ms=None,
                created_at=spot_trade_utc_isoformat(row.created_at),
                time_origin="PLATFORM_TRADE",
                source="INTERNAL",
            )
        )

    return TradesResponse(symbol=pair.symbol, trades=trades)


def _get_binance_trades(pair: TradingPair, limit: int = 50) -> TradesResponse:
    payload = binance_market_service.get_trades(_external_symbol(pair), limit=limit)
    return TradesResponse(
        symbol=pair.symbol,
        trades=[
            TradeItem(price=item.price, amount=item.amount, side=item.side, ts=item.ts)
            for item in payload.items
        ],
    )


def _spot_provider_rows(payload: Any) -> list[Any]:
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
    if isinstance(payload, list):
        return payload
    return []


def _spot_provider_first_row(payload: Any) -> Dict[str, Any]:
    rows = _spot_provider_rows(payload)
    if rows and isinstance(rows[0], dict):
        return rows[0]
    return {}


def _spot_provider_ts(value: Any) -> int:
    try:
        timestamp = int(value or 0)
    except Exception:
        timestamp = 0
    if timestamp > 0:
        return timestamp
    return _now_ms()


def _spot_provider_event_time_ms(value: Any) -> Optional[int]:
    try:
        timestamp = int(value or 0)
    except Exception:
        return None
    return timestamp if timestamp > 0 else None


def _spot_provider_symbol(db: Session, pair: TradingPair, provider: MarketDataProviderConfig) -> str:
    return resolve_spot_provider_symbol(
        db,
        provider_code=provider.provider_code,
        local_symbol=pair.symbol,
        fallback_symbol=_external_symbol(pair),
    )


def _enabled_spot_market_providers_for_pair(
    db: Session,
    pair: TradingPair,
    *,
    max_providers: Optional[int] = None,
) -> tuple[MarketDataProviderConfig, ...]:
    ordered = tuple(enabled_spot_market_providers(db))

    if max_providers is not None:
        return ordered[: max(0, int(max_providers))]
    return ordered


def _primary_spot_market_provider_for_pair(
    db: Session,
    pair: TradingPair,
) -> Optional[MarketDataProviderConfig]:
    providers = _enabled_spot_market_providers_for_pair(db, pair, max_providers=1)
    return providers[0] if providers else None


def _primary_spot_ws_provider_code(
    db: Session,
    pair: TradingPair,
    *,
    domain: str = "depth",
) -> Optional[str]:
    primary_provider = _primary_spot_market_provider_for_pair(db, pair)
    if primary_provider is None:
        return None
    provider_code = str(primary_provider.provider_code or "").strip().upper()
    if spot_provider_ws_supports_provider(provider_code, domain=domain):
        return provider_code
    return None


def _spot_provider_request_config(
    provider: MarketDataProviderConfig,
    *,
    timeout_cap_ms: int = _SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS,
) -> MarketDataProviderConfig:
    timeout_ms = max(
        300,
        min(int(provider.timeout_ms or 3000), int(timeout_cap_ms or _SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS)),
    )
    if timeout_ms == int(provider.timeout_ms or 0):
        return provider
    return replace(provider, timeout_ms=timeout_ms)


def _normalize_spot_price_precision(value: Any) -> Optional[int]:
    try:
        precision = int(value)
    except Exception:
        return None
    if 0 <= precision <= _SPOT_DISPLAY_PRICE_PRECISION_MAX:
        return precision
    return None


def _precision_from_tick_size(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        tick = Decimal(str(value).strip())
    except Exception:
        return None
    if tick <= 0:
        return None
    exponent = tick.normalize().as_tuple().exponent
    precision = max(0, -int(exponent))
    return min(precision, _SPOT_DISPLAY_PRICE_PRECISION_MAX)


def _tick_size_from_precision(precision: Optional[int]) -> Optional[str]:
    normalized = _normalize_spot_price_precision(precision)
    if normalized is None:
        return None
    if normalized <= 0:
        return "1"
    return "0." + ("0" * (normalized - 1)) + "1"


def _spot_pair_price_precision_metadata(pair: TradingPair) -> Dict[str, Any]:
    precision = _normalize_spot_price_precision(getattr(pair, "price_precision", None))
    source = "TRADING_PAIR"
    if precision is None:
        precision = _SPOT_DISPLAY_PRICE_PRECISION_FALLBACK
        source = "FALLBACK"
    provider = "INTERNAL" if _normalize_data_source(pair) == DATA_SOURCE_INTERNAL else None
    return {
        "price_tick_size": _tick_size_from_precision(precision),
        "display_price_precision": precision,
        "price_precision_source": source,
        "price_precision_provider": provider,
    }


def _spot_provider_precision_metadata_from_payload(
    provider_code: str,
    payload: Any,
) -> Optional[Dict[str, Any]]:
    code = str(provider_code or "").strip().upper()
    tick_size: Any = None
    precision: Optional[int] = None

    if code == PROVIDER_OKX_SPOT:
        row = _spot_provider_first_row(payload)
        tick_size = row.get("tickSz")
    elif code == PROVIDER_BITGET_SPOT:
        row = _spot_provider_first_row(payload)
        tick_size = row.get("tickSize") or row.get("priceTick") or row.get("priceStep")
        precision = _normalize_spot_price_precision(row.get("pricePrecision"))
    elif code == PROVIDER_BINANCE_SPOT and isinstance(payload, dict):
        filters = payload.get("filters")
        if isinstance(filters, list):
            price_filter = next(
                (
                    item
                    for item in filters
                    if isinstance(item, dict) and item.get("filterType") == "PRICE_FILTER"
                ),
                None,
            )
            if isinstance(price_filter, dict):
                tick_size = price_filter.get("tickSize")

    tick_precision = _precision_from_tick_size(tick_size)
    display_precision = tick_precision if tick_precision is not None else precision
    if display_precision is None:
        return None

    return {
        "price_tick_size": str(tick_size) if tick_size not in (None, "") else _tick_size_from_precision(display_precision),
        "display_price_precision": display_precision,
        "price_precision_source": "PROVIDER_TICK_SIZE",
        "price_precision_provider": code,
    }


def _spot_provider_price_precision_metadata(
    db: Session,
    pair: TradingPair,
    provider: Optional[MarketDataProviderConfig],
) -> Dict[str, Any]:
    fallback = _spot_pair_price_precision_metadata(pair)
    if provider is None:
        return fallback

    provider_code = str(getattr(provider, "provider_code", "") or "").strip().upper()
    if provider_code not in {PROVIDER_OKX_SPOT, PROVIDER_BITGET_SPOT, PROVIDER_BINANCE_SPOT}:
        return fallback

    try:
        provider_symbol = _spot_provider_symbol(db, pair, provider)
    except Exception:
        provider_symbol = _external_symbol(pair)
    cache_key = (provider_code, str(provider_symbol or "").strip().upper())
    now = time.monotonic()
    cached = _SPOT_PRICE_PRECISION_METADATA_CACHE.get(cache_key)
    if cached and now - cached[0] <= _SPOT_PRICE_PRECISION_METADATA_TTL_SECONDS:
        return dict(cached[1])
    miss_cached = _SPOT_PRICE_PRECISION_METADATA_MISS_CACHE.get(cache_key)
    if miss_cached and now - miss_cached[0] <= _SPOT_PRICE_PRECISION_METADATA_MISS_TTL_SECONDS:
        return dict(miss_cached[1])

    metadata = fallback
    try:
        payload = request_contract_market_provider_json(
            _spot_provider_request_config(provider, timeout_cap_ms=_SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS),
            "instrument",
            provider_symbol,
            limit=1,
        )
        parsed = _spot_provider_precision_metadata_from_payload(provider_code, payload)
        if parsed is not None:
            metadata = parsed
            _SPOT_PRICE_PRECISION_METADATA_CACHE[cache_key] = (now, dict(metadata))
            _SPOT_PRICE_PRECISION_METADATA_MISS_CACHE.pop(cache_key, None)
            return dict(metadata)
    except Exception as exc:
        logger.debug(
            "spot_provider_precision_metadata_unavailable symbol=%s provider=%s reason=%s",
            getattr(pair, "symbol", None),
            provider_code,
            exc,
        )

    _SPOT_PRICE_PRECISION_METADATA_MISS_CACHE[cache_key] = (now, dict(metadata))
    return dict(metadata)


def _apply_spot_price_precision_metadata(
    ticker: TickerItem,
    metadata: Dict[str, Any],
) -> TickerItem:
    data = _ticker_to_dict(ticker)
    data.update({key: metadata.get(key) for key in _SPOT_PRICE_PRECISION_PAYLOAD_KEYS})
    return TickerItem(**data)


def _apply_spot_depth_price_precision_metadata(
    depth: DepthResponse,
    metadata: Dict[str, Any],
) -> DepthResponse:
    data = depth.model_dump() if hasattr(depth, "model_dump") else depth.dict()
    data.update({key: metadata.get(key) for key in _SPOT_PRICE_PRECISION_PAYLOAD_KEYS})
    return DepthResponse(**data)


def _spot_interval_value(provider_code: str, interval: str) -> str:
    normalized = normalize_spot_kline_bucket_interval(interval)
    if provider_code == "OKX_SPOT":
        return {
            "1h": "1H",
            "4h": "4H",
            "1d": "1D",
            "1Dutc": "1Dutc",
            "1w": "1W",
            "1Wutc": "1Wutc",
            "1M": "1M",
            "1Mutc": "1Mutc",
        }.get(normalized, normalized)
    if provider_code == "BITGET_SPOT":
        return {
            "1m": "1min",
            "5m": "5min",
            "15m": "15min",
            "1h": "1h",
            "4h": "4h",
            "1d": "1day",
            "1w": "1week",
            "1M": "1M",
        }.get(normalized, normalized)
    return normalized


def _spot_kline_extra_params(provider_code: str, interval: str, end_time_ms: Optional[int]) -> dict[str, Any]:
    if provider_code == "OKX_SPOT":
        params: dict[str, Any] = {"bar": _spot_interval_value(provider_code, interval)}
        if end_time_ms:
            params["after"] = int(end_time_ms)
        return params
    if provider_code == "BITGET_SPOT":
        params: dict[str, Any] = {"granularity": _spot_interval_value(provider_code, interval)}
        if end_time_ms:
            params["endTime"] = max(int(end_time_ms) - 1, 1)
        return params
    if provider_code == "BINANCE_SPOT":
        params = {"interval": interval}
        if end_time_ms:
            params["endTime"] = max(int(end_time_ms) - 1, 1)
        return params
    return {}


def _spot_kline_endpoint_type(provider_code: str, end_time_ms: Optional[int]) -> str:
    if provider_code == "OKX_SPOT" and end_time_ms is not None:
        return "kline_history"
    return "kline"


def _spot_ticker_from_provider(
    *,
    pair: TradingPair,
    provider_code: str,
    payload: Any,
) -> TickerItem:
    received_at_ms = _now_ms()
    price_change_24h_override: Optional[Decimal] = None
    price_change_percent_override: Optional[Decimal] = None
    if provider_code == "OKX_SPOT":
        row = _spot_provider_first_row(payload)
        last_price = _to_decimal(row.get("last"))
        open_24h = _to_decimal(row.get("open24h"))
        high_24h = _to_decimal(row.get("high24h"), last_price)
        low_24h = _to_decimal(row.get("low24h"), last_price)
        base_volume = _to_decimal(row.get("vol24h"))
        quote_volume = _to_decimal(row.get("volCcy24h") or row.get("volCcyQuote24h"))
        event_time_ms = _spot_provider_event_time_ms(row.get("ts"))
    elif provider_code == "BITGET_SPOT":
        row = _spot_provider_first_row(payload)
        last_price = _to_decimal(row.get("lastPr") or row.get("last") or row.get("close"))
        change_ratio = _bitget_spot_change_ratio(row)
        open_24h = _bitget_spot_open_24h(row, last_price, change_ratio)
        high_24h = _to_decimal(row.get("high24h"), last_price)
        low_24h = _to_decimal(row.get("low24h"), last_price)
        base_volume = _to_decimal(row.get("baseVolume") or row.get("baseVol"))
        quote_volume = _to_decimal(row.get("quoteVolume") or row.get("quoteVol") or row.get("usdtVolume"))
        event_time_ms = _spot_provider_event_time_ms(row.get("ts"))
        price_change_24h_override = _bitget_spot_price_change_24h(
            last_price=last_price,
            open_24h=open_24h,
            change_ratio=change_ratio,
        )
        price_change_percent_override = _bitget_spot_price_change_percent(
            open_24h,
            price_change_24h_override,
            change_ratio,
        )
    elif provider_code == "BINANCE_SPOT" and isinstance(payload, dict):
        last_price = _to_decimal(payload.get("lastPrice"))
        price_change = _to_decimal(payload.get("priceChange"))
        open_24h = last_price - price_change if last_price > 0 else Decimal("0")
        high_24h = _to_decimal(payload.get("highPrice"), last_price)
        low_24h = _to_decimal(payload.get("lowPrice"), last_price)
        base_volume = _to_decimal(payload.get("volume"))
        quote_volume = _to_decimal(payload.get("quoteVolume"))
        event_time_ms = _spot_provider_event_time_ms(payload.get("closeTime"))
    else:
        raise ValueError("unsupported spot ticker provider")

    if last_price <= 0:
        raise ValueError("spot ticker last_price unavailable")
    if open_24h <= 0:
        open_24h = last_price
    if high_24h <= 0:
        high_24h = last_price
    if low_24h <= 0:
        low_24h = last_price
    if quote_volume <= 0 and base_volume > 0:
        quote_volume = base_volume * last_price

    price_change_24h = price_change_24h_override if price_change_24h_override is not None else last_price - open_24h
    price_change_percent = price_change_percent_override if price_change_percent_override is not None else Decimal("0")
    if price_change_percent_override is None and open_24h > 0:
        price_change_percent = (price_change_24h / open_24h) * Decimal("100")
    compatibility_time_ms = event_time_ms or received_at_ms
    updated_at = datetime.utcfromtimestamp(received_at_ms / 1000).isoformat()
    compatibility_ts = datetime.utcfromtimestamp(compatibility_time_ms / 1000).isoformat()

    return TickerItem(
        symbol=pair.symbol,
        last_price=_format_price_for_pair(pair, last_price),
        open_24h=_format_price_for_pair(pair, open_24h),
        price_change_24h=_format_price_for_pair(pair, price_change_24h),
        price_change_percent=_format_percent(price_change_percent),
        volume_24h=_format_amount_for_pair(pair, base_volume),
        base_volume_24h=_format_amount_for_pair(pair, base_volume),
        high_24h=_format_price_for_pair(pair, high_24h),
        low_24h=_format_price_for_pair(pair, low_24h),
        quote_volume_24h=_decimal_to_str(quote_volume),
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        source="external",
        provider=provider_code,
        stale=False,
        updated_at=updated_at,
        quote_freshness="LIVE",
        ts=compatibility_ts,
        event_time_ms=event_time_ms,
        received_at_ms=received_at_ms,
    )


def _spot_depth_from_provider(
    *,
    pair: TradingPair,
    provider_code: str,
    payload: Any,
    limit: int,
) -> DepthResponse:
    normalized_provider = str(provider_code or "").strip().upper()
    data = payload
    if normalized_provider in {"OKX_SPOT", "BITGET_SPOT"}:
        data = _spot_provider_first_row(payload)
    bids_raw = data.get("bids") if isinstance(data, dict) else None
    asks_raw = data.get("asks") if isinstance(data, dict) else None

    def adapt(levels: Any) -> list[DepthItem]:
        items: list[DepthItem] = []
        if not isinstance(levels, list):
            return items
        for row in levels[:limit]:
            if not isinstance(row, list) or len(row) < 2:
                continue
            price = _to_decimal(row[0])
            amount = _to_decimal(row[1])
            if price <= 0 or amount <= 0:
                continue
            items.append(DepthItem(price=_format_price_for_pair(pair, price), amount=_format_amount_for_pair(pair, amount)))
        return items

    bids = adapt(bids_raw)
    asks = adapt(asks_raw)
    if not bids or not asks:
        raise ValueError("spot depth unavailable")
    event_time_ms = _spot_provider_event_time_ms(
        data.get("ts")
        if normalized_provider in {"OKX_SPOT", "BITGET_SPOT"} and isinstance(data, dict)
        else data.get("event_time_ms") if isinstance(data, dict) else None
    )
    received_at_ms = _now_ms()
    updated_at = datetime.utcfromtimestamp(received_at_ms / 1000).isoformat()
    return DepthResponse(
        symbol=pair.symbol,
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        bids=bids,
        asks=asks,
        ts=event_time_ms or received_at_ms,
        event_time_ms=event_time_ms,
        received_at_ms=received_at_ms,
        provider=provider_code,
        stale=False,
        updated_at=updated_at,
        source="external",
        fetched_at=received_at_ms,
    )


def _spot_trades_from_provider(
    *,
    pair: TradingPair,
    provider_code: str,
    payload: Any,
    limit: int,
    provider_symbol: Optional[str] = None,
) -> TradesResponse:
    batch_received_at_ms = _now_ms()
    normalized_provider = str(provider_code or "").strip().upper()
    normalized_provider_symbol = str(provider_symbol or "").strip() or None
    rows = _spot_provider_rows(payload)
    trades: list[TradeItem] = []
    for row in rows[:limit]:
        if not isinstance(row, dict):
            continue
        if normalized_provider == "OKX_SPOT":
            price = row.get("px")
            amount = row.get("sz")
            side_text = str(row.get("side") or "").upper()
            event_time_ms = _spot_provider_event_time_ms(row.get("ts"))
            raw_trade_id = row.get("tradeId")
        elif normalized_provider == "BITGET_SPOT":
            price = row.get("price")
            amount = row.get("size") or row.get("baseVolume")
            side_text = str(row.get("side") or "").upper()
            event_time_ms = _spot_provider_event_time_ms(row.get("ts"))
            raw_trade_id = row.get("tradeId")
        else:
            price = row.get("price")
            amount = row.get("qty")
            side_text = "SELL" if bool(row.get("isBuyerMaker")) else "BUY"
            event_time_ms = _spot_provider_event_time_ms(row.get("time"))
            raw_trade_id = row.get("id")
            if raw_trade_id is None:
                raw_trade_id = row.get("tradeId")
        if _to_decimal(price) <= 0 or _to_decimal(amount) <= 0:
            continue
        provider_trade_id = str(raw_trade_id).strip() if raw_trade_id is not None else ""
        provider_trade_id = provider_trade_id or None
        compatibility_ts = event_time_ms or batch_received_at_ms
        trades.append(
            TradeItem(
                id=provider_trade_id,
                trade_id=provider_trade_id,
                provider_trade_id=provider_trade_id,
                price=_format_price_for_pair(pair, price),
                amount=_format_amount_for_pair(pair, amount),
                side="SELL" if side_text == "SELL" else "BUY",
                ts=compatibility_ts,
                event_time_ms=event_time_ms,
                received_at_ms=batch_received_at_ms,
                created_at=(
                    datetime.utcfromtimestamp(event_time_ms / 1000).isoformat()
                    if event_time_ms is not None
                    else None
                ),
                time_origin="PROVIDER",
                provider=normalized_provider,
                provider_symbol=normalized_provider_symbol,
                source="external",
                freshness="RECENT",
                updated_at_ms=batch_received_at_ms,
            )
        )
    if not trades:
        raise ValueError("spot trades unavailable")
    return TradesResponse(
        symbol=pair.symbol,
        trades=trades,
        provider=normalized_provider,
        provider_symbol=normalized_provider_symbol,
        stale=False,
        updated_at=datetime.utcfromtimestamp(batch_received_at_ms / 1000).isoformat(),
        updated_at_ms=batch_received_at_ms,
        received_at_ms=batch_received_at_ms,
    )


def _spot_klines_from_provider(
    *,
    provider_code: str,
    payload: Any,
    interval: str,
    limit: int,
    end_time_ms: Optional[int] = None,
    received_at_ms: Optional[int] = None,
) -> list[dict[str, Any]]:
    rows = _spot_provider_rows(payload)
    items: list[dict[str, Any]] = []
    step_ms = _INTERVAL_SECONDS[interval] * 1000
    batch_received_at_ms = int(received_at_ms if received_at_ms is not None else _now_ms())
    normalized_provider = str(provider_code or "").strip().upper()
    for row in rows:
        if not isinstance(row, list) or len(row) < 5:
            continue
        try:
            open_time = int(row[0])
        except Exception:
            continue
        if open_time <= 0:
            continue
        if end_time_ms and open_time >= int(end_time_ms):
            continue
        quote_volume_index = 6 if normalized_provider == "BITGET_SPOT" else 7
        close_time = open_time + step_ms
        is_closed: Optional[bool] = close_time <= batch_received_at_ms
        close_state_source = "TIME_DERIVED"
        if normalized_provider == "OKX_SPOT" and len(row) > 8:
            confirm = str(row[8] or "").strip()
            if confirm in {"0", "1"}:
                is_closed = confirm == "1"
                close_state_source = "PROVIDER_CONFIRMED"
        items.append(
            {
                "open_time": open_time,
                "close_time": close_time,
                "open": str(row[1]),
                "high": str(row[2]),
                "low": str(row[3]),
                "close": str(row[4]),
                "volume": str(row[5] if len(row) > 5 else "0"),
                "quote_volume": str(row[quote_volume_index] if len(row) > quote_volume_index else "0"),
                "_provider": normalized_provider,
                "_received_at_ms": batch_received_at_ms,
                "_is_closed": is_closed,
                "_close_state_source": close_state_source,
            }
        )
    items.sort(key=lambda item: int(item["open_time"]))
    return items[-limit:]


def _spot_kline_candidate_from_item(
    *,
    symbol: str,
    interval: str,
    item: Any,
    provider: str,
    source: str,
    transport: str,
    revision_epoch: int,
    revision_seq: int,
) -> KlineRevisionCandidate:
    item_mapping = item if isinstance(item, dict) else dict(item)
    return KlineRevisionCandidate(
        symbol=symbol,
        interval=interval,
        open_time=item_mapping.get("open_time"),
        open=item_mapping.get("open"),
        high=item_mapping.get("high"),
        low=item_mapping.get("low"),
        close=item_mapping.get("close"),
        volume=item_mapping.get("volume", "0"),
        quote_volume=item_mapping.get("quote_volume"),
        provider=provider,
        source=source,
        transport=transport,
        provider_generation=0,
        revision_epoch=revision_epoch,
        revision_seq=revision_seq,
        received_at_ms=int(item_mapping.get("_received_at_ms") or 0),
        is_closed=item_mapping.get("_is_closed", item_mapping.get("is_closed")),
        close_state_source=item_mapping.get(
            "_close_state_source",
            item_mapping.get("close_state_source"),
        ),
        provider_update_time_ms=item_mapping.get("provider_update_time_ms"),
    )


def _capture_spot_kline_rest_watermark(
    *,
    symbol: str,
    interval: str,
    provider: str,
) -> KlineRestWatermark:
    normalized_provider = str(provider or "").strip().upper()
    snapshot = get_spot_provider_ws_kline_revisions(
        symbol,
        interval,
        provider=normalized_provider,
        limit=1,
    )
    if not snapshot:
        return KlineRestWatermark(
            provider=normalized_provider,
            revision_epoch=0,
            revision_seq=0,
        )

    snapshot_provider = str(snapshot.get("provider") or normalized_provider).strip().upper()
    snapshot_items = list(snapshot.get("items") or [])
    if not snapshot_items:
        return KlineRestWatermark(
            provider=snapshot_provider,
            revision_epoch=0,
            revision_seq=0,
        )
    item = snapshot_items[-1]
    revision_epoch = int(item.get("revision_epoch") or 0)
    revision_seq = int(item.get("revision_seq") or 0)
    winner = _spot_kline_candidate_from_item(
        symbol=symbol,
        interval=interval,
        item=item,
        provider=snapshot_provider,
        source=str(snapshot.get("source") or "LIVE_WS"),
        transport="WS",
        revision_epoch=revision_epoch,
        revision_seq=revision_seq,
    )
    return KlineRestWatermark(
        provider=snapshot_provider,
        revision_epoch=revision_epoch,
        revision_seq=revision_seq,
        winner=winner,
    )


def _merge_spot_live_ws_klines(
    *,
    history_items: list[dict[str, Any]],
    live_items: list[dict[str, Any]],
    limit: int,
    end_time_ms: Optional[int] = None,
    open_time_validator: Optional[Callable[[int], bool]] = None,
) -> list[dict[str, Any]]:
    by_open_time: dict[int, dict[str, Any]] = {}
    for item in list(history_items or []) + list(live_items or []):
        if not isinstance(item, dict):
            continue
        try:
            open_time = int(item.get("open_time") or 0)
        except Exception:
            continue
        if open_time <= 0:
            continue
        if open_time_validator is not None and not open_time_validator(open_time):
            continue
        if end_time_ms is not None and open_time >= int(end_time_ms):
            continue
        by_open_time[open_time] = dict(item)
    return [
        by_open_time[open_time]
        for open_time in sorted(by_open_time.keys())[-max(1, int(limit or 200)):]
    ]


def _spot_kline_provider_error_code(error: Optional[Exception]) -> str:
    lowered = str(error or "").lower()
    if not lowered:
        return KLINE_PROVIDER_ERROR_UNKNOWN
    if "timeout" in lowered or "timed out" in lowered:
        return KLINE_PROVIDER_ERROR_TIMEOUT
    if "cooldown" in lowered:
        return KLINE_PROVIDER_ERROR_COOLDOWN
    if "http " in lowered or "status_code" in lowered:
        return KLINE_PROVIDER_ERROR_HTTP
    if "empty" in lowered or "unavailable" in lowered:
        return KLINE_PROVIDER_ERROR_EMPTY
    return KLINE_PROVIDER_ERROR_UNKNOWN


def _coerce_kline_cache_result(items: Any, *, end_time_ms: Optional[int]) -> KlineCacheResult:
    if isinstance(items, KlineCacheResult):
        return items
    rows = list(items or []) if isinstance(items, list) else []
    return KlineCacheResult(
        rows,
        origin=KLINE_CACHE_ORIGIN_REST_FETCH if rows else KLINE_CACHE_ORIGIN_EMPTY,
        cache_status="LEGACY",
        history_incomplete=bool(end_time_ms is not None and not rows),
    )


def _spot_kline_result_metadata(
    result: KlineCacheResult,
    *,
    end_time_ms: Optional[int],
    rest_snapshot_source: str = "REST_SNAPSHOT",
    rest_history_source: str = "REST_HISTORY",
) -> dict[str, Any]:
    if result.origin == KLINE_CACHE_ORIGIN_DB_CACHE:
        source = "DB_CACHE"
        freshness = "CACHED"
        stale = False
    elif result.origin == KLINE_CACHE_ORIGIN_STALE_CACHE:
        source = "STALE_CACHE"
        freshness = "STALE"
        stale = True
    elif result.origin == KLINE_CACHE_ORIGIN_EMPTY:
        source = "EMPTY"
        freshness = "MISSING"
        stale = False
    else:
        source = rest_history_source if end_time_ms is not None else rest_snapshot_source
        freshness = "RECENT"
        stale = False

    return {
        "source": source,
        "freshness": freshness,
        "stale": stale,
        "cache_status": result.cache_status,
        "history_incomplete": bool(result.history_incomplete),
        "provider_error_code": result.provider_error_code,
        "provider_error_provider": result.provider_error_provider,
        **build_spot_kline_terminal_metadata(result, end_time_ms=end_time_ms),
    }


def _kline_item_matches_open_time_validator(
    item: Any,
    open_time_validator: Optional[Callable[[int], bool]],
) -> bool:
    if open_time_validator is None:
        return True
    if not isinstance(item, dict):
        return False
    try:
        open_time = int(item.get("open_time") or item.get("time") or 0)
    except Exception:
        return False
    return open_time_validator(open_time)


def _spot_external_kline_cache_open_time_validator(
    provider_code: Optional[str],
    interval: str,
) -> Optional[Callable[[int], bool]]:
    if str(provider_code or "").strip().upper() == PROVIDER_OKX_SPOT:
        return okx_spot_open_time_validator(interval)
    return None


def _spot_last_good_ticker(pair: TradingPair) -> Optional[TickerItem]:
    cached = _SPOT_LAST_GOOD_TICKERS.get(pair.symbol)
    if cached is None:
        return None
    data = cached.model_dump() if hasattr(cached, "model_dump") else cached.dict()
    data.update({"provider": "LAST_GOOD", "stale": True, "quote_freshness": "LAST_VALID", "source": "external"})
    return TickerItem(**data)


def _spot_provider_ws_ticker_to_item(pair: TradingPair, record: dict[str, Any]) -> Optional[TickerItem]:
    last_price = _to_decimal(record.get("last_price"))
    if last_price <= 0:
        return None
    open_24h = _to_decimal(record.get("open_24h"), last_price)
    if open_24h <= 0:
        open_24h = last_price
    high_24h = _to_decimal(record.get("high_24h"), last_price)
    low_24h = _to_decimal(record.get("low_24h"), last_price)
    base_volume = _to_decimal(record.get("base_volume_24h") or record.get("volume_24h"))
    quote_volume = _to_decimal(record.get("quote_volume_24h"))
    if quote_volume <= 0 and base_volume > 0:
        quote_volume = base_volume * last_price
    price_change_24h = _to_decimal(record.get("price_change_24h"), last_price - open_24h)
    raw_change_percent = record.get("price_change_percent")
    if raw_change_percent in (None, ""):
        raw_change_percent = record.get("price_change_percent_24h")
    price_change_percent = _to_optional_decimal(raw_change_percent)
    if price_change_percent is None and price_change_24h != 0 and open_24h > 0:
        price_change_percent = (price_change_24h / open_24h) * Decimal("100")
    if price_change_percent is None:
        price_change_percent = Decimal("0")
    event_time_ms = (
        _spot_provider_event_time_ms(record.get("event_time_ms"))
        if "event_time_ms" in record
        else _spot_provider_event_time_ms(record.get("ts"))
    )
    received_at_ms = _spot_provider_event_time_ms(
        record.get("received_at_ms") or record.get("updated_at_ms")
    )
    updated_at = str(
        record.get("updated_at")
        or (
            datetime.utcfromtimestamp(received_at_ms / 1000).isoformat()
            if received_at_ms is not None
            else datetime.utcnow().isoformat()
        )
    )
    compatibility_time_ms = event_time_ms or received_at_ms
    compatibility_ts = (
        datetime.utcfromtimestamp(compatibility_time_ms / 1000).isoformat()
        if compatibility_time_ms is not None
        else updated_at
    )

    return TickerItem(
        symbol=pair.symbol,
        last_price=_format_price_for_pair(pair, last_price),
        open_24h=_format_price_for_pair(pair, open_24h),
        price_change_24h=_format_price_for_pair(pair, price_change_24h),
        price_change_percent=_format_percent(price_change_percent),
        volume_24h=_format_amount_for_pair(pair, base_volume),
        base_volume_24h=_format_amount_for_pair(pair, base_volume),
        high_24h=_format_price_for_pair(pair, high_24h),
        low_24h=_format_price_for_pair(pair, low_24h),
        quote_volume_24h=_decimal_to_str(quote_volume),
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        source="LIVE_WS",
        provider=str(record.get("provider") or PROVIDER_BITGET_SPOT),
        stale=False,
        updated_at=updated_at,
        market_status=str(record.get("market_status") or "OPEN"),
        quote_freshness="LIVE",
        ts=compatibility_ts,
        event_time_ms=event_time_ms,
        received_at_ms=received_at_ms,
    )


def _spot_market_gateway_service():
    from app.services.spot_market_gateway import spot_market_gateway

    return spot_market_gateway


def _record_spot_ticker_domain_snapshot(
    ticker: Optional[Any],
    *,
    context: DomainSnapshotContext,
    domain_snapshot: Optional[MarketDomainSnapshot] = None,
) -> None:
    try:
        if ticker is None:
            payload = None
        elif isinstance(ticker, dict):
            payload = dict(ticker)
        else:
            payload = _ticker_to_dict(ticker)

        if domain_snapshot is None:
            updated_at = next(
                (
                    value
                    for value in (
                        context.cache_updated_at_ms,
                        context.received_at_ms,
                        context.db_updated_at_ms,
                    )
                    if value is not None
                ),
                None,
            )
            domain_snapshot = build_market_domain_snapshot(
                symbol=context.symbol,
                domain="ticker",
                data=payload,
                source=context.source.value,
                provider=context.provider,
                updated_at=updated_at,
                version=CACHE_VERSION,
                max_age_ms=context.ttl_ms or SPOT_TICKER_SHARED_CACHE_TTL_MS,
                fallback_reason=(
                    context.fallback_reason.value
                    if context.fallback_reason is not None
                    else None
                ),
            )

        _spot_market_gateway_service().record_ticker_market_domain_snapshot(
            snapshot=domain_snapshot,
            context=context,
        )
    except Exception:
        logger.warning(
            "spot_ticker_domain_snapshot_record_failed symbol=%s source=%s",
            context.symbol,
            context.source.value,
            exc_info=True,
        )


def _spot_ticker_snapshot_source(value: Any) -> DomainSource:
    normalized = str(value or "").strip().upper()
    if normalized == "LIVE_WS":
        return DomainSource.LIVE_WS
    if normalized == "INTERNAL":
        return DomainSource.INTERNAL
    if normalized == "LAST_GOOD":
        return DomainSource.LAST_GOOD
    if normalized in {"", "MISSING"}:
        return DomainSource.MISSING
    return DomainSource.REST_SNAPSHOT


def _spot_ticker_failure_reason(error: Optional[Exception]) -> DomainFallbackReason:
    if error is None:
        return DomainFallbackReason.CACHE_MISS
    if isinstance(error, ProviderCooldownError):
        return DomainFallbackReason.PROVIDER_COOLDOWN
    if isinstance(error, TimeoutError) or "timeout" in str(error).strip().lower():
        return DomainFallbackReason.PROVIDER_TIMEOUT
    return DomainFallbackReason.PROVIDER_ERROR


def _record_spot_ticker_cache_hit(
    *,
    symbol: str,
    cache_hit: SpotTickerCacheHit,
) -> None:
    metadata = getattr(cache_hit, "metadata", None)
    if metadata is not None and hasattr(metadata, "to_domain_snapshot"):
        domain_snapshot = metadata.to_domain_snapshot(symbol=symbol)
    else:
        # Compatibility with pre-B-2.1 raw cache hit records.
        domain_snapshot = build_market_domain_snapshot(
            symbol=symbol,
            domain="ticker",
            data=cache_hit.payload,
            source=cache_hit.envelope.source,
            provider=cache_hit.envelope.provider,
            updated_at=cache_hit.envelope.updated_at_ms,
            version=cache_hit.envelope.version,
            max_age_ms=cache_hit.envelope.ttl_ms,
        )
    payload = dict(domain_snapshot.data)
    try:
        cache_origin = DomainCacheOrigin(cache_hit.cache_origin)
    except ValueError:
        cache_origin = DomainCacheOrigin.NONE
    _record_spot_ticker_domain_snapshot(
        payload,
        context=DomainSnapshotContext(
            domain=DomainName.TICKER,
            symbol=symbol,
            transport=DomainTransport.CACHE_READ,
            cache_origin=cache_origin,
            source=_spot_ticker_snapshot_source(domain_snapshot.source),
            provider=domain_snapshot.provider,
            provider_symbol=str(payload.get("provider_symbol") or "").strip() or None,
            fallback_reason=None,
            provider_event_time_ms=payload.get("event_time_ms"),
            received_at_ms=payload.get("received_at_ms"),
            cache_updated_at_ms=domain_snapshot.updated_at,
            ttl_ms=cache_hit.envelope.ttl_ms,
        ),
        domain_snapshot=domain_snapshot,
    )


def _record_spot_trades_domain_snapshot(
    trades: Optional[Any],
    *,
    context: DomainSnapshotContext,
    domain_snapshot: Optional[MarketDomainSnapshot] = None,
) -> None:
    try:
        if trades is None:
            payload = None
        elif isinstance(trades, dict):
            payload = dict(trades)
        elif hasattr(trades, "model_dump"):
            payload = trades.model_dump()
        else:
            payload = trades.dict()

        if domain_snapshot is None:
            updated_at = next(
                (
                    value
                    for value in (
                        context.cache_updated_at_ms,
                        context.received_at_ms,
                        context.db_updated_at_ms,
                    )
                    if value is not None
                ),
                None,
            )
            domain_snapshot = build_market_domain_snapshot(
                symbol=context.symbol,
                domain="trades",
                data=payload,
                source=context.source.value,
                provider=context.provider,
                updated_at=updated_at,
                version=CACHE_VERSION,
                max_age_ms=context.ttl_ms or SPOT_TRADES_SHARED_CACHE_TTL_MS,
                fallback_reason=(
                    context.fallback_reason.value
                    if context.fallback_reason is not None
                    else None
                ),
            )

        _spot_market_gateway_service().record_trades_market_domain_snapshot(
            snapshot=domain_snapshot,
            context=context,
        )
    except Exception:
        logger.warning(
            "spot_trades_domain_snapshot_record_failed symbol=%s source=%s",
            context.symbol,
            context.source.value,
            exc_info=True,
        )


def _spot_trades_item_values(payload: Dict[str, Any], field: str) -> list[Any]:
    items = payload.get("trades")
    if not isinstance(items, list):
        return []
    return [item.get(field) for item in items if isinstance(item, dict)]


def _spot_trades_text(payload: Dict[str, Any], field: str) -> Optional[str]:
    direct = str(payload.get(field) or "").strip()
    if direct:
        return direct
    values = {
        str(value).strip()
        for value in _spot_trades_item_values(payload, field)
        if str(value or "").strip()
    }
    return next(iter(values)) if len(values) == 1 else None


def _spot_trades_latest_time(payload: Dict[str, Any], *fields: str) -> Optional[int]:
    values: list[int] = []
    for field in fields:
        candidates = [payload.get(field), *_spot_trades_item_values(payload, field)]
        for value in candidates:
            if value is None or isinstance(value, bool):
                continue
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                continue
            if parsed >= 0:
                values.append(parsed)
    return max(values) if values else None


def _spot_trades_snapshot_source(payload: Dict[str, Any]) -> DomainSource:
    return _spot_ticker_snapshot_source(_spot_trades_text(payload, "source"))


def _spot_trades_failure_reason(error: Optional[Exception]) -> DomainFallbackReason:
    if error is None:
        return DomainFallbackReason.CACHE_MISS
    if isinstance(error, ProviderCooldownError):
        return DomainFallbackReason.PROVIDER_COOLDOWN
    if isinstance(error, TimeoutError) or "timeout" in str(error).strip().lower():
        return DomainFallbackReason.PROVIDER_TIMEOUT
    return DomainFallbackReason.PROVIDER_ERROR


def _record_spot_trades_cache_hit(
    *,
    symbol: str,
    cache_hit: SpotTradesCacheHit,
) -> None:
    metadata = getattr(cache_hit, "metadata", None)
    if metadata is not None and hasattr(metadata, "to_domain_snapshot"):
        domain_snapshot = metadata.to_domain_snapshot(symbol=symbol)
    else:
        # Compatibility with pre-B-2.3 raw cache hit records.
        domain_snapshot = build_market_domain_snapshot(
            symbol=symbol,
            domain="trades",
            data=cache_hit.payload,
            source=cache_hit.envelope.source,
            provider=cache_hit.envelope.provider,
            updated_at=cache_hit.envelope.updated_at_ms,
            version=cache_hit.envelope.version,
            max_age_ms=cache_hit.envelope.ttl_ms,
        )
    payload = dict(domain_snapshot.data)
    try:
        cache_origin = DomainCacheOrigin(cache_hit.cache_origin)
    except ValueError:
        cache_origin = DomainCacheOrigin.NONE
    source = _spot_ticker_snapshot_source(domain_snapshot.source)
    _record_spot_trades_domain_snapshot(
        payload,
        context=DomainSnapshotContext(
            domain=DomainName.TRADES,
            symbol=symbol,
            transport=DomainTransport.CACHE_READ,
            cache_origin=cache_origin,
            source=source,
            provider=domain_snapshot.provider,
            provider_symbol=_spot_trades_text(payload, "provider_symbol"),
            provider_event_time_ms=_spot_trades_latest_time(
                payload,
                "event_time_ms",
            ),
            received_at_ms=_spot_trades_latest_time(
                payload,
                "received_at_ms",
                "updated_at_ms",
            ),
            cache_updated_at_ms=domain_snapshot.updated_at,
            ttl_ms=cache_hit.envelope.ttl_ms,
        ),
        domain_snapshot=domain_snapshot,
    )


def _record_spot_depth_domain_snapshot(
    depth: Optional[Any],
    *,
    context: DomainSnapshotContext,
    domain_snapshot: Optional[MarketDomainSnapshot] = None,
) -> None:
    try:
        if depth is None:
            payload = None
        elif isinstance(depth, dict):
            payload = dict(depth)
        elif hasattr(depth, "model_dump"):
            payload = depth.model_dump()
        else:
            payload = depth.dict()

        if domain_snapshot is None:
            updated_at = next(
                (
                    value
                    for value in (
                        context.cache_updated_at_ms,
                        context.received_at_ms,
                        context.db_updated_at_ms,
                    )
                    if value is not None
                ),
                None,
            )
            domain_snapshot = build_market_domain_snapshot(
                symbol=context.symbol,
                domain="depth",
                data=payload,
                source=context.source.value,
                provider=context.provider,
                updated_at=updated_at,
                version=CACHE_VERSION,
                max_age_ms=context.ttl_ms or SPOT_DEPTH_SHARED_CACHE_TTL_MS,
                fallback_reason=(
                    context.fallback_reason.value
                    if context.fallback_reason is not None
                    else None
                ),
            )

        _spot_market_gateway_service().record_depth_market_domain_snapshot(
            snapshot=domain_snapshot,
            context=context,
        )
    except Exception:
        logger.warning(
            "spot_depth_domain_snapshot_record_failed symbol=%s source=%s",
            context.symbol,
            context.source.value,
            exc_info=True,
        )


def _spot_depth_failure_reason(error: Optional[Exception]) -> DomainFallbackReason:
    if error is None:
        return DomainFallbackReason.CACHE_MISS
    if isinstance(error, ProviderCooldownError):
        return DomainFallbackReason.PROVIDER_COOLDOWN
    if isinstance(error, TimeoutError) or "timeout" in str(error).strip().lower():
        return DomainFallbackReason.PROVIDER_TIMEOUT
    return DomainFallbackReason.PROVIDER_ERROR


def _spot_depth_non_negative_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _spot_depth_provider_generation(symbol: str, provider: Optional[str]) -> Optional[int]:
    normalized_provider = str(provider or "").strip().upper()
    if not normalized_provider:
        return None
    try:
        active_provider, active_generation = (
            _spot_market_gateway_service().get_active_depth_provider(symbol)
        )
    except Exception:
        return None
    if str(active_provider or "").strip().upper() != normalized_provider:
        return None
    return _spot_depth_non_negative_int(active_generation)


def _record_spot_depth_cache_hit(
    *,
    symbol: str,
    cache_hit: SpotDepthCacheHit,
) -> None:
    metadata = getattr(cache_hit, "metadata", None)
    if metadata is not None and hasattr(metadata, "to_domain_snapshot"):
        domain_snapshot = metadata.to_domain_snapshot(symbol=symbol)
    else:
        # Compatibility with pre-B-2.2 raw cache hit records.
        domain_snapshot = build_market_domain_snapshot(
            symbol=symbol,
            domain="depth",
            data=cache_hit.payload,
            source=cache_hit.envelope.source,
            provider=cache_hit.envelope.provider,
            updated_at=cache_hit.envelope.updated_at_ms,
            version=cache_hit.envelope.version,
            max_age_ms=cache_hit.envelope.ttl_ms,
        )
    payload = dict(domain_snapshot.data)
    try:
        cache_origin = DomainCacheOrigin(cache_hit.cache_origin)
    except ValueError:
        cache_origin = DomainCacheOrigin.NONE
    source = _spot_ticker_snapshot_source(domain_snapshot.source)
    _record_spot_depth_domain_snapshot(
        payload,
        context=DomainSnapshotContext(
            domain=DomainName.DEPTH,
            symbol=symbol,
            transport=DomainTransport.CACHE_READ,
            cache_origin=cache_origin,
            source=source,
            provider=domain_snapshot.provider,
            provider_symbol=str(payload.get("provider_symbol") or "").strip() or None,
            provider_event_time_ms=_spot_depth_non_negative_int(
                payload.get("event_time_ms") or payload.get("ts")
            ),
            received_at_ms=_spot_depth_non_negative_int(
                payload.get("received_at_ms") or payload.get("fetched_at")
            ),
            cache_updated_at_ms=domain_snapshot.updated_at,
            ttl_ms=cache_hit.envelope.ttl_ms,
            provider_generation=_spot_depth_non_negative_int(
                payload.get("provider_generation") or payload.get("generation")
            ),
        ),
        domain_snapshot=domain_snapshot,
    )


def _record_spot_kline_domain_snapshot(
    response: Dict[str, Any],
    *,
    context: DomainSnapshotContext,
    domain_snapshot: Optional[MarketDomainSnapshot] = None,
) -> None:
    try:
        if not context.interval:
            raise ValueError("kline snapshot context requires an interval")
        if domain_snapshot is None:
            updated_at = next(
                (
                    value
                    for value in (
                        context.cache_updated_at_ms,
                        context.db_updated_at_ms,
                        context.received_at_ms,
                    )
                    if value is not None
                ),
                None,
            )
            metadata = build_market_kline_cache_metadata(
                data=list(response.get("items") or []),
                source=context.source.value,
                provider=context.provider,
                updated_at=updated_at,
                interval=context.interval,
            )
            domain_snapshot = metadata.to_domain_snapshot(symbol=context.symbol)

        _spot_market_gateway_service().record_kline_market_domain_snapshot(
            snapshot=domain_snapshot,
            kline=dict(response),
            context=context,
        )
    except Exception:
        logger.warning(
            "spot_kline_domain_snapshot_record_failed symbol=%s interval=%s source=%s",
            context.symbol,
            context.interval,
            context.source.value,
            exc_info=True,
        )


def _spot_kline_time_ms(value: Any) -> Optional[int]:
    parsed_int = _spot_depth_non_negative_int(value)
    if parsed_int is not None:
        return parsed_int
    if isinstance(value, datetime):
        return _datetime_to_utc_ms(value)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return _datetime_to_utc_ms(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except (TypeError, ValueError):
        return None


def _spot_kline_latest_item_time(
    response: Dict[str, Any],
    *fields: str,
) -> Optional[int]:
    values: list[int] = []
    items = response.get("items")
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict):
            continue
        for field in fields:
            value = _spot_kline_time_ms(item.get(field))
            if value is not None:
                values.append(value)
    return max(values) if values else None


def _record_external_spot_kline_result(
    response: Dict[str, Any],
    *,
    cache_result: KlineCacheResult,
    rest_fetch_metadata: Dict[str, Any],
    interval: str,
    end_time_ms: Optional[int],
    live_ws_klines: Optional[Dict[str, Any]] = None,
) -> None:
    is_live_ws = str(response.get("source") or "").strip().upper() == "LIVE_WS"
    history_terminal = response.get("history_terminal") is True
    terminal_reason = str(response.get("terminal_reason") or "").strip()
    from_last_good = bool(rest_fetch_metadata.get("from_last_good"))
    if is_live_ws:
        transport = DomainTransport.PROVIDER_WS
        cache_origin = DomainCacheOrigin.PROVIDER_MEMORY
        source = DomainSource.LIVE_WS
        fallback_reason = None
    elif history_terminal and terminal_reason:
        transport = DomainTransport.CACHE_READ
        cache_origin = DomainCacheOrigin.HISTORY_BOUNDARY
        source = DomainSource.MISSING
        fallback_reason = DomainFallbackReason.HISTORY_BOUNDARY
    elif from_last_good:
        transport = DomainTransport.CACHE_READ
        cache_origin = DomainCacheOrigin.LAST_GOOD_MEMORY
        source = DomainSource.LAST_GOOD
        fallback_reason = None
    elif cache_result.origin in {
        KLINE_CACHE_ORIGIN_DB_CACHE,
        KLINE_CACHE_ORIGIN_STALE_CACHE,
    }:
        transport = DomainTransport.DB_READ
        cache_origin = DomainCacheOrigin.DATABASE
        source = DomainSource.DB_CACHE
        fallback_reason = None
    elif cache_result.origin == KLINE_CACHE_ORIGIN_REST_FETCH:
        transport = DomainTransport.PROVIDER_REST
        cache_origin = DomainCacheOrigin.NONE
        source = (
            DomainSource.REST_HISTORY
            if end_time_ms is not None
            else DomainSource.REST_SNAPSHOT
        )
        fallback_reason = None
    else:
        transport = DomainTransport.NONE
        cache_origin = DomainCacheOrigin.NONE
        source = DomainSource.MISSING
        fallback_reason = DomainFallbackReason.CACHE_MISS

    updated_at_ms = _spot_kline_time_ms(response.get("updated_at"))
    if transport == DomainTransport.DB_READ:
        # KlineCacheResult does not expose the DB row update time.  Do not use
        # unrelated last-good metadata as a database freshness clock.
        updated_at_ms = None
    received_at_ms = _spot_kline_time_ms(response.get("received_at_ms"))
    if received_at_ms is None:
        received_at_ms = _spot_kline_latest_item_time(
            response,
            "received_at_ms",
            "updated_at_ms",
        )
    if received_at_ms is None and transport in {
        DomainTransport.PROVIDER_REST,
        DomainTransport.CACHE_READ,
    }:
        received_at_ms = updated_at_ms

    provider_event_time_ms = _spot_kline_time_ms(
        response.get("provider_event_time_ms")
    )
    if provider_event_time_ms is None:
        provider_event_time_ms = _spot_kline_latest_item_time(
            response,
            "provider_update_time_ms",
        )

    provider = (
        str(rest_fetch_metadata.get("provider") or response.get("provider") or "").strip()
        or None
    )
    ttl_ms = int(LATEST_KLINE_REFRESH_TTL_SECONDS.get(interval, 30) * 1000)
    cache_metadata = getattr(cache_result, "metadata", None)
    if is_live_ws:
        live_items = [
            dict(item)
            for item in list((live_ws_klines or {}).get("items") or [])
            if isinstance(item, dict)
        ]
        current_items = (
            [max(live_items, key=lambda item: int(item.get("open_time") or 0))]
            if live_items
            else []
        )
        live_updated_at_ms = _spot_kline_time_ms(
            (live_ws_klines or {}).get("updated_at")
        )
        if live_updated_at_ms is None:
            live_updated_at_ms = _spot_kline_latest_item_time(
                {"items": current_items},
                "received_at_ms",
                "updated_at_ms",
            )
        cache_metadata = build_market_kline_cache_metadata(
            data=current_items,
            source=DomainSource.LIVE_WS.value,
            provider=provider,
            updated_at=live_updated_at_ms,
            interval=interval,
        )
    elif from_last_good or not isinstance(cache_metadata, MarketKlineCacheMetadata):
        cache_metadata = build_market_kline_cache_metadata(
            data=list(response.get("items") or []),
            source=source.value,
            provider=provider,
            updated_at=updated_at_ms,
            interval=interval,
        )
    domain_snapshot = cache_metadata.to_domain_snapshot(
        symbol=str(response.get("symbol") or "").strip().upper(),
        fallback_reason=(fallback_reason.value if fallback_reason is not None else None),
    )
    _record_spot_kline_domain_snapshot(
        response,
        context=DomainSnapshotContext(
            domain=DomainName.KLINE,
            symbol=str(response.get("symbol") or "").strip().upper(),
            interval=interval,
            transport=transport,
            cache_origin=cache_origin,
            source=source,
            provider=provider,
            provider_symbol=str(response.get("provider_symbol") or "").strip() or None,
            fallback_reason=fallback_reason,
            provider_event_time_ms=provider_event_time_ms,
            received_at_ms=received_at_ms,
            cache_updated_at_ms=(
                updated_at_ms
                if transport == DomainTransport.CACHE_READ
                else None
            ),
            db_updated_at_ms=(
                updated_at_ms
                if transport == DomainTransport.DB_READ
                else None
            ),
            ttl_ms=ttl_ms,
            provider_generation=_spot_depth_non_negative_int(
                response.get("provider_generation")
            ),
        ),
        domain_snapshot=domain_snapshot,
    )


def _is_spot_provider_cooldown_skip(exc: Exception) -> bool:
    return isinstance(exc, ProviderCooldownError)


def _spot_provider_warning_allowed(
    *,
    endpoint: str,
    symbol: str,
    provider: str,
    reason: Exception,
) -> bool:
    reason_text = str(reason or "")
    key = (str(endpoint or ""), str(symbol or ""), str(provider or ""), reason_text)
    now = time.monotonic()
    last_at = _SPOT_PROVIDER_LOG_THROTTLE.get(key)
    if last_at is not None and now - last_at < _SPOT_PROVIDER_LOG_THROTTLE_SECONDS:
        return False
    _SPOT_PROVIDER_LOG_THROTTLE[key] = now
    return True


def _is_spot_kline_history_unavailable(end_time_ms: Optional[int], exc: Exception) -> bool:
    return end_time_ms is not None and _spot_kline_provider_error_code(exc) == KLINE_PROVIDER_ERROR_EMPTY


def _log_spot_provider_kline_failure(
    *,
    symbol: str,
    provider: str,
    interval: str,
    end_time_ms: Optional[int],
    reason: Exception,
) -> None:
    if _is_spot_kline_history_unavailable(end_time_ms, reason):
        if _spot_provider_warning_allowed(
            endpoint=f"kline_history_unavailable:{interval}",
            symbol=symbol,
            provider=provider,
            reason=reason,
        ):
            logger.debug(
                "spot_provider_kline_history_unavailable symbol=%s provider=%s interval=%s end_time_ms=%s reason=%s",
                symbol,
                provider,
                interval,
                end_time_ms,
                reason,
            )
        return

    if _spot_provider_warning_allowed(endpoint=f"kline:{interval}", symbol=symbol, provider=provider, reason=reason):
        logger.warning("spot_provider_kline_failed symbol=%s provider=%s interval=%s reason=%s", symbol, provider, interval, reason)


def _get_external_spot_ticker(db: Session, pair: TradingPair, *, fast: bool = False) -> Optional[TickerItem]:
    last_error: Optional[Exception] = None
    providers = _enabled_spot_market_providers_for_pair(db, pair, max_providers=1 if fast else None)
    primary_provider = providers[0] if providers else None
    ws_lookup_attempted = False
    try:
        if primary_provider is not None and spot_provider_ws_supports_provider(primary_provider.provider_code, domain="ticker"):
            ws_lookup_attempted = True
            live_record = get_spot_provider_ws_ticker(pair.symbol, provider=primary_provider.provider_code)
            if live_record is not None:
                live_ticker = _spot_provider_ws_ticker_to_item(pair, live_record)
                if live_ticker is not None:
                    live_ticker = _apply_spot_price_precision_metadata(
                        live_ticker,
                        _spot_provider_price_precision_metadata(db, pair, primary_provider),
                    )
                    _SPOT_LAST_GOOD_TICKERS[pair.symbol] = live_ticker
                    _record_spot_ticker_domain_snapshot(
                        live_ticker,
                        context=DomainSnapshotContext(
                            domain=DomainName.TICKER,
                            symbol=pair.symbol,
                            transport=DomainTransport.PROVIDER_WS,
                            cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
                            source=DomainSource.LIVE_WS,
                            provider=(
                                str(primary_provider.provider_code or "").strip()
                                or None
                            ),
                            provider_symbol=(
                                str(live_record.get("provider_symbol") or "").strip()
                                or None
                            ),
                            provider_event_time_ms=live_ticker.event_time_ms,
                            received_at_ms=live_ticker.received_at_ms,
                            ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
                        ),
                    )
                    return live_ticker
    except Exception as exc:
        logger.debug("spot_provider_ws_ticker_unavailable symbol=%s reason=%s", pair.symbol, exc)

    timeout_cap_ms = _SPOT_PROVIDER_FAST_TIMEOUT_CAP_MS if fast else _SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS
    for provider in providers:
        try:
            provider_symbol = _spot_provider_symbol(db, pair, provider)
            payload = request_contract_market_provider_json(
                _spot_provider_request_config(provider, timeout_cap_ms=timeout_cap_ms),
                "ticker",
                provider_symbol,
                limit=1,
            )
            ticker = _spot_ticker_from_provider(pair=pair, provider_code=provider.provider_code, payload=payload)
            ticker = _apply_spot_price_precision_metadata(
                ticker,
                _spot_provider_price_precision_metadata(db, pair, provider),
            )
            _SPOT_LAST_GOOD_TICKERS[pair.symbol] = ticker
            mark_contract_market_provider_success(db, provider.provider_code, market_type="SPOT")
            _record_spot_ticker_domain_snapshot(
                ticker,
                context=DomainSnapshotContext(
                    domain=DomainName.TICKER,
                    symbol=pair.symbol,
                    transport=DomainTransport.PROVIDER_REST,
                    cache_origin=DomainCacheOrigin.NONE,
                    source=DomainSource.REST_SNAPSHOT,
                    provider=str(provider.provider_code or "").strip() or None,
                    provider_symbol=provider_symbol,
                    fallback_reason=(
                        DomainFallbackReason.WS_MISS
                        if ws_lookup_attempted
                        else None
                    ),
                    provider_event_time_ms=ticker.event_time_ms,
                    received_at_ms=ticker.received_at_ms,
                    ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
                ),
            )
            return ticker
        except ProviderCooldownError as exc:
            last_error = exc
            logger.debug(
                "spot_provider_ticker_skipped_cooldown symbol=%s provider=%s",
                pair.symbol,
                provider.provider_code,
            )
            continue
        except Exception as exc:
            last_error = exc
            mark_contract_market_provider_failure(
                db,
                provider.provider_code,
                exc,
                cooldown_seconds=provider.cooldown_seconds,
                market_type="SPOT",
            )
            logger.warning("spot_provider_ticker_failed symbol=%s provider=%s reason=%s", pair.symbol, provider.provider_code, exc)
    if contract_market_last_good_enabled(db):
        fallback = _spot_last_good_ticker(pair)
        if fallback is not None:
            original = _SPOT_LAST_GOOD_TICKERS.get(pair.symbol)
            _record_spot_ticker_domain_snapshot(
                fallback,
                context=DomainSnapshotContext(
                    domain=DomainName.TICKER,
                    symbol=pair.symbol,
                    transport=DomainTransport.CACHE_READ,
                    cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
                    source=DomainSource.LAST_GOOD,
                    provider=(
                        str(getattr(original, "provider", None) or "").strip()
                        or None
                    ),
                    fallback_reason=_spot_ticker_failure_reason(last_error),
                    provider_event_time_ms=getattr(original, "event_time_ms", None),
                    received_at_ms=getattr(original, "received_at_ms", None),
                    cache_updated_at_ms=getattr(original, "received_at_ms", None),
                    ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
                ),
            )
            return fallback
    logger.warning("spot_provider_ticker_unavailable symbol=%s reason=%s", pair.symbol, last_error)
    _record_spot_ticker_domain_snapshot(
        None,
        context=DomainSnapshotContext(
            domain=DomainName.TICKER,
            symbol=pair.symbol,
            transport=DomainTransport.NONE,
            cache_origin=DomainCacheOrigin.NONE,
            source=DomainSource.MISSING,
            fallback_reason=_spot_ticker_failure_reason(last_error),
            ttl_ms=SPOT_TICKER_SHARED_CACHE_TTL_MS,
        ),
    )
    return None


def _get_external_spot_ticker_cached(db: Session, pair: TradingPair, *, fast: bool = False) -> Optional[TickerItem]:
    def load_ticker() -> Optional[Dict[str, Any]]:
        ticker = _get_external_spot_ticker(db, pair, fast=fast)
        return _ticker_to_dict(ticker) if ticker is not None else None

    payload = get_spot_ticker_with_shared_cache(
        symbol=pair.symbol,
        data_source=_normalize_data_source(pair),
        loader=load_ticker,
        cache_hit_observer=lambda cache_hit: _record_spot_ticker_cache_hit(
            symbol=pair.symbol,
            cache_hit=cache_hit,
        ),
    )
    if not isinstance(payload, dict):
        return None
    return TickerItem(**payload)


def _get_external_spot_depth_live_or_rest(
    db: Session,
    pair: TradingPair,
    limit: int = 20,
    *,
    fast: bool = False,
) -> DepthResponse:
    ws_provider = _primary_spot_market_provider_for_pair(db, pair)
    ws_provider_code = (
        str(ws_provider.provider_code or "").strip().upper()
        if ws_provider is not None
        else None
    )
    if ws_provider_code and spot_provider_ws_supports_provider(ws_provider_code, domain="depth"):
        live_depth = get_spot_provider_ws_depth(pair.symbol, provider=ws_provider_code, limit=limit)
        if live_depth is not None:
            formatted_depth = _format_depth_for_pair(pair, live_depth, limit=limit)
            formatted_depth = _apply_spot_depth_price_precision_metadata(
                formatted_depth,
                _spot_provider_price_precision_metadata(db, pair, ws_provider),
            )
            _record_spot_depth_domain_snapshot(
                formatted_depth,
                context=DomainSnapshotContext(
                    domain=DomainName.DEPTH,
                    symbol=pair.symbol,
                    transport=DomainTransport.PROVIDER_WS,
                    cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
                    source=DomainSource.LIVE_WS,
                    provider=ws_provider_code,
                    provider_symbol=(
                        str(getattr(live_depth, "provider_symbol", None) or "").strip()
                        or None
                    ),
                    provider_event_time_ms=_spot_depth_non_negative_int(
                        formatted_depth.event_time_ms or formatted_depth.ts
                    ),
                    received_at_ms=_spot_depth_non_negative_int(
                        formatted_depth.received_at_ms or formatted_depth.fetched_at
                    ),
                    ttl_ms=SPOT_DEPTH_SHARED_CACHE_TTL_MS,
                    provider_generation=_spot_depth_provider_generation(
                        pair.symbol,
                        ws_provider_code,
                    ),
                ),
            )
            return formatted_depth
    return _get_external_spot_depth(db, pair, limit=limit, fast=fast)


def _get_external_spot_depth_cached(
    db: Session,
    pair: TradingPair,
    limit: int = 20,
    *,
    fast: bool = False,
) -> DepthResponse:
    def load_depth() -> Optional[Dict[str, Any]]:
        depth = _get_external_spot_depth_live_or_rest(db, pair, limit=limit, fast=fast)
        return depth.model_dump() if hasattr(depth, "model_dump") else depth.dict()

    payload = get_spot_depth_with_shared_cache(
        symbol=pair.symbol,
        data_source=_normalize_data_source(pair),
        loader=load_depth,
        cache_hit_observer=lambda cache_hit: _record_spot_depth_cache_hit(
            symbol=pair.symbol,
            cache_hit=cache_hit,
        ),
    )
    if not isinstance(payload, dict):
        raise ValueError("spot external depth unavailable")
    return DepthResponse(**payload)


def _get_external_spot_depth(db: Session, pair: TradingPair, limit: int = 20, *, fast: bool = False) -> DepthResponse:
    last_error: Optional[Exception] = None
    providers = _enabled_spot_market_providers_for_pair(db, pair, max_providers=1 if fast else None)
    timeout_cap_ms = _SPOT_PROVIDER_FAST_TIMEOUT_CAP_MS if fast else _SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS
    for provider in providers:
        try:
            provider_symbol = _spot_provider_symbol(db, pair, provider)
            payload = request_contract_market_provider_json(
                _spot_provider_request_config(provider, timeout_cap_ms=timeout_cap_ms),
                "depth",
                provider_symbol,
                limit=limit,
            )
            depth = _spot_depth_from_provider(pair=pair, provider_code=provider.provider_code, payload=payload, limit=limit)
            depth = _apply_spot_depth_price_precision_metadata(
                depth,
                _spot_provider_price_precision_metadata(db, pair, provider),
            )
            _SPOT_LAST_GOOD_DEPTHS[pair.symbol] = depth
            mark_contract_market_provider_success(db, provider.provider_code, market_type="SPOT")
            _record_spot_depth_domain_snapshot(
                depth,
                context=DomainSnapshotContext(
                    domain=DomainName.DEPTH,
                    symbol=pair.symbol,
                    transport=DomainTransport.PROVIDER_REST,
                    cache_origin=DomainCacheOrigin.NONE,
                    source=DomainSource.REST_SNAPSHOT,
                    provider=str(provider.provider_code or "").strip() or None,
                    provider_symbol=provider_symbol,
                    provider_event_time_ms=_spot_depth_non_negative_int(
                        depth.event_time_ms or depth.ts
                    ),
                    received_at_ms=_spot_depth_non_negative_int(
                        depth.received_at_ms or depth.fetched_at
                    ),
                    ttl_ms=SPOT_DEPTH_SHARED_CACHE_TTL_MS,
                    provider_generation=_spot_depth_provider_generation(
                        pair.symbol,
                        provider.provider_code,
                    ),
                ),
            )
            return depth
        except MarketDataProviderError as exc:
            if _is_spot_provider_cooldown_skip(exc):
                last_error = exc
                logger.debug(
                    "spot_provider_depth_skipped_cooldown symbol=%s provider=%s",
                    pair.symbol,
                    provider.provider_code,
                )
                continue
            last_error = exc
            mark_contract_market_provider_failure(db, provider.provider_code, exc, cooldown_seconds=provider.cooldown_seconds, market_type="SPOT")
            if _spot_provider_warning_allowed(endpoint="depth", symbol=pair.symbol, provider=provider.provider_code, reason=exc):
                logger.warning("spot_provider_depth_failed symbol=%s provider=%s reason=%s", pair.symbol, provider.provider_code, exc)
        except Exception as exc:
            last_error = exc
            mark_contract_market_provider_failure(db, provider.provider_code, exc, cooldown_seconds=provider.cooldown_seconds, market_type="SPOT")
            if _spot_provider_warning_allowed(endpoint="depth", symbol=pair.symbol, provider=provider.provider_code, reason=exc):
                logger.warning("spot_provider_depth_failed symbol=%s provider=%s reason=%s", pair.symbol, provider.provider_code, exc)
    if contract_market_last_good_enabled(db) and pair.symbol in _SPOT_LAST_GOOD_DEPTHS:
        cached = _SPOT_LAST_GOOD_DEPTHS[pair.symbol]
        data = cached.model_dump() if hasattr(cached, "model_dump") else cached.dict()
        original_provider = str(data.get("provider") or "").strip() or None
        original_provider_symbol = str(data.get("provider_symbol") or "").strip() or None
        data.update({"provider": "LAST_GOOD", "stale": True})
        fallback = DepthResponse(**data)
        received_at_ms = _spot_depth_non_negative_int(
            data.get("received_at_ms") or data.get("fetched_at")
        )
        _record_spot_depth_domain_snapshot(
            fallback,
            context=DomainSnapshotContext(
                domain=DomainName.DEPTH,
                symbol=pair.symbol,
                transport=DomainTransport.CACHE_READ,
                cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
                source=DomainSource.LAST_GOOD,
                provider=original_provider,
                provider_symbol=original_provider_symbol,
                fallback_reason=_spot_depth_failure_reason(last_error),
                provider_event_time_ms=_spot_depth_non_negative_int(
                    data.get("event_time_ms") or data.get("ts")
                ),
                received_at_ms=received_at_ms,
                cache_updated_at_ms=received_at_ms,
                ttl_ms=SPOT_DEPTH_SHARED_CACHE_TTL_MS,
                provider_generation=_spot_depth_non_negative_int(
                    data.get("provider_generation") or data.get("generation")
                ),
            ),
        )
        return fallback
    _record_spot_depth_domain_snapshot(
        None,
        context=DomainSnapshotContext(
            domain=DomainName.DEPTH,
            symbol=pair.symbol,
            transport=DomainTransport.NONE,
            cache_origin=DomainCacheOrigin.NONE,
            source=DomainSource.MISSING,
            fallback_reason=_spot_depth_failure_reason(last_error),
            ttl_ms=SPOT_DEPTH_SHARED_CACHE_TTL_MS,
        ),
    )
    raise ValueError(f"spot external depth unavailable: {last_error}")


def _get_external_spot_trades(db: Session, pair: TradingPair, limit: int = 50, *, fast: bool = False) -> TradesResponse:
    last_error: Optional[Exception] = None
    providers = _enabled_spot_market_providers_for_pair(db, pair, max_providers=1 if fast else None)
    primary_provider = providers[0] if providers else None
    ws_lookup_attempted = False
    if primary_provider is not None and spot_provider_ws_supports_provider(primary_provider.provider_code, domain="trades"):
        ws_lookup_attempted = True
        try:
            live_trades = get_spot_provider_ws_trades(
                pair.symbol,
                provider=primary_provider.provider_code,
                limit=limit,
            )
            if live_trades is not None and live_trades.trades:
                formatted_live_trades = _format_trades_for_pair(pair, live_trades, limit=limit)
                _SPOT_LAST_GOOD_TRADES[pair.symbol] = formatted_live_trades
                formatted_payload = (
                    formatted_live_trades.model_dump()
                    if hasattr(formatted_live_trades, "model_dump")
                    else formatted_live_trades.dict()
                )
                _record_spot_trades_domain_snapshot(
                    formatted_live_trades,
                    context=DomainSnapshotContext(
                        domain=DomainName.TRADES,
                        symbol=pair.symbol,
                        transport=DomainTransport.PROVIDER_WS,
                        cache_origin=DomainCacheOrigin.PROVIDER_MEMORY,
                        source=DomainSource.LIVE_WS,
                        provider=(
                            str(primary_provider.provider_code or "").strip()
                            or None
                        ),
                        provider_symbol=_spot_trades_text(
                            formatted_payload,
                            "provider_symbol",
                        ),
                        provider_event_time_ms=_spot_trades_latest_time(
                            formatted_payload,
                            "event_time_ms",
                        ),
                        received_at_ms=_spot_trades_latest_time(
                            formatted_payload,
                            "received_at_ms",
                            "updated_at_ms",
                        ),
                        ttl_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
                    ),
                )
                return formatted_live_trades
        except Exception as exc:
            logger.debug("spot_provider_ws_trades_unavailable symbol=%s reason=%s", pair.symbol, exc)
    timeout_cap_ms = _SPOT_PROVIDER_FAST_TIMEOUT_CAP_MS if fast else _SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS
    for provider in providers:
        try:
            provider_symbol = _spot_provider_symbol(db, pair, provider)
            payload = request_contract_market_provider_json(
                _spot_provider_request_config(provider, timeout_cap_ms=timeout_cap_ms),
                "trades",
                provider_symbol,
                limit=limit,
            )
            trades = _spot_trades_from_provider(
                pair=pair,
                provider_code=provider.provider_code,
                provider_symbol=provider_symbol,
                payload=payload,
                limit=limit,
            )
            _SPOT_LAST_GOOD_TRADES[pair.symbol] = trades
            mark_contract_market_provider_success(db, provider.provider_code, market_type="SPOT")
            trades_payload = trades.model_dump() if hasattr(trades, "model_dump") else trades.dict()
            _record_spot_trades_domain_snapshot(
                trades,
                context=DomainSnapshotContext(
                    domain=DomainName.TRADES,
                    symbol=pair.symbol,
                    transport=DomainTransport.PROVIDER_REST,
                    cache_origin=DomainCacheOrigin.NONE,
                    source=DomainSource.REST_SNAPSHOT,
                    provider=str(provider.provider_code or "").strip() or None,
                    provider_symbol=provider_symbol,
                    fallback_reason=(
                        DomainFallbackReason.WS_MISS
                        if ws_lookup_attempted
                        else None
                    ),
                    provider_event_time_ms=_spot_trades_latest_time(
                        trades_payload,
                        "event_time_ms",
                    ),
                    received_at_ms=_spot_trades_latest_time(
                        trades_payload,
                        "received_at_ms",
                        "updated_at_ms",
                    ),
                    ttl_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
                ),
            )
            return trades
        except MarketDataProviderError as exc:
            if _is_spot_provider_cooldown_skip(exc):
                last_error = exc
                logger.debug(
                    "spot_provider_trades_skipped_cooldown symbol=%s provider=%s",
                    pair.symbol,
                    provider.provider_code,
                )
                continue
            last_error = exc
            mark_contract_market_provider_failure(db, provider.provider_code, exc, cooldown_seconds=provider.cooldown_seconds, market_type="SPOT")
            if _spot_provider_warning_allowed(endpoint="trades", symbol=pair.symbol, provider=provider.provider_code, reason=exc):
                logger.warning("spot_provider_trades_failed symbol=%s provider=%s reason=%s", pair.symbol, provider.provider_code, exc)
        except Exception as exc:
            last_error = exc
            mark_contract_market_provider_failure(db, provider.provider_code, exc, cooldown_seconds=provider.cooldown_seconds, market_type="SPOT")
            if _spot_provider_warning_allowed(endpoint="trades", symbol=pair.symbol, provider=provider.provider_code, reason=exc):
                logger.warning("spot_provider_trades_failed symbol=%s provider=%s reason=%s", pair.symbol, provider.provider_code, exc)
    if contract_market_last_good_enabled(db) and pair.symbol in _SPOT_LAST_GOOD_TRADES:
        cached = _SPOT_LAST_GOOD_TRADES[pair.symbol]
        data = cached.model_dump() if hasattr(cached, "model_dump") else cached.dict()
        original_provider = _spot_trades_text(data, "provider")
        original_provider_symbol = _spot_trades_text(data, "provider_symbol")
        data.update({"provider": "LAST_GOOD", "stale": True})
        fallback = TradesResponse(**data)
        _record_spot_trades_domain_snapshot(
            fallback,
            context=DomainSnapshotContext(
                domain=DomainName.TRADES,
                symbol=pair.symbol,
                transport=DomainTransport.CACHE_READ,
                cache_origin=DomainCacheOrigin.LAST_GOOD_MEMORY,
                source=DomainSource.LAST_GOOD,
                provider=original_provider,
                provider_symbol=original_provider_symbol,
                fallback_reason=_spot_trades_failure_reason(last_error),
                provider_event_time_ms=_spot_trades_latest_time(
                    data,
                    "event_time_ms",
                ),
                received_at_ms=_spot_trades_latest_time(
                    data,
                    "received_at_ms",
                    "updated_at_ms",
                ),
                cache_updated_at_ms=_spot_trades_latest_time(
                    data,
                    "received_at_ms",
                    "updated_at_ms",
                ),
                ttl_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
            ),
        )
        return fallback
    _record_spot_trades_domain_snapshot(
        None,
        context=DomainSnapshotContext(
            domain=DomainName.TRADES,
            symbol=pair.symbol,
            transport=DomainTransport.NONE,
            cache_origin=DomainCacheOrigin.NONE,
            source=DomainSource.MISSING,
            fallback_reason=_spot_trades_failure_reason(last_error),
            ttl_ms=SPOT_TRADES_SHARED_CACHE_TTL_MS,
        ),
    )
    raise ValueError(f"spot external trades unavailable: {last_error}")


def _get_external_spot_trades_cached(
    db: Session,
    pair: TradingPair,
    limit: int = 50,
    *,
    fast: bool = False,
) -> TradesResponse:
    def load_trades() -> Optional[Dict[str, Any]]:
        trades = _get_external_spot_trades(db, pair, limit=limit, fast=fast)
        return trades.model_dump() if hasattr(trades, "model_dump") else trades.dict()

    payload = get_spot_trades_with_shared_cache(
        symbol=pair.symbol,
        data_source=_normalize_data_source(pair),
        loader=load_trades,
        cache_hit_observer=lambda cache_hit: _record_spot_trades_cache_hit(
            symbol=pair.symbol,
            cache_hit=cache_hit,
        ),
    )
    if not isinstance(payload, dict):
        raise ValueError("spot external trades unavailable")
    return TradesResponse(**payload)


def _fetch_okx_spot_klines(
    provider: MarketDataProviderConfig,
    provider_symbol: str,
    *,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
) -> list[dict[str, Any]]:
    requested_limit = max(1, int(limit or 200))
    max_pages = 10
    by_open_time: dict[int, dict[str, Any]] = {}
    cursor = int(end_time_ms) if end_time_ms is not None else None
    use_history = end_time_ms is not None

    for _page_index in range(max_pages):
        remaining = requested_limit - len(by_open_time)
        if remaining <= 0:
            break
        page_limit = min(max(remaining, 1), 300)
        endpoint_type = "kline_history" if use_history else "kline"
        extra_params = _spot_kline_extra_params(
            provider.provider_code,
            interval,
            cursor if endpoint_type == "kline_history" else None,
        )
        payload = request_contract_market_provider_json(
            provider,
            endpoint_type,
            provider_symbol,
            limit=page_limit,
            extra_params=extra_params,
        )
        page_items = _spot_klines_from_provider(
            provider_code=provider.provider_code,
            payload=payload,
            interval=interval,
            limit=page_limit,
            end_time_ms=cursor if endpoint_type == "kline_history" else None,
        )
        if not page_items:
            break

        before_count = len(by_open_time)
        for item in page_items:
            try:
                open_time = int(item.get("open_time") or 0)
            except Exception:
                continue
            if open_time <= 0:
                continue
            if end_time_ms is not None and open_time >= int(end_time_ms):
                continue
            by_open_time[open_time] = item
        if len(by_open_time) == before_count:
            break

        cursor = min(int(item["open_time"]) for item in page_items)
        use_history = True
        if len(page_items) < page_limit:
            break

    return [
        by_open_time[open_time]
        for open_time in sorted(by_open_time.keys())[-requested_limit:]
    ]


def _fetch_external_spot_klines(
    db: Session,
    pair: TradingPair,
    *,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
    fast: bool = False,
    before_provider_fetch: Optional[Callable[[str], None]] = None,
    fetch_metadata: Optional[dict[str, Any]] = None,
    update_last_good: bool = True,
) -> list[dict[str, Any]]:
    last_error: Optional[Exception] = None
    last_provider_code: Optional[str] = None
    providers = list(
        _enabled_spot_market_providers_for_pair(
            db,
            pair,
            max_providers=1 if fast else None,
        )
    )
    explicit_empty_provider_codes: list[str] = []
    had_non_boundary_error = False
    timeout_cap_ms = _SPOT_KLINE_FAST_TIMEOUT_CAP_MS if fast else _SPOT_PROVIDER_REQUEST_TIMEOUT_CAP_MS
    for provider in providers:
        provider_returned_empty = False
        try:
            last_provider_code = provider.provider_code
            if before_provider_fetch is not None:
                before_provider_fetch(provider.provider_code)
            provider_symbol = _spot_provider_symbol(db, pair, provider)
            request_provider = _spot_provider_request_config(provider, timeout_cap_ms=timeout_cap_ms)
            if provider.provider_code == "OKX_SPOT":
                items = _fetch_okx_spot_klines(
                    request_provider,
                    provider_symbol,
                    interval=interval,
                    limit=limit,
                    end_time_ms=end_time_ms,
                )
            else:
                payload = request_contract_market_provider_json(
                    request_provider,
                    _spot_kline_endpoint_type(provider.provider_code, end_time_ms),
                    provider_symbol,
                    limit=limit,
                    extra_params=_spot_kline_extra_params(provider.provider_code, interval, end_time_ms),
                )
                items = _spot_klines_from_provider(
                    provider_code=provider.provider_code,
                    payload=payload,
                    interval=interval,
                    limit=limit,
                    end_time_ms=end_time_ms,
                )
            if not items:
                provider_returned_empty = True
                explicit_empty_provider_codes.append(str(provider.provider_code))
                raise ValueError("spot kline unavailable")
            if fetch_metadata is not None:
                fetch_metadata.clear()
                fetch_metadata.update(
                    {
                        "provider": provider.provider_code,
                        "from_last_good": False,
                    }
                )
            if update_last_good:
                _SPOT_LAST_GOOD_KLINES[(pair.symbol, interval)] = {
                    "items": items,
                    "provider": provider.provider_code,
                    "updated_at": datetime.utcnow().isoformat(),
                }
            mark_contract_market_provider_success(db, provider.provider_code, market_type="SPOT")
            return items
        except MarketDataProviderError as exc:
            had_non_boundary_error = True
            if _is_spot_provider_cooldown_skip(exc):
                last_error = exc
                logger.debug(
                    "spot_provider_kline_skipped_cooldown symbol=%s provider=%s interval=%s",
                    pair.symbol,
                    provider.provider_code,
                    interval,
                )
                continue
            last_error = exc
            mark_contract_market_provider_failure(db, provider.provider_code, exc, cooldown_seconds=provider.cooldown_seconds, market_type="SPOT")
            _log_spot_provider_kline_failure(
                symbol=pair.symbol,
                provider=provider.provider_code,
                interval=interval,
                end_time_ms=end_time_ms,
                reason=exc,
            )
        except Exception as exc:
            if not provider_returned_empty:
                had_non_boundary_error = True
            last_error = exc
            mark_contract_market_provider_failure(db, provider.provider_code, exc, cooldown_seconds=provider.cooldown_seconds, market_type="SPOT")
            _log_spot_provider_kline_failure(
                symbol=pair.symbol,
                provider=provider.provider_code,
                interval=interval,
                end_time_ms=end_time_ms,
                reason=exc,
            )
    monthly_history_boundary_candidate = bool(
        end_time_ms is not None
        and normalize_spot_kline_bucket_interval(interval) == "1Mutc"
        and providers
        and len(explicit_empty_provider_codes) == len(providers)
        and not had_non_boundary_error
    )
    if contract_market_last_good_enabled(db):
        cached = _SPOT_LAST_GOOD_KLINES.get((pair.symbol, interval))
        if cached and cached.get("items"):
            cached_items = list(cached["items"])[-limit:]
            has_usable_history_item = not monthly_history_boundary_candidate or any(
                int(item.get("open_time") or item.get("time") or 0) < int(end_time_ms or 0)
                for item in cached_items
                if isinstance(item, dict)
            )
            if has_usable_history_item:
                if fetch_metadata is not None:
                    fetch_metadata.clear()
                    fetch_metadata.update(
                        {
                            "provider": cached.get("provider") or last_provider_code,
                            "from_last_good": True,
                        }
                    )
                return cached_items
    if monthly_history_boundary_candidate:
        raise KlineProviderHistoryBoundary(
            "spot provider monthly history boundary",
            provider_error_provider=last_provider_code,
        )
    raise KlineProviderFetchError(
        "spot external kline unavailable",
        provider_error_code=_spot_kline_provider_error_code(last_error),
        provider_error_provider=last_provider_code,
    )


def _build_itick_fallback_trades(pair: TradingPair, limit: int = 50) -> TradesResponse:
    trade_limit = max(1, min(int(limit or 20), 50))
    mid_price = _itick_ref_price(pair, allow_upstream=False)
    tick = _price_quant(pair)
    now_ms = _now_ms()
    trades: List[TradeItem] = []

    for idx in range(trade_limit):
        direction = Decimal("1") if idx % 2 == 0 else Decimal("-1")
        wave = (_stable_unit(pair.symbol, f"trade:{idx}", 1000) - Decimal("0.5")) / Decimal("1000")
        price = _round_price(pair, max(mid_price * (Decimal("1") + wave * direction), tick))
        amount = _round_amount(
            pair,
            Decimal("0.2") + _stable_unit(pair.symbol, f"trade-amount:{idx}", 5000) * Decimal("2"),
        )
        trades.append(
            TradeItem(
                price=_decimal_to_str(price),
                amount=_decimal_to_str(max(amount, _amount_quant(pair))),
                side="BUY" if idx % 2 == 0 else "SELL",
                ts=now_ms - idx * 15_000,
                time_origin="SYNTHETIC",
            )
        )

    return TradesResponse(symbol=pair.symbol, trades=trades)


def get_trades(db: Session, symbol: str, limit: int = 50, *, fast: bool = False) -> TradesResponse:
    pair = _get_active_pair(db, symbol)
    data_source = _normalize_data_source(pair)

    if data_source == DATA_SOURCE_BINANCE:
        return _get_external_spot_trades_cached(db, pair, limit=limit, fast=fast)

    if data_source == DATA_SOURCE_ITICK:
        trades = _get_internal_trades(db, pair, limit=limit)
        if trades.trades:
            return trades
        return _build_itick_fallback_trades(pair, limit=limit)

    return _get_internal_trades(db, pair, limit=limit)


def _build_internal_ticker_stats(db: Session, pairs: List[TradingPair]) -> Dict[int, Dict[str, Decimal]]:
    now = datetime.utcnow()
    since = now - timedelta(hours=24)
    pair_ids = [int(pair.id) for pair in pairs if getattr(pair, "id", None) is not None]
    stats: Dict[int, Dict[str, Decimal]] = {
        pair_id: {
            "last_price": Decimal("0"),
            "open_24h": Decimal("0"),
            "high_24h": Decimal("0"),
            "low_24h": Decimal("0"),
            "volume_24h": Decimal("0"),
            "quote_volume_24h": Decimal("0"),
        }
        for pair_id in pair_ids
    }
    if not pair_ids:
        return stats

    recent_rows = (
        db.query(Trade)
        .filter(Trade.trading_pair_id.in_(pair_ids), Trade.created_at >= since)
        .order_by(Trade.created_at.asc(), Trade.id.asc())
        .all()
    )

    seen_recent_ids = set()
    for row in recent_rows:
        pair_id = int(row.trading_pair_id)
        item = stats[pair_id]
        price = _to_decimal(row.price)
        amount = _to_decimal(row.amount)
        quote_amount = _to_decimal(getattr(row, "quote_amount", None), price * amount)

        if item["open_24h"] <= 0:
            item["open_24h"] = price
            item["high_24h"] = price
            item["low_24h"] = price

        item["last_price"] = price
        item["high_24h"] = max(item["high_24h"], price)
        item["low_24h"] = min(item["low_24h"], price)
        item["volume_24h"] += amount
        item["quote_volume_24h"] += quote_amount
        seen_recent_ids.add(pair_id)

    missing_ids = [pair_id for pair_id in pair_ids if pair_id not in seen_recent_ids]
    if missing_ids:
        historical_rows = (
            db.query(Trade)
            .filter(Trade.trading_pair_id.in_(missing_ids))
            .order_by(Trade.trading_pair_id.asc(), Trade.created_at.desc(), Trade.id.desc())
            .all()
        )
        filled_ids = set()
        for row in historical_rows:
            pair_id = int(row.trading_pair_id)
            if pair_id in filled_ids:
                continue
            price = _to_decimal(row.price)
            stats[pair_id].update(
                {
                    "last_price": price,
                    "open_24h": price,
                    "high_24h": price,
                    "low_24h": price,
                    "volume_24h": Decimal("0"),
                    "quote_volume_24h": Decimal("0"),
                }
            )
            filled_ids.add(pair_id)

    return stats


def _get_internal_ticker(
    db: Session,
    pair: TradingPair,
    stats: Optional[Dict[int, Dict[str, Decimal]]] = None,
) -> TickerItem:
    if stats is None:
        stats = _build_internal_ticker_stats(db, [pair])

    item = stats.get(int(pair.id), {})
    last_price = _to_decimal(item.get("last_price"))
    open_24h = _to_decimal(item.get("open_24h"), last_price)
    high_24h = _to_decimal(item.get("high_24h"), last_price)
    low_24h = _to_decimal(item.get("low_24h"), last_price)
    volume_24h = _to_decimal(item.get("volume_24h"))
    quote_volume_24h = _to_decimal(item.get("quote_volume_24h"))

    if high_24h <= 0:
        high_24h = last_price
    if low_24h <= 0:
        low_24h = last_price

    if quote_volume_24h <= 0:
        if last_price <= 0:
            last_price = Decimal("0")
        open_24h = last_price
        high_24h = last_price
        low_24h = last_price
        volume_24h = Decimal("0")
        quote_volume_24h = Decimal("0")

    price_change_percent = Decimal("0")
    if quote_volume_24h > 0 and open_24h > 0:
        price_change_percent = ((last_price - open_24h) / open_24h) * Decimal("100")

    return TickerItem(
        symbol=pair.symbol,
        last_price=_format_price_for_pair(pair, last_price),
        open_24h=_format_price_for_pair(pair, open_24h),
        price_change_24h=_format_price_for_pair(pair, last_price - open_24h),
        price_change_percent=_format_percent(price_change_percent),
        volume_24h=_format_amount_for_pair(pair, volume_24h),
        base_volume_24h=_format_amount_for_pair(pair, volume_24h),
        high_24h=_format_price_for_pair(pair, high_24h),
        low_24h=_format_price_for_pair(pair, low_24h),
        quote_volume_24h=_decimal_to_str(quote_volume_24h),
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        source="internal",
        quote_freshness="LIVE",
        ts=datetime.utcnow().isoformat(),
    )


def _get_binance_ticker(pair: TradingPair) -> Optional[TickerItem]:
    try:
        payload: ExternalTickerResponse = binance_market_service.get_ticker(_external_symbol(pair))
    except BinanceMarketServiceError as exc:
        logger.warning("binance ticker fetch failed for %s: %s", pair.symbol, exc)
        return None
    except Exception as exc:
        logger.warning("unexpected binance ticker fetch failed for %s: %s", pair.symbol, exc)
        return None

    open_24h = _to_decimal(payload.price) - _to_decimal(payload.price_change)

    return TickerItem(
        symbol=pair.symbol,
        last_price=_format_price_for_pair(pair, payload.price),
        open_24h=_format_price_for_pair(pair, open_24h),
        price_change_24h=_format_price_for_pair(pair, payload.price_change),
        price_change_percent=payload.price_change_percent,
        volume_24h=_format_amount_for_pair(pair, payload.volume),
        base_volume_24h=_format_amount_for_pair(pair, payload.volume),
        high_24h=_format_price_for_pair(pair, payload.high_price or payload.price or "0"),
        low_24h=_format_price_for_pair(pair, payload.low_price or payload.price or "0"),
        quote_volume_24h=str(payload.quote_volume or "0"),
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        source="binance",
        quote_freshness="LIVE",
        ts=datetime.utcnow().isoformat(),
    )


def _pick_decimal(data: Dict[str, Any], keys: List[str], default: Decimal = Decimal("0")) -> Decimal:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return _to_decimal(value, default)
    return default


def _get_itick_daily_snapshot(pair: TradingPair) -> Dict[str, Decimal]:
    try:
        payload = _get_itick_klines(pair, "1d", 3)
    except ItickMarketServiceError as exc:
        logger.info("itick ticker 24h kline unavailable for %s: %s", pair.symbol, exc)
        return {}
    except Exception as exc:
        logger.warning("unexpected itick ticker 24h kline failed for %s: %s", pair.symbol, exc)
        return {}

    rows = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(rows, list) or not rows:
        logger.info("itick ticker 24h kline empty for %s", pair.symbol)
        return {}

    rows = sorted(rows, key=lambda row: int(row.get("open_time") or 0))
    latest = rows[-1]
    previous = rows[-2] if len(rows) >= 2 else None

    previous_close = _to_decimal(previous.get("close")) if isinstance(previous, dict) else _to_decimal(latest.get("open"))
    high_24h = _to_decimal(latest.get("high"))
    low_24h = _to_decimal(latest.get("low"))
    close_price = _to_decimal(latest.get("close"))
    base_volume_24h = _to_decimal(latest.get("volume"))
    quote_volume_24h = _to_decimal(latest.get("quote_volume"))
    if quote_volume_24h <= 0 and base_volume_24h > 0 and close_price > 0:
        # iTick daily kline may not include quote turnover; estimate quote turnover from close price and base volume.
        quote_volume_24h = base_volume_24h * close_price

    return {
        "previous_close": previous_close,
        "high_24h": high_24h,
        "low_24h": low_24h,
        "base_volume_24h": base_volume_24h,
        "quote_volume_24h": quote_volume_24h,
        "close_price": close_price,
    }


def _derive_itick_24h_metrics(
    pair: TradingPair,
    data: Dict[str, Any],
    last_price: Decimal,
    *,
    allow_upstream: bool,
) -> Dict[str, Decimal]:
    previous_close = _pick_decimal(
        data,
        list(ITICK_PREVIOUS_CLOSE_FIELDS),
    )
    open_price = _pick_decimal(data, list(ITICK_OPEN_PRICE_FIELDS))
    high_24h = _pick_decimal(data, ["h", "high", "high_price", "highPrice", "high_24h"], last_price)
    low_24h = _pick_decimal(data, ["l", "low", "low_price", "lowPrice", "low_24h"], last_price)
    base_volume_24h = _pick_decimal(data, ["v", "volume", "vol", "volume_24h", "baseVolume", "base_volume_24h"])
    quote_volume_24h = _pick_decimal(
        data,
        [
            "quote_volume_24h",
            "turnover",
            "amount",
            "turnover_value",
            "trade_amount",
            "value",
            "tu",
            "qv",
            "quoteVolume",
            "quote_volume",
            "turnover_24h",
        ],
    )
    if quote_volume_24h <= 0 and base_volume_24h > 0 and last_price > 0:
        # iTick quote payload may not include quote turnover; estimate quote turnover from last price and base volume.
        quote_volume_24h = base_volume_24h * last_price

    official_change = _pick_decimal(
        data,
        ["ch", "change", "changePrice", "priceChange", "price_change", "price_change_24h"],
    )
    official_percent = _pick_decimal(
        data,
        [
            "chp",
            "changePercent",
            "change_percent",
            "change_percent_24h",
            "priceChangePercent",
            "price_change_percent",
            "price_change_percent_24h",
            "percent",
            "rate",
            "pct_chg",
            "percent_change_24h",
        ],
    )

    daily_snapshot: Dict[str, Decimal] = {}
    needs_daily_kline = (
        allow_upstream
        and (
            previous_close <= 0
            or high_24h <= 0
            or low_24h <= 0
            or (base_volume_24h <= 0 and quote_volume_24h <= 0)
        )
    )
    if needs_daily_kline:
        daily_snapshot = _get_itick_daily_snapshot(pair)

    if previous_close <= 0:
        previous_close = daily_snapshot.get("previous_close", Decimal("0"))
    if previous_close <= 0 and open_price > 0:
        previous_close = open_price
    if previous_close <= 0 and official_change != 0:
        previous_close = last_price - official_change

    if high_24h <= 0:
        high_24h = daily_snapshot.get("high_24h", Decimal("0"))
    if low_24h <= 0:
        low_24h = daily_snapshot.get("low_24h", Decimal("0"))
    if base_volume_24h <= 0:
        base_volume_24h = daily_snapshot.get("base_volume_24h", Decimal("0"))
    if quote_volume_24h <= 0:
        quote_volume_24h = daily_snapshot.get("quote_volume_24h", Decimal("0"))
    if quote_volume_24h <= 0 and base_volume_24h > 0 and last_price > 0:
        # Daily snapshot may still lack quote turnover; estimate quote turnover from last price and base volume.
        quote_volume_24h = base_volume_24h * last_price

    price_change_24h = Decimal("0")
    price_change_percent_24h = Decimal("0")
    if official_change != 0:
        price_change_24h = official_change
    elif previous_close > 0:
        price_change_24h = last_price - previous_close

    if official_percent != 0:
        price_change_percent_24h = official_percent
    elif previous_close > 0:
        price_change_percent_24h = (price_change_24h / previous_close) * Decimal("100")
    else:
        logger.info("itick ticker 24h previous close unavailable for %s", pair.symbol)

    if high_24h <= 0:
        high_24h = max(last_price, previous_close)
    if low_24h <= 0:
        low_24h = min(value for value in [last_price, previous_close] if value > 0) if max(last_price, previous_close) > 0 else last_price
    if high_24h < last_price:
        high_24h = last_price
    if low_24h <= 0 or low_24h > last_price:
        low_24h = last_price

    return {
        "open_24h": previous_close,
        "price_change_24h": price_change_24h,
        "price_change_percent_24h": price_change_percent_24h,
        "high_24h": high_24h,
        "low_24h": low_24h,
        "base_volume_24h": base_volume_24h,
        "quote_volume_24h": quote_volume_24h,
    }


def _get_itick_ticker(
    pair: TradingPair,
    *,
    allow_upstream: bool = True,
    quote_data: Optional[Dict[str, Any]] = None,
) -> Optional[TickerItem]:
    cache_key = str(pair.symbol or "").upper()
    if allow_upstream and quote_data is None:
        cached = _ITICK_TICKER_CACHE.get(cache_key)
        if cached and time.time() - cached[0] <= _ITICK_TICKER_CACHE_TTL_SECONDS:
            return cached[1]

    context_last_price: Optional[Decimal] = None
    if allow_upstream and is_stock_dealer_pair(pair):
        try:
            context_last_price = get_stock_trade_context(db=None, trading_pair=pair, limit=1).last_price
        except Exception as exc:
            logger.warning("stock trade context ticker fetch failed for %s: %s", pair.symbol, exc)

    data = quote_data if isinstance(quote_data, dict) else None
    if data is None and allow_upstream:
        try:
            payload = _get_itick_quote_payload(pair)
            data = payload.get("data") if isinstance(payload, dict) else None
        except ItickMarketServiceError as exc:
            logger.warning("itick ticker fetch failed for %s: %s", pair.symbol, exc)
        except Exception as exc:
            logger.warning("unexpected itick ticker fetch failed for %s: %s", pair.symbol, exc)

    has_quote_data = isinstance(data, dict)
    if has_quote_data:
        last_price = context_last_price or _pick_decimal(
            data,
            list(ITICK_LATEST_PRICE_FIELDS),
        )
    else:
        last_price = context_last_price or _itick_ref_price(pair, allow_upstream=False)
        data = {}
    quote_ts = _quote_ts_from_itick_data(data) if has_quote_data else None

    if last_price <= 0:
        last_price = _itick_ref_price(pair, allow_upstream=False)

    metrics = _derive_itick_24h_metrics(
        pair,
        data,
        last_price,
        allow_upstream=allow_upstream,
    )

    _ITICK_LAST_GOOD_PRICE[pair.symbol] = _round_price(pair, last_price)

    ticker = TickerItem(
        symbol=pair.symbol,
        last_price=_format_price_for_pair(pair, last_price),
        open_24h=_format_price_for_pair(pair, metrics["open_24h"]),
        price_change_24h=_format_price_for_pair(pair, metrics["price_change_24h"]),
        price_change_percent=_format_percent(metrics["price_change_percent_24h"]),
        volume_24h=_format_amount_for_pair(pair, metrics["base_volume_24h"]),
        base_volume_24h=_format_amount_for_pair(pair, metrics["base_volume_24h"]),
        high_24h=_format_price_for_pair(pair, metrics["high_24h"]),
        low_24h=_format_price_for_pair(pair, metrics["low_24h"]),
        quote_volume_24h=_decimal_to_str(metrics["quote_volume_24h"]),
        price_precision=int(pair.price_precision or 8),
        amount_precision=int(pair.amount_precision or 8),
        source="itick",
        quote_freshness=_quote_freshness("itick", quote_ts) if has_quote_data else "FALLBACK",
        ts=quote_ts.isoformat() if quote_ts else None,
    )
    if _is_itick_stock_pair(pair):
        logger.debug(
            "itick stock ticker final symbol=%s last_price=%s price_change_percent_24h=%s quote_volume_24h=%s has_quote_data=%s",
            pair.symbol,
            ticker.last_price,
            ticker.price_change_percent,
            ticker.quote_volume_24h,
            bool(quote_data),
        )
    if allow_upstream:
        _ITICK_TICKER_CACHE[cache_key] = (time.time(), ticker)
    return ticker


def get_tickers(db: Session) -> TickerListResponse:
    items: List[TickerItem] = []
    pairs = (
        db.query(TradingPair)
        .filter(TradingPair.status == 1)
        .order_by(TradingPair.is_hot.desc(), TradingPair.sort_order.asc(), TradingPair.symbol.asc())
        .all()
    )
    pairs = filter_contract_authorized_trading_pairs(db, pairs)
    internal_stats = _build_internal_ticker_stats(
        db,
        [pair for pair in pairs if _normalize_data_source(pair) != DATA_SOURCE_ITICK],
    )

    for pair in pairs:
        data_source = _normalize_data_source(pair)
        ticker = None
        if data_source == DATA_SOURCE_BINANCE:
            ticker = _get_external_spot_ticker_cached(db, pair)
        elif data_source == DATA_SOURCE_ITICK:
            ticker = _get_itick_ticker(pair, allow_upstream=False)

        items.append(_with_pair_metadata(ticker or _get_internal_ticker(db, pair, internal_stats), pair))

    return TickerListResponse(items=items)


def get_market_tickers(
    db: Session,
    symbol: Optional[str] = None,
    symbols: Optional[str] = None,
    *,
    spot_fast: bool = False,
):
    query = db.query(TradingPair).filter(TradingPair.status == 1)
    normalized_symbol = str(symbol or "").upper().strip()
    normalized_symbols = [
        item.strip().upper()
        for item in str(symbols or "").split(",")
        if item.strip()
    ]
    if normalized_symbol:
        query = query.filter(TradingPair.symbol == normalized_symbol)
    elif normalized_symbols:
        query = query.filter(TradingPair.symbol.in_(normalized_symbols))

    pairs = query.order_by(TradingPair.is_hot.desc(), TradingPair.sort_order.asc(), TradingPair.symbol.asc()).all()
    pairs = filter_contract_authorized_trading_pairs(db, pairs)
    logger.debug(
        "market tickers request pairs_count=%s requested_symbols=%s",
        len(pairs),
        normalized_symbols or ([normalized_symbol] if normalized_symbol else []),
    )
    internal_stats = _build_internal_ticker_stats(
        db,
        [pair for pair in pairs if _normalize_data_source(pair) != DATA_SOURCE_ITICK],
    )
    itick_quote_batch = {}
    if not normalized_symbol:
        itick_quote_batch = _fetch_itick_quote_batch(
            [pair for pair in pairs if _normalize_data_source(pair) == DATA_SOURCE_ITICK]
        )

    items = []
    for pair in pairs:
        data_source = _normalize_data_source(pair)
        ticker = None
        if data_source == DATA_SOURCE_BINANCE:
            ticker = _get_external_spot_ticker_cached(db, pair, fast=spot_fast)
        elif data_source == DATA_SOURCE_ITICK:
            quote_data = itick_quote_batch.get(pair.symbol)
            if _is_itick_stock_pair(pair) and not normalized_symbol and quote_data is None:
                logger.debug(
                    "itick stock ticker missing quote_data symbol=%s external_symbol=%s",
                    pair.symbol,
                    _external_symbol(pair),
                )
                items.append(_empty_itick_stock_ticker_dict(pair))
                continue
            ticker = _get_itick_ticker(
                pair,
                allow_upstream=bool(normalized_symbol),
                quote_data=quote_data,
            )

        if ticker is None:
            ticker = _get_internal_ticker(db, pair, internal_stats)

        ticker_data = _ticker_to_dict(ticker)
        item = {
            "symbol": pair.symbol,
            "last_price": ticker.last_price,
            "change_24h": ticker.price_change_percent,
            "price_change_percent_24h": ticker.price_change_percent,
            "price_change_24h": ticker.price_change_24h,
            "high_24h": ticker.high_24h,
            "low_24h": ticker.low_24h,
            "volume_24h": ticker.volume_24h,
            "base_volume_24h": ticker.base_volume_24h,
            "quote_volume_24h": ticker.quote_volume_24h,
            "provider": ticker.provider,
            "stale": bool(ticker.stale),
            "updated_at": ticker.updated_at,
            "source": ticker.source,
            "quote_freshness": ticker.quote_freshness,
            "ts": ticker.ts,
            "event_time_ms": ticker.event_time_ms,
            "received_at_ms": ticker.received_at_ms,
            **_ticker_metadata(pair),
        }
        for key in _SPOT_PRICE_PRECISION_PAYLOAD_KEYS:
            if ticker_data.get(key) not in (None, ""):
                item[key] = ticker_data.get(key)
        item.update(_market_status_payload_for_pair(pair))
        item["quote_freshness"] = item.get("quote_freshness") or _quote_freshness(
            str(item.get("source") or ""),
            _normalize_quote_ts(item.get("ts")),
        )
        if _is_itick_stock_pair(pair) and _external_symbol(pair) in ("NVDA", "MSFT", "AAPL"):
            logger.debug(
                "market tickers final stock symbol=%s last_price=%s price_change_percent_24h=%s quote_volume_24h=%s",
                item["symbol"],
                item["last_price"],
                item["price_change_percent_24h"],
                item["quote_volume_24h"],
            )
        items.append(item)

    return items


def get_market_pairs(
    db: Session,
    *,
    market_type: str = "spot",
    category: str = "all",
    quote: str = "all",
    keyword: Optional[str] = None,
    page: int = 1,
    page_size: int = PAIR_PAGE_SIZE_DEFAULT,
):
    normalized_market_type = str(market_type or "spot").strip().lower()
    normalized_quote = str(quote or "all").strip().upper()
    normalized_page = max(int(page or 1), 1)
    normalized_page_size = max(1, min(int(page_size or PAIR_PAGE_SIZE_DEFAULT), PAIR_PAGE_SIZE_MAX))

    pairs = (
        db.query(TradingPair)
        .filter(TradingPair.status == 1)
        .order_by(TradingPair.is_hot.desc(), TradingPair.sort_order.asc(), TradingPair.symbol.asc())
        .all()
    )

    filtered_pairs = []
    for pair in pairs:
        is_contract = _is_contract_pair(pair)
        if normalized_market_type == "spot" and is_contract:
            continue
        if normalized_market_type == "contract" and not is_contract:
            continue

        _, pair_quote = _pair_base_quote(pair)
        if normalized_quote != "ALL" and pair_quote != normalized_quote:
            continue
        if not _pair_matches_category(pair, category):
            continue
        if not _pair_matches_keyword(pair, keyword or ""):
            continue

        filtered_pairs.append(pair)

    filtered_pairs = filter_contract_authorized_trading_pairs(db, filtered_pairs)
    total = len(filtered_pairs)
    offset = (normalized_page - 1) * normalized_page_size
    page_pairs = filtered_pairs[offset : offset + normalized_page_size]

    items = []
    for pair in page_pairs:
        status_payload = _market_status_payload_for_pair(pair)
        is_contract = _is_contract_pair(pair)
        items.append(
            {
                "symbol": pair.symbol,
                **_ticker_metadata(pair),
                **status_payload,
                "quote_freshness": "FALLBACK" if _is_itick_stock_pair(pair) else "LIVE",
                "status": int(getattr(pair, "status", 0) or 0),
                "enabled": int(getattr(pair, "status", 0) or 0) == 1,
                "market_type": "contract" if is_contract else "spot",
            }
        )

    return {
        "items": items,
        "total": total,
        "page": normalized_page,
        "page_size": normalized_page_size,
    }


def filter_active_trading_pair_rows(
    db: Session,
    rows: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Keep cached market data, but never cached control-plane membership."""
    normalized_rows = [row for row in rows if isinstance(row, dict)]
    symbols = {
        str(row.get("symbol") or "").upper().strip()
        for row in normalized_rows
        if str(row.get("symbol") or "").strip()
    }
    if not symbols:
        return []

    active_rows = (
        db.query(TradingPair)
        .filter(TradingPair.symbol.in_(symbols), TradingPair.status == 1)
        .all()
    )
    active_rows = filter_contract_authorized_trading_pairs(db, active_rows)
    active_symbols = {
        str(getattr(row, "symbol", None) or row[0]).upper().strip()
        for row in active_rows
    }
    return [
        row
        for row in normalized_rows
        if str(row.get("symbol") or "").upper().strip() in active_symbols
    ]


def filter_active_mobile_market_overview(
    db: Session,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    """Prune disabled pairs from cached mobile overview membership."""
    if not isinstance(payload, dict):
        return payload

    overview_cards = payload.get("overview_cards")
    sections = payload.get("sections")
    rows: List[Dict[str, Any]] = []
    if isinstance(overview_cards, list):
        rows.extend(row for row in overview_cards if isinstance(row, dict))
    if isinstance(sections, list):
        for section in sections:
            if isinstance(section, dict) and isinstance(section.get("items"), list):
                rows.extend(row for row in section["items"] if isinstance(row, dict))

    active_rows = filter_active_trading_pair_rows(db, rows)
    active_symbols = {
        str(row.get("symbol") or "").upper().strip()
        for row in active_rows
    }

    def keep_active(row: Any) -> bool:
        return (
            isinstance(row, dict)
            and str(row.get("symbol") or "").upper().strip() in active_symbols
        )

    next_payload = dict(payload)
    if isinstance(overview_cards, list):
        next_payload["overview_cards"] = [row for row in overview_cards if keep_active(row)]
    if isinstance(sections, list):
        next_sections = []
        for section in sections:
            if not isinstance(section, dict):
                continue
            next_section = dict(section)
            items = section.get("items")
            if isinstance(items, list):
                next_section["items"] = [row for row in items if keep_active(row)]
            next_sections.append(next_section)
        next_payload["sections"] = next_sections
    return next_payload


def _mobile_market_category(pair_data: Dict[str, Any]) -> str:
    symbol = str(pair_data.get("symbol") or "").upper().strip()
    asset_type = str(pair_data.get("asset_type") or "").upper().strip()
    market_category = str(pair_data.get("market_category") or "").upper().strip()
    market_sub_category = str(pair_data.get("market_sub_category") or "").upper().strip()
    display_category = str(pair_data.get("display_category") or "").upper().strip()
    values = {asset_type, market_category, market_sub_category, display_category}

    if "STOCK" in values or any("STOCK" in value for value in values):
        return "stocks"
    if (
        "RWA" in values
        or "ONCHAIN" in values
        or any("ONCHAIN" in value for value in values)
        or symbol in {"SPYX", "COAI", "AGT", "CLO", "TRIA"}
    ):
        return "onchain"
    if (
        values.intersection({"CONTRACT", "CFD", "INDEX", "FOREX", "METAL", "COMMODITY", "ETF"})
        or symbol in {"NAS100", "XAUUSD", "XAGUSD", "EURUSD", "USOUSD"}
    ):
        return "contract_cfd"
    return "spot"


def _mobile_display_symbol(pair_data: Dict[str, Any]) -> str:
    symbol = str(pair_data.get("symbol") or "").upper().strip()
    display = str(pair_data.get("display_symbol") or pair_data.get("base_asset") or "").strip()
    if display:
        return display.replace("/USDT", "").replace("USDT", "")
    if symbol.endswith("USDT"):
        return symbol[:-4]
    return symbol


def _mobile_market_name(pair_data: Dict[str, Any]) -> str:
    symbol = str(pair_data.get("symbol") or "").upper().strip()
    display_symbol = _mobile_display_symbol(pair_data)
    known_names = {
        "BTCUSDT": "Bitcoin",
        "RCBUSDT": "Royal Coin",
        "ETHUSDT": "Ethereum",
        "NAS100": "NASDAQ 100",
        "XAUUSD": "Gold US Dollar",
        "XAGUSD": "Silver US Dollar",
        "EURUSD": "Euro vs US Dollar",
        "USOUSD": "WTI Crude Oil Cash",
        "NVDA": "NVIDIA",
        "TSLA": "Tesla",
    }
    return known_names.get(symbol) or str(
        pair_data.get("display_name")
        or pair_data.get("name")
        or pair_data.get("spot_logo_alt")
        or pair_data.get("external_symbol")
        or display_symbol
    ).strip()


def _mobile_market_item(pair_data: Dict[str, Any]) -> Dict[str, Any]:
    symbol = str(pair_data.get("symbol") or "").upper().strip()
    return {
        "symbol": symbol,
        "display_symbol": _mobile_display_symbol(pair_data),
        "name": _mobile_market_name(pair_data),
        "category": _mobile_market_category(pair_data),
        "price": str(pair_data.get("last_price") or pair_data.get("price") or "0"),
        "change_pct": str(
            pair_data.get("price_change_percent_24h")
            or pair_data.get("change_24h")
            or pair_data.get("price_change_percent")
            or "0"
        ),
        "volume": str(pair_data.get("quote_volume_24h") or pair_data.get("volume_24h") or "0"),
        "price_precision": int(pair_data.get("price_precision") or 8),
        "amount_precision": int(pair_data.get("amount_precision") or 8),
        "source": str(pair_data.get("source") or pair_data.get("data_source") or "api"),
        "stale": bool(pair_data.get("stale") or pair_data.get("is_stale")),
        "updated_at": pair_data.get("updated_at") or pair_data.get("cache_updated_at"),
    }


def _mobile_sort_key(item: Dict[str, Any]) -> Tuple[int, int, str]:
    symbol = str(item.get("symbol") or "").upper()
    try:
        change_weight = int(abs(_to_decimal(item.get("change_pct"))) * Decimal("100"))
    except Exception:
        change_weight = 0
    priority = MOBILE_OVERVIEW_SYMBOLS.index(symbol) if symbol in MOBILE_OVERVIEW_SYMBOLS else 999
    return (priority, -change_weight, symbol)


def get_mobile_market_overview(db: Session) -> Dict[str, Any]:
    pair_payload = get_market_pairs(
        db=db,
        market_type="all",
        category="all",
        quote="all",
        page=1,
        page_size=PAIR_PAGE_SIZE_MAX,
    )
    pair_rows = pair_payload.get("items") if isinstance(pair_payload, dict) else []
    ticker_rows = get_market_tickers(db=db)

    by_symbol: Dict[str, Dict[str, Any]] = {}
    for row in (pair_rows if isinstance(pair_rows, list) else []):
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").upper().strip()
        if symbol:
            by_symbol[symbol] = dict(row)

    for row in (ticker_rows if isinstance(ticker_rows, list) else []):
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").upper().strip()
        if not symbol:
            continue
        by_symbol[symbol] = {**by_symbol.get(symbol, {}), **row}

    items = [_mobile_market_item(item) for item in by_symbol.values()]
    items = [item for item in items if item.get("symbol")]
    items.sort(key=_mobile_sort_key)

    overview_cards = [item for symbol in MOBILE_OVERVIEW_SYMBOLS for item in items if item["symbol"] == symbol]
    if len(overview_cards) < 6:
        seen = {item["symbol"] for item in overview_cards}
        overview_cards.extend(item for item in items if item["symbol"] not in seen)
    overview_cards = overview_cards[:6]

    section_configs = [
        ("stocks", "股票"),
        ("spot", "现货"),
        ("contract_cfd", "合约 / CFD"),
        ("onchain", "链上交易"),
    ]
    sections = []
    for key, title in section_configs:
        section_items = [item for item in items if item.get("category") == key]
        section_items = sorted(section_items, key=_mobile_sort_key)[:MOBILE_OVERVIEW_SECTION_LIMIT]
        sections.append({"key": key, "title": title, "items": section_items})

    now = datetime.utcnow().replace(microsecond=0)
    return {
        "server_time": int(time.time() * 1000),
        "updated_at": now.isoformat() + "Z",
        "stale": any(bool(item.get("stale")) for item in items),
        "source": "live",
        "overview_cards": overview_cards,
        "sections": sections,
    }


def _floor_ts(dt: datetime, step: int) -> datetime:
    ts = int(dt.timestamp())
    return datetime.fromtimestamp(ts - ts % step)


def _normalize_limit(limit: int, default: int = 200, max_limit: int = 1000) -> int:
    try:
        value = int(limit)
    except Exception:
        value = default

    if value <= 0:
        value = default

    return min(value, max_limit)


def _parse_end_time_ms(end_time_ms: Optional[int]) -> Optional[datetime]:
    if end_time_ms in (None, "", 0):
        return None

    try:
        ms = int(end_time_ms)
    except Exception:
        raise ValueError("invalid end_time")

    if ms <= 0:
        raise ValueError("invalid end_time")

    return datetime.fromtimestamp(ms / 1000)


def _parse_end_time_ms_int(end_time_ms: Optional[int]) -> Optional[int]:
    if end_time_ms in (None, "", 0):
        return None

    try:
        ms = int(end_time_ms)
    except Exception:
        raise ValueError("invalid end_time")

    if ms <= 0:
        raise ValueError("invalid end_time")

    return ms


def _utc_naive_from_ms(ms: int) -> datetime:
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).replace(tzinfo=None)


def _datetime_to_utc_ms(value: datetime) -> int:
    dt = value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return int(dt.timestamp() * 1000)


def _add_one_utc_month(value: datetime) -> datetime:
    month = value.month + 1
    year = value.year
    if month > 12:
        month = 1
        year += 1
    return value.replace(year=year, month=month)


def _internal_utc_bucket_open_ms(value_ms: int, interval: str) -> int:
    value = datetime.fromtimestamp(int(value_ms) / 1000, tz=timezone.utc)
    if interval == "1Dutc":
        start = value.replace(hour=0, minute=0, second=0, microsecond=0)
    elif interval == "1Wutc":
        start = (value - timedelta(days=value.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    elif interval == "1Mutc":
        start = value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        raise ValueError("invalid interval")
    return int(start.timestamp() * 1000)


def _internal_utc_bucket_close_ms(open_time_ms: int, interval: str) -> int:
    if interval == "1Mutc":
        start = datetime.fromtimestamp(int(open_time_ms) / 1000, tz=timezone.utc)
        return int(_add_one_utc_month(start).timestamp() * 1000)
    return int(open_time_ms) + _INTERVAL_SECONDS[interval] * 1000


def _append_internal_utc_bucket(
    buckets: Dict[int, Dict[str, Decimal]],
    *,
    bucket_open_ms: int,
    open_price: Decimal,
    high_price: Decimal,
    low_price: Decimal,
    close_price: Decimal,
    volume: Decimal,
    quote_volume: Decimal,
) -> None:
    if volume <= 0 and quote_volume <= 0:
        return

    if bucket_open_ms not in buckets:
        buckets[bucket_open_ms] = {
            "open": open_price,
            "high": high_price,
            "low": low_price,
            "close": close_price,
            "volume": volume,
            "quote_volume": quote_volume,
        }
        return

    item = buckets[bucket_open_ms]
    item["high"] = max(item["high"], high_price)
    item["low"] = min(item["low"], low_price)
    item["close"] = close_price
    item["volume"] += volume
    item["quote_volume"] += quote_volume


def _serialize_internal_utc_buckets(
    buckets: Dict[int, Dict[str, Decimal]],
    *,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
) -> List[dict[str, Any]]:
    rows = [
        (open_time_ms, item)
        for open_time_ms, item in sorted(buckets.items(), key=lambda row: row[0])
        if end_time_ms is None or open_time_ms < end_time_ms
    ]
    rows = rows[-limit:]

    return [
        {
            "open_time": open_time_ms,
            "close_time": _internal_utc_bucket_close_ms(open_time_ms, interval),
            "open": _decimal_to_str(item["open"]),
            "high": _decimal_to_str(item["high"]),
            "low": _decimal_to_str(item["low"]),
            "close": _decimal_to_str(item["close"]),
            "volume": _decimal_to_str(item["volume"]),
            "quote_volume": _decimal_to_str(item["quote_volume"]),
        }
        for open_time_ms, item in rows
    ]


def _aggregate_internal_utc_market_kline_rows(
    rows: List[MarketKline],
    *,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
) -> List[dict[str, Any]]:
    buckets: Dict[int, Dict[str, Decimal]] = {}
    for row in rows:
        try:
            source_open_time_ms = int(row.open_time)
        except Exception:
            continue
        if end_time_ms is not None and source_open_time_ms >= end_time_ms:
            continue

        volume = _to_decimal(row.volume)
        quote_volume = _to_decimal(getattr(row, "quote_volume", None))
        if volume <= 0 and quote_volume <= 0:
            continue

        bucket_open_ms = _internal_utc_bucket_open_ms(source_open_time_ms, interval)
        _append_internal_utc_bucket(
            buckets,
            bucket_open_ms=bucket_open_ms,
            open_price=_to_decimal(row.open),
            high_price=_to_decimal(row.high),
            low_price=_to_decimal(row.low),
            close_price=_to_decimal(row.close),
            volume=volume,
            quote_volume=quote_volume,
        )

    return _serialize_internal_utc_buckets(
        buckets,
        interval=interval,
        limit=limit,
        end_time_ms=end_time_ms,
    )


def _aggregate_internal_utc_trade_rows(
    rows: List[Trade],
    *,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
) -> List[dict[str, Any]]:
    buckets: Dict[int, Dict[str, Decimal]] = {}
    for row in rows:
        created_at = getattr(row, "created_at", None)
        if created_at is None:
            continue
        trade_time_ms = _datetime_to_utc_ms(created_at)
        if end_time_ms is not None and trade_time_ms >= end_time_ms:
            continue

        price = _to_decimal(row.price)
        amount = _to_decimal(row.amount)
        if price <= 0 or amount <= 0:
            continue
        quote_amount = (
            _to_decimal(row.quote_amount)
            if getattr(row, "quote_amount", None) is not None
            else price * amount
        )

        bucket_open_ms = _internal_utc_bucket_open_ms(trade_time_ms, interval)
        _append_internal_utc_bucket(
            buckets,
            bucket_open_ms=bucket_open_ms,
            open_price=price,
            high_price=price,
            low_price=price,
            close_price=price,
            volume=amount,
            quote_volume=quote_amount,
        )

    return _serialize_internal_utc_buckets(
        buckets,
        interval=interval,
        limit=limit,
        end_time_ms=end_time_ms,
    )


def _get_internal_utc_klines_from_market_klines(
    db: Session,
    pair: TradingPair,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
) -> List[dict[str, Any]]:
    source_limit = min(
        max(limit * 500, 1000),
        _INTERNAL_SPOT_KLINE_AGGREGATE_SOURCE_ROW_LIMIT,
    )

    for source_interval in _INTERNAL_SPOT_KLINE_AGGREGATE_SOURCE_INTERVALS:
        query = db.query(MarketKline).filter(
            MarketKline.market_type == "spot",
            MarketKline.symbol == pair.symbol,
            MarketKline.interval == source_interval,
            MarketKline.source.in_(_INTERNAL_SPOT_KLINE_AGGREGATE_SOURCES),
        )
        if end_time_ms is not None:
            query = query.filter(MarketKline.open_time < end_time_ms)

        rows = (
            query.order_by(MarketKline.open_time.desc())
            .limit(source_limit)
            .all()
        )
        if not rows:
            continue

        items = _aggregate_internal_utc_market_kline_rows(
            list(reversed(rows)),
            interval=interval,
            limit=limit,
            end_time_ms=end_time_ms,
        )
        if items:
            return items

    return []


def _get_internal_utc_klines_from_trades(
    db: Session,
    pair: TradingPair,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
) -> List[dict[str, Any]]:
    query = db.query(Trade).filter(Trade.trading_pair_id == pair.id)
    if end_time_ms is not None:
        query = query.filter(Trade.created_at < _utc_naive_from_ms(end_time_ms))

    rows = query.order_by(Trade.created_at.asc(), Trade.id.asc()).all()
    if not rows:
        return []

    return _aggregate_internal_utc_trade_rows(
        rows,
        interval=interval,
        limit=limit,
        end_time_ms=end_time_ms,
    )


def _resolve_earliest_internal_kline_boundary_ms(
    db: Session,
    pair: TradingPair,
    interval: str,
) -> Optional[int]:
    if interval not in _INTERNAL_SPOT_KLINE_UTC_AGGREGATE_INTERVALS:
        return None

    candidates: list[int] = []
    trade_row = (
        db.query(Trade)
        .filter(
            Trade.trading_pair_id == pair.id,
            Trade.price > 0,
            Trade.amount > 0,
        )
        .order_by(Trade.created_at.asc(), Trade.id.asc())
        .first()
    )
    if trade_row is not None:
        created_at = getattr(trade_row, "created_at", None)
        if created_at is not None:
            candidates.append(_datetime_to_utc_ms(created_at))

    eligible_market_kline_intervals = tuple(
        dict.fromkeys((*_INTERNAL_SPOT_KLINE_AGGREGATE_SOURCE_INTERVALS, interval))
    )
    market_kline_row = (
        db.query(MarketKline)
        .filter(
            MarketKline.market_type == "spot",
            MarketKline.symbol == pair.symbol,
            MarketKline.interval.in_(eligible_market_kline_intervals),
            MarketKline.source.in_(_INTERNAL_SPOT_KLINE_AGGREGATE_SOURCES),
            or_(MarketKline.volume > 0, MarketKline.quote_volume > 0),
        )
        .order_by(MarketKline.open_time.asc())
        .first()
    )
    if market_kline_row is not None:
        try:
            open_time_ms = int(getattr(market_kline_row, "open_time", 0) or 0)
        except (TypeError, ValueError):
            open_time_ms = 0
        volume = _to_decimal(getattr(market_kline_row, "volume", None))
        quote_volume = _to_decimal(getattr(market_kline_row, "quote_volume", None))
        if open_time_ms > 0 and (volume > 0 or quote_volume > 0):
            candidates.append(open_time_ms)

    if not candidates:
        return None
    return min(_internal_utc_bucket_open_ms(value, interval) for value in candidates)


def _get_internal_utc_aggregate_klines(
    db: Session,
    pair: TradingPair,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
) -> dict[str, Any]:
    parsed_end_time_ms = _parse_end_time_ms_int(end_time_ms)
    market_kline_items = _get_internal_utc_klines_from_market_klines(
        db=db,
        pair=pair,
        interval=interval,
        limit=limit,
        end_time_ms=parsed_end_time_ms,
    )
    if len(market_kline_items) >= limit:
        return {"symbol": pair.symbol, "interval": interval, "items": market_kline_items}

    trade_items = _get_internal_utc_klines_from_trades(
        db=db,
        pair=pair,
        interval=interval,
        limit=limit,
        end_time_ms=parsed_end_time_ms,
    )
    if len(trade_items) > len(market_kline_items):
        return {"symbol": pair.symbol, "interval": interval, "items": trade_items}

    return {"symbol": pair.symbol, "interval": interval, "items": market_kline_items}


def _itick_number(value: Any) -> str:
    if value in (None, ""):
        return "0"
    return str(value)


def _get_itick_klines(pair: TradingPair, interval: str, limit: int = 200):
    k_type = ITICK_KLINE_TYPES.get(interval)
    if not k_type:
        raise ValueError("invalid interval")

    payload = _get_itick_kline_payload(pair, k_type=k_type, limit=limit)
    rows = payload.get("data") if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        rows = []
    logger.debug(
        "stock itick kline parsed symbol=%s interval=%s kType=%s limit=%s rows=%s",
        pair.symbol,
        interval,
        k_type,
        limit,
        len(rows),
    )

    step_ms = _INTERVAL_SECONDS[interval] * 1000
    items = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        open_time = int(row.get("t") or 0)
        if open_time <= 0:
            continue
        volume = _itick_number(row.get("v"))
        quote_volume = _itick_number(row.get("tu") or row.get("qv") or "0")
        items.append(
            {
                "open_time": open_time,
                "close_time": open_time + step_ms,
                "open": _itick_number(row.get("o")),
                "high": _itick_number(row.get("h")),
                "low": _itick_number(row.get("l")),
                "close": _itick_number(row.get("c")),
                "volume": volume,
                "quote_volume": quote_volume,
            }
        )

    return {
        "symbol": pair.symbol,
        "interval": interval,
        "items": items,
    }


def _build_itick_fallback_klines(pair: TradingPair, interval: str, limit: int = 200):
    kline_limit = max(1, min(int(limit or 60), 1000))
    step = _INTERVAL_SECONDS[interval]
    now = datetime.utcnow()
    end_bucket = _floor_ts(now, step)
    ref_price = _itick_ref_price(pair, allow_upstream=False)
    tick = _price_quant(pair)
    items = []

    for idx in range(kline_limit):
        reverse_index = kline_limit - idx
        bucket = end_bucket - timedelta(seconds=step * reverse_index)
        base_wave = (_stable_unit(pair.symbol, f"kline:{interval}:{idx}", 10000) - Decimal("0.5"))
        close_shift = base_wave / Decimal("500")
        open_shift = (_stable_unit(pair.symbol, f"kline-open:{interval}:{idx}", 10000) - Decimal("0.5")) / Decimal("700")

        close_price = _round_price(pair, max(ref_price * (Decimal("1") + close_shift), tick))
        open_price = _round_price(pair, max(ref_price * (Decimal("1") + open_shift), tick))
        high_price = _round_price(
            pair,
            max(open_price, close_price) * (Decimal("1") + Decimal("0.0008")),
        )
        low_price = _round_price(
            pair,
            max(min(open_price, close_price) * (Decimal("1") - Decimal("0.0008")), tick),
        )
        volume = _round_amount(
            pair,
            Decimal("10") + _stable_unit(pair.symbol, f"kline-volume:{interval}:{idx}", 10000) * Decimal("100"),
        )
        quote_volume = _round_price(pair, volume * close_price)
        open_ts = int(bucket.timestamp() * 1000)

        items.append(
            {
                "open_time": open_ts,
                "close_time": open_ts + step * 1000,
                "open": _decimal_to_str(open_price),
                "high": _decimal_to_str(max(high_price, open_price, close_price)),
                "low": _decimal_to_str(min(low_price, open_price, close_price)),
                "close": _decimal_to_str(close_price),
                "volume": _decimal_to_str(volume),
                "quote_volume": _decimal_to_str(quote_volume),
            }
        )

    return {"symbol": pair.symbol, "interval": interval, "items": items}


def _get_internal_klines(
    db: Session,
    pair: TradingPair,
    interval: str,
    limit: int,
    end_time_ms: Optional[int],
):
    step = _INTERVAL_SECONDS[interval]
    end_time = _parse_end_time_ms(end_time_ms)

    rows = (
        db.query(Trade)
        .filter(Trade.trading_pair_id == pair.id)
        .order_by(Trade.created_at.asc(), Trade.id.asc())
        .all()
    )

    if not rows:
        return {"symbol": pair.symbol, "interval": interval, "items": []}

    buckets: Dict[datetime, Dict[str, Decimal]] = {}

    for row in rows:
        price = Decimal(str(row.price))
        amount = Decimal(str(row.amount))
        quote_amount = (
            Decimal(str(row.quote_amount))
            if getattr(row, "quote_amount", None) is not None
            else price * amount
        )

        bucket = _floor_ts(row.created_at, step)

        if bucket not in buckets:
            buckets[bucket] = {
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": amount,
                "quote_volume": quote_amount,
            }
        else:
            item = buckets[bucket]
            item["high"] = max(item["high"], price)
            item["low"] = min(item["low"], price)
            item["close"] = price
            item["volume"] += amount
            item["quote_volume"] += quote_amount

    real_items: List[Tuple[datetime, Dict[str, Decimal]]] = sorted(buckets.items(), key=lambda x: x[0])

    filled: List[Tuple[datetime, Dict[str, Decimal]]] = []
    prev_bucket: Optional[datetime] = None
    prev_close: Optional[Decimal] = None

    for bucket, item in real_items:
        if prev_bucket is None:
            filled.append((bucket, item))
            prev_bucket = bucket
            prev_close = item["close"]
            continue

        next_expected = prev_bucket + timedelta(seconds=step)
        while next_expected < bucket:
            empty_item = {
                "open": prev_close,
                "high": prev_close,
                "low": prev_close,
                "close": prev_close,
                "volume": Decimal("0"),
                "quote_volume": Decimal("0"),
            }
            filled.append((next_expected, empty_item))
            prev_bucket = next_expected
            prev_close = empty_item["close"]
            next_expected = prev_bucket + timedelta(seconds=step)

        filled.append((bucket, item))
        prev_bucket = bucket
        prev_close = item["close"]

    if end_time is not None:
        end_bucket = _floor_ts(end_time, step)
        filled = [(bucket, item) for bucket, item in filled if bucket < end_bucket]

    filled = filled[-limit:]

    result = []
    for bucket, item in filled:
        open_ts = int(bucket.timestamp() * 1000)
        close_ts = int((bucket + timedelta(seconds=step)).timestamp() * 1000)

        result.append(
            {
                "open_time": open_ts,
                "close_time": close_ts,
                "open": _decimal_to_str(item["open"]),
                "high": _decimal_to_str(item["high"]),
                "low": _decimal_to_str(item["low"]),
                "close": _decimal_to_str(item["close"]),
                "volume": _decimal_to_str(item["volume"]),
                "quote_volume": _decimal_to_str(item["quote_volume"]),
            }
        )

    return {"symbol": pair.symbol, "interval": interval, "items": result}


def get_klines(
    db: Session,
    symbol: str,
    interval: str,
    limit: int = 200,
    end_time_ms: Optional[int] = None,
    force_rest: bool = False,
):
    symbol = symbol.upper().strip()
    interval = normalize_spot_kline_bucket_interval(interval)
    limit = _normalize_limit(limit)

    if interval not in _INTERVAL_SECONDS:
        raise ValueError("invalid interval")

    pair = _get_active_pair(db, symbol)
    data_source = _normalize_data_source(pair)

    if data_source == DATA_SOURCE_BINANCE:
        live_ws_klines: Optional[dict[str, Any]] = None
        primary_provider_code: Optional[str] = None
        try:
            providers = _enabled_spot_market_providers_for_pair(db, pair)
            primary_provider = providers[0] if providers else None
            primary_provider_code = str(primary_provider.provider_code) if primary_provider is not None else None
            if end_time_ms is None and not force_rest:
                if primary_provider is not None and spot_provider_ws_supports_provider(primary_provider.provider_code, domain="kline"):
                    live_ws_klines = get_spot_provider_ws_klines(
                        pair.symbol,
                        interval,
                        provider=primary_provider.provider_code,
                        limit=limit,
                    )
        except Exception as exc:
            logger.debug(
                "spot_provider_ws_kline_unavailable symbol=%s interval=%s reason=%s",
                pair.symbol,
                interval,
                exc,
            )

        cache_open_time_validator = _spot_external_kline_cache_open_time_validator(
            primary_provider_code,
            interval,
        )
        rest_request_watermark: dict[str, KlineRestWatermark] = {}
        rest_fetch_metadata: dict[str, Any] = {}
        accepted_rest_items: list[dict[str, Any]] = []

        def _capture_rest_request_watermark(provider_code: str) -> None:
            rest_request_watermark["value"] = _capture_spot_kline_rest_watermark(
                symbol=pair.symbol,
                interval=interval,
                provider=provider_code,
            )

        def _fetch_external_spot(fetch_limit: int, fetch_end_time_ms: Optional[int]):
            return _fetch_external_spot_klines(
                db,
                pair,
                interval=interval,
                limit=fetch_limit,
                end_time_ms=fetch_end_time_ms,
                fast=False,
                before_provider_fetch=_capture_rest_request_watermark,
                fetch_metadata=rest_fetch_metadata,
                update_last_good=False,
            )

        def _reconcile_external_spot_items(
            external_items: list[dict[str, Any]],
        ) -> list[dict[str, Any]]:
            accepted_rest_items.clear()
            provider_code = str(rest_fetch_metadata.get("provider") or "").strip().upper()
            request_watermark = rest_request_watermark.get("value")
            if request_watermark is None or not provider_code:
                return []
            current_watermark = _capture_spot_kline_rest_watermark(
                symbol=pair.symbol,
                interval=interval,
                provider=provider_code,
            )
            for item in external_items:
                incoming = _spot_kline_candidate_from_item(
                    symbol=pair.symbol,
                    interval=interval,
                    item=item,
                    provider=provider_code,
                    source="REST_SNAPSHOT",
                    transport="REST",
                    revision_epoch=request_watermark.revision_epoch,
                    revision_seq=0,
                )
                comparison = reconcile_rest_kline_candidate(
                    request_watermark,
                    current_watermark,
                    incoming,
                )
                if comparison.decision == KlineRevisionDecision.ACCEPT:
                    accepted_rest_items.append(dict(item))
            return list(accepted_rest_items)

        cache_result = _coerce_kline_cache_result(
            get_klines_cache_first(
                db,
                market_type="spot",
                symbol=pair.symbol,
                interval=interval,
                limit=limit,
                end_time_ms=end_time_ms,
                source="EXTERNAL_SPOT",
                fetch_external=_fetch_external_spot,
                external_budget_seconds=6.0,
                open_time_validator=cache_open_time_validator,
                reconcile_external_items=_reconcile_external_spot_items,
            ),
            end_time_ms=end_time_ms,
        )
        if accepted_rest_items and not bool(rest_fetch_metadata.get("from_last_good")):
            accepted_provider = str(rest_fetch_metadata.get("provider") or primary_provider_code or "EXTERNAL_SPOT")
            _SPOT_LAST_GOOD_KLINES[(pair.symbol, interval)] = {
                "items": [
                    {
                        key: value
                        for key, value in item.items()
                        if not str(key).startswith("_")
                    }
                    for item in accepted_rest_items
                ],
                "provider": accepted_provider,
                "updated_at": datetime.utcnow().isoformat(),
            }
        items = cache_result.items
        result_metadata = _spot_kline_result_metadata(
            cache_result,
            end_time_ms=end_time_ms,
        )
        cached_meta = _SPOT_LAST_GOOD_KLINES.get((pair.symbol, interval), {})
        live_ws_items = list(live_ws_klines.get("items") or []) if live_ws_klines else []
        if cache_open_time_validator is not None:
            live_ws_items = [
                item
                for item in live_ws_items
                if _kline_item_matches_open_time_validator(item, cache_open_time_validator)
            ]
        has_live_ws_overlay = bool(items and live_ws_items)
        if has_live_ws_overlay:
            items = _merge_spot_live_ws_klines(
                history_items=items,
                live_items=live_ws_items,
                limit=limit,
                end_time_ms=end_time_ms,
                open_time_validator=cache_open_time_validator,
            )
        if has_live_ws_overlay:
            provider = str(live_ws_klines.get("provider") or cached_meta.get("provider") or "EXTERNAL_SPOT")
            source = str(live_ws_klines.get("source") or "LIVE_WS")
            freshness = str(live_ws_klines.get("freshness") or "LIVE")
            stale = False
            updated_at = live_ws_klines.get("updated_at") or cached_meta.get("updated_at")
        else:
            provider = str(cached_meta.get("provider") or primary_provider_code or "EXTERNAL_SPOT")
            if provider == "LAST_GOOD":
                source = "LAST_GOOD"
                freshness = "LAST_GOOD"
                stale = True
            else:
                source = str(result_metadata["source"])
                freshness = str(result_metadata["freshness"])
                stale = bool(result_metadata["stale"])
            updated_at = cached_meta.get("updated_at")
        response = {
            "symbol": pair.symbol,
            "interval": interval,
            "items": items,
            "provider": provider,
            "stale": stale,
            "updated_at": updated_at,
            "source": source,
            "freshness": freshness,
            "cache_status": result_metadata.get("cache_status"),
            "history_incomplete": result_metadata.get("history_incomplete"),
            "history_terminal": result_metadata.get("history_terminal"),
            "terminal_reason": result_metadata.get("terminal_reason"),
            "earliest_available_time": result_metadata.get("earliest_available_time"),
            "provider_error_code": result_metadata.get("provider_error_code"),
            "provider_error_provider": result_metadata.get("provider_error_provider"),
        }
        _record_external_spot_kline_result(
            response,
            cache_result=cache_result,
            rest_fetch_metadata=rest_fetch_metadata,
            interval=interval,
            end_time_ms=end_time_ms,
            live_ws_klines=(live_ws_klines if has_live_ws_overlay else None),
        )
        return response

    if _is_itick_stock_pair(pair):
        logger.info(
            "stock_itick_kline_source symbol=%s interval=%s limit=%s source=itick",
            pair.symbol,
            interval,
            limit,
        )

        def _fetch_stock_itick_klines(fetch_limit: int, _fetch_end_time_ms: Optional[int]):
            payload = _get_itick_klines(pair=pair, interval=interval, limit=fetch_limit)
            return payload.get("items", [])

        cache_result = _coerce_kline_cache_result(
            get_klines_cache_first(
                db,
                market_type="spot",
                symbol=pair.symbol,
                interval=interval,
                limit=limit,
                end_time_ms=end_time_ms,
                source=DATA_SOURCE_ITICK,
                fetch_external=_fetch_stock_itick_klines,
            ),
            end_time_ms=end_time_ms,
        )
        items = cache_result.items
        result_metadata = _spot_kline_result_metadata(
            cache_result,
            end_time_ms=end_time_ms,
            rest_snapshot_source=DATA_SOURCE_ITICK,
            rest_history_source=DATA_SOURCE_ITICK,
        )
        return {
            "symbol": pair.symbol,
            "interval": interval,
            "items": items,
            "source": result_metadata["source"],
            "freshness": result_metadata["freshness"],
            "stale": result_metadata["stale"],
            "cache_status": result_metadata.get("cache_status"),
            "history_incomplete": result_metadata.get("history_incomplete"),
            "history_terminal": result_metadata.get("history_terminal"),
            "terminal_reason": result_metadata.get("terminal_reason"),
            "earliest_available_time": result_metadata.get("earliest_available_time"),
            "provider_error_code": result_metadata.get("provider_error_code"),
            "provider_error_provider": result_metadata.get("provider_error_provider"),
        }

    if data_source == DATA_SOURCE_ITICK:
        def _fetch_itick_klines(fetch_limit: int, _fetch_end_time_ms: Optional[int]):
            payload = _get_itick_klines(pair=pair, interval=interval, limit=fetch_limit)
            return payload.get("items", [])

        cache_result = _coerce_kline_cache_result(
            get_klines_cache_first(
                db,
                market_type="spot",
                symbol=pair.symbol,
                interval=interval,
                limit=limit,
                end_time_ms=end_time_ms,
                source=DATA_SOURCE_ITICK,
                fetch_external=_fetch_itick_klines,
            ),
            end_time_ms=end_time_ms,
        )
        items = cache_result.items
        result_metadata = _spot_kline_result_metadata(
            cache_result,
            end_time_ms=end_time_ms,
            rest_snapshot_source=DATA_SOURCE_ITICK,
            rest_history_source=DATA_SOURCE_ITICK,
        )
        return {
            "symbol": pair.symbol,
            "interval": interval,
            "items": items,
            "source": result_metadata["source"],
            "freshness": result_metadata["freshness"],
            "stale": result_metadata["stale"],
            "cache_status": result_metadata.get("cache_status"),
            "history_incomplete": result_metadata.get("history_incomplete"),
            "history_terminal": result_metadata.get("history_terminal"),
            "terminal_reason": result_metadata.get("terminal_reason"),
            "earliest_available_time": result_metadata.get("earliest_available_time"),
            "provider_error_code": result_metadata.get("provider_error_code"),
            "provider_error_provider": result_metadata.get("provider_error_provider"),
        }

    if interval not in _INTERNAL_SPOT_KLINE_SUPPORTED_INTERVALS:
        return {
            "symbol": pair.symbol,
            "interval": interval,
            "items": [],
            "source": "INTERNAL",
            "freshness": "MISSING",
            "history_terminal": False if end_time_ms is not None else None,
            "terminal_reason": None,
            "earliest_available_time": None,
        }

    def _fetch_internal_spot_klines(fetch_limit: int, fetch_end_time_ms: Optional[int]):
        if interval in _INTERNAL_SPOT_KLINE_UTC_AGGREGATE_INTERVALS:
            payload = _get_internal_utc_aggregate_klines(
                db=db,
                pair=pair,
                interval=interval,
                limit=fetch_limit,
                end_time_ms=fetch_end_time_ms,
            )
        else:
            payload = _get_internal_klines(
                db=db,
                pair=pair,
                interval=interval,
                limit=fetch_limit,
                end_time_ms=fetch_end_time_ms,
            )
        return payload.get("items", [])

    internal_boundary_result: Optional[KlineCacheResult] = None
    parsed_end_time_ms = _parse_end_time_ms_int(end_time_ms)
    if parsed_end_time_ms is not None and interval in _INTERNAL_SPOT_KLINE_UTC_AGGREGATE_INTERVALS:
        internal_boundary_result = get_cached_internal_kline_history_boundary_result(
            market_type="spot",
            symbol=pair.symbol,
            interval=interval,
            end_time_ms=parsed_end_time_ms,
        )
        if internal_boundary_result is None:
            earliest_available_time = _resolve_earliest_internal_kline_boundary_ms(db, pair, interval)
            if earliest_available_time is not None:
                internal_boundary_result = remember_internal_kline_history_boundary(
                    market_type="spot",
                    symbol=pair.symbol,
                    interval=interval,
                    earliest_available_time=earliest_available_time,
                    end_time_ms=parsed_end_time_ms,
                )

    cache_result = _coerce_kline_cache_result(
        internal_boundary_result
        if internal_boundary_result is not None
        else get_klines_cache_first(
            db,
            market_type="spot",
            symbol=pair.symbol,
            interval=interval,
            limit=limit,
            end_time_ms=end_time_ms,
            source=SPOT_KLINE_SOURCE_INTERNAL_TRADE,
            fetch_external=_fetch_internal_spot_klines,
            history_boundary_scope=KLINE_HISTORY_BOUNDARY_SCOPE_INTERNAL,
        ),
        end_time_ms=end_time_ms,
    )
    items = cache_result.items
    result_metadata = _spot_kline_result_metadata(
        cache_result,
        end_time_ms=end_time_ms,
        rest_snapshot_source="INTERNAL",
        rest_history_source="INTERNAL",
    )
    return {
        "symbol": pair.symbol,
        "interval": interval,
        "items": items,
        "source": result_metadata["source"],
        "freshness": result_metadata["freshness"],
        "stale": result_metadata["stale"],
        "cache_status": result_metadata.get("cache_status"),
        "history_incomplete": result_metadata.get("history_incomplete"),
        "history_terminal": result_metadata.get("history_terminal"),
        "terminal_reason": result_metadata.get("terminal_reason"),
        "earliest_available_time": result_metadata.get("earliest_available_time"),
        "provider_error_code": result_metadata.get("provider_error_code"),
        "provider_error_provider": result_metadata.get("provider_error_provider"),
    }


def get_market_depth(db: Session, symbol: str, limit: int = 20):
    return get_depth(db=db, symbol=symbol, limit=limit)


def get_market_trades(db: Session, symbol: str, limit: int = 30):
    return get_trades(db=db, symbol=symbol, limit=limit)
