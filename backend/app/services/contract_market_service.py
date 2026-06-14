from __future__ import annotations

import logging
import hashlib
import math
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

import requests
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models.contract_market_quote import ContractMarketQuote
from app.db.models.contract_symbol import ContractSymbol
from app.services.binance_market_service import BinanceMarketServiceError, binance_market_service
from app.services.itick_holiday_service import (
    MARKET_STATUS_CLOSED,
    ItickMarketStatus,
    itick_holiday_service,
)
from app.services.itick_market_service import ItickMarketServiceError, itick_market_service
from app.services.market_kline_cache import get_klines_cache_first, upsert_klines


logger = logging.getLogger(__name__)

CONTRACT_MARKET_SESSION_POLICY_VERSION = "v1"
CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION = "ld"
CONTRACT_MARKET_STATUS_VERSION = "v2.1"

QUOTE_FRESHNESS_LIVE = "LIVE"
QUOTE_FRESHNESS_STALE = "STALE"
QUOTE_FRESHNESS_LAST_VALID = "LAST_VALID"
QUOTE_FRESHNESS_FALLBACK = "FALLBACK"
QUOTE_FRESHNESS_LIVE_SECONDS = 30
QUOTE_FRESHNESS_LAST_VALID_SECONDS = 300

_binance_usdm_session = requests.Session()
_binance_usdm_session.trust_env = bool(getattr(settings, "BINANCE_USDM_USE_ENV_PROXY", False))
_last_valid_depth_cache: dict[str, dict[str, Any]] = {}
_tradfi_quote_cache: dict[str, dict[str, Any]] = {}
_tradfi_kline_cache: dict[str, dict[str, Any]] = {}
_closed_market_depth_cache: dict[str, dict[str, Any]] = {}
_closed_market_quote_cache: dict[str, dict[str, Any]] = {}
_contract_symbol_optional_columns: Optional[set[str]] = None
_binance_usdm_failure_until: dict[str, datetime] = {}
_binance_usdm_failure_cooldown = timedelta(seconds=5)
_contract_market_warning_last_at: dict[tuple[str, str, str, str], float] = {}
_contract_market_warning_cooldown_seconds = 300
_contract_market_symbol_warning_events = {
    "stock_contract_quote_unavailable",
    "tradfi_cfd_quote_unavailable",
}
_contract_market_symbol_warning_cooldown_seconds = 60
_tradfi_quote_cache_ttl = timedelta(seconds=60)
_tradfi_forex_quote_cache_ttl = timedelta(seconds=2)
_tradfi_kline_cache_ttl = timedelta(seconds=45)
_itick_ticker_24h_fields = (
    "price_change_24h",
    "high_24h",
    "low_24h",
    "base_volume_24h",
    "quote_volume_24h",
)
_stock_contract_ticker_request_limit = 20
_stock_contract_region = "US"
_stock_contract_quote_asset = "USDT"
_tradfi_cfd_categories = {"INDEX", "FOREX", "METAL", "COMMODITY"}
_holiday_contract_categories = {"STOCK", "INDEX"}
_contract_24x5_categories = {"FOREX", "METAL", "COMMODITY"}
_itick_contract_k_type = {
    "1m": 1,
    "5m": 2,
    "15m": 3,
    "30m": 4,
    "1h": 5,
    "1d": 8,
    "1w": 9,
    "1M": 10,
}
_contract_interval_seconds = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
    "1d": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
    "1M": 30 * 24 * 60 * 60,
}
_tradfi_reference_prices = {
    "DJI": Decimal("39000"),
    "US30": Decimal("39000"),
    "SPX": Decimal("5200"),
    "US500": Decimal("5200"),
    "NAS100": Decimal("18000"),
    "XAU": Decimal("2400"),
    "XAUUSD": Decimal("2400"),
    "GOLD": Decimal("2400"),
    "XAG": Decimal("30"),
    "XAGUSD": Decimal("30"),
    "SILVER": Decimal("30"),
    "OIL": Decimal("75"),
    "WTI": Decimal("75"),
    "USOIL": Decimal("75"),
    "BRENT": Decimal("80"),
    "XBRUSD": Decimal("80"),
    "EURUSD": Decimal("1.08"),
    "GBPUSD": Decimal("1.27"),
    "USDJPY": Decimal("155"),
}
_known_crypto_contract_bases = {
    "BTC",
    "ETH",
    "BNB",
    "SOL",
    "XRP",
    "DOGE",
    "ADA",
    "AVAX",
    "MATIC",
    "DOT",
    "TRX",
    "LTC",
    "BCH",
    "LINK",
    "UNI",
}


def _warning_key_part(value: Any, *, limit: int = 160) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _log_contract_market_warning(
    *,
    log_context: str,
    event: str,
    symbol: Any,
    reason: Any,
    message: str,
    args: tuple[Any, ...],
) -> None:
    normalized_context = _warning_key_part(log_context or "contract_quote", limit=80)
    normalized_event = _warning_key_part(event, limit=80)
    normalized_symbol = _warning_key_part(symbol)
    if normalized_event in _contract_market_symbol_warning_events:
        key = ("", normalized_event, normalized_symbol, "")
        cooldown_seconds = _contract_market_symbol_warning_cooldown_seconds
    else:
        key = (normalized_context, normalized_event, normalized_symbol, _warning_key_part(reason))
        cooldown_seconds = _contract_market_warning_cooldown_seconds
    now = time.monotonic()
    last_at = _contract_market_warning_last_at.get(key)
    if last_at is None or now - last_at >= cooldown_seconds:
        _contract_market_warning_last_at[key] = now
        logger.warning(message, *args)
        return
    logger.debug(message, *args)


class ContractMarketError(RuntimeError):
    code = "CONTRACT_MARKET_ERROR"


class ContractSymbolNotFound(ContractMarketError):
    code = "CONTRACT_SYMBOL_NOT_FOUND"


class ContractQuoteUnavailable(ContractMarketError):
    code = "CONTRACT_QUOTE_UNAVAILABLE"


class ItickQuoteUnavailable(ContractQuoteUnavailable):
    code = "ITICK_QUOTE_UNAVAILABLE"


def _normalize_symbol(symbol: str) -> str:
    normalized = str(symbol or "").strip().upper()
    if not normalized:
        raise ContractQuoteUnavailable("symbol is required")
    return normalized


def _stock_contract_underlying(symbol: str) -> Optional[str]:
    normalized = _normalize_symbol(symbol)
    if not normalized.endswith("_PERP"):
        return None
    market_symbol = normalized[:-5]
    if not market_symbol.endswith(_stock_contract_quote_asset):
        return None
    underlying = market_symbol[: -len(_stock_contract_quote_asset)]
    if not underlying or underlying in _known_crypto_contract_bases:
        return None
    return underlying


def _is_stock_contract_symbol(symbol: str) -> bool:
    return _stock_contract_underlying(symbol) is not None


def _normalize_contract_category(value: Any) -> str:
    upper = str(value or "").strip().upper()
    if upper in ("GOLD", "SILVER", "METAL"):
        return "METAL"
    if upper in ("FUTURES", "COMMODITY"):
        return "COMMODITY"
    if upper in ("INDEX", "FOREX", "STOCK", "CRYPTO"):
        return upper
    if upper in ("FX",):
        return "FOREX"
    return upper


def _contract_asset_category(contract_symbol: ContractSymbol) -> str:
    return _normalize_contract_category(getattr(contract_symbol, "category", None))


def _is_tradfi_cfd_contract(contract_symbol: ContractSymbol) -> bool:
    return _contract_asset_category(contract_symbol) in _tradfi_cfd_categories


def _is_stock_contract_config(contract_symbol: ContractSymbol) -> bool:
    return _contract_asset_category(contract_symbol) == "STOCK"


def attach_contract_symbol_market_metadata(db: Session, items: ContractSymbol | List[ContractSymbol]) -> None:
    rows = items if isinstance(items, list) else [items]
    if not rows:
        return
    columns = _get_contract_symbol_optional_columns(db)
    selected_columns = [name for name in ("external_region", "region") if name in columns]
    if not selected_columns:
        return

    ids = [int(item.id) for item in rows if getattr(item, "id", None) is not None]
    if not ids:
        return
    id_list = ",".join(str(item_id) for item_id in ids)
    column_sql = ", ".join(["id", *selected_columns])
    try:
        result = db.execute(
            text(f"SELECT {column_sql} FROM contract_symbols WHERE id IN ({id_list})")
        ).mappings().all()
    except Exception as exc:
        logger.warning("contract_symbol_optional_market_metadata_unavailable reason=%s", exc)
        return

    value_by_id = {int(row["id"]): row for row in result}
    for item in rows:
        row = value_by_id.get(int(item.id))
        if not row:
            continue
        for column in selected_columns:
            value = str(row.get(column) or "").strip().upper()
            if value:
                setattr(item, f"_{column}_override", value)


def contract_symbol_market_status_payload(contract_symbol: ContractSymbol) -> dict[str, Optional[str]]:
    return _market_status_for_contract_symbol(contract_symbol).to_payload()


def _get_contract_symbol_optional_columns(db: Session) -> set[str]:
    global _contract_symbol_optional_columns
    if _contract_symbol_optional_columns is not None:
        return _contract_symbol_optional_columns
    try:
        _contract_symbol_optional_columns = {
            str(column.get("name") or "")
            for column in inspect(db.bind).get_columns("contract_symbols")
        }
    except Exception as exc:
        logger.warning("contract_symbol_optional_columns_unavailable reason=%s", exc)
        _contract_symbol_optional_columns = set()
    return _contract_symbol_optional_columns


def _market_status_for_contract_symbol(contract_symbol: ContractSymbol) -> ItickMarketStatus:
    category = _contract_asset_category(contract_symbol)
    provider = str(getattr(contract_symbol, "provider", "") or "").strip().upper()
    if provider != "ITICK":
        return itick_holiday_service.crypto_open()
    if category == "STOCK":
        return itick_holiday_service.get_us_stock_regular_status()
    if category in _contract_24x5_categories:
        return itick_holiday_service.forex_24x5_status()
    if category in _holiday_contract_categories:
        session_code = _contract_session_code(contract_symbol, category)
        if session_code:
            return itick_holiday_service.get_market_status(session_code)
    return itick_holiday_service.crypto_open()


def _market_status_for_stock_contract_symbol() -> ItickMarketStatus:
    return itick_holiday_service.get_us_stock_regular_status()


def _contract_session_code(contract_symbol: ContractSymbol, category: Optional[str] = None) -> Optional[str]:
    for attr_name in ("_external_region_override", "_region_override", "external_region", "region"):
        explicit_region = str(getattr(contract_symbol, attr_name, "") or "").strip().upper()
        if explicit_region and explicit_region not in ("FOREX", "GLOBAL"):
            return explicit_region
    normalized_category = category or _contract_asset_category(contract_symbol)
    if normalized_category == "STOCK":
        return _stock_contract_region
    if normalized_category in ("INDEX", "METAL", "COMMODITY"):
        return _fallback_session_code_for_contract(contract_symbol, normalized_category)
    return None


def _fallback_session_code_for_contract(contract_symbol: ContractSymbol, category: str) -> str:
    provider_symbol = _contract_provider_symbol(contract_symbol)
    if category == "INDEX":
        if provider_symbol in {"HSI", "HK50", "HKG33", "HKHSI"}:
            return "HK"
        if provider_symbol in {"DAX", "GER40", "DE40", "DAX40"}:
            return "DE"
        if provider_symbol in {"N225", "NI225", "JP225", "NKY"}:
            return "JP"
        if provider_symbol in {"STI", "SG30"}:
            return "SG"
        if provider_symbol in {"ASX200", "AUS200"}:
            return "AU"
        if provider_symbol in {"FTSE", "UK100"}:
            return "GB"
        if provider_symbol in {"SSE", "CSI300", "CN50"}:
            return "CN"
        if provider_symbol in {"DJ", "DJI", "US30", "SPX", "SPX500", "US500", "NAS100", "NDX"}:
            return "US"
        return "US"
    if category == "METAL":
        if provider_symbol.startswith(("XAU", "XAG", "GOLD", "SILVER")):
            return "GB"
        return "GB"
    if category == "COMMODITY":
        if provider_symbol.startswith(("BRENT", "XBR", "UKOIL")):
            return "GB"
        if provider_symbol.startswith(("OIL", "WTI", "USOIL")):
            return "GB"
        return "GB"
    return "GB"


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
            numeric_value = float(text_value)
            return _normalize_quote_ts(numeric_value)
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


def _itick_quote_timestamp(data: Dict[str, Any]) -> datetime:
    return _normalize_quote_ts(_pick_first_present(data, ["t", "timestamp", "time", "ts"])) or datetime.utcnow()


def _quote_freshness_for_payload(payload: dict[str, Any]) -> str:
    source = str(payload.get("source") or "").strip().upper()
    if "FALLBACK" in source:
        return QUOTE_FRESHNESS_FALLBACK
    if "LAST_VALID" in source:
        return QUOTE_FRESHNESS_LAST_VALID

    ts = _normalize_quote_ts(payload.get("ts"))
    if ts is None:
        return QUOTE_FRESHNESS_FALLBACK

    age_seconds = (datetime.utcnow() - ts).total_seconds()
    if age_seconds <= QUOTE_FRESHNESS_LIVE_SECONDS:
        return QUOTE_FRESHNESS_LIVE
    if age_seconds <= QUOTE_FRESHNESS_LAST_VALID_SECONDS:
        return QUOTE_FRESHNESS_STALE
    return QUOTE_FRESHNESS_LAST_VALID


def _with_market_status(payload: dict[str, Any], status: ItickMarketStatus) -> dict[str, Any]:
    payload.update(status.to_payload())
    payload["quote_freshness"] = _quote_freshness_for_payload(payload)
    return payload


def _is_market_closed(status: ItickMarketStatus) -> bool:
    return status.market_status == MARKET_STATUS_CLOSED


def _copy_depth_payload(depth: dict[str, Any], *, limit: Optional[int] = None) -> dict[str, Any]:
    copied = dict(depth)
    copied["bids"] = _copy_depth_levels(depth.get("bids") or [], limit)
    copied["asks"] = _copy_depth_levels(depth.get("asks") or [], limit)
    copied["best_bid"] = _best_depth_price(copied["bids"], side="bid")
    copied["best_ask"] = _best_depth_price(copied["asks"], side="ask")
    return copied


def _get_closed_depth(symbol: str, *, limit: Optional[int] = None) -> Optional[dict[str, Any]]:
    cached = _closed_market_depth_cache.get(_normalize_symbol(symbol))
    if cached is None:
        return None
    return _copy_depth_payload(cached, limit=limit)


def _set_closed_depth(depth: dict[str, Any]) -> dict[str, Any]:
    symbol = _normalize_symbol(str(depth.get("symbol") or ""))
    frozen = _copy_depth_payload(depth)
    frozen["source"] = str(frozen.get("source") or "PLATFORM_BBO")
    _closed_market_depth_cache[symbol] = frozen
    return _copy_depth_payload(frozen)


def _freeze_depth_if_closed(
    depth: dict[str, Any],
    status: ItickMarketStatus,
    *,
    limit: Optional[int] = None,
) -> dict[str, Any]:
    if not _is_market_closed(status):
        return depth
    cached = _get_closed_depth(str(depth.get("symbol") or ""), limit=limit)
    if cached is not None:
        return cached
    last_valid = _get_cached_depth(str(depth.get("symbol") or ""), limit=limit or len(depth.get("bids") or []), source="LAST_VALID")
    if last_valid is not None:
        return _set_closed_depth(last_valid)
    return _set_closed_depth(depth)


def _copy_closed_quote(quote: dict[str, Any]) -> dict[str, Any]:
    return dict(quote)


def _get_closed_quote(symbol: str) -> Optional[dict[str, Any]]:
    cached = _closed_market_quote_cache.get(_normalize_symbol(symbol))
    return _copy_closed_quote(cached) if cached is not None else None


def _set_closed_quote(quote: dict[str, Any]) -> dict[str, Any]:
    symbol = _normalize_symbol(str(quote.get("symbol") or ""))
    frozen = _copy_closed_quote(quote)
    frozen["source"] = str(frozen.get("source") or "PLATFORM_BBO")
    _closed_market_quote_cache[symbol] = frozen
    return _copy_closed_quote(frozen)


def _freeze_quote_if_closed(quote: dict[str, Any], status: ItickMarketStatus) -> dict[str, Any]:
    if not _is_market_closed(status):
        return quote
    cached = _get_closed_quote(str(quote.get("symbol") or ""))
    if cached is not None:
        return cached
    closed_depth = _get_closed_depth(str(quote.get("symbol") or ""), limit=5)
    if closed_depth is not None:
        try:
            frozen_quote = _quote_from_depth(
                _quote_contract_stub(quote),
                closed_depth,
                source=str(closed_depth.get("source") or "PLATFORM_BBO"),
            )
            frozen_quote["price_precision"] = quote.get("price_precision")
            return _set_closed_quote(frozen_quote)
        except Exception:
            pass
    return _set_closed_quote(quote)


def _quote_contract_stub(quote: dict[str, Any]) -> ContractSymbol:
    return ContractSymbol(
        symbol=str(quote.get("symbol") or ""),
        provider=str(quote.get("provider") or ""),
        provider_symbol=str(quote.get("provider_symbol") or ""),
        display_name=str(quote.get("symbol") or ""),
        category="STOCK",
        quote_asset="USDT",
    )


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _require_positive(value: Optional[Decimal], field_name: str) -> Decimal:
    if value is None or value <= Decimal("0"):
        raise ContractQuoteUnavailable(f"{field_name} is unavailable")
    return value


def _format_decimal(value: Decimal) -> str:
    return format(value, "f")


def _depth_level(price: Decimal, quantity: Decimal) -> list[Decimal]:
    return [price, quantity]


def _format_depth_levels(levels: list[list[Decimal]]) -> list[list[str]]:
    return [[_format_decimal(price), _format_decimal(quantity)] for price, quantity in levels]


def _copy_depth_levels(levels: list[list[Decimal]], limit: Optional[int] = None) -> list[list[Decimal]]:
    selected = levels[:limit] if limit is not None else levels
    return [[price, quantity] for price, quantity in selected]


def _calculate_mark_price(
    *,
    bid_price: Optional[Decimal],
    ask_price: Optional[Decimal],
    last_price: Decimal,
) -> Decimal:
    if bid_price is not None and ask_price is not None and bid_price > 0 and ask_price > 0:
        return (bid_price + ask_price) / Decimal("2")
    return last_price


def _best_depth_price(levels: Any, *, side: str) -> Optional[Decimal]:
    if not isinstance(levels, list):
        return None

    prices: list[Decimal] = []
    for level in levels:
        if not isinstance(level, list) or not level:
            continue
        price = _to_decimal(level[0])
        if price is not None and price > 0:
            prices.append(price)
    if not prices:
        return None
    return max(prices) if side == "bid" else min(prices)


def _quote_payload(
    *,
    symbol: str,
    provider: str,
    provider_symbol: str,
    bid_price: Decimal,
    ask_price: Decimal,
    last_price: Decimal,
    mark_price: Decimal,
    source: str,
    ts: datetime,
    index_price: Optional[Decimal] = None,
    funding_rate: Optional[Decimal] = None,
    next_funding_time: Optional[int] = None,
) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "provider": provider,
        "provider_symbol": provider_symbol,
        "bid_price": bid_price,
        "ask_price": ask_price,
        "last_price": last_price,
        "mark_price": mark_price,
        "index_price": index_price,
        "funding_rate": funding_rate,
        "next_funding_time": next_funding_time,
        "source": source,
        "ts": ts,
    }


def _depth_payload(
    *,
    symbol: str,
    provider: str,
    provider_symbol: str,
    bids: list[list[Decimal]],
    asks: list[list[Decimal]],
    source: str,
    ts: datetime,
) -> dict[str, Any]:
    best_bid = _best_depth_price(bids, side="bid")
    best_ask = _best_depth_price(asks, side="ask")
    return {
        "symbol": symbol,
        "provider": provider,
        "provider_symbol": provider_symbol,
        "bids": bids,
        "asks": asks,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "source": source,
        "ts": ts,
    }


def _cache_depth(depth: dict[str, Any]) -> None:
    _last_valid_depth_cache[str(depth["symbol"]).upper()] = {
        **depth,
        "bids": _copy_depth_levels(depth["bids"]),
        "asks": _copy_depth_levels(depth["asks"]),
    }


def _copy_quote_payload(quote: dict[str, Any], *, source: Optional[str] = None) -> dict[str, Any]:
    copied = dict(quote)
    if source is not None:
        copied["source"] = source
    return copied


def _cache_tradfi_quote(quote: dict[str, Any]) -> None:
    _tradfi_quote_cache[str(quote["symbol"]).upper()] = {
        "ts": datetime.utcnow(),
        "quote": _copy_quote_payload(quote),
    }


def _get_cached_tradfi_quote(
    symbol: str,
    *,
    allow_stale: bool = False,
    max_age: Optional[timedelta] = None,
) -> Optional[dict[str, Any]]:
    cached = _tradfi_quote_cache.get(_normalize_symbol(symbol))
    if cached is None:
        return None
    ts = cached.get("ts")
    quote = cached.get("quote")
    if not isinstance(ts, datetime) or not isinstance(quote, dict):
        return None
    if not allow_stale and datetime.utcnow() - ts > _tradfi_quote_cache_ttl:
        return None
    if max_age is not None and not allow_stale and datetime.utcnow() - ts > max_age:
        return None
    return _copy_quote_payload(quote, source=quote.get("source"))


def _ticker_from_quote_payload(symbol: str, quote: dict[str, Any]) -> dict[str, Any]:
    return {
        "symbol": _normalize_symbol(symbol),
        "last_price": _format_decimal(quote.get("last_price")),
        "price_change_percent_24h": quote.get("price_change_percent_24h"),
        "source": quote.get("source"),
        "ts": quote.get("ts"),
        **_ticker_24h_fields_from_quote(quote),
    }


def _ticker_from_cached_tradfi_quote(
    symbol: str,
    *,
    allow_stale: bool = False,
    required_price_field: Optional[str] = None,
    max_age: Optional[timedelta] = None,
) -> Optional[dict[str, Any]]:
    cached_quote = _get_cached_tradfi_quote(symbol, allow_stale=allow_stale, max_age=max_age)
    if cached_quote is None:
        return None
    if required_price_field and cached_quote.get("price_field") != required_price_field:
        return None
    return _ticker_from_quote_payload(symbol, cached_quote)


def _get_cached_depth(symbol: str, *, limit: int, source: str = "LAST_VALID") -> Optional[dict[str, Any]]:
    cached = _last_valid_depth_cache.get(_normalize_symbol(symbol))
    if cached is None:
        return None
    return _depth_payload(
        symbol=cached["symbol"],
        provider=cached["provider"],
        provider_symbol=cached["provider_symbol"],
        bids=_copy_depth_levels(cached["bids"], limit),
        asks=_copy_depth_levels(cached["asks"], limit),
        source=source,
        ts=cached["ts"],
    )


def _depth_from_quote_payload(quote: dict[str, Any], *, limit: int, source: str) -> dict[str, Any]:
    bid = _require_positive(_to_decimal(quote.get("bid_price")), "bid_price")
    ask = _require_positive(_to_decimal(quote.get("ask_price")), "ask_price")
    depth = _depth_payload(
        symbol=str(quote["symbol"]),
        provider=str(quote["provider"]),
        provider_symbol=str(quote["provider_symbol"]),
        bids=[_depth_level(bid, Decimal("1"))],
        asks=[_depth_level(ask, Decimal("1"))],
        source=source,
        ts=quote.get("ts") if isinstance(quote.get("ts"), datetime) else datetime.utcnow(),
    )
    depth["price_precision"] = int(quote.get("price_precision") or 8)
    return _copy_depth_payload(depth, limit=limit)


def _seed_closed_depth_from_last_good(
    db: Session,
    contract_symbol: ContractSymbol,
    *,
    limit: int,
) -> Optional[dict[str, Any]]:
    cached_depth = _get_cached_depth(contract_symbol.symbol, limit=limit, source="LAST_VALID")
    if cached_depth is not None:
        cached_depth["price_precision"] = int(getattr(contract_symbol, "price_precision", cached_depth.get("price_precision") or 8) or 8)
        return _set_closed_depth(cached_depth)

    fallback = get_last_valid_contract_quote(db, contract_symbol.symbol)
    if fallback is not None:
        fallback["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
        return _set_closed_depth(_depth_from_quote_payload(fallback, limit=limit, source="LAST_VALID"))

    if _is_tradfi_cfd_contract(contract_symbol):
        depth = _build_cfd_depth_from_price(
            contract_symbol=contract_symbol,
            reference_price=_stable_reference_price(
                _contract_provider_symbol(contract_symbol),
                _contract_asset_category(contract_symbol),
            ),
            source="CFD_FALLBACK_CLOSED",
            limit=limit,
        )
        return _set_closed_depth(depth)

    return None


def _seed_closed_quote_from_last_good(db: Session, contract_symbol: ContractSymbol) -> Optional[dict[str, Any]]:
    closed_depth = _get_closed_depth(contract_symbol.symbol, limit=5)
    if closed_depth is None:
        closed_depth = _seed_closed_depth_from_last_good(db, contract_symbol, limit=5)
    if closed_depth is None:
        return None
    quote = _quote_from_depth(
        contract_symbol,
        closed_depth,
        source=str(closed_depth.get("source") or "LAST_VALID"),
    )
    quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
    return _set_closed_quote(quote)


def _quote_from_depth(contract_symbol: ContractSymbol, depth: dict[str, Any], *, source: str) -> dict[str, Any]:
    bid_price = _require_positive(depth.get("best_bid"), "bid_price")
    ask_price = _require_positive(depth.get("best_ask"), "ask_price")
    last_price = (bid_price + ask_price) / Decimal("2")
    mark_price = _calculate_mark_price(bid_price=bid_price, ask_price=ask_price, last_price=last_price)
    return _quote_payload(
        symbol=contract_symbol.symbol,
        provider=depth["provider"],
        provider_symbol=depth["provider_symbol"],
        bid_price=bid_price,
        ask_price=ask_price,
        last_price=last_price,
        mark_price=mark_price,
        source=source,
        ts=depth["ts"],
    )


def _recent_cached_quote(contract_symbol: ContractSymbol, *, max_age_seconds: float = 2.5) -> Optional[dict[str, Any]]:
    cached = _get_cached_depth(contract_symbol.symbol, limit=5, source="LIVE")
    if cached is None:
        return None
    ts = cached.get("ts")
    if not isinstance(ts, datetime):
        return None
    age = (datetime.utcnow() - ts).total_seconds()
    if age < 0 or age > max_age_seconds:
        return None
    return _quote_from_depth(contract_symbol, cached, source="LIVE")


def _load_contract_symbol(db: Session, symbol: str) -> ContractSymbol:
    normalized_symbol = _normalize_symbol(symbol)
    item = (
        db.query(ContractSymbol)
        .filter(ContractSymbol.symbol == normalized_symbol)
        .filter(ContractSymbol.status == 1)
        .first()
    )
    if item is None:
        raise ContractSymbolNotFound("contract symbol not found or disabled")
    attach_contract_symbol_market_metadata(db, item)
    return item


def get_last_valid_contract_quote(db: Session, symbol: str) -> Optional[dict[str, Any]]:
    normalized_symbol = _normalize_symbol(symbol)
    item = db.query(ContractMarketQuote).filter(ContractMarketQuote.symbol == normalized_symbol).first()
    if item is None:
        return None

    ts = item.updated_at or item.created_at or datetime.utcnow()
    return _quote_payload(
        symbol=item.symbol,
        provider=item.provider,
        provider_symbol=item.provider_symbol,
        bid_price=Decimal(str(item.bid_price)),
        ask_price=Decimal(str(item.ask_price)),
        last_price=Decimal(str(item.last_price)),
        mark_price=Decimal(str(item.mark_price)),
        source="LAST_VALID",
        ts=ts,
    )


def save_last_valid_contract_quote(
    db: Session,
    *,
    symbol: str,
    provider: str,
    provider_symbol: str,
    bid_price: Decimal,
    ask_price: Decimal,
    last_price: Decimal,
    mark_price: Decimal,
    source: str = "LIVE",
    ts: Optional[datetime] = None,
) -> ContractMarketQuote:
    normalized_symbol = _normalize_symbol(symbol)
    now = ts or datetime.utcnow()
    item = (
        db.query(ContractMarketQuote)
        .filter(ContractMarketQuote.symbol == normalized_symbol)
        .with_for_update()
        .first()
    )
    if item is None:
        item = ContractMarketQuote(
            symbol=normalized_symbol,
            provider=provider,
            provider_symbol=provider_symbol,
            bid_price=bid_price,
            ask_price=ask_price,
            last_price=last_price,
            mark_price=mark_price,
            source=source,
            created_at=now,
            updated_at=now,
        )
        db.add(item)
    else:
        item.provider = provider
        item.provider_symbol = provider_symbol
        item.bid_price = bid_price
        item.ask_price = ask_price
        item.last_price = last_price
        item.mark_price = mark_price
        item.source = source
        item.updated_at = now

    db.flush()
    return item


def _normalize_depth_levels(levels: Any) -> list[list[Decimal]]:
    if not isinstance(levels, list):
        return []

    normalized: list[list[Decimal]] = []
    for level in levels:
        if not isinstance(level, list) or len(level) < 2:
            continue
        price = _to_decimal(level[0])
        quantity = _to_decimal(level[1])
        if price is None or quantity is None or price <= 0 or quantity < 0:
            continue
        normalized.append(_depth_level(price, quantity))
    return normalized


def _pick_first_present(data: Dict[str, Any], keys: List[str]) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return None


def _pick_positive_decimal(data: Dict[str, Any], keys: List[str]) -> Optional[Decimal]:
    for key in keys:
        value = _to_decimal(data.get(key))
        if value is not None and value > 0:
            return value
    return None


def _pick_positive_decimal_with_key(data: Dict[str, Any], keys: List[str]) -> tuple[Optional[Decimal], Optional[str]]:
    for key in keys:
        value = _to_decimal(data.get(key))
        if value is not None and value > 0:
            return value, key
    return None, None


def _pick_itick_quote_reference_price(
    data: Dict[str, Any],
    *,
    prefer_forex_latest: bool = False,
) -> tuple[Optional[Decimal], Optional[str]]:
    if prefer_forex_latest:
        return _pick_positive_decimal_with_key(data, ["ld", "last", "price", "latest_price", "close", "c", "p"])
    return _pick_positive_decimal_with_key(data, ["p", "ld", "last", "price", "latest_price", "close", "c"])


def _pick_decimal_present(data: Dict[str, Any], keys: List[str], *, positive: bool = False) -> Optional[Decimal]:
    for key in keys:
        value = data.get(key)
        if value in (None, ""):
            continue
        decimal_value = _to_decimal(value)
        if decimal_value is None:
            continue
        if positive and decimal_value <= 0:
            continue
        return decimal_value
    return None


def _format_optional_decimal(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return _format_decimal(value)


def _extract_itick_24h_ticker_fields(data: Dict[str, Any]) -> dict[str, Optional[str]]:
    base_volume_24h = _pick_decimal_present(
        data,
        ["v", "volume", "vol", "base_volume_24h", "volume_24h", "baseVolume"],
    )
    quote_volume_24h = _pick_decimal_present(
        data,
        [
            "turnover",
            "amount",
            "value",
            "tu",
            "qv",
            "quote_volume_24h",
            "quoteVolume",
            "quote_volume",
            "turnover_value",
            "trade_amount",
            "turnover_24h",
        ],
    )
    return {
        "price_change_24h": _format_optional_decimal(
            _pick_decimal_present(
                data,
                ["change", "price_change", "price_change_24h", "ch", "priceChange", "changePrice"],
            )
        ),
        "high_24h": _format_optional_decimal(
            _pick_decimal_present(data, ["h", "high", "high_price", "high_24h", "highPrice"], positive=True)
        ),
        "low_24h": _format_optional_decimal(
            _pick_decimal_present(data, ["l", "low", "low_price", "low_24h", "lowPrice"], positive=True)
        ),
        "base_volume_24h": _format_optional_decimal(base_volume_24h),
        "quote_volume_24h": _format_optional_decimal(quote_volume_24h),
    }


def _ticker_24h_fields_from_quote(quote: dict[str, Any]) -> dict[str, Any]:
    return {key: quote.get(key) for key in _itick_ticker_24h_fields}


def _has_ticker_24h_fields(item: dict[str, Any]) -> bool:
    return any(item.get(key) not in (None, "") for key in _itick_ticker_24h_fields)


def _extract_itick_data_candidates(payload: Any) -> list[Dict[str, Any]]:
    candidates: list[Dict[str, Any]] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            candidates.append(value)
            for nested_key in ("data", "tick", "quote", "depth", "result"):
                nested = value.get(nested_key)
                if isinstance(nested, dict):
                    visit(nested)
                elif isinstance(nested, list):
                    for item in nested[:3]:
                        visit(item)
            for nested_value in value.values():
                if isinstance(nested_value, dict) and nested_value not in candidates:
                    if any(key in nested_value for key in ("p", "ld", "last", "price", "bids", "asks", "bid", "ask")):
                        visit(nested_value)
        elif isinstance(value, list):
            for item in value[:3]:
                visit(item)

    visit(payload)
    return candidates


def _extract_stock_quote_item(payload: Any) -> Optional[Dict[str, Any]]:
    for item in _extract_itick_data_candidates(payload):
        if _pick_positive_decimal(item, ["p", "ld", "last", "price", "latest_price", "close", "c"]):
            return item
    return None


def _get_stock_contract_reference_price(provider_symbol: str, *, log_context: str = "contract_quote") -> Decimal:
    try:
        payload = itick_market_service.get_stock_quote(region=_stock_contract_region, code=provider_symbol, timeout=2)
    except ItickMarketServiceError as exc:
        _log_contract_market_warning(
            log_context=log_context,
            event="stock_contract_quote_unavailable",
            symbol=provider_symbol,
            reason=exc,
            message="stock_contract_quote_unavailable provider_symbol=%s reason=%s",
            args=(provider_symbol, exc),
        )
        raise ItickQuoteUnavailable("ITICK_STOCK_QUOTE_UNAVAILABLE") from exc

    data = _extract_stock_quote_item(payload)
    if data is None:
        raise ItickQuoteUnavailable("ITICK_STOCK_QUOTE_MISSING_PRICE")

    price = _pick_positive_decimal(data, ["p", "ld", "last", "price", "latest_price", "close", "c"])
    return _require_positive(price, "last_price")


def _pick_depth_side(data: Dict[str, Any], keys: List[str]) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return []


def _extract_stock_depth_sides(payload: Any) -> tuple[Any, Any]:
    for item in _extract_itick_data_candidates(payload):
        bids = _pick_depth_side(item, ["bids", "bid", "b", "buy", "buys"])
        asks = _pick_depth_side(item, ["asks", "ask", "a", "sell", "sells"])
        if bids or asks:
            return bids, asks
    return [], []


def _normalize_stock_depth_levels(levels: Any, *, side: str) -> list[list[Decimal]]:
    if not isinstance(levels, list):
        return []

    normalized: list[list[Decimal]] = []
    for item in levels:
        price_raw: Any = None
        quantity_raw: Any = None
        if isinstance(item, dict):
            if side == "bid":
                price_raw = _pick_first_present(item, ["price", "p", "bid", "bid_price", "bp"])
            else:
                price_raw = _pick_first_present(item, ["price", "p", "ask", "ask_price", "ap"])
            quantity_raw = _pick_first_present(item, ["amount", "volume", "quantity", "qty", "size", "v"])
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            price_raw, quantity_raw = item[0], item[1]

        price = _to_decimal(price_raw)
        quantity = _to_decimal(quantity_raw)
        if price is None or price <= 0:
            continue
        if quantity is None or quantity <= 0:
            quantity = Decimal("1")
        normalized.append(_depth_level(price, quantity))

    return sorted(normalized, key=lambda item: item[0], reverse=side == "bid")


def _stock_price_quant() -> Decimal:
    return Decimal("0.01")


def _price_quant(precision: int) -> Decimal:
    safe_precision = max(0, min(int(precision or 2), 8))
    return Decimal("1").scaleb(-safe_precision)


def _round_price(value: Decimal, precision: int) -> Decimal:
    return value.quantize(_price_quant(precision))


def _round_stock_price(value: Decimal) -> Decimal:
    return value.quantize(_stock_price_quant())


def _stock_depth_gap(reference_price: Decimal, best_bid: Decimal, best_ask: Decimal) -> Decimal:
    spread = best_ask - best_bid
    if spread > 0:
        return max(spread / Decimal("2"), _stock_price_quant())
    return max(reference_price * Decimal("0.00025"), _stock_price_quant())


def _extend_stock_depth_side(
    levels: list[list[Decimal]],
    *,
    side: str,
    start_price: Decimal,
    gap: Decimal,
    limit: int,
) -> list[list[Decimal]]:
    items = _copy_depth_levels(levels, limit)
    first_qty = items[0][1] if items else Decimal("10")
    index = len(items)
    while len(items) < limit:
        step = Decimal(index)
        price = start_price - (gap * step) if side == "bid" else start_price + (gap * step)
        if price <= 0:
            break
        quantity = first_qty + Decimal(index * 3)
        items.append(_depth_level(_round_stock_price(price), quantity))
        index += 1
    return items


def _build_stock_depth_from_prices(
    *,
    symbol: str,
    provider_symbol: str,
    best_bid: Decimal,
    best_ask: Decimal,
    limit: int,
    source: str,
    ts: Optional[datetime] = None,
) -> dict[str, Any]:
    last_price = (best_bid + best_ask) / Decimal("2")
    gap = _stock_depth_gap(last_price, best_bid, best_ask)
    bids = _extend_stock_depth_side(
        [_depth_level(_round_stock_price(best_bid), Decimal("10"))],
        side="bid",
        start_price=best_bid,
        gap=gap,
        limit=limit,
    )
    asks = _extend_stock_depth_side(
        [_depth_level(_round_stock_price(best_ask), Decimal("10"))],
        side="ask",
        start_price=best_ask,
        gap=gap,
        limit=limit,
    )
    depth = _depth_payload(
        symbol=symbol,
        provider="ITICK",
        provider_symbol=provider_symbol,
        bids=bids,
        asks=asks,
        source=source,
        ts=ts or datetime.utcnow(),
    )
    depth["price_precision"] = 2
    return depth


def _build_stock_depth_from_quote(
    *,
    symbol: str,
    provider_symbol: str,
    limit: int,
    log_context: str = "contract_quote",
) -> dict[str, Any]:
    price = _get_stock_contract_reference_price(provider_symbol, log_context=log_context)
    return _build_stock_depth_from_prices(
        symbol=symbol,
        provider_symbol=provider_symbol,
        best_bid=price * Decimal("0.9995"),
        best_ask=price * Decimal("1.0005"),
        limit=limit,
        source="ITICK_QUOTE_FALLBACK",
    )


def _extract_itick_stock_depth_top(payload: Any) -> tuple[Optional[Decimal], Optional[Decimal], Optional[datetime]]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None, None, None

    raw_bids = data.get("b") or data.get("bids") or data.get("bid")
    raw_asks = data.get("a") or data.get("asks") or data.get("ask")

    def pick_price(levels: Any, *, side: str) -> Optional[Decimal]:
        if isinstance(levels, dict):
            levels = [levels]
        if not isinstance(levels, list):
            return None
        prices: list[Decimal] = []
        for item in levels:
            raw_price = None
            if isinstance(item, dict):
                raw_price = item.get("p") or item.get("price")
            elif isinstance(item, (list, tuple)) and item:
                raw_price = item[0]
            price = _to_decimal(raw_price)
            if price is not None and price > 0:
                prices.append(price)
        if not prices:
            return None
        return max(prices) if side == "bid" else min(prices)

    return (
        pick_price(raw_bids, side="bid"),
        pick_price(raw_asks, side="ask"),
        _normalize_quote_ts(_pick_first_present(data, ["t", "timestamp", "time", "ts"])),
    )


def _get_stock_contract_depth(
    symbol: str,
    provider_symbol: Optional[str] = None,
    *,
    limit: int = 20,
    log_context: str = "contract_quote",
) -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    underlying = provider_symbol or _stock_contract_underlying(normalized_symbol)
    if not underlying:
        raise ContractSymbolNotFound("contract symbol not found or disabled")

    normalized_provider_symbol = str(underlying).strip().upper()
    safe_limit = max(5, min(int(limit or 20), 100))

    try:
        depth_payload = itick_market_service.get_stock_depth(
            region="US",
            code=normalized_provider_symbol,
            limit=safe_limit,
        )
        bid, ask, depth_ts = _extract_itick_stock_depth_top(depth_payload)
        if bid is not None and ask is not None and bid > 0 and ask > bid:
            return _build_stock_depth_from_prices(
                symbol=normalized_symbol,
                provider_symbol=normalized_provider_symbol,
                best_bid=bid,
                best_ask=ask,
                limit=safe_limit,
                source="ITICK_DEPTH",
                ts=depth_ts,
            )
        logger.debug(
            "itick_stock_depth_invalid symbol=%s provider_symbol=%s bid=%s ask=%s",
            normalized_symbol,
            normalized_provider_symbol,
            bid,
            ask,
        )
    except Exception as exc:
        logger.debug(
            "itick_stock_depth_unavailable symbol=%s provider_symbol=%s reason=%s",
            normalized_symbol,
            normalized_provider_symbol,
            exc,
        )

    cached_quote = _get_cached_tradfi_quote(
        normalized_symbol,
        allow_stale=itick_market_service.is_quote_depth_cooldown_active(),
    )
    if cached_quote is not None:
        bid = _to_decimal(cached_quote.get("bid_price"))
        ask = _to_decimal(cached_quote.get("ask_price"))
        if bid is not None and ask is not None and bid > 0 and ask > bid:
            return _build_stock_depth_from_prices(
                symbol=normalized_symbol,
                provider_symbol=normalized_provider_symbol,
                best_bid=bid,
                best_ask=ask,
                limit=safe_limit,
                source=str(cached_quote.get("source") or "CACHE"),
                ts=_normalize_quote_ts(cached_quote.get("ts")),
            )

    return _build_stock_depth_from_quote(
        symbol=normalized_symbol,
        provider_symbol=normalized_provider_symbol,
        limit=safe_limit,
        log_context=log_context,
    )


def _quote_from_stock_depth(symbol: str, depth: dict[str, Any], *, source: str) -> dict[str, Any]:
    bid_price = _require_positive(depth.get("best_bid"), "bid_price")
    ask_price = _require_positive(depth.get("best_ask"), "ask_price")
    last_price = (bid_price + ask_price) / Decimal("2")
    mark_price = _calculate_mark_price(bid_price=bid_price, ask_price=ask_price, last_price=last_price)
    quote = _quote_payload(
        symbol=_normalize_symbol(symbol),
        provider=depth["provider"],
        provider_symbol=depth["provider_symbol"],
        bid_price=bid_price,
        ask_price=ask_price,
        last_price=last_price,
        mark_price=mark_price,
        source=source,
        ts=depth["ts"],
    )
    quote["price_precision"] = 2
    return quote


def _get_stock_contract_quote(
    symbol: str,
    provider_symbol: Optional[str] = None,
    *,
    log_context: str = "contract_quote",
) -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    cached_quote = _get_cached_tradfi_quote(
        normalized_symbol,
        allow_stale=itick_market_service.is_quote_depth_cooldown_active(),
    )
    if cached_quote is not None:
        return cached_quote

    cached_depth = _get_cached_depth(normalized_symbol, limit=5, source="LIVE")
    if cached_depth is not None:
        quote = _quote_from_stock_depth(normalized_symbol, cached_depth, source="LIVE")
        _cache_tradfi_quote(quote)
        return quote

    depth = _get_stock_contract_depth(normalized_symbol, provider_symbol, limit=10, log_context=log_context)
    _cache_depth(depth)
    quote = _quote_from_stock_depth(normalized_symbol, depth, source=depth["source"])
    _cache_tradfi_quote(quote)
    return quote


def _itick_market_for_contract(contract_symbol: ContractSymbol) -> str:
    category = _contract_asset_category(contract_symbol)
    if category == "INDEX":
        return "indices"
    if category in ("FOREX", "METAL", "COMMODITY"):
        return "forex"
    return "stock"


def _uses_itick_forex_endpoint(contract_symbol: ContractSymbol) -> bool:
    return _itick_market_for_contract(contract_symbol) == "forex"


def _uses_itick_latest_price_field(contract_symbol: ContractSymbol) -> bool:
    return _itick_market_for_contract(contract_symbol) in ("forex", "indices")


def _get_cached_tradfi_quote_for_contract(
    contract_symbol: ContractSymbol,
    *,
    allow_stale: bool = False,
) -> Optional[dict[str, Any]]:
    if _uses_itick_latest_price_field(contract_symbol):
        cached_quote = _get_cached_tradfi_quote(
            contract_symbol.symbol,
            allow_stale=allow_stale,
            max_age=_tradfi_forex_quote_cache_ttl if _uses_itick_forex_endpoint(contract_symbol) else None,
        )
        if cached_quote is None:
            return None
        if cached_quote.get("price_field") != CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION:
            return None
        return cached_quote
    return _get_cached_tradfi_quote(contract_symbol.symbol, allow_stale=allow_stale)


def _itick_region_for_contract(contract_symbol: ContractSymbol) -> str:
    category = _contract_asset_category(contract_symbol)
    if category == "INDEX":
        return "GB"
    if category in ("FOREX", "METAL", "COMMODITY"):
        return _contract_session_code(contract_symbol, category) or "GB"
    return "US"


def _contract_provider_symbol(contract_symbol: ContractSymbol) -> str:
    provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper()
    if provider_symbol:
        return provider_symbol
    return str(contract_symbol.symbol or "").replace("_PERP", "").upper()


def _stock_provider_symbol_from_contract_symbol(symbol: str, provider_symbol: Optional[str] = None) -> str:
    raw_provider_symbol = str(provider_symbol or "").strip().upper()
    if raw_provider_symbol:
        normalized = raw_provider_symbol.replace("_PERP", "")
        if normalized.endswith("USDT"):
            normalized = normalized[:-4]
        if normalized.endswith("USD") and len(normalized) > 4:
            normalized = normalized[:-3]
        if normalized.endswith("ON"):
            normalized = normalized[:-2]
        return normalized

    underlying = _stock_contract_underlying(symbol)
    if underlying:
        return underlying
    normalized_symbol = _normalize_symbol(symbol).replace("_PERP", "")
    if normalized_symbol.endswith("USDT"):
        normalized_symbol = normalized_symbol[:-4]
    return normalized_symbol


def _stable_reference_price(provider_symbol: str, category: str) -> Decimal:
    normalized_symbol = str(provider_symbol or "").strip().upper()
    base = _tradfi_reference_prices.get(normalized_symbol)
    if base is None:
        for prefix, value in _tradfi_reference_prices.items():
            if normalized_symbol.startswith(prefix):
                base = value
                break
    if base is None:
        base = Decimal("100")

    digest = hashlib.sha256(f"{category}:{normalized_symbol}".encode("utf-8")).hexdigest()
    jitter_bps = Decimal(int(digest[:8], 16) % 81 - 40) / Decimal("10000")
    return max(base * (Decimal("1") + jitter_bps), Decimal("0.0001"))


def _get_itick_cfd_reference_price(contract_symbol: ContractSymbol) -> tuple[Decimal, str, Optional[str], datetime]:
    provider_symbol = _contract_provider_symbol(contract_symbol)
    category = _contract_asset_category(contract_symbol)
    market = _itick_market_for_contract(contract_symbol)
    region = _itick_region_for_contract(contract_symbol)
    prefer_latest_price = _uses_itick_latest_price_field(contract_symbol)
    try:
        payload = itick_market_service.get_market_quote(
            market,
            region,
            provider_symbol,
            timeout=2,
        )
        data = _extract_stock_quote_item(payload)
        if data is not None:
            price, price_field = _pick_itick_quote_reference_price(
                data,
                prefer_forex_latest=prefer_latest_price,
            )
            if price is not None and price > 0:
                if prefer_latest_price and price_field != CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION:
                    logger.debug(
                        "itick_reference_price_field_fallback symbol=%s provider_symbol=%s market=%s price_field=%s",
                        contract_symbol.symbol,
                        provider_symbol,
                        market,
                        price_field,
                    )
                return price, "ITICK", price_field, _itick_quote_timestamp(data)
    except Exception as exc:
        _log_contract_market_warning(
            log_context="contract_quote",
            event="tradfi_cfd_quote_unavailable",
            symbol=contract_symbol.symbol,
            reason=exc,
            message="tradfi_cfd_quote_unavailable symbol=%s provider_symbol=%s category=%s reason=%s",
            args=(
                contract_symbol.symbol,
                provider_symbol,
                category,
                exc,
            ),
        )

    return _stable_reference_price(provider_symbol, category), "CFD_FALLBACK", None, datetime.utcnow()


def _extend_cfd_depth_side(
    levels: list[list[Decimal]],
    *,
    side: str,
    start_price: Decimal,
    gap: Decimal,
    limit: int,
    precision: int,
) -> list[list[Decimal]]:
    items = _copy_depth_levels(levels, limit)
    first_qty = items[0][1] if items else Decimal("10")
    index = len(items)
    while len(items) < limit:
        step = Decimal(index)
        price = start_price - (gap * step) if side == "bid" else start_price + (gap * step)
        if price <= 0:
            break
        quantity = first_qty + Decimal(index * 5)
        items.append(_depth_level(_round_price(price, precision), quantity))
        index += 1
    return items


def _build_cfd_depth_from_price(
    *,
    contract_symbol: ContractSymbol,
    reference_price: Decimal,
    source: str,
    limit: int,
    price_field: Optional[str] = None,
    ts: Optional[datetime] = None,
) -> dict[str, Any]:
    precision = int(getattr(contract_symbol, "price_precision", 2) or 2)
    quant = _price_quant(precision)
    spread_half = max(reference_price * Decimal("0.0005"), quant)
    best_bid = _round_price(reference_price - spread_half, precision)
    best_ask = _round_price(reference_price + spread_half, precision)
    gap = max(spread_half, quant)
    depth = _depth_payload(
        symbol=contract_symbol.symbol,
        provider="ITICK",
        provider_symbol=_contract_provider_symbol(contract_symbol),
        bids=_extend_cfd_depth_side(
            [_depth_level(best_bid, Decimal("10"))],
            side="bid",
            start_price=best_bid,
            gap=gap,
            limit=limit,
            precision=precision,
        ),
        asks=_extend_cfd_depth_side(
            [_depth_level(best_ask, Decimal("10"))],
            side="ask",
            start_price=best_ask,
            gap=gap,
            limit=limit,
            precision=precision,
        ),
        source=source,
        ts=ts or datetime.utcnow(),
    )
    depth["price_precision"] = precision
    if price_field:
        depth["price_field"] = price_field
    return depth


def _get_itick_cfd_depth(contract_symbol: ContractSymbol, *, limit: int = 20) -> dict[str, Any]:
    safe_limit = max(5, min(int(limit or 20), 100))
    cached_quote = _get_cached_tradfi_quote_for_contract(contract_symbol)
    if cached_quote is not None:
        reference_price = _require_positive(_to_decimal(cached_quote.get("last_price")), "last_price")
        return _build_cfd_depth_from_price(
            contract_symbol=contract_symbol,
            reference_price=reference_price,
            source=str(cached_quote.get("source") or "CACHE"),
            limit=safe_limit,
            price_field=cached_quote.get("price_field"),
            ts=_normalize_quote_ts(cached_quote.get("ts")),
        )
    reference_price, source, price_field, quote_ts = _get_itick_cfd_reference_price(contract_symbol)
    return _build_cfd_depth_from_price(
        contract_symbol=contract_symbol,
        reference_price=reference_price,
        source=source,
        limit=safe_limit,
        price_field=price_field,
        ts=quote_ts,
    )


def _quote_from_cfd_depth(contract_symbol: ContractSymbol, depth: dict[str, Any], *, source: str) -> dict[str, Any]:
    quote = _quote_from_depth(contract_symbol, depth, source=source)
    quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 2) or 2)
    if depth.get("price_field"):
        quote["price_field"] = depth.get("price_field")
    return quote


def _depth_to_quote(
    *,
    contract_symbol: ContractSymbol,
    depth: dict[str, Any],
    last_price: Optional[Decimal],
) -> dict[str, Any]:
    bids = depth.get("bids") if isinstance(depth, dict) else None
    asks = depth.get("asks") if isinstance(depth, dict) else None
    bid_price = _best_depth_price(bids, side="bid")
    ask_price = _best_depth_price(asks, side="ask")
    bid_price = _require_positive(bid_price, "bid_price")
    ask_price = _require_positive(ask_price, "ask_price")
    last = last_price if last_price is not None and last_price > 0 else (bid_price + ask_price) / Decimal("2")
    mark_price = _calculate_mark_price(bid_price=bid_price, ask_price=ask_price, last_price=last)
    return _quote_payload(
        symbol=contract_symbol.symbol,
        provider="BINANCE",
        provider_symbol=str(contract_symbol.provider_symbol or "").strip().upper(),
        bid_price=bid_price,
        ask_price=ask_price,
        last_price=last,
        mark_price=mark_price,
        source="LIVE",
        ts=datetime.utcnow(),
    )


def _get_binance_live_quote(contract_symbol: ContractSymbol) -> dict[str, Any]:
    provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper()
    if not provider_symbol:
        raise ContractQuoteUnavailable("provider_symbol is required")
    _raise_if_binance_in_cooldown(provider_symbol)

    try:
        depth = _request_binance_usdm_json("/fapi/v1/depth", {"symbol": provider_symbol, "limit": 5})
    except ContractQuoteUnavailable:
        _mark_binance_failure(provider_symbol)
        raise
    except Exception as exc:
        _mark_binance_failure(provider_symbol)
        raise ContractQuoteUnavailable("BINANCE_FUTURES_QUOTE_UNAVAILABLE") from exc

    last_price: Optional[Decimal] = None
    try:
        ticker = _request_binance_usdm_json("/fapi/v1/ticker/24hr", {"symbol": provider_symbol}, timeout=0.8)
        last_price = _to_decimal(ticker.get("lastPrice")) if isinstance(ticker, dict) else None
    except ContractQuoteUnavailable:
        last_price = None

    quote = _depth_to_quote(contract_symbol=contract_symbol, depth=depth, last_price=last_price)
    bids = _normalize_depth_levels(depth.get("bids") if isinstance(depth, dict) else None)
    asks = _normalize_depth_levels(depth.get("asks") if isinstance(depth, dict) else None)
    if bids and asks:
        _cache_depth(
            _depth_payload(
                symbol=contract_symbol.symbol,
                provider="BINANCE",
                provider_symbol=provider_symbol,
                bids=bids,
                asks=asks,
                source="LIVE",
                ts=quote["ts"],
            )
        )
    logger.debug(
        "contract_binance_usdm_quote symbol=%s bid=%s ask=%s last=%s mark=%s source=LIVE",
        provider_symbol,
        quote["bid_price"],
        quote["ask_price"],
        quote["last_price"],
        quote["mark_price"],
    )
    return quote


def _with_binance_premium_fields(quote: dict[str, Any], provider_symbol: str) -> dict[str, Any]:
    try:
        payload = _request_binance_usdm_json(
            "/fapi/v1/premiumIndex",
            {"symbol": provider_symbol},
            timeout=0.8,
            mark_failure=False,
        )
    except Exception as exc:
        logger.warning(
            "contract_binance_premium_unavailable symbol=%s reason=%s",
            provider_symbol,
            exc,
        )
        return quote

    if not isinstance(payload, dict):
        return quote

    index_price = _to_decimal(payload.get("indexPrice"))
    funding_rate = _to_decimal(payload.get("lastFundingRate"))
    next_funding_time: Optional[int] = None
    raw_next_funding_time = payload.get("nextFundingTime")
    if raw_next_funding_time not in (None, ""):
        try:
            next_funding_time = int(raw_next_funding_time)
        except (TypeError, ValueError):
            next_funding_time = None

    return {
        **quote,
        "index_price": index_price if index_price is not None and index_price > 0 else quote.get("index_price"),
        "funding_rate": funding_rate if funding_rate is not None else quote.get("funding_rate"),
        "next_funding_time": next_funding_time or quote.get("next_funding_time"),
    }


def _get_binance_live_depth(contract_symbol: ContractSymbol, *, limit: int) -> dict[str, Any]:
    provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper()
    if not provider_symbol:
        raise ContractQuoteUnavailable("provider_symbol is required")
    _raise_if_binance_in_cooldown(provider_symbol)

    try:
        raw_depth = _request_binance_usdm_json("/fapi/v1/depth", {"symbol": provider_symbol, "limit": limit})
    except ContractQuoteUnavailable:
        _mark_binance_failure(provider_symbol)
        raise
    bids = _normalize_depth_levels(raw_depth.get("bids") if isinstance(raw_depth, dict) else None)
    asks = _normalize_depth_levels(raw_depth.get("asks") if isinstance(raw_depth, dict) else None)
    if not bids or not asks:
        raise ContractQuoteUnavailable("BINANCE_FUTURES_DEPTH_UNAVAILABLE")
    depth = _depth_payload(
        symbol=contract_symbol.symbol,
        provider="BINANCE",
        provider_symbol=provider_symbol,
        bids=bids,
        asks=asks,
        source="LIVE",
        ts=datetime.utcnow(),
    )
    logger.info(
        "contract_depth_live_success symbol=%s provider_symbol=%s source=LIVE bids_count=%s asks_count=%s "
        "first_bid=%s first_ask=%s",
        contract_symbol.symbol,
        provider_symbol,
        len(bids),
        len(asks),
        _format_decimal(depth["best_bid"]) if depth.get("best_bid") is not None else None,
        _format_decimal(depth["best_ask"]) if depth.get("best_ask") is not None else None,
    )
    return depth


def _candidate_binance_usdm_base_urls() -> list[str]:
    candidates: list[str] = []
    configured = str(getattr(settings, "BINANCE_USDM_BASE_URL", "") or "").strip()
    if configured:
        candidates.append(configured)

    raw_fallbacks = str(getattr(settings, "BINANCE_USDM_FALLBACK_BASE_URLS", "") or "")
    for raw in raw_fallbacks.split(","):
        item = raw.strip()
        if item:
            candidates.append(item)

    normalized: list[str] = []
    for item in candidates:
        base = item.rstrip("/")
        if base and base not in normalized:
            normalized.append(base)
    return normalized or ["https://testnet.binancefuture.com"]


def _mark_binance_failure(provider_symbol: str, base_url: Optional[str] = None) -> None:
    key = _binance_failure_key(provider_symbol, base_url)
    _binance_usdm_failure_until[key] = datetime.utcnow() + _binance_usdm_failure_cooldown


def _binance_failure_key(provider_symbol: str, base_url: Optional[str]) -> str:
    return f"{provider_symbol}|{base_url or '*'}"


def _raise_if_binance_in_cooldown(provider_symbol: str, base_url: Optional[str] = None) -> None:
    until = _binance_usdm_failure_until.get(_binance_failure_key(provider_symbol, base_url))
    if until is not None and until > datetime.utcnow():
        raise ContractQuoteUnavailable("BINANCE_FUTURES_QUOTE_COOLDOWN")


def _log_binance_usdm_request_warning(
    *,
    event: str,
    path: str,
    params: dict[str, Any],
    base_url: str,
    timeout: float,
    reason: Any,
    status: Optional[int] = None,
    body: Optional[str] = None,
) -> None:
    provider_symbol = str(params.get("symbol") or "").strip().upper() or "*"
    reason_key = f"{path}|{base_url}|{status or ''}|{type(reason).__name__}"
    reason_label = str(reason or type(reason).__name__).splitlines()[0][:120]
    if status is None:
        message = (
            "%s path=%s symbol=%s base_url=%s timeout=%s trust_env=%s reason=%s "
            "(repeated failures are logged at debug level)"
        )
        args = (
            event,
            path,
            provider_symbol,
            base_url,
            timeout,
            _binance_usdm_session.trust_env,
            reason_label,
        )
    else:
        message = (
            "%s path=%s symbol=%s base_url=%s status=%s body=%s "
            "(repeated failures are logged at debug level)"
        )
        args = (event, path, provider_symbol, base_url, status, (body or "")[:160])
    _log_contract_market_warning(
        log_context="binance_usdm",
        event=event,
        symbol=provider_symbol,
        reason=reason_key,
        message=message,
        args=args,
    )


def _request_binance_usdm_json(
    path: str,
    params: dict[str, Any],
    *,
    timeout: float = 1.0,
    mark_failure: bool = True,
) -> Any:
    provider_symbol = str(params.get("symbol") or "")
    last_error: Optional[Exception] = None
    for base_url in _candidate_binance_usdm_base_urls():
        try:
            _raise_if_binance_in_cooldown(provider_symbol, base_url)
        except ContractQuoteUnavailable as exc:
            last_error = exc
            continue

        url = f"{base_url}{path}"
        try:
            response = _binance_usdm_session.get(url, params=params, timeout=timeout)
        except requests.RequestException as exc:
            last_error = exc
            if mark_failure:
                _mark_binance_failure(provider_symbol, base_url)
            _log_binance_usdm_request_warning(
                event="binance_usdm_request_failed",
                path=path,
                params=params,
                base_url=base_url,
                timeout=timeout,
                reason=exc,
            )
            continue
        if response.status_code >= 400:
            last_error = ContractQuoteUnavailable("BINANCE_FUTURES_QUOTE_UNAVAILABLE")
            if mark_failure:
                _mark_binance_failure(provider_symbol, base_url)
            _log_binance_usdm_request_warning(
                event="binance_usdm_request_bad_status",
                path=path,
                params=params,
                base_url=base_url,
                timeout=timeout,
                reason="BINANCE_FUTURES_BAD_STATUS",
                status=response.status_code,
                body=response.text or "",
            )
            continue
        try:
            payload = response.json()
        except ValueError as exc:
            last_error = exc
            if mark_failure:
                _mark_binance_failure(provider_symbol, base_url)
            _log_binance_usdm_request_warning(
                event="binance_usdm_request_bad_json",
                path=path,
                params=params,
                base_url=base_url,
                timeout=timeout,
                reason=exc,
            )
            continue
        logger.debug("binance_usdm_request_success path=%s params=%s base_url=%s", path, params, base_url)
        return payload

    raise ContractQuoteUnavailable("BINANCE_FUTURES_QUOTE_UNAVAILABLE") from last_error


def _get_itick_live_quote(contract_symbol: ContractSymbol, *, log_context: str = "contract_quote") -> dict[str, Any]:
    if _is_tradfi_cfd_contract(contract_symbol):
        cached_quote = _get_cached_tradfi_quote_for_contract(
            contract_symbol,
            allow_stale=itick_market_service.is_quote_depth_cooldown_active(),
        )
        if cached_quote is not None:
            return cached_quote
        if itick_market_service.is_quote_depth_cooldown_active():
            raise ItickQuoteUnavailable("ITICK_COOLDOWN_ACTIVE")
        depth = _get_itick_cfd_depth(contract_symbol, limit=10)
        _cache_depth(depth)
        quote = _quote_from_cfd_depth(contract_symbol, depth, source=depth["source"])
        _cache_tradfi_quote(quote)
        return quote

    provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper()
    if not provider_symbol:
        provider_symbol = _stock_contract_underlying(contract_symbol.symbol) or ""
    if not provider_symbol:
        raise ItickQuoteUnavailable("ITICK_QUOTE_UNAVAILABLE")
    return _get_stock_contract_quote(
        contract_symbol.symbol,
        _stock_provider_symbol_from_contract_symbol(contract_symbol.symbol, provider_symbol),
        log_context=log_context,
    )


def get_contract_quote(db: Session, symbol: str, *, log_context: str = "contract_quote") -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    try:
        contract_symbol = _load_contract_symbol(db, symbol)
    except ContractSymbolNotFound:
        if not _is_stock_contract_symbol(normalized_symbol):
            raise
        market_status = _market_status_for_stock_contract_symbol()
        frozen_quote = _get_closed_quote(normalized_symbol) if _is_market_closed(market_status) else None
        if frozen_quote is not None:
            return _with_market_status(frozen_quote, market_status)
        try:
            quote = _freeze_quote_if_closed(_get_stock_contract_quote(normalized_symbol, log_context=log_context), market_status)
            return _with_market_status(quote, market_status)
        except Exception as exc:
            cached_depth = _get_cached_depth(normalized_symbol, limit=5, source="LAST_VALID")
            if cached_depth is not None:
                _log_contract_market_warning(
                    log_context=log_context,
                    event="stock_contract_quote_cache_fallback",
                    symbol=normalized_symbol,
                    reason=exc,
                    message="stock_contract_quote_cache_fallback symbol=%s reason=%s fallback_bid=%s fallback_ask=%s",
                    args=(
                        normalized_symbol,
                        exc,
                        cached_depth.get("best_bid"),
                        cached_depth.get("best_ask"),
                    ),
                )
                quote = _freeze_quote_if_closed(_quote_from_stock_depth(normalized_symbol, cached_depth, source="LAST_VALID"), market_status)
                return _with_market_status(quote, market_status)
            raise

    provider = str(contract_symbol.provider or "").strip().upper()
    market_status = _market_status_for_contract_symbol(contract_symbol)
    frozen_quote = _get_closed_quote(contract_symbol.symbol) if _is_market_closed(market_status) else None
    if frozen_quote is None and _is_market_closed(market_status):
        frozen_quote = _seed_closed_quote_from_last_good(db, contract_symbol)
    if frozen_quote is not None:
        return _with_market_status(frozen_quote, market_status)

    try:
        if provider == "BINANCE":
            provider_symbol = _contract_provider_symbol(contract_symbol)
            quote = _recent_cached_quote(contract_symbol) or _get_binance_live_quote(contract_symbol)
            quote = _with_binance_premium_fields(quote, provider_symbol)
        elif provider == "ITICK":
            quote = _get_itick_live_quote(contract_symbol, log_context=log_context)
        else:
            raise ContractQuoteUnavailable(f"provider {provider} quote is unavailable")

        quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
        quote = _freeze_quote_if_closed(quote, market_status)
        save_last_valid_contract_quote(
            db,
            symbol=quote["symbol"],
            provider=quote["provider"],
            provider_symbol=quote["provider_symbol"],
            bid_price=quote["bid_price"],
            ask_price=quote["ask_price"],
            last_price=quote["last_price"],
            mark_price=quote["mark_price"],
            source="LIVE",
            ts=quote["ts"],
        )
        db.commit()
        return _with_market_status(quote, market_status)
    except Exception as exc:
        db.rollback()
        cached_depth = _get_cached_depth(contract_symbol.symbol, limit=5, source="LAST_VALID")
        if cached_depth is not None:
            _log_contract_market_warning(
                log_context=log_context,
                event="contract_quote_cache_fallback",
                symbol=contract_symbol.symbol,
                reason=exc,
                message=(
                    "contract_quote_cache_fallback symbol=%s provider_symbol=%s provider=%s reason=%s "
                    "fallback_bid=%s fallback_ask=%s fallback_source=%s"
                ),
                args=(
                    contract_symbol.symbol,
                    contract_symbol.provider_symbol,
                    provider,
                    exc,
                    cached_depth.get("best_bid"),
                    cached_depth.get("best_ask"),
                    cached_depth.get("source"),
                ),
            )
            quote = _quote_from_depth(contract_symbol, cached_depth, source="LAST_VALID")
            quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
            quote = _freeze_quote_if_closed(quote, market_status)
            return _with_market_status(quote, market_status)
        fallback = get_last_valid_contract_quote(db, contract_symbol.symbol)
        if fallback is not None:
            _log_contract_market_warning(
                log_context=log_context,
                event="contract_quote_fallback",
                symbol=contract_symbol.symbol,
                reason=exc,
                message=(
                    "contract_quote_fallback symbol=%s provider_symbol=%s provider=%s reason=%s "
                    "fallback_bid=%s fallback_ask=%s fallback_source=%s"
                ),
                args=(
                    contract_symbol.symbol,
                    contract_symbol.provider_symbol,
                    provider,
                    exc,
                    fallback.get("bid_price"),
                    fallback.get("ask_price"),
                    fallback.get("source"),
                ),
            )
            fallback["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
            fallback = _freeze_quote_if_closed(fallback, market_status)
            return _with_market_status(fallback, market_status)
        if provider == "ITICK":
            raise ItickQuoteUnavailable("ITICK_QUOTE_UNAVAILABLE")
        raise


def _contract_ticker_from_binance(contract_symbol: ContractSymbol) -> dict[str, Any]:
    provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper()
    if not provider_symbol:
        raise ContractQuoteUnavailable("provider_symbol is required")

    payload = _request_binance_usdm_json("/fapi/v1/ticker/24hr", {"symbol": provider_symbol}, timeout=1.0)
    if not isinstance(payload, dict):
        raise ContractQuoteUnavailable("BINANCE_FUTURES_TICKER_UNAVAILABLE")

    last_price = _to_decimal(payload.get("lastPrice"))
    price_change = _to_decimal(payload.get("priceChange"))
    high_24h = _to_decimal(payload.get("highPrice"))
    low_24h = _to_decimal(payload.get("lowPrice"))
    base_volume_24h = _to_decimal(payload.get("volume"))
    quote_volume_24h = _to_decimal(payload.get("quoteVolume"))
    return {
        "symbol": contract_symbol.symbol,
        "last_price": _format_decimal(last_price) if last_price is not None and last_price > 0 else None,
        "price_change_24h": _format_optional_decimal(price_change),
        "price_change_percent_24h": str(payload.get("priceChangePercent"))
        if payload.get("priceChangePercent") not in (None, "")
        else None,
        "high_24h": _format_optional_decimal(high_24h),
        "low_24h": _format_optional_decimal(low_24h),
        "base_volume_24h": _format_optional_decimal(base_volume_24h),
        "quote_volume_24h": _format_optional_decimal(quote_volume_24h),
        "source": "LIVE",
        "ts": datetime.utcnow(),
    }


def _quote_from_stock_quote_item(
    *,
    symbol: str,
    provider_symbol: str,
    data: Dict[str, Any],
    source: str = "ITICK_QUOTE",
) -> dict[str, Any]:
    last_price = _pick_positive_decimal(data, ["p", "ld", "last", "price", "latest_price", "close", "c"])
    price = _require_positive(last_price, "last_price")
    quote_ts = _itick_quote_timestamp(data)
    depth = _build_stock_depth_from_prices(
        symbol=_normalize_symbol(symbol),
        provider_symbol=provider_symbol,
        best_bid=price * Decimal("0.9995"),
        best_ask=price * Decimal("1.0005"),
        limit=10,
        source=source,
        ts=quote_ts,
    )
    return _quote_from_stock_depth(symbol, depth, source=source)


def _contract_ticker_from_stock_contract(
    symbol: str,
    *,
    provider_symbol: Optional[str] = None,
    quote_item: Optional[Dict[str, Any]] = None,
) -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    normalized_provider_symbol = _stock_provider_symbol_from_contract_symbol(normalized_symbol, provider_symbol)
    if not normalized_provider_symbol:
        raise ContractQuoteUnavailable("stock contract provider symbol is unavailable")
    if quote_item is None:
        cached_ticker = _ticker_from_cached_tradfi_quote(
            normalized_symbol,
            allow_stale=itick_market_service.is_quote_depth_cooldown_active(),
        )
        if cached_ticker is not None:
            return cached_ticker
        if itick_market_service.is_quote_depth_cooldown_active():
            return {"symbol": normalized_symbol, "last_price": None, "price_change_percent_24h": None}
        payload = itick_market_service.get_stock_quote(
            region=_stock_contract_region,
            code=normalized_provider_symbol,
            timeout=2,
        )
        data = _extract_stock_quote_item(payload) or {}
    else:
        data = quote_item
    last_price = _pick_positive_decimal(data, ["p", "ld", "last", "price", "latest_price", "close", "c"])
    change_percent = _pick_first_present(
        data,
        ["chp", "rate", "change_percent", "price_change_percent", "percent", "pct_chg"],
    )
    if last_price is not None and last_price > 0:
        quote_ts = _itick_quote_timestamp(data)
        quote = _quote_from_stock_quote_item(
            symbol=normalized_symbol,
            provider_symbol=normalized_provider_symbol,
            data=data,
        )
        _cache_tradfi_quote(quote)
    return {
        "symbol": normalized_symbol,
        "last_price": _format_decimal(last_price) if last_price is not None and last_price > 0 else None,
        "price_change_percent_24h": str(change_percent) if change_percent not in (None, "") else None,
        "source": "ITICK_QUOTE" if last_price is not None and last_price > 0 else None,
        "ts": quote_ts if last_price is not None and last_price > 0 else None,
    }


def _contract_ticker_from_itick_cfd(contract_symbol: ContractSymbol) -> dict[str, Any]:
    provider_symbol = _contract_provider_symbol(contract_symbol)
    is_cooldown_active = itick_market_service.is_quote_depth_cooldown_active()
    cached_quote = _get_cached_tradfi_quote_for_contract(contract_symbol, allow_stale=is_cooldown_active)
    cached_ticker = _ticker_from_quote_payload(contract_symbol.symbol, cached_quote) if cached_quote is not None else None
    if cached_ticker is not None and (is_cooldown_active or _has_ticker_24h_fields(cached_ticker)):
        return cached_ticker
    if is_cooldown_active:
        return {"symbol": contract_symbol.symbol, "last_price": None, "price_change_percent_24h": None}
    try:
        payload = itick_market_service.get_market_quote(
            _itick_market_for_contract(contract_symbol),
            _itick_region_for_contract(contract_symbol),
            provider_symbol,
        )
        data = _extract_stock_quote_item(payload) or {}
        last_price, price_field = _pick_itick_quote_reference_price(
            data,
            prefer_forex_latest=_uses_itick_latest_price_field(contract_symbol),
        )
        change_percent = _pick_first_present(
            data,
            ["chp", "rate", "change_percent", "price_change_percent", "percent", "pct_chg"],
        )
        ticker_24h_fields = _extract_itick_24h_ticker_fields(data)
        if last_price is not None and last_price > 0:
            quote_ts = _itick_quote_timestamp(data)
            depth = _build_cfd_depth_from_price(
                contract_symbol=contract_symbol,
                reference_price=last_price,
                source="ITICK_QUOTE",
                limit=10,
                price_field=price_field,
                ts=quote_ts,
            )
            quote = _quote_from_cfd_depth(contract_symbol, depth, source="ITICK_QUOTE")
            quote.update(ticker_24h_fields)
            quote["price_change_percent_24h"] = str(change_percent) if change_percent not in (None, "") else None
            _cache_tradfi_quote(quote)
            return {
                "symbol": contract_symbol.symbol,
                "last_price": _format_decimal(last_price),
                "price_change_percent_24h": str(change_percent) if change_percent not in (None, "") else None,
                "source": "ITICK_QUOTE",
                "ts": quote_ts,
                **ticker_24h_fields,
            }
    except Exception as exc:
        cached_quote = _get_cached_tradfi_quote_for_contract(contract_symbol, allow_stale=True)
        cached_ticker = _ticker_from_quote_payload(contract_symbol.symbol, cached_quote) if cached_quote is not None else None
        if cached_ticker is not None:
            return cached_ticker
        logger.warning(
            "tradfi_cfd_ticker_unavailable symbol=%s provider_symbol=%s reason=%s",
            contract_symbol.symbol,
            provider_symbol,
            exc,
        )

    fallback_price = _stable_reference_price(provider_symbol, _contract_asset_category(contract_symbol))
    return {
        "symbol": contract_symbol.symbol,
        "last_price": _format_decimal(_round_price(fallback_price, int(contract_symbol.price_precision or 2))),
        "price_change_percent_24h": None,
        "price_change_24h": None,
        "high_24h": None,
        "low_24h": None,
        "base_volume_24h": None,
        "quote_volume_24h": None,
        "source": "CFD_FALLBACK",
        "ts": datetime.utcnow(),
    }


def _stock_contract_tickers_from_symbols(
    db: Session,
    symbol_to_code: Dict[str, str],
) -> List[Dict[str, Any]]:
    if not symbol_to_code:
        return []

    limited_symbol_to_code = dict(list(symbol_to_code.items())[:_stock_contract_ticker_request_limit])
    if len(symbol_to_code) > len(limited_symbol_to_code):
        logger.warning(
            "stock_contract_ticker_request_limited requested=%s processed=%s cooldown_remaining=%s",
            len(symbol_to_code),
            len(limited_symbol_to_code),
            itick_market_service.quote_depth_cooldown_remaining_seconds(),
        )
    symbol_to_code = limited_symbol_to_code

    quote_by_code: Dict[str, Dict[str, Any]] = {}
    if not itick_market_service.is_quote_depth_cooldown_active():
        try:
            quote_by_code = itick_market_service.get_stock_quotes(
                _stock_contract_region,
                list(symbol_to_code.values()),
                timeout=3,
            )
        except Exception as exc:
            logger.warning(
                "stock_contract_ticker_batch_unavailable count=%s reason=%s cooldown_remaining=%s",
                len(symbol_to_code),
                exc,
                itick_market_service.quote_depth_cooldown_remaining_seconds(),
            )
    else:
        logger.warning(
            "stock_contract_ticker_batch_skipped_itick_cooldown count=%s cooldown_remaining=%s",
            len(symbol_to_code),
            itick_market_service.quote_depth_cooldown_remaining_seconds(),
        )

    if not quote_by_code and itick_market_service.is_quote_depth_cooldown_active():
        quote_by_code = itick_market_service.get_stock_quotes(
            _stock_contract_region,
            list(symbol_to_code.values()),
            timeout=3,
        )

    items: list[dict[str, Any]] = []
    for symbol, code in symbol_to_code.items():
        quote_item = quote_by_code.get(code) or quote_by_code.get(code.replace("US.", "")) or quote_by_code.get(symbol)
        if quote_item is None:
            cached_ticker = _ticker_from_cached_tradfi_quote(
                symbol,
                allow_stale=itick_market_service.is_quote_depth_cooldown_active(),
            )
            if cached_ticker is not None:
                items.append(cached_ticker)
                continue
            if not itick_market_service.is_quote_depth_cooldown_active():
                try:
                    payload = itick_market_service.get_stock_quote(
                        region=_stock_contract_region,
                        code=code,
                        timeout=2,
                    )
                    quote_item = _extract_stock_quote_item(payload)
                except Exception as exc:
                    logger.warning(
                        "stock_contract_ticker_single_unavailable symbol=%s provider_symbol=%s reason=%s",
                        symbol,
                        code,
                        exc,
                    )

        try:
            items.append(
                _contract_ticker_from_stock_contract(
                    symbol,
                    provider_symbol=code,
                    quote_item=quote_item,
                )
            )
        except Exception as exc:
            logger.warning(
                "stock_contract_ticker_unavailable symbol=%s provider_symbol=%s reason=%s",
                symbol,
                code,
                exc,
            )
            fallback = get_last_valid_contract_quote(db, symbol)
            items.append(
                {
                    "symbol": symbol,
                    "last_price": _format_decimal(fallback["last_price"]) if fallback else None,
                    "price_change_percent_24h": None,
                    "source": "LAST_VALID" if fallback else "CFD_FALLBACK",
                    "ts": fallback.get("ts") if fallback else None,
                }
            )
    return items


def get_contract_tickers(
    db: Session,
    symbols: Optional[List[str]] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    normalized_symbols = {_normalize_symbol(item) for item in (symbols or []) if str(item or "").strip()}
    safe_limit = max(1, min(int(limit or 100), 200))

    query = db.query(ContractSymbol).filter(ContractSymbol.status == 1)
    if normalized_symbols:
        query = query.filter(ContractSymbol.symbol.in_(normalized_symbols))

    rows = query.order_by(ContractSymbol.category.asc(), ContractSymbol.symbol.asc()).limit(safe_limit).all()
    attach_contract_symbol_market_metadata(db, rows)
    items: list[dict[str, Any]] = []
    stock_contract_rows: list[ContractSymbol] = []
    for contract_symbol in rows:
        provider = str(contract_symbol.provider or "").strip().upper()
        try:
            if provider == "BINANCE":
                items.append(_contract_ticker_from_binance(contract_symbol))
                continue
            if provider == "ITICK":
                if _is_stock_contract_config(contract_symbol):
                    stock_contract_rows.append(contract_symbol)
                else:
                    items.append(_contract_ticker_from_itick_cfd(contract_symbol))
                continue
            raise ContractQuoteUnavailable(f"provider {provider} ticker is unavailable")
        except Exception as exc:
            logger.warning(
                "contract_ticker_fallback symbol=%s provider_symbol=%s provider=%s reason=%s",
                contract_symbol.symbol,
                contract_symbol.provider_symbol,
                provider,
                exc,
            )
            fallback = get_last_valid_contract_quote(db, contract_symbol.symbol)
            fallback_percent = None
            if provider == "BINANCE":
                try:
                    spot_ticker = binance_market_service.get_ticker(contract_symbol.provider_symbol)
                    fallback_percent = spot_ticker.price_change_percent
                except BinanceMarketServiceError:
                    fallback_percent = None
            items.append(
                {
                    "symbol": contract_symbol.symbol,
                    "last_price": _format_decimal(fallback["last_price"]) if fallback else None,
                    "price_change_percent_24h": fallback_percent,
                    "source": "LAST_VALID" if fallback else "CFD_FALLBACK",
                    "ts": fallback.get("ts") if fallback else None,
                }
            )
    if stock_contract_rows:
        code_by_symbol = {
            str(contract_symbol.symbol or "").upper(): _stock_provider_symbol_from_contract_symbol(
                str(contract_symbol.symbol or "").upper(),
                _contract_provider_symbol(contract_symbol),
            )
            for contract_symbol in stock_contract_rows
        }
        items.extend(_stock_contract_tickers_from_symbols(db, code_by_symbol))
    existing_symbols = {str(item.get("symbol") or "").upper() for item in items}
    missing_stock_symbols = {
        item: _stock_provider_symbol_from_contract_symbol(item)
        for item in sorted(normalized_symbols)
        if item not in existing_symbols and _is_stock_contract_symbol(item)
    }
    if missing_stock_symbols:
        items.extend(_stock_contract_tickers_from_symbols(db, missing_stock_symbols))

    row_by_symbol = {str(row.symbol or "").upper(): row for row in rows}
    for item in items:
        item_symbol = str(item.get("symbol") or "").upper()
        contract_symbol = row_by_symbol.get(item_symbol)
        status = (
            _market_status_for_contract_symbol(contract_symbol)
            if contract_symbol is not None
            else _market_status_for_stock_contract_symbol()
        )
        _with_market_status(item, status)
    return items


def get_contract_depth(db: Session, symbol: str, limit: int = 20, *, allow_fallback: bool = True) -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    safe_limit = max(5, min(int(limit or 20), 100))
    try:
        contract_symbol = _load_contract_symbol(db, symbol)
    except ContractSymbolNotFound:
        if not _is_stock_contract_symbol(normalized_symbol):
            raise
        safe_limit = max(5, min(int(limit or 20), 100))
        market_status = _market_status_for_stock_contract_symbol()
        frozen_depth = _get_closed_depth(normalized_symbol, limit=safe_limit) if _is_market_closed(market_status) else None
        if frozen_depth is not None:
            return _with_market_status(frozen_depth, market_status)
        try:
            depth = _get_stock_contract_depth(normalized_symbol, limit=safe_limit)
            depth = _freeze_depth_if_closed(depth, market_status, limit=safe_limit)
            _cache_depth(depth)
            return _with_market_status(depth, market_status)
        except Exception as exc:
            if not allow_fallback:
                raise
            cached_depth = _get_cached_depth(normalized_symbol, limit=safe_limit, source="LAST_VALID")
            if cached_depth is not None:
                logger.warning(
                    "stock_contract_depth_cache_fallback symbol=%s reason=%s fallback_bid=%s fallback_ask=%s levels=%s",
                    normalized_symbol,
                    exc,
                    cached_depth.get("best_bid"),
                    cached_depth.get("best_ask"),
                    min(len(cached_depth.get("bids") or []), len(cached_depth.get("asks") or [])),
                )
                cached_depth["price_precision"] = 2
                cached_depth = _freeze_depth_if_closed(cached_depth, market_status, limit=safe_limit)
                return _with_market_status(cached_depth, market_status)
            raise

    provider = str(contract_symbol.provider or "").strip().upper()
    market_status = _market_status_for_contract_symbol(contract_symbol)
    frozen_depth = _get_closed_depth(contract_symbol.symbol, limit=safe_limit) if _is_market_closed(market_status) else None
    if frozen_depth is None and _is_market_closed(market_status):
        frozen_depth = _seed_closed_depth_from_last_good(db, contract_symbol, limit=safe_limit)
    if frozen_depth is not None:
        return _with_market_status(frozen_depth, market_status)

    try:
        if provider == "BINANCE":
            depth = _get_binance_live_depth(contract_symbol, limit=safe_limit)
        elif provider == "ITICK":
            if _is_tradfi_cfd_contract(contract_symbol):
                depth = _get_itick_cfd_depth(contract_symbol, limit=safe_limit)
            else:
                provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper() or None
                depth = _get_stock_contract_depth(contract_symbol.symbol, provider_symbol, limit=safe_limit)
        else:
            raise ContractQuoteUnavailable(f"provider {provider} depth is unavailable")

        depth["price_precision"] = int(getattr(contract_symbol, "price_precision", depth.get("price_precision") or 8) or 8)
        depth = _freeze_depth_if_closed(depth, market_status, limit=safe_limit)
        best_bid = _require_positive(depth.get("best_bid"), "bid_price")
        best_ask = _require_positive(depth.get("best_ask"), "ask_price")
        last_valid = get_last_valid_contract_quote(db, contract_symbol.symbol)
        last_price = _to_decimal(last_valid.get("last_price")) if last_valid else None
        last_price = last_price if last_price is not None and last_price > 0 else (best_bid + best_ask) / Decimal("2")
        mark_price = _calculate_mark_price(bid_price=best_bid, ask_price=best_ask, last_price=last_price)
        save_last_valid_contract_quote(
            db,
            symbol=contract_symbol.symbol,
            provider=depth["provider"],
            provider_symbol=depth["provider_symbol"],
            bid_price=best_bid,
            ask_price=best_ask,
            last_price=last_price,
            mark_price=mark_price,
            source="LIVE",
            ts=depth["ts"],
        )
        _cache_depth(depth)
        db.commit()
        return _with_market_status(depth, market_status)
    except Exception as exc:
        db.rollback()
        if not allow_fallback:
            raise
        cached_depth = _get_cached_depth(contract_symbol.symbol, limit=safe_limit, source="LAST_VALID")
        if cached_depth is not None:
            logger.warning(
                "contract_depth_cache_fallback symbol=%s provider_symbol=%s provider=%s reason=%s "
                "fallback_bid=%s fallback_ask=%s fallback_source=%s levels=%s",
                contract_symbol.symbol,
                contract_symbol.provider_symbol,
                provider,
                exc,
                cached_depth.get("best_bid"),
                cached_depth.get("best_ask"),
                cached_depth.get("source"),
                min(len(cached_depth.get("bids") or []), len(cached_depth.get("asks") or [])),
            )
            cached_depth["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
            cached_depth = _freeze_depth_if_closed(cached_depth, market_status, limit=safe_limit)
            return _with_market_status(cached_depth, market_status)
        fallback = get_last_valid_contract_quote(db, contract_symbol.symbol)
        if fallback is not None:
            bid = _require_positive(_to_decimal(fallback.get("bid_price")), "bid_price")
            ask = _require_positive(_to_decimal(fallback.get("ask_price")), "ask_price")
            logger.warning(
                "contract_depth_fallback symbol=%s provider_symbol=%s provider=%s reason=%s "
                "fallback_bid=%s fallback_ask=%s fallback_source=%s",
                contract_symbol.symbol,
                contract_symbol.provider_symbol,
                provider,
                exc,
                bid,
                ask,
                fallback.get("source"),
            )
            depth = _depth_payload(
                symbol=contract_symbol.symbol,
                provider=fallback["provider"],
                provider_symbol=fallback["provider_symbol"],
                bids=[_depth_level(bid, Decimal("1"))],
                asks=[_depth_level(ask, Decimal("1"))],
                source="LAST_VALID",
                ts=fallback["ts"],
            )
            depth["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
            depth = _freeze_depth_if_closed(depth, market_status, limit=safe_limit)
            return _with_market_status(depth, market_status)
        if provider == "ITICK":
            raise ItickQuoteUnavailable("ITICK_QUOTE_UNAVAILABLE")
        raise


def _normalize_contract_interval(interval: str) -> str:
    normalized = str(interval or "1m").strip()
    if normalized not in _contract_interval_seconds:
        return "1m"
    return normalized


def _normalize_kline_limit(limit: int) -> int:
    return max(1, min(int(limit or 200), 1000))


def _contract_kline_cache_key(symbol: str, interval: str, limit: int) -> str:
    return f"{_normalize_symbol(symbol)}:{_normalize_contract_interval(interval)}:{_normalize_kline_limit(limit)}"


def _copy_kline_rows(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    return [dict(item) for item in rows if isinstance(item, dict)]


def _cache_contract_klines(symbol: str, interval: str, limit: int, rows: list[dict[str, Any]]) -> None:
    _tradfi_kline_cache[_contract_kline_cache_key(symbol, interval, limit)] = {
        "ts": datetime.utcnow(),
        "rows": _copy_kline_rows(rows),
    }


def _get_cached_contract_klines(
    symbol: str,
    interval: str,
    limit: int,
    *,
    allow_stale: bool = False,
) -> Optional[list[dict[str, Any]]]:
    cached = _tradfi_kline_cache.get(_contract_kline_cache_key(symbol, interval, limit))
    if cached is None:
        return None
    ts = cached.get("ts")
    if not isinstance(ts, datetime):
        return None
    if not allow_stale and datetime.utcnow() - ts > _tradfi_kline_cache_ttl:
        return None
    return _copy_kline_rows(cached.get("rows"))


def _to_timestamp_ms(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number <= 0:
            return None
        return int(number if number > 10_000_000_000 else number * 1000)
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
        return int(number if number > 10_000_000_000 else number * 1000)
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return int(parsed.timestamp() * 1000)
    except Exception:
        return None


def _extract_itick_kline_rows(payload: Any) -> list[dict[str, Any]]:
    data = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        for key in ("items", "list", "klines", "rows"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        return []

    rows: list[dict[str, Any]] = []
    for item in data:
        if isinstance(item, dict):
            open_time = _to_timestamp_ms(
                _pick_first_present(item, ["open_time", "time", "timestamp", "t", "tu", "date"])
            )
            open_price = _pick_first_present(item, ["open", "o"])
            high_price = _pick_first_present(item, ["high", "h"])
            low_price = _pick_first_present(item, ["low", "l"])
            close_price = _pick_first_present(item, ["close", "c", "last", "p"])
            volume = _pick_first_present(item, ["volume", "v", "vol"])
        elif isinstance(item, (list, tuple)) and len(item) >= 5:
            open_time = _to_timestamp_ms(item[0])
            open_price, high_price, low_price, close_price = item[1], item[2], item[3], item[4]
            volume = item[5] if len(item) > 5 else "0"
        else:
            continue

        if open_time is None:
            continue
        if any(_to_decimal(value) is None for value in (open_price, high_price, low_price, close_price)):
            continue
        rows.append(
            {
                "open_time": open_time,
                "open": str(open_price),
                "high": str(high_price),
                "low": str(low_price),
                "close": str(close_price),
                "volume": str(volume or "0"),
            }
        )

    rows.sort(key=lambda item: int(item["open_time"]))
    return rows


def _fallback_contract_klines(
    *,
    symbol: str,
    provider_symbol: str,
    category: str,
    interval: str,
    limit: int,
    reference_price: Decimal,
    precision: int,
    end_time_ms: Optional[int] = None,
) -> list[dict[str, Any]]:
    seconds = _contract_interval_seconds[_normalize_contract_interval(interval)]
    safe_limit = _normalize_kline_limit(limit)
    now = int(((int(end_time_ms) - 1) // 1000) if end_time_ms else datetime.utcnow().timestamp())
    aligned_now = now - (now % seconds)
    digest = hashlib.sha256(f"{symbol}:{provider_symbol}:{interval}".encode("utf-8")).hexdigest()
    seed = int(digest[:8], 16)
    amplitude = max(reference_price * Decimal("0.003"), _price_quant(precision) * Decimal("5"))
    rows: list[dict[str, Any]] = []
    previous_close = reference_price
    for index in range(safe_limit):
        point_index = index - safe_limit + 1
        open_time = (aligned_now + point_index * seconds) * 1000
        wave = Decimal(str(math.sin((seed % 37 + index) / 4))) * amplitude
        close_price = max(reference_price + wave, _price_quant(precision))
        open_price = previous_close
        high_price = max(open_price, close_price) + amplitude * Decimal("0.35")
        low_price = max(min(open_price, close_price) - amplitude * Decimal("0.35"), _price_quant(precision))
        volume = Decimal(100 + ((seed + index * 17) % 500))
        rows.append(
            {
                "open_time": open_time,
                "open": _format_decimal(_round_price(open_price, precision)),
                "high": _format_decimal(_round_price(high_price, precision)),
                "low": _format_decimal(_round_price(low_price, precision)),
                "close": _format_decimal(_round_price(close_price, precision)),
                "volume": _format_decimal(volume),
            }
        )
        previous_close = close_price
    return rows


def _get_stock_contract_klines_from_itick(
    db: Session,
    *,
    symbol: str,
    provider_symbol: str,
    interval: str,
    limit: int,
    end_time_ms: Optional[int] = None,
) -> list[dict[str, Any]]:
    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = _normalize_contract_interval(interval)
    safe_limit = _normalize_kline_limit(limit)
    if end_time_ms is None:
        cached_rows = _get_cached_contract_klines(normalized_symbol, normalized_interval, safe_limit)
        if cached_rows is not None:
            return cached_rows

    if normalized_interval not in _itick_contract_k_type:
        logger.info(
            "stock_contract_kline_interval_unsupported symbol=%s interval=%s",
            normalized_symbol,
            normalized_interval,
        )
        if end_time_ms is None:
            _cache_contract_klines(normalized_symbol, normalized_interval, safe_limit, [])
        return []

    def _fetch_stock_contract_klines(fetch_limit: int, _fetch_end_time_ms: Optional[int]):
        payload = itick_market_service.get_stock_kline(
            region=_stock_contract_region,
            code=provider_symbol,
            kType=_itick_contract_k_type[normalized_interval],
            limit=fetch_limit,
            end_time_ms=_fetch_end_time_ms,
        )
        rows = _extract_itick_kline_rows(payload)
        if _fetch_end_time_ms:
            rows = [row for row in rows if int(row.get("open_time") or 0) < int(_fetch_end_time_ms)]
        return rows[-fetch_limit:] if rows else []

    rows = get_klines_cache_first(
        db,
        market_type="contract",
        symbol=normalized_symbol,
        interval=normalized_interval,
        limit=safe_limit,
        end_time_ms=end_time_ms,
        source="ITICK",
        fetch_external=_fetch_stock_contract_klines,
    )
    if end_time_ms is None:
        _cache_contract_klines(normalized_symbol, normalized_interval, safe_limit, rows)
    if not rows:
        logger.warning(
            "stock_contract_kline_empty symbol=%s provider_symbol=%s interval=%s kType=%s limit=%s",
            normalized_symbol,
            provider_symbol,
            normalized_interval,
            _itick_contract_k_type[normalized_interval],
            safe_limit,
        )
    return rows


def get_contract_klines(
    db: Session,
    symbol: str,
    interval: str = "1m",
    limit: int = 200,
    end_time_ms: Optional[int] = None,
) -> list[dict[str, Any]]:
    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = _normalize_contract_interval(interval)
    safe_limit = _normalize_kline_limit(limit)

    try:
        contract_symbol = _load_contract_symbol(db, normalized_symbol)
    except ContractSymbolNotFound:
        if not _is_stock_contract_symbol(normalized_symbol):
            raise
        provider_symbol = _stock_contract_underlying(normalized_symbol) or normalized_symbol.replace("_PERP", "")
        return _get_stock_contract_klines_from_itick(
            db,
            symbol=normalized_symbol,
            provider_symbol=provider_symbol,
            interval=normalized_interval,
            limit=safe_limit,
            end_time_ms=end_time_ms,
        )

    provider = str(contract_symbol.provider or "").strip().upper()
    provider_symbol = _contract_provider_symbol(contract_symbol)
    if provider == "BINANCE":
        def _fetch_binance_contract_klines(fetch_limit: int, _fetch_end_time_ms: Optional[int]):
            params: dict[str, Any] = {
                "symbol": provider_symbol,
                "interval": normalized_interval,
                "limit": fetch_limit,
            }
            if _fetch_end_time_ms:
                params["endTime"] = max(int(_fetch_end_time_ms) - 1, 1)
            rows = _request_binance_usdm_json(
                "/fapi/v1/klines",
                params,
                timeout=1.2,
            )
            if not isinstance(rows, list):
                raise ContractQuoteUnavailable("BINANCE_FUTURES_KLINE_UNAVAILABLE")
            return [
                {
                    "open_time": row[0],
                    "open": row[1],
                    "high": row[2],
                    "low": row[3],
                    "close": row[4],
                    "volume": row[5],
                    "quote_volume": row[7] if len(row) > 7 else "0",
                }
                for row in rows
                if isinstance(row, list) and len(row) >= 6
            ]

        return get_klines_cache_first(
            db,
            market_type="contract",
            symbol=contract_symbol.symbol,
            interval=normalized_interval,
            limit=safe_limit,
            end_time_ms=end_time_ms,
            source="BINANCE",
            fetch_external=_fetch_binance_contract_klines,
        )

    precision = int(getattr(contract_symbol, "price_precision", 2) or 2)
    category = _contract_asset_category(contract_symbol)
    if provider == "ITICK":
        if _is_stock_contract_config(contract_symbol):
            return _get_stock_contract_klines_from_itick(
                db,
                symbol=contract_symbol.symbol,
                provider_symbol=provider_symbol,
                interval=normalized_interval,
                limit=safe_limit,
                end_time_ms=end_time_ms,
            )

        if category != "INDEX" and end_time_ms is None:
            cached_rows = _get_cached_contract_klines(contract_symbol.symbol, normalized_interval, safe_limit)
            if cached_rows is not None:
                return cached_rows
        if normalized_interval not in _itick_contract_k_type:
            logger.info(
                "tradfi_cfd_kline_interval_unsupported symbol=%s interval=%s",
                contract_symbol.symbol,
                normalized_interval,
            )
            if end_time_ms is None:
                _cache_contract_klines(contract_symbol.symbol, normalized_interval, safe_limit, [])
            return []
        def _fetch_itick_contract_klines(fetch_limit: int, _fetch_end_time_ms: Optional[int]):
            payload = itick_market_service.get_market_kline(
                _itick_market_for_contract(contract_symbol),
                _itick_region_for_contract(contract_symbol),
                provider_symbol,
                _itick_contract_k_type[normalized_interval],
                fetch_limit,
                end_time_ms=_fetch_end_time_ms,
                timeout=4,
            )
            rows = _extract_itick_kline_rows(payload)
            if _fetch_end_time_ms:
                rows = [row for row in rows if int(row.get("open_time") or 0) < int(_fetch_end_time_ms)]
            return rows[-fetch_limit:] if rows else []

        if category == "INDEX":
            try:
                rows = _fetch_itick_contract_klines(safe_limit, end_time_ms)
            except Exception as exc:
                logger.warning(
                    "tradfi_index_kline_fetch_failed symbol=%s provider_symbol=%s market=%s region=%s interval=%s kType=%s limit=%s reason=%s",
                    contract_symbol.symbol,
                    provider_symbol,
                    _itick_market_for_contract(contract_symbol),
                    _itick_region_for_contract(contract_symbol),
                    normalized_interval,
                    _itick_contract_k_type[normalized_interval],
                    safe_limit,
                    exc,
                )
                rows = []
        else:
            rows = get_klines_cache_first(
                db,
                market_type="contract",
                symbol=contract_symbol.symbol,
                interval=normalized_interval,
                limit=safe_limit,
                end_time_ms=end_time_ms,
                source="ITICK",
                fetch_external=_fetch_itick_contract_klines,
            )
        if rows:
            if end_time_ms is None:
                _cache_contract_klines(contract_symbol.symbol, normalized_interval, safe_limit, rows)
                if category == "INDEX":
                    upsert_klines(
                        db,
                        market_type="contract",
                        symbol=contract_symbol.symbol,
                        interval=normalized_interval,
                        items=rows,
                        source="ITICK",
                    )
            return rows
        if _is_tradfi_cfd_contract(contract_symbol):
            logger.warning(
                "tradfi_cfd_kline_empty symbol=%s provider_symbol=%s market=%s region=%s interval=%s kType=%s limit=%s",
                contract_symbol.symbol,
                provider_symbol,
                _itick_market_for_contract(contract_symbol),
                _itick_region_for_contract(contract_symbol),
                normalized_interval,
                _itick_contract_k_type[normalized_interval],
                safe_limit,
            )
            if category == "INDEX":
                return []
            if end_time_ms is None:
                _cache_contract_klines(contract_symbol.symbol, normalized_interval, safe_limit, [])
            return []

    reference_price, _source, _price_field, _quote_ts = _get_itick_cfd_reference_price(contract_symbol)
    return _fallback_contract_klines(
        symbol=contract_symbol.symbol,
        provider_symbol=provider_symbol,
        category=category,
        interval=normalized_interval,
        limit=safe_limit,
        reference_price=reference_price,
        precision=precision,
        end_time_ms=end_time_ms,
    )


def get_contract_recent_trades(db: Session, symbol: str, limit: int = 30) -> list[dict[str, Any]]:
    normalized_symbol = _normalize_symbol(symbol)
    safe_limit = max(1, min(int(limit or 30), 100))
    try:
        contract_symbol = _load_contract_symbol(db, normalized_symbol)
    except ContractSymbolNotFound:
        if not _is_stock_contract_symbol(normalized_symbol):
            raise
        if _is_market_closed(_market_status_for_stock_contract_symbol()):
            return []
        quote = _get_stock_contract_quote(normalized_symbol)
        price = quote["last_price"]
    else:
        provider = str(contract_symbol.provider or "").strip().upper()
        if provider == "BINANCE":
            provider_symbol = _contract_provider_symbol(contract_symbol)
            rows = _request_binance_usdm_json(
                "/fapi/v1/trades",
                {"symbol": provider_symbol, "limit": safe_limit},
                timeout=1.0,
            )
            return rows if isinstance(rows, list) else []
        if provider == "ITICK" and _is_market_closed(_market_status_for_contract_symbol(contract_symbol)):
            return []
        quote = get_contract_quote(db, normalized_symbol)
        price = quote["last_price"]

    now_ms = int(datetime.utcnow().timestamp() * 1000)
    precision = 2
    if "contract_symbol" in locals():
        precision = int(getattr(contract_symbol, "price_precision", 2) or 2)
    base_price = _to_decimal(price) or Decimal("1")
    trades: list[dict[str, Any]] = []
    for index in range(safe_limit):
        direction = Decimal("1") if index % 2 == 0 else Decimal("-1")
        next_price = _round_price(base_price * (Decimal("1") + direction * Decimal(index) / Decimal("100000")), precision)
        trades.append(
            {
                "id": now_ms - index,
                "price": _format_decimal(next_price),
                "qty": _format_decimal(Decimal("1") + Decimal(index % 9) / Decimal("10")),
                "quoteQty": _format_decimal(next_price),
                "time": now_ms - index * 3000,
                "isBuyerMaker": bool(index % 2),
            }
        )
    return trades


def contract_quote_to_response(quote: dict[str, Any]) -> dict[str, Any]:
    return {
        "symbol": quote["symbol"],
        "provider": quote["provider"],
        "provider_symbol": quote["provider_symbol"],
        "price_precision": int(quote.get("price_precision") or 8),
        "market_status": quote.get("market_status") or "UNKNOWN",
        "market_status_text": quote.get("market_status_text") or "",
        "market_session_code": quote.get("market_session_code"),
        "market_timezone": quote.get("market_timezone"),
        "market_trading_hours": quote.get("market_trading_hours"),
        "market_session_type": quote.get("market_session_type"),
        "quote_freshness": quote.get("quote_freshness") or _quote_freshness_for_payload(quote),
        "bid_price": _format_decimal(quote["bid_price"]),
        "ask_price": _format_decimal(quote["ask_price"]),
        "last_price": _format_decimal(quote["last_price"]),
        "mark_price": _format_decimal(quote["mark_price"]),
        "index_price": _format_optional_decimal(_to_decimal(quote.get("index_price"))),
        "funding_rate": _format_optional_decimal(_to_decimal(quote.get("funding_rate"))),
        "next_funding_time": quote.get("next_funding_time"),
        "source": quote["source"],
        "ts": quote["ts"],
    }


def contract_depth_to_response(depth: dict[str, Any]) -> dict[str, Any]:
    return {
        "symbol": depth["symbol"],
        "provider": depth["provider"],
        "provider_symbol": depth["provider_symbol"],
        "price_precision": int(depth.get("price_precision") or 8),
        "market_status": depth.get("market_status") or "UNKNOWN",
        "market_status_text": depth.get("market_status_text") or "",
        "market_session_code": depth.get("market_session_code"),
        "market_timezone": depth.get("market_timezone"),
        "market_trading_hours": depth.get("market_trading_hours"),
        "market_session_type": depth.get("market_session_type"),
        "quote_freshness": depth.get("quote_freshness") or _quote_freshness_for_payload(depth),
        "bids": _format_depth_levels(depth["bids"]),
        "asks": _format_depth_levels(depth["asks"]),
        "best_bid": _format_decimal(depth["best_bid"]) if depth.get("best_bid") is not None else None,
        "best_ask": _format_decimal(depth["best_ask"]) if depth.get("best_ask") is not None else None,
        "source": depth["source"],
        "ts": depth["ts"],
    }
