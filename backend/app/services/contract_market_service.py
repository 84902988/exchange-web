from __future__ import annotations

import logging
import hashlib
import time
from datetime import date as date_cls, datetime, time as dt_time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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
from app.services.contract_itick_market_resolver import (
    ITICK_KLINE_TYPE_BY_INTERVAL,
    ContractItickKlineProviderEvidence,
    resolve_contract_itick_kline_provider_evidence,
    resolve_contract_itick_provider_symbol,
)
from app.services.market_kline_cache import (
    KLINE_CACHE_POLICY_GAP_TOLERANT,
    KlineProviderHistoryBoundary,
    get_klines_cache_first,
)
from app.services.contract_kline_response import (
    ContractKlineResult,
    coerce_contract_kline_result,
    contract_kline_error_result,
    contract_kline_process_cache_result,
)
from app.services.contract_market_provider_service import (
    MarketDataProviderConfig,
    ProviderCooldownError,
    contract_market_last_good_enabled,
    enabled_contract_market_providers,
    mark_contract_market_provider_failure,
    mark_contract_market_provider_success,
    request_contract_market_provider_json,
    resolve_contract_provider_symbol,
)
from app.services.contract_market_guard import (
    _CLOSED_MARKET_LAST_GOOD_BBO_MAX_AGE_SECONDS,
    executable_contract_quote_rejection_reason,
    require_executable_contract_quote,
)


logger = logging.getLogger(__name__)

CONTRACT_MARKET_SESSION_POLICY_VERSION = "v1"
CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION = "ld"
CONTRACT_MARKET_STATUS_VERSION = "v2.2"

QUOTE_FRESHNESS_LIVE = "LIVE"
QUOTE_FRESHNESS_RECENT = "RECENT"
QUOTE_FRESHNESS_STALE = "STALE"
QUOTE_FRESHNESS_LAST_VALID = "LAST_VALID"
QUOTE_FRESHNESS_FALLBACK = "FALLBACK"
QUOTE_SOURCE_LAST_GOOD_BBO = "LAST_GOOD_BBO"
DEPTH_MODE_FULL_DEPTH = "FULL_DEPTH"
DEPTH_MODE_SYNTHETIC_FROM_BBO = "SYNTHETIC_FROM_BBO"
DEPTH_MODE_BBO_ONLY = "BBO_ONLY"
PRICE_SOURCE_TRADE_TICK = "TRADE_TICK"
PRICE_SOURCE_KLINE_CLOSE = "KLINE_CLOSE"
CONTRACT_PROVIDER_REST_SOURCE = "PROVIDER_REST"
_NON_PROVIDER_KLINE_SOURCE_TOKENS = {
    "BBO",
    "DEPTH",
    "DISPLAY_PRICE",
    "LIVE_MID",
    "QUOTE_DRIVEN",
    "SYNTHETIC_FROM_QUOTE",
    "TRADE_TICK",
}
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
_tradfi_cfd_categories = {"CFD", "INDEX", "FOREX", "METAL", "COMMODITY"}
_holiday_contract_categories = {"STOCK", "INDEX"}
_contract_24x5_categories = {"FOREX", "METAL", "COMMODITY"}
_itick_contract_k_type = ITICK_KLINE_TYPE_BY_INTERVAL
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


class ContractTradesUnavailable(ContractQuoteUnavailable):
    code = "CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE"


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
    if upper in ("CFD", "INDEX", "FOREX", "STOCK", "CRYPTO"):
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


def _payload_quote_source(payload: dict[str, Any]) -> str:
    return str(payload.get("quote_source") or payload.get("source") or "").strip().upper()


def _is_closed_market_status_value(value: Any) -> bool:
    return str(value or "").strip().upper() in {"CLOSED", "HOLIDAY"}


def _payload_has_valid_bbo(payload: dict[str, Any]) -> bool:
    bid = _to_decimal(payload.get("bid_price") or payload.get("best_bid") or payload.get("bid"))
    ask = _to_decimal(payload.get("ask_price") or payload.get("best_ask") or payload.get("ask"))
    return bid is not None and ask is not None and bid > 0 and ask > 0 and ask >= bid


def _closed_market_last_good_bbo_timestamp(payload: dict[str, Any]) -> Optional[datetime]:
    for key in ("last_good_at", "ts", "timestamp", "time"):
        dt = _normalize_quote_ts(payload.get(key))
        if dt is not None:
            return dt
    return None


def _last_good_bbo_timezone(status: Optional[ItickMarketStatus]) -> ZoneInfo:
    timezone_name = str(getattr(status, "market_timezone", None) or "").strip()
    session_code = str(getattr(status, "market_session_code", None) or "").strip().upper()
    if not timezone_name and session_code:
        timezone_name = itick_holiday_service.SESSION_TIMEZONE_FALLBACKS.get(session_code, "")
    try:
        return ZoneInfo(timezone_name) if timezone_name else ZoneInfo("UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _last_good_bbo_local_now(status: Optional[ItickMarketStatus], now: Optional[datetime]) -> datetime:
    base = now or datetime.now(timezone.utc)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    return base.astimezone(_last_good_bbo_timezone(status))


def _last_good_bbo_local_date(payload: dict[str, Any], status: Optional[ItickMarketStatus]) -> Optional[date_cls]:
    dt = _closed_market_last_good_bbo_timestamp(payload)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_last_good_bbo_timezone(status)).date()


def _holiday_rows_for_status(status: Optional[ItickMarketStatus]) -> Optional[list[dict[str, Any]]]:
    session_code = str(getattr(status, "market_session_code", None) or "").strip().upper()
    if not session_code:
        return None
    try:
        rows = itick_holiday_service._get_holidays(session_code)
    except Exception:
        return None
    return rows if isinstance(rows, list) else None


def _is_holiday_date(rows: Optional[list[dict[str, Any]]], day: date_cls) -> bool:
    if not rows:
        return False
    day_text = day.isoformat()
    return any(itick_holiday_service._date_matches(row.get("d"), day_text) for row in rows if isinstance(row, dict))


def _is_trading_day(day: date_cls, rows: Optional[list[dict[str, Any]]]) -> bool:
    return day.weekday() < 5 and not _is_holiday_date(rows, day)


def _first_trading_clock(trading_hours: Any) -> Optional[dt_time]:
    candidates: list[dt_time] = []
    for raw_segment in str(trading_hours or "").replace("|", ",").split(","):
        segment = raw_segment.strip()
        if "-" not in segment:
            continue
        start_raw = segment.split("-", 1)[0].strip()
        start = itick_holiday_service._parse_clock_time(start_raw)
        if start is not None:
            candidates.append(start)
    return min(candidates) if candidates else None


def _previous_trading_day(day: date_cls, rows: Optional[list[dict[str, Any]]]) -> date_cls:
    candidate = day - timedelta(days=1)
    for _ in range(370):
        if _is_trading_day(candidate, rows):
            return candidate
        candidate -= timedelta(days=1)
    return day - timedelta(days=1)


def _required_last_good_trading_day(
    contract_symbol: Optional[ContractSymbol],
    status: Optional[ItickMarketStatus],
    *,
    now: Optional[datetime] = None,
) -> Optional[date_cls]:
    category = _contract_asset_category(contract_symbol) if contract_symbol is not None else ""
    if category not in (_tradfi_cfd_categories | _holiday_contract_categories | _contract_24x5_categories):
        return None

    current = _last_good_bbo_local_now(status, now)
    rows = _holiday_rows_for_status(status)
    current_day = current.date()
    if not _is_trading_day(current_day, rows):
        return _previous_trading_day(current_day, rows)

    session_type = str(getattr(status, "market_session_type", None) or "").strip().upper()
    if session_type == "PRE_MARKET":
        return _previous_trading_day(current_day, rows)
    if session_type == "CLOSED":
        first_clock = _first_trading_clock(getattr(status, "market_trading_hours", None))
        if first_clock is not None and current.time() < first_clock:
            return _previous_trading_day(current_day, rows)
    return current_day


def _closed_market_last_good_bbo_is_recent(
    payload: Optional[dict[str, Any]],
    contract_symbol: Optional[ContractSymbol] = None,
    status: Optional[ItickMarketStatus] = None,
    *,
    now: Optional[datetime] = None,
) -> bool:
    if not isinstance(payload, dict):
        return False
    if _payload_quote_source(payload) != QUOTE_SOURCE_LAST_GOOD_BBO:
        return False
    dt = _closed_market_last_good_bbo_timestamp(payload)
    if dt is None:
        return False
    required_day = _required_last_good_trading_day(contract_symbol, status, now=now)
    if required_day is not None:
        last_good_day = _last_good_bbo_local_date(payload, status)
        current_day = _last_good_bbo_local_now(status, now).date()
        return last_good_day is not None and required_day <= last_good_day <= current_day
    age_seconds = (datetime.utcnow() - dt).total_seconds()
    return 0 <= age_seconds <= _CLOSED_MARKET_LAST_GOOD_BBO_MAX_AGE_SECONDS


def _contract_closed_market_execution_mode(contract_symbol: Optional[ContractSymbol]) -> str:
    mode = str(getattr(contract_symbol, "closed_market_execution_mode", None) or "DISABLED").strip().upper()
    return mode if mode in {"DISABLED", "LAST_GOOD_BBO"} else "DISABLED"


def _attach_contract_symbol_execution_metadata(
    payload: dict[str, Any],
    contract_symbol: Optional[ContractSymbol],
) -> dict[str, Any]:
    payload["closed_market_execution_mode"] = _contract_closed_market_execution_mode(contract_symbol)
    if contract_symbol is not None:
        payload["category"] = _contract_asset_category(contract_symbol)
    else:
        payload.setdefault("category", "UNKNOWN")
    return payload


def _annotate_closed_market_last_good_bbo_validity(
    payload: dict[str, Any],
    contract_symbol: Optional[ContractSymbol],
    status: ItickMarketStatus,
) -> dict[str, Any]:
    if _payload_quote_source(payload) == QUOTE_SOURCE_LAST_GOOD_BBO and _is_market_closed(status):
        payload["last_good_bbo_valid"] = _closed_market_last_good_bbo_is_recent(
            payload,
            contract_symbol,
            status,
        )
        if payload["last_good_bbo_valid"]:
            payload["quote_freshness"] = QUOTE_FRESHNESS_LAST_VALID
    else:
        payload.pop("last_good_bbo_valid", None)
    return payload


def _ensure_closed_market_quote_mark_price(payload: dict[str, Any]) -> dict[str, Any]:
    if str(payload.get("closed_market_execution_mode") or "").strip().upper() != "LAST_GOOD_BBO":
        return payload
    market_status = str(payload.get("market_status") or "").strip().upper()
    quote_source = _payload_quote_source(payload)
    if market_status not in {"CLOSED", "HOLIDAY"} or quote_source != QUOTE_SOURCE_LAST_GOOD_BBO:
        return payload
    if _to_decimal(payload.get("mark_price")) is not None:
        return payload
    bid = _to_decimal(payload.get("bid_price") or payload.get("best_bid") or payload.get("bid"))
    ask = _to_decimal(payload.get("ask_price") or payload.get("best_ask") or payload.get("ask"))
    if bid is not None and ask is not None and bid > 0 and ask > 0 and ask >= bid:
        payload["mark_price"] = (bid + ask) / Decimal("2")
    return payload


def _payload_quote_executable(
    payload: dict[str, Any],
    *,
    contract_symbol: Optional[ContractSymbol] = None,
    require_mark_price: bool = False,
) -> bool:
    return (
        executable_contract_quote_rejection_reason(
            payload,
            require_mark_price=require_mark_price,
            contract_symbol=contract_symbol,
        )
        is None
    )


def _augment_contract_quote_payload(payload: dict[str, Any]) -> dict[str, Any]:
    _ensure_closed_market_quote_mark_price(payload)
    payload["quote_source"] = _payload_quote_source(payload) or str(payload.get("source") or "UNKNOWN")
    payload["is_realtime"] = (
        payload.get("quote_freshness") == QUOTE_FRESHNESS_LIVE
        and payload["quote_source"] != QUOTE_SOURCE_LAST_GOOD_BBO
    )
    if payload["quote_source"] == QUOTE_SOURCE_LAST_GOOD_BBO:
        payload["last_good_at"] = payload.get("last_good_at") or payload.get("ts")
    else:
        payload.setdefault("last_good_at", None)
    payload["executable"] = _payload_quote_executable(payload)
    return payload


def _with_market_status(payload: dict[str, Any], status: ItickMarketStatus) -> dict[str, Any]:
    payload.update(status.to_payload())
    payload["quote_freshness"] = _quote_freshness_for_payload(payload)
    return _augment_contract_quote_payload(payload)


def _is_market_closed(status: ItickMarketStatus) -> bool:
    return status.market_status == MARKET_STATUS_CLOSED or _is_closed_market_status_value(status.market_status)


def _manual_spread_addon(contract_symbol: Optional[ContractSymbol]) -> Decimal:
    # contract_symbols.spread_x stores the manual addon, not a replacement spread.
    manual_addon = _to_decimal(getattr(contract_symbol, "spread_x", None))
    if manual_addon is None or manual_addon < 0:
        return Decimal("0")
    return manual_addon


def _auto_spread_from_prices(bid_price: Optional[Decimal], ask_price: Optional[Decimal]) -> Decimal:
    if bid_price is None or ask_price is None or bid_price <= 0 or ask_price <= 0:
        return Decimal("0")
    spread = ask_price - bid_price
    if spread <= 0:
        return Decimal("0")
    return spread


def _effective_spread_x(auto_spread: Decimal, manual_addon: Decimal) -> Decimal:
    return max(auto_spread, Decimal("0")) + max(manual_addon, Decimal("0")) * Decimal("2")


def _single_side_spread_fee_price(effective_spread: Decimal) -> Decimal:
    if effective_spread <= Decimal("0"):
        return Decimal("0")
    return effective_spread / Decimal("2")


def apply_manual_spread_addon(
    raw_bid: Decimal,
    raw_ask: Decimal,
    manual_addon: Decimal,
) -> tuple[Decimal, Decimal]:
    addon = manual_addon if manual_addon > Decimal("0") else Decimal("0")
    return raw_bid - addon, raw_ask + addon


def _apply_effective_spread_x_to_quote(quote: dict[str, Any], contract_symbol: Optional[ContractSymbol]) -> dict[str, Any]:
    if quote.get("spread_x_applied"):
        return quote

    raw_bid = _require_positive(_to_decimal(quote.get("bid_price")), "bid_price")
    raw_ask = _require_positive(_to_decimal(quote.get("ask_price")), "ask_price")
    auto_spread = _auto_spread_from_prices(raw_bid, raw_ask)
    manual_addon = _manual_spread_addon(contract_symbol)
    effective_spread = _effective_spread_x(auto_spread, manual_addon)
    quote["manual_spread_x"] = manual_addon
    quote["effective_total_spread"] = effective_spread
    quote["single_side_spread_fee_price"] = _single_side_spread_fee_price(effective_spread)
    quote["spread_x"] = effective_spread

    if manual_addon <= Decimal("0"):
        quote["spread_x_applied"] = True
        return quote

    adjusted_bid, adjusted_ask = apply_manual_spread_addon(raw_bid, raw_ask, manual_addon)
    quote["raw_bid_price"] = quote.get("raw_bid_price", raw_bid)
    quote["raw_ask_price"] = quote.get("raw_ask_price", raw_ask)
    quote["bid_price"] = adjusted_bid
    quote["ask_price"] = adjusted_ask
    quote["spread_x_applied"] = True
    return quote


def _shift_depth_levels(levels: Any, delta: Decimal) -> list[list[Decimal]]:
    shifted: list[list[Decimal]] = []
    if not isinstance(levels, list):
        return shifted
    for level in levels:
        if not isinstance(level, list) or len(level) < 2:
            continue
        price = _to_decimal(level[0])
        quantity = _to_decimal(level[1])
        if price is None or quantity is None:
            continue
        shifted.append([price + delta, quantity])
    return shifted


def _apply_effective_spread_x_to_depth(depth: dict[str, Any], contract_symbol: Optional[ContractSymbol]) -> dict[str, Any]:
    if depth.get("spread_x_applied"):
        return depth

    raw_bids = _copy_depth_levels(depth.get("bids") or [])
    raw_asks = _copy_depth_levels(depth.get("asks") or [])
    raw_best_bid = _best_depth_price(raw_bids, side="bid")
    raw_best_ask = _best_depth_price(raw_asks, side="ask")
    auto_spread = _auto_spread_from_prices(raw_best_bid, raw_best_ask)
    manual_addon = _manual_spread_addon(contract_symbol)
    effective_spread = _effective_spread_x(auto_spread, manual_addon)
    depth["manual_spread_x"] = manual_addon
    depth["effective_total_spread"] = effective_spread
    depth["single_side_spread_fee_price"] = _single_side_spread_fee_price(effective_spread)
    depth["spread_x"] = effective_spread

    if manual_addon <= Decimal("0"):
        depth["spread_x_applied"] = True
        return depth

    depth["raw_bids"] = depth.get("raw_bids", raw_bids)
    depth["raw_asks"] = depth.get("raw_asks", raw_asks)
    depth["raw_best_bid"] = depth.get("raw_best_bid", raw_best_bid)
    depth["raw_best_ask"] = depth.get("raw_best_ask", raw_best_ask)
    depth["bids"] = _shift_depth_levels(raw_bids, -manual_addon)
    depth["asks"] = _shift_depth_levels(raw_asks, manual_addon)
    depth["best_bid"] = _best_depth_price(depth["bids"], side="bid")
    depth["best_ask"] = _best_depth_price(depth["asks"], side="ask")
    depth["spread_x_applied"] = True
    return depth


def _copy_depth_payload(depth: dict[str, Any], *, limit: Optional[int] = None) -> dict[str, Any]:
    copied = dict(depth)
    copied["bids"] = _copy_depth_levels(depth.get("bids") or [], limit)
    copied["asks"] = _copy_depth_levels(depth.get("asks") or [], limit)
    if "raw_bids" in depth:
        copied["raw_bids"] = _copy_depth_levels(depth.get("raw_bids") or [], limit)
    if "raw_asks" in depth:
        copied["raw_asks"] = _copy_depth_levels(depth.get("raw_asks") or [], limit)
    copied["best_bid"] = _best_depth_price(copied["bids"], side="bid")
    copied["best_ask"] = _best_depth_price(copied["asks"], side="ask")
    return copied


def _get_closed_depth(symbol: str, *, limit: Optional[int] = None) -> Optional[dict[str, Any]]:
    cached = _closed_market_depth_cache.get(_normalize_symbol(symbol))
    if cached is None:
        return None
    return _copy_depth_payload(cached, limit=limit)


def _is_safe_last_good_bbo_source(source: Any) -> bool:
    normalized = str(source or "").strip().upper()
    return bool(normalized) and not any(token in normalized for token in ("FALLBACK", "STALE", "INVALID"))


def _set_closed_depth(depth: dict[str, Any]) -> dict[str, Any]:
    symbol = _normalize_symbol(str(depth.get("symbol") or ""))
    frozen = _copy_depth_payload(depth)
    original_source = str(frozen.get("source") or "PLATFORM_BBO")
    frozen["source"] = original_source
    frozen["quote_source"] = original_source
    frozen["is_realtime"] = False
    frozen["last_good_at"] = frozen.get("last_good_at") or frozen.get("ts")
    if _is_safe_last_good_bbo_source(original_source) and _payload_has_valid_bbo(frozen):
        frozen["source"] = QUOTE_SOURCE_LAST_GOOD_BBO
        frozen["quote_source"] = QUOTE_SOURCE_LAST_GOOD_BBO
    _closed_market_depth_cache[symbol] = frozen
    return _copy_depth_payload(frozen)


def _freeze_depth_if_closed(
    depth: dict[str, Any],
    status: ItickMarketStatus,
    *,
    limit: Optional[int] = None,
    prefer_cached: bool = True,
) -> dict[str, Any]:
    if not _is_market_closed(status):
        return depth
    if prefer_cached:
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
    original_source = str(frozen.get("source") or "PLATFORM_BBO")
    frozen["source"] = original_source
    frozen["quote_source"] = original_source
    frozen["is_realtime"] = False
    frozen["last_good_at"] = frozen.get("last_good_at") or frozen.get("ts")
    if _is_safe_last_good_bbo_source(original_source) and _payload_has_valid_bbo(frozen):
        frozen["source"] = QUOTE_SOURCE_LAST_GOOD_BBO
        frozen["quote_source"] = QUOTE_SOURCE_LAST_GOOD_BBO
    _closed_market_quote_cache[symbol] = frozen
    return _copy_closed_quote(frozen)


def _freeze_quote_if_closed(
    quote: dict[str, Any],
    status: ItickMarketStatus,
    *,
    prefer_cached: bool = True,
) -> dict[str, Any]:
    if not _is_market_closed(status):
        return quote
    if prefer_cached:
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
    depth_mode: str = DEPTH_MODE_FULL_DEPTH,
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
        "depth_mode": depth_mode,
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
        depth_mode=str(cached.get("depth_mode") or DEPTH_MODE_FULL_DEPTH),
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
        depth_mode=DEPTH_MODE_BBO_ONLY,
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


def _closed_bbo_payload_timestamp(payload: Optional[dict[str, Any]]) -> Optional[datetime]:
    if not isinstance(payload, dict):
        return None
    return _closed_market_last_good_bbo_timestamp(payload)


def _is_payload_newer(left: Optional[dict[str, Any]], right: Optional[dict[str, Any]]) -> bool:
    left_ts = _closed_bbo_payload_timestamp(left)
    right_ts = _closed_bbo_payload_timestamp(right)
    if left_ts is None:
        return False
    if right_ts is None:
        return True
    return left_ts > right_ts


def _set_closed_quote_from_depth(contract_symbol: ContractSymbol, depth: dict[str, Any]) -> Optional[dict[str, Any]]:
    try:
        quote = _quote_from_depth(
            contract_symbol,
            depth,
            source=str(depth.get("source") or QUOTE_SOURCE_LAST_GOOD_BBO),
        )
        quote["price_precision"] = int(getattr(contract_symbol, "price_precision", quote.get("price_precision") or 8) or 8)
        return _set_closed_quote(quote)
    except Exception:
        return None


def _set_closed_depth_from_quote(
    contract_symbol: ContractSymbol,
    quote: dict[str, Any],
    *,
    limit: int,
) -> Optional[dict[str, Any]]:
    try:
        depth = _depth_from_quote_payload(
            quote,
            limit=limit,
            source=str(quote.get("source") or QUOTE_SOURCE_LAST_GOOD_BBO),
        )
        depth["price_precision"] = int(getattr(contract_symbol, "price_precision", depth.get("price_precision") or 8) or 8)
        return _set_closed_depth(depth)
    except Exception:
        return None


def _sync_closed_quote_with_newer_depth(
    contract_symbol: ContractSymbol,
    status: ItickMarketStatus,
    quote: Optional[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    depth = _get_closed_depth(contract_symbol.symbol, limit=5)
    if not _closed_market_last_good_bbo_is_recent(depth, contract_symbol, status):
        return quote
    if quote is None or _is_payload_newer(depth, quote):
        synced = _set_closed_quote_from_depth(contract_symbol, depth or {})
        if synced is not None:
            return synced
    return quote


def _sync_closed_depth_with_newer_quote(
    contract_symbol: ContractSymbol,
    status: ItickMarketStatus,
    depth: Optional[dict[str, Any]],
    *,
    limit: int,
) -> Optional[dict[str, Any]]:
    quote = _get_closed_quote(contract_symbol.symbol)
    if not _closed_market_last_good_bbo_is_recent(quote, contract_symbol, status):
        return depth
    if depth is None or _is_payload_newer(quote, depth):
        synced = _set_closed_depth_from_quote(contract_symbol, quote or {}, limit=limit)
        if synced is not None:
            return synced
    return depth


def _get_itick_depth_for_contract(
    contract_symbol: ContractSymbol,
    *,
    limit: int,
    log_context: str = "contract_quote",
) -> dict[str, Any]:
    if _is_tradfi_cfd_contract(contract_symbol):
        return _get_itick_cfd_depth(contract_symbol, limit=limit)
    provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper() or None
    return _get_stock_contract_depth(
        contract_symbol.symbol,
        provider_symbol,
        limit=limit,
        log_context=log_context,
    )


def _quote_from_open_market_depth_if_live(
    contract_symbol: ContractSymbol,
    quote: dict[str, Any],
    *,
    market_status: ItickMarketStatus,
    log_context: str,
) -> dict[str, Any]:
    if _is_market_closed(market_status):
        return quote
    try:
        depth = _get_itick_depth_for_contract(contract_symbol, limit=10, log_context=log_context)
    except Exception:
        return quote
    if _quote_freshness_for_payload(depth) != QUOTE_FRESHNESS_LIVE:
        return quote
    try:
        best_bid = _require_positive(depth.get("best_bid"), "bid_price")
        best_ask = _require_positive(depth.get("best_ask"), "ask_price")
    except Exception:
        return quote
    if best_ask < best_bid:
        return quote
    _cache_depth(depth)
    derived = (
        _quote_from_cfd_depth(contract_symbol, depth, source=str(depth.get("source") or "ITICK_DEPTH"))
        if _is_tradfi_cfd_contract(contract_symbol)
        else _quote_from_stock_depth(contract_symbol.symbol, depth, source=str(depth.get("source") or "ITICK_DEPTH"))
    )
    derived["price_precision"] = int(getattr(contract_symbol, "price_precision", quote.get("price_precision") or 8) or 8)
    _cache_tradfi_quote(derived)
    return derived


def _depth_from_open_market_quote_if_live(
    contract_symbol: ContractSymbol,
    quote: dict[str, Any],
    *,
    limit: int,
) -> Optional[dict[str, Any]]:
    if _quote_freshness_for_payload(quote) != QUOTE_FRESHNESS_LIVE:
        return None
    try:
        if not _payload_has_valid_bbo(quote):
            return None
        depth = _depth_from_quote_payload(
            quote,
            limit=limit,
            source=str(quote.get("source") or "ITICK_QUOTE"),
        )
        depth["price_precision"] = int(getattr(contract_symbol, "price_precision", depth.get("price_precision") or 8) or 8)
        return depth
    except Exception:
        return None


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


def _recent_persisted_contract_quote(
    db: Session,
    contract_symbol: ContractSymbol,
    *,
    max_age_seconds: float = QUOTE_FRESHNESS_LIVE_SECONDS,
) -> Optional[dict[str, Any]]:
    quote = get_last_valid_contract_quote(db, contract_symbol.symbol)
    if quote is None:
        return None

    ts = _normalize_quote_ts(quote.get("ts"))
    if ts is None:
        return None

    age_seconds = (datetime.utcnow() - ts).total_seconds()
    if age_seconds < -QUOTE_FRESHNESS_LIVE_SECONDS:
        return None
    if age_seconds < 0:
        age_seconds = 0
    if age_seconds > max_age_seconds:
        return None

    quote = dict(quote)
    quote["source"] = "PERSISTED_LIVE"
    quote["ts"] = ts
    quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
    return quote


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


def _quote_display_index_price(quote: dict[str, Any]) -> Optional[Decimal]:
    index_price = _to_decimal(quote.get("index_price"))
    if index_price is not None and index_price > 0:
        return index_price
    mark_price = _to_decimal(quote.get("mark_price"))
    if mark_price is not None and mark_price > 0:
        return mark_price
    last_price = _to_decimal(quote.get("last_price"))
    if last_price is not None and last_price > 0:
        return last_price
    return None


def _extract_itick_24h_ticker_fields(
    data: Dict[str, Any],
    *,
    last_price: Optional[Decimal] = None,
) -> dict[str, Optional[str]]:
    base_volume_24h = _pick_decimal_present(
        data,
        ["v", "volume", "vol", "base_volume", "base_volume_24h", "volume_24h", "baseVolume"],
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
    if (
        (quote_volume_24h is None or quote_volume_24h <= 0)
        and base_volume_24h is not None
        and base_volume_24h > 0
        and last_price is not None
        and last_price > 0
    ):
        # iTick stock contract quote may omit quote turnover; estimate it from last price and base volume.
        quote_volume_24h = base_volume_24h * last_price
    return {
        "price_change_24h": _format_optional_decimal(
            _pick_decimal_present(
                data,
                ["change", "price_change", "price_change_24h", "ch", "priceChange", "changePrice"],
            )
        ),
        "high_24h": _format_optional_decimal(
            _pick_decimal_present(
                data,
                ["h", "high", "high_price", "high_24h", "highPrice", "day_high", "dayHigh"],
                positive=True,
            )
        ),
        "low_24h": _format_optional_decimal(
            _pick_decimal_present(
                data,
                ["l", "low", "low_price", "low_24h", "lowPrice", "day_low", "dayLow"],
                positive=True,
            )
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
        depth_mode=DEPTH_MODE_SYNTHETIC_FROM_BBO,
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


def _extract_itick_stock_depth_levels(payload: Any) -> tuple[list[list[Decimal]], list[list[Decimal]], Optional[datetime]]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return [], [], None
    raw_bids = data.get("b") or data.get("bids") or data.get("bid")
    raw_asks = data.get("a") or data.get("asks") or data.get("ask")
    bids = _normalize_stock_depth_levels(raw_bids, side="bid")
    asks = _normalize_stock_depth_levels(raw_asks, side="ask")
    depth_ts = _normalize_quote_ts(_pick_first_present(data, ["t", "timestamp", "time", "ts"]))
    return bids, asks, depth_ts


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
        bids, asks, depth_ts = _extract_itick_stock_depth_levels(depth_payload)
        if bids and asks:
            depth = _depth_payload(
                symbol=normalized_symbol,
                provider="ITICK",
                provider_symbol=normalized_provider_symbol,
                bids=bids[:safe_limit],
                asks=asks[:safe_limit],
                source="ITICK_DEPTH",
                ts=depth_ts or datetime.utcnow(),
                depth_mode=DEPTH_MODE_FULL_DEPTH,
            )
            depth["price_precision"] = 2
            return depth
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


def _contract_itick_kline_provider_evidence(
    contract_symbol: ContractSymbol,
    interval: str,
) -> ContractItickKlineProviderEvidence:
    category = _contract_asset_category(contract_symbol)
    return resolve_contract_itick_kline_provider_evidence(
        local_symbol=contract_symbol.symbol,
        provider_symbol=getattr(contract_symbol, "provider_symbol", None),
        category=category,
        interval=interval,
        explicit_region=_contract_session_code(contract_symbol, category),
    )


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

    fallback_price = _stable_reference_price(provider_symbol, category)
    logger.debug(
        "tradfi_cfd_reference_price_fallback symbol=%s provider_symbol=%s category=%s fallback_price=%s",
        contract_symbol.symbol,
        provider_symbol,
        category,
        _format_decimal(fallback_price),
    )
    return fallback_price, "CFD_FALLBACK", None, datetime.utcnow()


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
        depth_mode=DEPTH_MODE_SYNTHETIC_FROM_BBO,
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


def _provider_data_rows(payload: Any) -> list[Any]:
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
    if isinstance(payload, list):
        return payload
    return []


def _provider_first_row(payload: Any) -> dict[str, Any]:
    rows = _provider_data_rows(payload)
    if rows and isinstance(rows[0], dict):
        return rows[0]
    return {}


def _provider_timestamp_ms(value: Any) -> int:
    timestamp = _to_timestamp_ms(value)
    return timestamp or int(datetime.utcnow().timestamp() * 1000)


def _normalize_provider_depth(
    *,
    provider: MarketDataProviderConfig,
    contract_symbol: ContractSymbol,
    provider_symbol: str,
    payload: Any,
    limit: int,
) -> dict[str, Any]:
    data = payload
    if provider.provider_code == "OKX_SWAP":
        row = _provider_first_row(payload)
        data = row
    elif provider.provider_code == "BITGET_USDT_FUTURES":
        data = payload.get("data") if isinstance(payload, dict) else payload

    bids = _normalize_depth_levels(data.get("bids") if isinstance(data, dict) else None)
    asks = _normalize_depth_levels(data.get("asks") if isinstance(data, dict) else None)
    if not bids or not asks:
        raise ContractQuoteUnavailable(f"{provider.provider_code}_DEPTH_UNAVAILABLE")
    return _depth_payload(
        symbol=contract_symbol.symbol,
        provider=provider.provider_code,
        provider_symbol=provider_symbol,
        bids=bids[:limit],
        asks=asks[:limit],
        source="LIVE",
        ts=datetime.utcnow(),
        depth_mode=DEPTH_MODE_FULL_DEPTH,
    )


def _provider_ticker_last_price(provider_code: str, payload: Any) -> Optional[Decimal]:
    if provider_code == "OKX_SWAP":
        row = _provider_first_row(payload)
        return _to_decimal(row.get("last"))
    if provider_code == "BITGET_USDT_FUTURES":
        row = _provider_first_row(payload)
        return _to_decimal(_pick_first_present(row, ["lastPr", "last", "close"]))
    if provider_code == "BINANCE_USDM" and isinstance(payload, dict):
        return _to_decimal(_pick_first_present(payload, ["lastPrice", "price"]))
    return None


def _provider_funding_rate(provider_code: str, payload: Any) -> Optional[Decimal]:
    if provider_code in {"OKX_SWAP", "BITGET_USDT_FUTURES"}:
        row = _provider_first_row(payload)
        return _to_decimal(row.get("fundingRate"))
    if provider_code == "BINANCE_USDM":
        rows = _provider_data_rows(payload)
        if rows and isinstance(rows[0], dict):
            return _to_decimal(rows[0].get("fundingRate"))
        if isinstance(payload, dict):
            return _to_decimal(payload.get("lastFundingRate") or payload.get("fundingRate"))
    return None


def _configured_provider_symbol(
    db: Session,
    provider: MarketDataProviderConfig,
    contract_symbol: ContractSymbol,
) -> str:
    return resolve_contract_provider_symbol(
        db,
        provider_code=provider.provider_code,
        local_symbol=contract_symbol.symbol,
        fallback_symbol=getattr(contract_symbol, "provider_symbol", None),
    )


def _get_configured_contract_live_depth(
    db: Session,
    contract_symbol: ContractSymbol,
    *,
    limit: int,
) -> dict[str, Any]:
    last_error: Optional[Exception] = None
    for provider in enabled_contract_market_providers(db):
        try:
            provider_symbol = _configured_provider_symbol(db, provider, contract_symbol)
            payload = request_contract_market_provider_json(provider, "depth", provider_symbol, limit=limit)
            depth = _normalize_provider_depth(
                provider=provider,
                contract_symbol=contract_symbol,
                provider_symbol=provider_symbol,
                payload=payload,
                limit=limit,
            )
            mark_contract_market_provider_success(db, provider.provider_code)
            logger.info(
                "contract_provider_depth_success symbol=%s provider=%s provider_symbol=%s best_bid=%s best_ask=%s",
                contract_symbol.symbol,
                provider.provider_code,
                provider_symbol,
                depth.get("best_bid"),
                depth.get("best_ask"),
            )
            return depth
        except ProviderCooldownError as exc:
            last_error = exc
            logger.debug(
                "contract_provider_depth_skipped_cooldown symbol=%s provider=%s",
                contract_symbol.symbol,
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
            )
            logger.warning(
                "contract_provider_depth_failed symbol=%s provider=%s reason=%s",
                contract_symbol.symbol,
                provider.provider_code,
                exc,
            )
            continue
    raise ContractQuoteUnavailable("CONTRACT_MARKET_PROVIDER_DEPTH_UNAVAILABLE") from last_error


def _get_configured_contract_live_quote(db: Session, contract_symbol: ContractSymbol) -> dict[str, Any]:
    last_error: Optional[Exception] = None
    for provider in enabled_contract_market_providers(db):
        try:
            provider_symbol = _configured_provider_symbol(db, provider, contract_symbol)
            depth_payload = request_contract_market_provider_json(provider, "depth", provider_symbol, limit=5)
            depth = _normalize_provider_depth(
                provider=provider,
                contract_symbol=contract_symbol,
                provider_symbol=provider_symbol,
                payload=depth_payload,
                limit=5,
            )
            last_price: Optional[Decimal] = None
            funding_rate: Optional[Decimal] = None
            try:
                ticker_payload = request_contract_market_provider_json(provider, "ticker", provider_symbol, limit=1)
                last_price = _provider_ticker_last_price(provider.provider_code, ticker_payload)
            except Exception:
                last_price = None
            try:
                funding_payload = request_contract_market_provider_json(provider, "funding", provider_symbol, limit=1)
                funding_rate = _provider_funding_rate(provider.provider_code, funding_payload)
            except Exception:
                funding_rate = None
            quote = _depth_to_quote(contract_symbol=contract_symbol, depth=depth, last_price=last_price)
            quote["provider"] = provider.provider_code
            quote["provider_symbol"] = provider_symbol
            if funding_rate is not None:
                quote["funding_rate"] = funding_rate
            _cache_depth(depth)
            mark_contract_market_provider_success(db, provider.provider_code)
            logger.debug(
                "contract_provider_quote_success symbol=%s provider=%s provider_symbol=%s bid=%s ask=%s last=%s",
                contract_symbol.symbol,
                provider.provider_code,
                provider_symbol,
                quote.get("bid_price"),
                quote.get("ask_price"),
                quote.get("last_price"),
            )
            return quote
        except ProviderCooldownError as exc:
            last_error = exc
            logger.debug(
                "contract_provider_quote_skipped_cooldown symbol=%s provider=%s",
                contract_symbol.symbol,
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
            )
            logger.warning(
                "contract_provider_quote_failed symbol=%s provider=%s reason=%s",
                contract_symbol.symbol,
                provider.provider_code,
                exc,
            )
            continue
    raise ContractQuoteUnavailable("CONTRACT_MARKET_PROVIDER_QUOTE_UNAVAILABLE") from last_error


def _configured_contract_ticker(db: Session, contract_symbol: ContractSymbol) -> dict[str, Any]:
    last_error: Optional[Exception] = None
    for provider in enabled_contract_market_providers(db):
        try:
            provider_symbol = _configured_provider_symbol(db, provider, contract_symbol)
            payload = request_contract_market_provider_json(provider, "ticker", provider_symbol, limit=1)
            last_price = _provider_ticker_last_price(provider.provider_code, payload)
            if last_price is None or last_price <= 0:
                raise ContractQuoteUnavailable(f"{provider.provider_code}_TICKER_UNAVAILABLE")
            row = _provider_first_row(payload)
            if provider.provider_code == "OKX_SWAP":
                high_24h = _to_decimal(row.get("high24h"))
                low_24h = _to_decimal(row.get("low24h"))
                volume = _to_decimal(row.get("vol24h"))
                quote_volume = _to_decimal(row.get("volCcy24h"))
            elif provider.provider_code == "BITGET_USDT_FUTURES":
                high_24h = _to_decimal(row.get("high24h"))
                low_24h = _to_decimal(row.get("low24h"))
                volume = _to_decimal(row.get("baseVolume"))
                quote_volume = _to_decimal(row.get("quoteVolume"))
            else:
                high_24h = _to_decimal(payload.get("highPrice")) if isinstance(payload, dict) else None
                low_24h = _to_decimal(payload.get("lowPrice")) if isinstance(payload, dict) else None
                volume = _to_decimal(payload.get("volume")) if isinstance(payload, dict) else None
                quote_volume = _to_decimal(payload.get("quoteVolume")) if isinstance(payload, dict) else None
            mark_contract_market_provider_success(db, provider.provider_code)
            return {
                "symbol": contract_symbol.symbol,
                "last_price": _format_decimal(last_price),
                "price_change_24h": None,
                "price_change_percent_24h": str(row.get("change24h") or row.get("priceChangePercent") or "")
                or None,
                "high_24h": _format_optional_decimal(high_24h),
                "low_24h": _format_optional_decimal(low_24h),
                "base_volume_24h": _format_optional_decimal(volume),
                "quote_volume_24h": _format_optional_decimal(quote_volume),
                "source": "LIVE",
                "ts": datetime.utcnow(),
            }
        except ProviderCooldownError as exc:
            last_error = exc
            logger.debug(
                "contract_provider_ticker_skipped_cooldown symbol=%s provider=%s",
                contract_symbol.symbol,
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
            )
            continue
    raise ContractQuoteUnavailable("CONTRACT_MARKET_PROVIDER_TICKER_UNAVAILABLE") from last_error


def _provider_bar_value(provider_code: str, interval: str) -> str:
    normalized = _normalize_contract_interval(interval)
    if provider_code in {"OKX_SWAP", "BITGET_USDT_FUTURES"}:
        return {
            "1h": "1H",
            "4h": "4H",
            "1d": "1D",
            "1w": "1W",
        }.get(normalized, normalized)
    return normalized


def _provider_kline_extra_params(provider_code: str, interval: str, end_time_ms: Optional[int]) -> dict[str, Any]:
    bar = _provider_bar_value(provider_code, interval)
    if provider_code == "OKX_SWAP":
        params: dict[str, Any] = {"bar": bar}
    elif provider_code == "BITGET_USDT_FUTURES":
        params = {"granularity": bar}
    elif provider_code == "BINANCE_USDM":
        params = {"interval": _normalize_contract_interval(interval)}
    else:
        params = {}
    if end_time_ms and provider_code == "OKX_SWAP":
        params["after"] = str(max(int(end_time_ms), 1))
    if end_time_ms and provider_code == "BINANCE_USDM":
        params["endTime"] = max(int(end_time_ms) - 1, 1)
    if end_time_ms and provider_code == "BITGET_USDT_FUTURES":
        params["endTime"] = max(int(end_time_ms) - 1, 1)
    return params


def _normalize_provider_kline_rows(provider_code: str, payload: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    raw_rows = _provider_data_rows(payload)
    for row in raw_rows:
        if not isinstance(row, list) or len(row) < 5:
            continue
        open_time = _provider_timestamp_ms(row[0])
        if any(_to_decimal(value) is None for value in (row[1], row[2], row[3], row[4])):
            continue
        rows.append(
            {
                "open_time": open_time,
                "open": str(row[1]),
                "high": str(row[2]),
                "low": str(row[3]),
                "close": str(row[4]),
                "volume": str(row[5] if len(row) > 5 else "0"),
                "quote_volume": str(row[6] if len(row) > 6 else "0"),
            }
        )
    rows.sort(key=lambda item: int(item["open_time"]))
    return rows


def _provider_kline_payload_succeeded(provider_code: str, payload: Any) -> bool:
    normalized_provider = str(provider_code or "").strip().upper()
    if normalized_provider == "OKX_SWAP":
        return bool(
            isinstance(payload, dict)
            and str(payload.get("code")).strip() == "0"
            and isinstance(payload.get("data"), list)
        )
    if normalized_provider == "BITGET_USDT_FUTURES":
        return bool(
            isinstance(payload, dict)
            and str(payload.get("code") or "").strip() == "00000"
            and isinstance(payload.get("data"), list)
        )
    if normalized_provider == "BINANCE_USDM":
        return isinstance(payload, list)
    return False


def _get_configured_contract_klines(
    db: Session,
    contract_symbol: ContractSymbol,
    *,
    interval: str,
    limit: int,
    end_time_ms: Optional[int] = None,
) -> list[dict[str, Any]]:
    last_error: Optional[Exception] = None
    last_provider_code: Optional[str] = None
    providers = tuple(enabled_contract_market_providers(db))
    explicit_empty_provider_codes: list[str] = []
    had_non_boundary_error = False
    for provider in providers:
        try:
            last_provider_code = provider.provider_code
            provider_symbol = _configured_provider_symbol(db, provider, contract_symbol)
            endpoint_type = (
                "kline_history"
                if provider.provider_code == "OKX_SWAP" and end_time_ms is not None
                else "kline"
            )
            payload = request_contract_market_provider_json(
                provider,
                endpoint_type,
                provider_symbol,
                limit=limit,
                extra_params=_provider_kline_extra_params(provider.provider_code, interval, end_time_ms),
            )
            if not _provider_kline_payload_succeeded(provider.provider_code, payload):
                raise ContractQuoteUnavailable(f"{provider.provider_code}_KLINE_PROVIDER_ERROR")
            rows = _normalize_provider_kline_rows(provider.provider_code, payload)
            if end_time_ms:
                rows = [row for row in rows if int(row.get("open_time") or 0) < int(end_time_ms)]
            rows = rows[-limit:] if rows else []
            if not rows:
                if end_time_ms is not None:
                    explicit_empty_provider_codes.append(str(provider.provider_code))
                    logger.debug(
                        "contract_provider_kline_history_empty symbol=%s provider=%s interval=%s end_time_ms=%s",
                        contract_symbol.symbol,
                        provider.provider_code,
                        interval,
                        end_time_ms,
                    )
                    continue
                raise ContractQuoteUnavailable(f"{provider.provider_code}_KLINE_UNAVAILABLE")
            mark_contract_market_provider_success(db, provider.provider_code)
            return rows
        except ProviderCooldownError as exc:
            had_non_boundary_error = True
            last_error = exc
            logger.debug(
                "contract_provider_kline_skipped_cooldown symbol=%s provider=%s interval=%s",
                contract_symbol.symbol,
                provider.provider_code,
                interval,
            )
            continue
        except Exception as exc:
            had_non_boundary_error = True
            last_error = exc
            mark_contract_market_provider_failure(
                db,
                provider.provider_code,
                exc,
                cooldown_seconds=provider.cooldown_seconds,
            )
            logger.warning(
                "contract_provider_kline_failed symbol=%s provider=%s interval=%s reason=%s",
                contract_symbol.symbol,
                provider.provider_code,
                interval,
                exc,
            )
            continue
    monthly_history_boundary_candidate = bool(
        end_time_ms is not None
        and _normalize_contract_interval(interval) == "1M"
        and providers
        and len(explicit_empty_provider_codes) == len(providers)
        and not had_non_boundary_error
    )
    if monthly_history_boundary_candidate:
        raise KlineProviderHistoryBoundary(
            "contract provider monthly history boundary",
            provider_error_provider=last_provider_code,
        )
    raise ContractQuoteUnavailable("CONTRACT_MARKET_PROVIDER_KLINE_UNAVAILABLE") from last_error


def _normalize_provider_trade_rows(
    provider_code: str,
    payload: Any,
    limit: int,
    *,
    symbol: Optional[str] = None,
    provider_symbol: Optional[str] = None,
) -> list[dict[str, Any]]:
    rows = _provider_data_rows(payload)
    normalized: list[dict[str, Any]] = []
    now_ms = int(datetime.utcnow().timestamp() * 1000)
    normalized_provider = str(provider_code or "").strip().upper()
    normalized_symbol = _normalize_symbol(symbol) if symbol else None
    normalized_provider_symbol = str(provider_symbol or "").strip() or None
    for index, row in enumerate(rows[:limit]):
        if not isinstance(row, dict):
            continue
        if normalized_provider == "OKX_SWAP":
            trade_id = row.get("tradeId") or row.get("ts") or now_ms - index
            price = row.get("px")
            qty = row.get("sz")
            ts = _to_timestamp_ms(row.get("ts"))
            side_text = str(row.get("side") or "").lower()
            is_buyer_maker = side_text == "sell"
        elif normalized_provider == "BITGET_USDT_FUTURES":
            trade_id = row.get("tradeId") or row.get("ts") or now_ms - index
            price = row.get("price")
            qty = row.get("size")
            ts = _to_timestamp_ms(row.get("ts"))
            side_text = str(row.get("side") or "").lower()
            is_buyer_maker = side_text == "sell"
        else:
            trade_id = row.get("id") or row.get("time") or now_ms - index
            price = row.get("price")
            qty = row.get("qty")
            ts = _to_timestamp_ms(row.get("time"))
            is_buyer_maker = bool(row.get("isBuyerMaker"))
        price_value = _to_decimal(price)
        qty_value = _to_decimal(qty)
        if (
            price_value is None
            or qty_value is None
            or price_value <= 0
            or qty_value <= 0
            or ts is None
            or ts <= 0
        ):
            continue
        normalized.append(
            {
                "id": trade_id,
                "symbol": normalized_symbol,
                "price": str(price),
                "qty": str(qty),
                "quoteQty": str(price),
                "time": ts,
                "event_time_ms": ts,
                "received_at_ms": now_ms,
                "isBuyerMaker": is_buyer_maker,
                "price_source": PRICE_SOURCE_TRADE_TICK,
                "freshness": QUOTE_FRESHNESS_RECENT,
                "quote_freshness": QUOTE_FRESHNESS_RECENT,
                "source": CONTRACT_PROVIDER_REST_SOURCE,
                "quote_source": CONTRACT_PROVIDER_REST_SOURCE,
                "provider": normalized_provider or None,
                "provider_symbol": normalized_provider_symbol,
                "synthetic": False,
            }
        )
    return normalized


def _normalize_itick_stock_tick_trade(
    *,
    symbol: str,
    provider_symbol: str,
    row: Dict[str, Any],
    fallback_id: Any = None,
    source: str = "ITICK_TICK",
) -> Optional[dict[str, Any]]:
    price = _pick_positive_decimal(row, ["ld", "last", "latest_price", "price"])
    if price is None or price <= 0:
        return None
    qty = _pick_positive_decimal(row, ["v", "volume", "qty", "quantity", "amount"])
    if qty is None or qty <= 0:
        return None
    ts_value = _pick_first_present(row, ["t", "ts", "time", "timestamp"])
    ts = _to_timestamp_ms(ts_value)
    if ts is None or ts <= 0:
        return None
    direction = str(row.get("d") or row.get("direction") or "").strip()
    side = None
    is_buyer_maker = None
    if direction == "1":
        side = "SELL"
        is_buyer_maker = True
    elif direction == "2":
        side = "BUY"
        is_buyer_maker = False
    amount = qty
    trade_id = (
        row.get("id")
        or row.get("trade_id")
        or row.get("tradeId")
        or fallback_id
        or f"{provider_symbol}:{ts}:{_format_decimal(price)}:{direction or '0'}"
    )
    return {
        "id": str(trade_id),
        "symbol": _normalize_symbol(symbol),
        "provider": "ITICK",
        "provider_symbol": provider_symbol,
        "price": _format_decimal(price),
        "last_price": _format_decimal(price),
        "qty": _format_decimal(amount),
        "amount": _format_decimal(amount),
        "volume": _format_decimal(amount),
        "quoteQty": _format_decimal(price * amount) if amount > 0 else None,
        "time": ts,
        "ts": ts,
        "event_time_ms": ts,
        "received_at_ms": int(datetime.utcnow().timestamp() * 1000),
        "side": side,
        "direction": direction or None,
        "trading_session": row.get("te"),
        "isBuyerMaker": is_buyer_maker,
        "source": source,
        "quote_source": source,
        "freshness": QUOTE_FRESHNESS_RECENT,
        "quote_freshness": QUOTE_FRESHNESS_RECENT,
        "price_source": PRICE_SOURCE_TRADE_TICK,
        "synthetic": False,
        "exchange_ts": ts_value,
        "exchange_symbol": row.get("s"),
        "exchange_region": row.get("r"),
        "exchange": row.get("e"),
    }


def _is_truthful_provider_ws_trade(row: Dict[str, Any], *, symbol: str) -> bool:
    normalized_symbol = _normalize_symbol(symbol)
    row_symbol = _normalize_symbol(row.get("symbol"))
    price = _to_decimal(row.get("price") or row.get("last_price"))
    qty = _to_decimal(row.get("qty") or row.get("amount") or row.get("quantity") or row.get("volume"))
    event_time_ms = None
    for key in ("event_time_ms", "time", "ts", "exchange_ts"):
        event_time_ms = _to_timestamp_ms(row.get(key))
        if event_time_ms is not None and event_time_ms > 0:
            break
    source = str(row.get("source") or row.get("quote_source") or "").strip().upper()
    quote_source = str(row.get("quote_source") or source).strip().upper()
    freshness = str(row.get("freshness") or row.get("quote_freshness") or "").strip().upper()
    synthetic = row.get("synthetic") is True or str(row.get("synthetic") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    return bool(
        row_symbol == normalized_symbol
        and price is not None
        and price > 0
        and qty is not None
        and qty > 0
        and event_time_ms is not None
        and event_time_ms > 0
        and str(row.get("price_source") or "").strip().upper() == PRICE_SOURCE_TRADE_TICK
        and source in {"LIVE_WS", "PROVIDER_WS"}
        and quote_source in {"LIVE_WS", "PROVIDER_WS"}
        and freshness == QUOTE_FRESHNESS_LIVE
        and not synthetic
        and str(row.get("provider") or "").strip()
        and str(row.get("provider_symbol") or "").strip()
    )


def _get_provider_ws_stock_tick_trade(
    db: Session,
    contract_symbol: ContractSymbol,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    try:
        from app.services.contract_market_provider_ws import (
            CONTRACT_PROVIDER_WS_SOURCE,
            provider_ws_trades_enabled,
            select_fresh_provider_ws_trades,
        )

        if not provider_ws_trades_enabled():
            return []
        payload = select_fresh_provider_ws_trades(
            db,
            contract_symbol.symbol,
            max_age_ms=int(getattr(settings, "CONTRACT_PROVIDER_WS_TRADES_MAX_AGE_MS", 1500) or 1500),
            ensure_subscription=True,
        )
    except Exception:
        logger.debug("contract_itick_provider_ws_tick_unavailable symbol=%s", contract_symbol.symbol, exc_info=True)
        return []
    if not isinstance(payload, dict):
        return []
    trades: list[dict[str, Any]] = []
    for item in payload.get("trades") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("price_source") or "").upper() != PRICE_SOURCE_TRADE_TICK:
            continue
        trade = dict(item)
        trade.setdefault("source", payload.get("source") or CONTRACT_PROVIDER_WS_SOURCE)
        trade.setdefault("quote_source", payload.get("quote_source") or trade.get("source"))
        trade.setdefault("quote_freshness", QUOTE_FRESHNESS_LIVE)
        trade.setdefault("freshness", trade.get("quote_freshness"))
        trade.setdefault("synthetic", False)
        if not _is_truthful_provider_ws_trade(trade, symbol=contract_symbol.symbol):
            continue
        trades.append(trade)
        if len(trades) >= limit:
            break
    return trades


def _get_itick_stock_tick_trade(contract_symbol: ContractSymbol) -> list[dict[str, Any]]:
    provider_symbol = _stock_provider_symbol_from_contract_symbol(
        contract_symbol.symbol,
        getattr(contract_symbol, "provider_symbol", None),
    )
    if not provider_symbol:
        return []
    try:
        payload = itick_market_service.get_stock_tick(
            region=_stock_contract_region,
            code=provider_symbol,
            timeout=2,
        )
    except ItickMarketServiceError as exc:
        logger.debug(
            "contract_itick_stock_tick_rest_unavailable symbol=%s provider_symbol=%s reason=%s",
            contract_symbol.symbol,
            provider_symbol,
            exc,
        )
        return []
    for index, item in enumerate(_extract_itick_data_candidates(payload)):
        trade = _normalize_itick_stock_tick_trade(
            symbol=contract_symbol.symbol,
            provider_symbol=provider_symbol,
            row=item,
            fallback_id=index,
            source="ITICK_TICK",
        )
        if trade is not None:
            return [trade]
    return []


def _get_configured_contract_recent_trades(db: Session, contract_symbol: ContractSymbol, *, limit: int) -> list[dict[str, Any]]:
    last_error: Optional[Exception] = None
    for provider in enabled_contract_market_providers(db):
        try:
            provider_symbol = _configured_provider_symbol(db, provider, contract_symbol)
            payload = request_contract_market_provider_json(provider, "trades", provider_symbol, limit=limit)
            rows = _normalize_provider_trade_rows(
                provider.provider_code,
                payload,
                limit,
                symbol=contract_symbol.symbol,
                provider_symbol=provider_symbol,
            )
            if not rows:
                raise ContractQuoteUnavailable(f"{provider.provider_code}_TRADES_UNAVAILABLE")
            mark_contract_market_provider_success(db, provider.provider_code)
            return rows
        except ProviderCooldownError as exc:
            last_error = exc
            logger.debug(
                "contract_provider_trades_skipped_cooldown symbol=%s provider=%s",
                contract_symbol.symbol,
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
            )
            continue
    raise ContractTradesUnavailable("CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE") from last_error


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
                depth_mode=DEPTH_MODE_FULL_DEPTH,
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
        depth_mode=DEPTH_MODE_FULL_DEPTH,
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
    return normalized or ["https://fapi.binance.com"]


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


def _contract_quote_with_status(
    quote: dict[str, Any],
    status: ItickMarketStatus,
    contract_symbol: Optional[ContractSymbol],
) -> dict[str, Any]:
    payload = _with_market_status(quote, status)
    _attach_contract_symbol_execution_metadata(payload, contract_symbol)
    _annotate_closed_market_last_good_bbo_validity(payload, contract_symbol, status)
    _augment_contract_quote_payload(payload)
    payload = _apply_effective_spread_x_to_quote(payload, contract_symbol)
    _annotate_closed_market_last_good_bbo_validity(payload, contract_symbol, status)
    return _augment_contract_quote_payload(payload)


def _contract_depth_with_status(
    depth: dict[str, Any],
    status: ItickMarketStatus,
    contract_symbol: Optional[ContractSymbol],
) -> dict[str, Any]:
    payload = _with_market_status(depth, status)
    _attach_contract_symbol_execution_metadata(payload, contract_symbol)
    _annotate_closed_market_last_good_bbo_validity(payload, contract_symbol, status)
    _augment_contract_quote_payload(payload)
    payload = _apply_effective_spread_x_to_depth(payload, contract_symbol)
    _annotate_closed_market_last_good_bbo_validity(payload, contract_symbol, status)
    return _augment_contract_quote_payload(payload)


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
            return _contract_quote_with_status(frozen_quote, market_status, None)
        try:
            quote = _freeze_quote_if_closed(_get_stock_contract_quote(normalized_symbol, log_context=log_context), market_status)
            return _contract_quote_with_status(quote, market_status, None)
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
                return _contract_quote_with_status(quote, market_status, None)
            raise

    provider = str(contract_symbol.provider or "").strip().upper()
    market_status = _market_status_for_contract_symbol(contract_symbol)
    is_closed_market = _is_market_closed(market_status)
    frozen_quote = _get_closed_quote(contract_symbol.symbol) if is_closed_market else None
    if frozen_quote is None and is_closed_market:
        frozen_quote = _seed_closed_quote_from_last_good(db, contract_symbol)
    if is_closed_market:
        frozen_quote = _sync_closed_quote_with_newer_depth(contract_symbol, market_status, frozen_quote)
    if frozen_quote is not None and _closed_market_last_good_bbo_is_recent(
        frozen_quote,
        contract_symbol,
        market_status,
    ):
        return _contract_quote_with_status(frozen_quote, market_status, contract_symbol)

    try:
        if provider == "BINANCE":
            quote = _recent_cached_quote(contract_symbol) or _get_configured_contract_live_quote(db, contract_symbol)
        elif provider == "ITICK":
            quote = _get_itick_live_quote(contract_symbol, log_context=log_context)
        else:
            raise ContractQuoteUnavailable(f"provider {provider} quote is unavailable")

        if provider == "ITICK" and not is_closed_market:
            quote = _quote_from_open_market_depth_if_live(
                contract_symbol,
                quote,
                market_status=market_status,
                log_context=log_context,
            )
        quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
        quote = _freeze_quote_if_closed(quote, market_status, prefer_cached=not is_closed_market)
        if is_closed_market and _is_payload_newer(quote, _get_closed_depth(contract_symbol.symbol, limit=5)):
            _set_closed_depth_from_quote(contract_symbol, quote, limit=5)
        quote_source = str(quote.get("source") or "LIVE")
        quote_freshness = _quote_freshness_for_payload(quote)
        if (
            quote_freshness != QUOTE_FRESHNESS_LIVE
            and provider == "ITICK"
            and _is_tradfi_cfd_contract(contract_symbol)
        ):
            recent_quote = _recent_persisted_contract_quote(db, contract_symbol)
            if recent_quote is not None:
                logger.info(
                    "contract_quote_recent_persisted_fallback symbol=%s provider_symbol=%s provider=%s "
                    "degraded_source=%s fallback_bid=%s fallback_ask=%s persisted_bid=%s persisted_ask=%s",
                    contract_symbol.symbol,
                    contract_symbol.provider_symbol,
                    provider,
                    quote_source,
                    quote.get("bid_price"),
                    quote.get("ask_price"),
                    recent_quote.get("bid_price"),
                    recent_quote.get("ask_price"),
                )
                return _contract_quote_with_status(
                    _freeze_quote_if_closed(recent_quote, market_status),
                    market_status,
                    contract_symbol,
                )

        if quote_freshness == QUOTE_FRESHNESS_LIVE:
            save_last_valid_contract_quote(
                db,
                symbol=quote["symbol"],
                provider=quote["provider"],
                provider_symbol=quote["provider_symbol"],
                bid_price=quote["bid_price"],
                ask_price=quote["ask_price"],
                last_price=quote["last_price"],
                mark_price=quote["mark_price"],
                source=quote_source,
                ts=quote["ts"],
            )
        else:
            _log_contract_market_warning(
                log_context=log_context,
                event="contract_quote_skip_last_valid_save",
                symbol=contract_symbol.symbol,
                reason=quote_source,
                message="contract_quote_skip_last_valid_save symbol=%s provider_symbol=%s provider=%s source=%s",
                args=(contract_symbol.symbol, contract_symbol.provider_symbol, provider, quote_source),
            )
        db.commit()
        return _contract_quote_with_status(quote, market_status, contract_symbol)
    except Exception as exc:
        db.rollback()
        if is_closed_market and frozen_quote is not None:
            return _contract_quote_with_status(frozen_quote, market_status, contract_symbol)
        if provider == "BINANCE" and not contract_market_last_good_enabled(db):
            raise
        if provider == "ITICK" and _is_tradfi_cfd_contract(contract_symbol):
            recent_quote = _recent_persisted_contract_quote(db, contract_symbol)
            if recent_quote is not None:
                _log_contract_market_warning(
                    log_context=log_context,
                    event="contract_quote_recent_persisted_error_fallback",
                    symbol=contract_symbol.symbol,
                    reason=exc,
                    message=(
                        "contract_quote_recent_persisted_error_fallback symbol=%s provider_symbol=%s "
                        "provider=%s reason=%s fallback_bid=%s fallback_ask=%s"
                    ),
                    args=(
                        contract_symbol.symbol,
                        contract_symbol.provider_symbol,
                        provider,
                        exc,
                        recent_quote.get("bid_price"),
                        recent_quote.get("ask_price"),
                    ),
                )
                return _contract_quote_with_status(
                    _freeze_quote_if_closed(recent_quote, market_status),
                    market_status,
                    contract_symbol,
                )
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
            return _contract_quote_with_status(quote, market_status, contract_symbol)
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
            return _contract_quote_with_status(fallback, market_status, contract_symbol)
        if provider == "ITICK":
            raise ItickQuoteUnavailable("ITICK_QUOTE_UNAVAILABLE")
        raise


def _contract_ticker_from_binance(db: Session, contract_symbol: ContractSymbol) -> dict[str, Any]:
    try:
        return _configured_contract_ticker(db, contract_symbol)
    except Exception as exc:
        if not contract_market_last_good_enabled(db):
            raise
        fallback = get_last_valid_contract_quote(db, contract_symbol.symbol)
        if fallback is not None:
            return _ticker_from_quote_payload(contract_symbol.symbol, fallback)
        raise ContractQuoteUnavailable("CONTRACT_MARKET_PROVIDER_TICKER_UNAVAILABLE") from exc


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
        if cached_ticker is not None and (
            itick_market_service.is_quote_depth_cooldown_active() or _has_ticker_24h_fields(cached_ticker)
        ):
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
    ticker_24h_fields = _extract_itick_24h_ticker_fields(data, last_price=last_price)
    if last_price is not None and last_price > 0:
        quote_ts = _itick_quote_timestamp(data)
        quote = _quote_from_stock_quote_item(
            symbol=normalized_symbol,
            provider_symbol=normalized_provider_symbol,
            data=data,
        )
        quote.update(ticker_24h_fields)
        quote["price_change_percent_24h"] = str(change_percent) if change_percent not in (None, "") else None
        _cache_tradfi_quote(quote)
    return {
        "symbol": normalized_symbol,
        "last_price": _format_decimal(last_price) if last_price is not None and last_price > 0 else None,
        "price_change_percent_24h": str(change_percent) if change_percent not in (None, "") else None,
        "source": "ITICK_QUOTE" if last_price is not None and last_price > 0 else None,
        "ts": quote_ts if last_price is not None and last_price > 0 else None,
        **ticker_24h_fields,
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
        ticker_24h_fields = _extract_itick_24h_ticker_fields(data, last_price=last_price)
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
                items.append(_contract_ticker_from_binance(db, contract_symbol))
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
            return _contract_depth_with_status(frozen_depth, market_status, None)
        try:
            depth = _get_stock_contract_depth(normalized_symbol, limit=safe_limit)
            depth = _freeze_depth_if_closed(depth, market_status, limit=safe_limit)
            _cache_depth(depth)
            return _contract_depth_with_status(depth, market_status, None)
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
                return _contract_depth_with_status(cached_depth, market_status, None)
            raise

    provider = str(contract_symbol.provider or "").strip().upper()
    market_status = _market_status_for_contract_symbol(contract_symbol)
    is_closed_market = _is_market_closed(market_status)
    frozen_depth = _get_closed_depth(contract_symbol.symbol, limit=safe_limit) if is_closed_market else None
    if frozen_depth is None and is_closed_market:
        frozen_depth = _seed_closed_depth_from_last_good(db, contract_symbol, limit=safe_limit)
    if is_closed_market:
        frozen_depth = _sync_closed_depth_with_newer_quote(
            contract_symbol,
            market_status,
            frozen_depth,
            limit=safe_limit,
        )
    if frozen_depth is not None and _closed_market_last_good_bbo_is_recent(
        frozen_depth,
        contract_symbol,
        market_status,
    ):
        return _contract_depth_with_status(frozen_depth, market_status, contract_symbol)

    try:
        if provider == "BINANCE":
            depth = _get_configured_contract_live_depth(db, contract_symbol, limit=safe_limit)
        elif provider == "ITICK":
            if _is_tradfi_cfd_contract(contract_symbol):
                depth = _get_itick_cfd_depth(contract_symbol, limit=safe_limit)
            else:
                provider_symbol = str(contract_symbol.provider_symbol or "").strip().upper() or None
                depth = _get_stock_contract_depth(contract_symbol.symbol, provider_symbol, limit=safe_limit)
        else:
            raise ContractQuoteUnavailable(f"provider {provider} depth is unavailable")

        depth["price_precision"] = int(getattr(contract_symbol, "price_precision", depth.get("price_precision") or 8) or 8)
        depth = _freeze_depth_if_closed(depth, market_status, limit=safe_limit, prefer_cached=not is_closed_market)
        if provider == "ITICK" and not is_closed_market and _quote_freshness_for_payload(depth) != QUOTE_FRESHNESS_LIVE:
            try:
                quote_for_depth = _get_itick_live_quote(contract_symbol, log_context="contract_depth_quote_fallback")
                quote_for_depth["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
                derived_depth = _depth_from_open_market_quote_if_live(
                    contract_symbol,
                    quote_for_depth,
                    limit=safe_limit,
                )
                if derived_depth is not None:
                    depth = derived_depth
            except Exception:
                pass
        best_bid = _require_positive(depth.get("best_bid"), "bid_price")
        best_ask = _require_positive(depth.get("best_ask"), "ask_price")
        depth_mid_price = (best_bid + best_ask) / Decimal("2")
        last_valid = get_last_valid_contract_quote(db, contract_symbol.symbol)
        last_price = _to_decimal(last_valid.get("last_price")) if last_valid else None
        if provider == "ITICK" and _is_tradfi_cfd_contract(contract_symbol):
            last_price = depth_mid_price
        else:
            last_price = last_price if last_price is not None and last_price > 0 else depth_mid_price
        mark_price = _calculate_mark_price(bid_price=best_bid, ask_price=best_ask, last_price=last_price)
        depth_source = str(depth.get("source") or "LIVE")
        if _quote_freshness_for_payload(depth) == QUOTE_FRESHNESS_LIVE:
            save_last_valid_contract_quote(
                db,
                symbol=contract_symbol.symbol,
                provider=depth["provider"],
                provider_symbol=depth["provider_symbol"],
                bid_price=best_bid,
                ask_price=best_ask,
                last_price=last_price,
                mark_price=mark_price,
                source=depth_source,
                ts=depth["ts"],
            )
            _cache_depth(depth)
        else:
            _log_contract_market_warning(
                log_context="contract_depth",
                event="contract_depth_skip_last_valid_save",
                symbol=contract_symbol.symbol,
                reason=depth_source,
                message="contract_depth_skip_last_valid_save symbol=%s provider_symbol=%s provider=%s source=%s",
                args=(contract_symbol.symbol, contract_symbol.provider_symbol, provider, depth_source),
            )
        db.commit()
        if is_closed_market:
            _set_closed_quote_from_depth(contract_symbol, depth)
        return _contract_depth_with_status(depth, market_status, contract_symbol)
    except Exception as exc:
        db.rollback()
        if not allow_fallback:
            raise
        if provider == "BINANCE" and not contract_market_last_good_enabled(db):
            raise
        if provider == "ITICK" and not is_closed_market:
            try:
                quote = _get_itick_live_quote(contract_symbol, log_context="contract_depth_quote_fallback")
                quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
                depth = _depth_from_open_market_quote_if_live(contract_symbol, quote, limit=safe_limit)
                if depth is not None:
                    best_bid = _require_positive(depth.get("best_bid"), "bid_price")
                    best_ask = _require_positive(depth.get("best_ask"), "ask_price")
                    last_price = _to_decimal(quote.get("last_price")) or (best_bid + best_ask) / Decimal("2")
                    mark_price = _calculate_mark_price(bid_price=best_bid, ask_price=best_ask, last_price=last_price)
                    depth_source = str(depth.get("source") or "ITICK_QUOTE")
                    save_last_valid_contract_quote(
                        db,
                        symbol=contract_symbol.symbol,
                        provider=depth["provider"],
                        provider_symbol=depth["provider_symbol"],
                        bid_price=best_bid,
                        ask_price=best_ask,
                        last_price=last_price,
                        mark_price=mark_price,
                        source=depth_source,
                        ts=depth["ts"],
                    )
                    _cache_depth(depth)
                    db.commit()
                    return _contract_depth_with_status(depth, market_status, contract_symbol)
            except Exception:
                db.rollback()
        if provider == "ITICK" and is_closed_market:
            try:
                quote = _get_itick_live_quote(contract_symbol, log_context="contract_depth")
                quote["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
                quote = _freeze_quote_if_closed(quote, market_status, prefer_cached=False)
                depth = _depth_from_quote_payload(
                    quote,
                    limit=safe_limit,
                    source=str(quote.get("source") or QUOTE_SOURCE_LAST_GOOD_BBO),
                )
                depth["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
                depth = _freeze_depth_if_closed(depth, market_status, limit=safe_limit, prefer_cached=False)
                best_bid = _require_positive(depth.get("best_bid"), "bid_price")
                best_ask = _require_positive(depth.get("best_ask"), "ask_price")
                last_price = _to_decimal(quote.get("last_price")) or (best_bid + best_ask) / Decimal("2")
                mark_price = _calculate_mark_price(bid_price=best_bid, ask_price=best_ask, last_price=last_price)
                depth_source = str(depth.get("source") or QUOTE_SOURCE_LAST_GOOD_BBO)
                if _quote_freshness_for_payload(depth) == QUOTE_FRESHNESS_LIVE:
                    save_last_valid_contract_quote(
                        db,
                        symbol=contract_symbol.symbol,
                        provider=depth["provider"],
                        provider_symbol=depth["provider_symbol"],
                        bid_price=best_bid,
                        ask_price=best_ask,
                        last_price=last_price,
                        mark_price=mark_price,
                        source=depth_source,
                        ts=depth["ts"],
                    )
                    _cache_depth(depth)
                    db.commit()
                return _contract_depth_with_status(depth, market_status, contract_symbol)
            except Exception:
                db.rollback()
                if frozen_depth is not None:
                    return _contract_depth_with_status(frozen_depth, market_status, contract_symbol)
        if is_closed_market and frozen_depth is not None:
            return _contract_depth_with_status(frozen_depth, market_status, contract_symbol)
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
            return _contract_depth_with_status(cached_depth, market_status, contract_symbol)
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
                depth_mode=DEPTH_MODE_BBO_ONLY,
            )
            depth["price_precision"] = int(getattr(contract_symbol, "price_precision", 8) or 8)
            depth = _freeze_depth_if_closed(depth, market_status, limit=safe_limit)
            return _contract_depth_with_status(depth, market_status, contract_symbol)
        if provider == "ITICK":
            raise ItickQuoteUnavailable("ITICK_QUOTE_UNAVAILABLE")
        raise


def get_executable_contract_quote(
    db: Session,
    symbol: str,
    *,
    context: str | None = None,
    order_id: Any = None,
    position_id: Any = None,
    user_id: Any = None,
    log_context: str | None = None,
) -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    execution_context = context or "contract_execution"
    try:
        contract_symbol = _load_contract_symbol(db, normalized_symbol)
    except ContractSymbolNotFound:
        contract_symbol = None
    quote = get_contract_quote(db, normalized_symbol, log_context=log_context or execution_context)
    _attach_contract_symbol_execution_metadata(quote, contract_symbol)
    _augment_contract_quote_payload(quote)
    require_executable_contract_quote(
        quote,
        context=execution_context,
        symbol=normalized_symbol,
        order_id=order_id,
        position_id=position_id,
        user_id=user_id,
        contract_symbol=contract_symbol,
    )
    return quote


def get_executable_contract_depth(
    db: Session,
    symbol: str,
    *,
    limit: int = 5,
    context: str | None = None,
    order_id: Any = None,
    position_id: Any = None,
    user_id: Any = None,
) -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    execution_context = context or "contract_execution_depth"
    try:
        contract_symbol = _load_contract_symbol(db, normalized_symbol)
    except ContractSymbolNotFound:
        contract_symbol = None
    depth = get_contract_depth(db, normalized_symbol, limit=limit, allow_fallback=False)
    _attach_contract_symbol_execution_metadata(depth, contract_symbol)
    _augment_contract_quote_payload(depth)
    require_executable_contract_quote(
        depth,
        context=execution_context,
        symbol=normalized_symbol,
        order_id=order_id,
        position_id=position_id,
        user_id=user_id,
        require_mark_price=False,
        contract_symbol=contract_symbol,
    )
    best_bid = _to_decimal(depth.get("best_bid"))
    best_ask = _to_decimal(depth.get("best_ask"))
    if best_bid is None or best_ask is None or best_bid <= 0 or best_ask <= 0 or best_ask < best_bid:
        raise ContractQuoteUnavailable("missing_executable_bbo")
    return depth


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


def _cache_contract_klines(symbol: str, interval: str, limit: int, rows: list[dict[str, Any]]) -> bool:
    cache_rows = _copy_kline_rows(rows)
    if not cache_rows:
        return False
    _tradfi_kline_cache[_contract_kline_cache_key(symbol, interval, limit)] = {
        "ts": datetime.utcnow(),
        "rows": cache_rows,
    }
    return True


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
    cached_rows = _copy_kline_rows(cached.get("rows"))
    if not cached_rows:
        _tradfi_kline_cache.pop(_contract_kline_cache_key(symbol, interval, limit), None)
        return None
    return cached_rows


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


def _is_provider_contract_kline_row(row: dict[str, Any]) -> bool:
    for key in ("kline_mode", "price_source", "source", "quote_source"):
        raw_value = row.get(key)
        if raw_value is None or raw_value == "":
            continue
        normalized = str(raw_value).strip().upper()
        if normalized in _NON_PROVIDER_KLINE_SOURCE_TOKENS or "QUOTE" in normalized:
            return False
    return True


def _provider_contract_kline_rows(rows: Any, *, limit: Optional[int] = None) -> ContractKlineResult:
    """Filter non-provider candles without dropping history authority metadata."""

    result = coerce_contract_kline_result(rows)
    clean_rows = [
        dict(row)
        for row in result
        if isinstance(row, dict) and _is_provider_contract_kline_row(row)
    ]
    if limit is None:
        return result.with_items(clean_rows)
    safe_limit = _normalize_kline_limit(limit)
    return result.with_items(clean_rows[-safe_limit:])


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
            return _provider_contract_kline_rows(
                contract_kline_process_cache_result(cached_rows),
                limit=safe_limit,
            )

    if normalized_interval not in _itick_contract_k_type:
        logger.info(
            "stock_contract_kline_interval_unsupported symbol=%s interval=%s",
            normalized_symbol,
            normalized_interval,
        )
        return ContractKlineResult(
            [],
            origin="EMPTY",
            cache_status="UNSUPPORTED_INTERVAL",
            provider_error_code=None,
            retryable=False,
        )

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
    rows = _provider_contract_kline_rows(rows, limit=safe_limit)
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
        def _fetch_configured_contract_klines(fetch_limit: int, _fetch_end_time_ms: Optional[int]):
            return _get_configured_contract_klines(
                db,
                contract_symbol,
                interval=normalized_interval,
                limit=fetch_limit,
                end_time_ms=_fetch_end_time_ms,
            )

        try:
            rows = get_klines_cache_first(
                db,
                market_type="contract",
                symbol=contract_symbol.symbol,
                interval=normalized_interval,
                limit=safe_limit,
                end_time_ms=end_time_ms,
                source="CONFIGURED",
                fetch_external=_fetch_configured_contract_klines,
            )
            return _provider_contract_kline_rows(rows, limit=safe_limit)
        except Exception as exc:
            if not contract_market_last_good_enabled(db):
                raise
            logger.warning(
                "contract_kline_provider_unavailable_no_synthetic_fallback symbol=%s interval=%s limit=%s",
                contract_symbol.symbol,
                normalized_interval,
                safe_limit,
            )
            return contract_kline_error_result(exc, end_time_ms=end_time_ms)

    category = _contract_asset_category(contract_symbol)
    if provider == "ITICK":
        provider_symbol = resolve_contract_itick_provider_symbol(
            contract_symbol.symbol,
            getattr(contract_symbol, "provider_symbol", None),
            category,
        )
        if _is_stock_contract_config(contract_symbol):
            rows = _get_stock_contract_klines_from_itick(
                db,
                symbol=contract_symbol.symbol,
                provider_symbol=provider_symbol,
                interval=normalized_interval,
                limit=safe_limit,
                end_time_ms=end_time_ms,
            )
            return rows

        if category != "INDEX" and end_time_ms is None:
            cached_rows = _get_cached_contract_klines(contract_symbol.symbol, normalized_interval, safe_limit)
            if cached_rows is not None:
                return _provider_contract_kline_rows(
                    contract_kline_process_cache_result(cached_rows),
                    limit=safe_limit,
                )
        if normalized_interval not in _itick_contract_k_type:
            logger.info(
                "tradfi_cfd_kline_interval_unsupported symbol=%s interval=%s",
                contract_symbol.symbol,
                normalized_interval,
            )
            return ContractKlineResult(
                [],
                origin="EMPTY",
                cache_status="UNSUPPORTED_INTERVAL",
                provider_error_code=None,
                retryable=False,
            )
        provider_evidence = _contract_itick_kline_provider_evidence(
            contract_symbol,
            normalized_interval,
        )
        def _fetch_itick_contract_klines(fetch_limit: int, _fetch_end_time_ms: Optional[int]):
            payload = itick_market_service.get_market_kline(
                provider_evidence.market,
                provider_evidence.region,
                provider_evidence.provider_symbol,
                provider_evidence.k_type,
                fetch_limit,
                end_time_ms=_fetch_end_time_ms,
                timeout=4,
            )
            rows = _extract_itick_kline_rows(payload)
            if _fetch_end_time_ms:
                rows = [row for row in rows if int(row.get("open_time") or 0) < int(_fetch_end_time_ms)]
            return rows[-fetch_limit:] if rows else []

        rows = get_klines_cache_first(
            db,
            market_type="contract",
            symbol=contract_symbol.symbol,
            interval=normalized_interval,
            limit=safe_limit,
            end_time_ms=end_time_ms,
            source="ITICK",
            fetch_external=_fetch_itick_contract_klines,
            **(
                {"cache_policy": KLINE_CACHE_POLICY_GAP_TOLERANT}
                if category == "INDEX"
                else {}
            ),
        )
        rows = _provider_contract_kline_rows(rows, limit=safe_limit)
        if rows:
            if end_time_ms is None and category != "INDEX":
                _cache_contract_klines(contract_symbol.symbol, normalized_interval, safe_limit, rows)
            return rows
        if _is_tradfi_cfd_contract(contract_symbol):
            logger.warning(
                "tradfi_cfd_kline_empty symbol=%s provider_symbol=%s market=%s region=%s interval=%s kType=%s limit=%s",
                contract_symbol.symbol,
                provider_symbol,
                provider_evidence.market,
                provider_evidence.region,
                normalized_interval,
                _itick_contract_k_type[normalized_interval],
                safe_limit,
            )
            if category == "INDEX":
                return rows
            return rows

    logger.warning(
        "contract_kline_provider_missing_no_synthetic_fallback symbol=%s provider=%s category=%s interval=%s limit=%s",
        contract_symbol.symbol,
        provider,
        category,
        normalized_interval,
        safe_limit,
    )
    return ContractKlineResult(
        [],
        origin="EMPTY",
        cache_status="PROVIDER_NOT_CONFIGURED",
        provider_error_code=None,
        retryable=False,
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
        raise ContractTradesUnavailable("CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE")
    else:
        provider = str(contract_symbol.provider or "").strip().upper()
        if provider == "ITICK" and _is_market_closed(_market_status_for_contract_symbol(contract_symbol)):
            return []
        if provider == "ITICK" and str(getattr(contract_symbol, "category", "") or "").strip().upper() == "STOCK":
            provider_ws_trades = _get_provider_ws_stock_tick_trade(db, contract_symbol, limit=safe_limit)
            if provider_ws_trades:
                return provider_ws_trades
            rest_tick_trades = _get_itick_stock_tick_trade(contract_symbol)
            if rest_tick_trades:
                return rest_tick_trades[:safe_limit]
            raise ContractTradesUnavailable("CONTRACT_MARKET_PROVIDER_TRADES_UNAVAILABLE")
        return _get_configured_contract_recent_trades(db, contract_symbol, limit=safe_limit)


def contract_quote_to_response(quote: dict[str, Any]) -> dict[str, Any]:
    quote_freshness = quote.get("quote_freshness") or _quote_freshness_for_payload(quote)
    quote_source = quote.get("quote_source") or quote.get("source") or "UNKNOWN"
    bid_price = quote["bid_price"]
    ask_price = quote["ask_price"]
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
        "quote_freshness": quote_freshness,
        "quote_source": quote_source,
        "closed_market_execution_mode": quote.get("closed_market_execution_mode") or "DISABLED",
        "executable": bool(quote.get("executable") if quote.get("executable") is not None else _payload_quote_executable({**quote, "quote_freshness": quote_freshness})),
        "is_realtime": bool(quote.get("is_realtime") if quote.get("is_realtime") is not None else quote_freshness == QUOTE_FRESHNESS_LIVE),
        "last_good_at": quote.get("last_good_at"),
        "stale": quote_freshness != QUOTE_FRESHNESS_LIVE,
        "spread_x": _format_decimal(_to_decimal(quote.get("spread_x")) or Decimal("0")),
        "manual_spread_x": _format_decimal(_to_decimal(quote.get("manual_spread_x")) or Decimal("0")),
        "effective_total_spread": _format_decimal(_to_decimal(quote.get("effective_total_spread")) or Decimal("0")),
        "single_side_spread_fee_price": _format_decimal(_to_decimal(quote.get("single_side_spread_fee_price")) or Decimal("0")),
        "bid": _format_decimal(bid_price),
        "ask": _format_decimal(ask_price),
        "bid_price": _format_decimal(bid_price),
        "ask_price": _format_decimal(ask_price),
        "best_bid": _format_decimal(bid_price),
        "best_ask": _format_decimal(ask_price),
        "raw_bid_price": _format_optional_decimal(_to_decimal(quote.get("raw_bid_price"))),
        "raw_ask_price": _format_optional_decimal(_to_decimal(quote.get("raw_ask_price"))),
        "last_price": _format_decimal(quote["last_price"]),
        "mark_price": _format_decimal(quote["mark_price"]),
        "index_price": _format_optional_decimal(_quote_display_index_price(quote)),
        "funding_rate": _format_optional_decimal(_to_decimal(quote.get("funding_rate"))),
        "next_funding_time": quote.get("next_funding_time"),
        "source": quote["source"],
        "ts": quote["ts"],
    }


def contract_depth_to_response(depth: dict[str, Any]) -> dict[str, Any]:
    quote_freshness = depth.get("quote_freshness") or _quote_freshness_for_payload(depth)
    quote_source = depth.get("quote_source") or depth.get("source") or "UNKNOWN"
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
        "quote_freshness": quote_freshness,
        "quote_source": quote_source,
        "depth_mode": depth.get("depth_mode") or DEPTH_MODE_FULL_DEPTH,
        "closed_market_execution_mode": depth.get("closed_market_execution_mode") or "DISABLED",
        "executable": bool(depth.get("executable") if depth.get("executable") is not None else _payload_quote_executable({**depth, "quote_freshness": quote_freshness})),
        "is_realtime": bool(depth.get("is_realtime") if depth.get("is_realtime") is not None else quote_freshness == QUOTE_FRESHNESS_LIVE),
        "last_good_at": depth.get("last_good_at"),
        "spread_x": _format_decimal(_to_decimal(depth.get("spread_x")) or Decimal("0")),
        "manual_spread_x": _format_decimal(_to_decimal(depth.get("manual_spread_x")) or Decimal("0")),
        "effective_total_spread": _format_decimal(_to_decimal(depth.get("effective_total_spread")) or Decimal("0")),
        "single_side_spread_fee_price": _format_decimal(_to_decimal(depth.get("single_side_spread_fee_price")) or Decimal("0")),
        "bids": _format_depth_levels(depth["bids"]),
        "asks": _format_depth_levels(depth["asks"]),
        "raw_bids": _format_depth_levels(depth["raw_bids"]) if depth.get("raw_bids") is not None else None,
        "raw_asks": _format_depth_levels(depth["raw_asks"]) if depth.get("raw_asks") is not None else None,
        "bid": _format_decimal(depth["best_bid"]) if depth.get("best_bid") is not None else None,
        "ask": _format_decimal(depth["best_ask"]) if depth.get("best_ask") is not None else None,
        "best_bid": _format_decimal(depth["best_bid"]) if depth.get("best_bid") is not None else None,
        "best_ask": _format_decimal(depth["best_ask"]) if depth.get("best_ask") is not None else None,
        "raw_best_bid": _format_optional_decimal(_to_decimal(depth.get("raw_best_bid"))),
        "raw_best_ask": _format_optional_decimal(_to_decimal(depth.get("raw_best_ask"))),
        "source": depth["source"],
        "ts": depth["ts"],
    }


def get_contract_market_snapshot_authority(
    symbol: str,
    *,
    interval: str = "1m",
    refresh: bool = True,
) -> dict[str, Any]:
    """Return only Gateway-accepted domain snapshots for MarketView V2.

    Provider refresh remains owned by ContractMarketGateway. This function
    never returns the raw values produced by a provider refresh.
    """

    from app.schemas.contract_market_domain_snapshot import ContractMarketDomainName
    from app.services.contract_market_gateway import contract_market_gateway

    normalized_symbol = _normalize_symbol(symbol)
    normalized_interval = str(interval or "1m").strip() or "1m"
    warnings: list[str] = []
    if refresh:
        try:
            contract_market_gateway._refresh_market_once(normalized_symbol)
        except Exception as exc:
            warnings.append(f"snapshot_market_refresh_failed:{type(exc).__name__}")
        try:
            contract_market_gateway._refresh_kline_once(
                normalized_symbol,
                normalized_interval,
            )
        except Exception as exc:
            warnings.append(f"snapshot_kline_refresh_failed:{type(exc).__name__}")

    snapshots = {
        "ticker": contract_market_gateway.get_domain_snapshot(
            ContractMarketDomainName.TICKER,
            normalized_symbol,
        ),
        "depth": contract_market_gateway.get_domain_snapshot(
            ContractMarketDomainName.DEPTH,
            normalized_symbol,
        ),
        "trades": contract_market_gateway.get_domain_snapshot(
            ContractMarketDomainName.TRADES,
            normalized_symbol,
        ),
        "kline": contract_market_gateway.get_domain_snapshot(
            ContractMarketDomainName.KLINE,
            normalized_symbol,
            interval=normalized_interval,
        ),
    }
    return {
        **snapshots,
        "warnings": warnings,
    }


def _contract_market_view_category(
    contract_symbol: Any,
    quote: Optional[dict[str, Any]],
    depth: Optional[dict[str, Any]],
) -> str:
    raw_category = (
        getattr(contract_symbol, "category", None)
        or (quote or {}).get("category")
        or (depth or {}).get("category")
        or ""
    )
    category = str(raw_category).strip().upper()
    if category in {"GOLD", "SILVER", "METALS"}:
        return "METAL"
    if category in {"FUTURE", "FUTURES", "OIL", "ENERGY"}:
        return "COMMODITY"
    if category:
        return category
    provider = str(
        getattr(contract_symbol, "provider", None)
        or (quote or {}).get("provider")
        or (depth or {}).get("provider")
        or ""
    ).strip().upper()
    return "CRYPTO" if provider == "BINANCE" else "INTERNAL"


def get_contract_market_view_legacy_inputs(
    db: Session,
    symbol: str,
) -> dict[str, Any]:
    """Preserve the pre-C-3 provider path for order execution only.

    Public MarketView V2 must use ``get_contract_market_snapshot_authority``.
    Keeping this adapter separate prevents the order execution path from being
    silently migrated to new authority semantics in Phase C-3.
    """

    normalized_symbol = _normalize_symbol(symbol)
    contract_symbol = (
        db.query(ContractSymbol)
        .filter(ContractSymbol.symbol == normalized_symbol)
        .first()
    )
    quote: Optional[dict[str, Any]] = None
    depth: Optional[dict[str, Any]] = None
    latest_kline: Optional[dict[str, Any]] = None
    latest_trade: Optional[dict[str, Any]] = None
    warnings: list[str] = []

    try:
        quote = get_contract_quote(
            db,
            normalized_symbol,
            log_context="contract_market_view_quote",
        )
    except ContractSymbolNotFound:
        if contract_symbol is None:
            raise
        warnings.append("quote_unavailable")
    except Exception as exc:
        warnings.append(f"quote_unavailable:{type(exc).__name__}")

    try:
        depth = get_contract_depth(db, normalized_symbol, limit=5)
    except ContractSymbolNotFound:
        if contract_symbol is None and quote is None:
            raise
        warnings.append("depth_unavailable")
    except Exception as exc:
        warnings.append(f"depth_unavailable:{type(exc).__name__}")

    try:
        recent_trades = get_contract_recent_trades(
            db,
            normalized_symbol,
            limit=1,
        )
        first_trade = recent_trades[0] if recent_trades else None
        if (
            isinstance(first_trade, dict)
            and str(first_trade.get("price_source") or "").strip().upper()
            == PRICE_SOURCE_TRADE_TICK
        ):
            latest_trade = first_trade
    except Exception as exc:
        warnings.append(f"trade_tick_unavailable:{type(exc).__name__}")

    category = _contract_market_view_category(contract_symbol, quote, depth)
    provider = str(
        getattr(contract_symbol, "provider", None)
        or (quote or {}).get("provider")
        or (depth or {}).get("provider")
        or ""
    ).strip().upper()
    should_load_current_kline = (
        category
        in {
            "STOCK",
            "FOREX",
            "METAL",
            "GOLD",
            "COMMODITY",
            "FUTURES",
            "INDEX",
            "CFD",
        }
        and category != "CRYPTO"
        and provider != "BINANCE"
    )
    if should_load_current_kline:
        try:
            rows = get_contract_klines(
                db,
                symbol=normalized_symbol,
                interval="1m",
                limit=1,
            )
            latest_kline = rows[-1] if rows else None
        except Exception as exc:
            warnings.append(f"kline_unavailable:{type(exc).__name__}")

    return {
        "symbol": normalized_symbol,
        "contract_symbol": contract_symbol,
        "quote": quote,
        "depth": depth,
        "latest_kline": latest_kline,
        "latest_trade": latest_trade,
        "warnings": warnings,
    }
