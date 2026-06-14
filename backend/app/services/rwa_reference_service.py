from __future__ import annotations

import logging
import json
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models.rwa_reference_price import RwaReferencePrice

logger = logging.getLogger(__name__)


class RwaReferenceServiceError(RuntimeError):
    pass


class RwaReferenceConfigError(RwaReferenceServiceError):
    pass


class RwaReferenceUpstreamError(RwaReferenceServiceError):
    pass


class RwaReferenceMissingRateError(RwaReferenceServiceError):
    pass


class RwaReferenceBadRateError(RwaReferenceServiceError):
    pass


class RwaReferenceSymbolUnsupportedError(RwaReferenceServiceError):
    pass


class RwaReferencePlanUnsupportedError(RwaReferenceServiceError):
    pass


class RwaReferenceRateLimitedError(RwaReferencePlanUnsupportedError):
    pass


_CACHE_TTL_SECONDS = 60
_TIMESERIES_CHUNK_DAYS = 30
_IRON_SYMBOL_CANDIDATES = ("IRON62", "IRON")
_DEBUG_SYMBOL_CANDIDATES = ("IRON62", "IRON", "XIRON62", "IO62", "IRON_ORE")
_DEBUG_LOG_PATH = Path(__file__).resolve().parents[2] / "rwa_symbol_debug.log"
_IRON62_SYMBOL = "IRON62"
_DAILY_CACHE_KEY = "rwa:iron62:daily"
_cache_expires_at = 0.0
_cache_date: Optional[str] = None
_cache_value: Optional[Dict[str, Any]] = None
_kline_cache: Dict[Tuple[str, int], Tuple[float, Dict[str, Any]]] = {}
_daily_refresh_lock = threading.RLock()
_session = requests.Session()
_session.trust_env = False


def _format_decimal(value: Decimal, places: str = "0.00000001") -> str:
    quantized = value.quantize(Decimal(places))
    return format(quantized.normalize(), "f")


def _cache_date_key(value: Optional[date] = None) -> str:
    return (value or datetime.now(timezone.utc).date()).isoformat()


def _next_utc_midnight_epoch(value: Optional[date] = None) -> float:
    current_date = value or datetime.now(timezone.utc).date()
    next_day = current_date + timedelta(days=1)
    return datetime(next_day.year, next_day.month, next_day.day, tzinfo=timezone.utc).timestamp()


def _with_daily_cache_fields(result: Dict[str, Any], cache_date: str) -> Dict[str, Any]:
    payload = dict(result)
    mfc_reference_price = payload.get("mfc_usdt_price")
    if mfc_reference_price is not None:
        payload["mfc_reference_price"] = mfc_reference_price
    payload["cache_key"] = _DAILY_CACHE_KEY
    payload["cache_date"] = cache_date
    return payload


def _store_daily_memory_cache(result: Dict[str, Any], cache_date: str) -> Dict[str, Any]:
    global _cache_date, _cache_expires_at, _cache_value

    payload = _with_daily_cache_fields(result, cache_date)
    _cache_date = cache_date
    _cache_value = dict(payload)
    _cache_expires_at = _next_utc_midnight_epoch(date.fromisoformat(cache_date))
    return payload


def _get_daily_memory_cache(cache_date: str) -> Optional[Dict[str, Any]]:
    now = time.time()
    if _cache_value is not None and _cache_date == cache_date and now < _cache_expires_at:
        logger.info("[RWA_CACHE_HIT] key=%s cache_date=%s source=memory", _DAILY_CACHE_KEY, cache_date)
        return dict(_cache_value)
    return None


def _clear_daily_memory_cache() -> None:
    global _cache_date, _cache_expires_at, _cache_value

    _cache_date = None
    _cache_value = None
    _cache_expires_at = 0.0


def _mask_url_access_key(url: str) -> str:
    parsed = urlparse(url)
    query = [
        (key, "***" if key == "access_key" else value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
    ]
    return urlunparse(parsed._replace(query=urlencode(query)))


def _prepare_masked_url(url: str, params: Dict[str, Any]) -> str:
    request = requests.Request("GET", url, params=params).prepare()
    return _mask_url_access_key(str(request.url or url))


def _write_debug_log(message: str) -> None:
    try:
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with _DEBUG_LOG_PATH.open("a", encoding="utf-8") as file:
            file.write(f"[{timestamp}] {message}\n")
    except OSError as exc:
        logger.warning("rwa_debug_log_write_failed path=%s error=%r", _DEBUG_LOG_PATH, exc)


def _normalize_price_key(value: Any) -> str:
    try:
        return _format_decimal(Decimal(str(value).strip()))
    except (InvalidOperation, AttributeError):
        return str(value).strip()


def _with_kline_summary(result: Dict[str, Any]) -> Dict[str, Any]:
    items = result.get("items") if isinstance(result.get("items"), list) else []
    prices = [
        str(item.get("price")).strip()
        for item in items
        if isinstance(item, dict) and str(item.get("price") or "").strip()
    ]
    result["items_length"] = len(items)
    result["first_price"] = prices[0] if prices else None
    result["last_price"] = prices[-1] if prices else None
    result["unique_price_count"] = len({_normalize_price_key(price) for price in prices})
    return result


def _response_sample(payload: Any) -> Any:
    if isinstance(payload, dict):
        sample: Dict[str, Any] = {}
        for key in ("success", "base", "date", "timestamp", "rates", "error"):
            if key not in payload:
                continue
            value = payload.get(key)
            if key == "rates" and isinstance(value, dict):
                sample[key] = {
                    "keys": list(value.keys())[:10],
                    "sample": {rate_key: value[rate_key] for rate_key in list(value.keys())[:3]},
                }
            else:
                sample[key] = value
        return sample
    return payload


def _endpoint_debug_summary(
    *,
    endpoint: str,
    symbol: str,
    url: str,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    masked_url = _prepare_masked_url(url, params)
    logger.info("rwa_debug_request endpoint=%s symbol=%s url=%s", endpoint, symbol, masked_url)
    _write_debug_log(f"REQUEST endpoint={endpoint} symbol={symbol} url={masked_url}")

    try:
        response = _session.get(url, params=params, timeout=10)
    except requests.RequestException as exc:
        logger.warning("rwa_debug_request_failed endpoint=%s symbol=%s error=%r", endpoint, symbol, exc)
        _write_debug_log(f"ERROR endpoint={endpoint} symbol={symbol} error={repr(exc)}")
        return {
            "endpoint": endpoint,
            "symbol": symbol,
            "url": masked_url,
            "http_status": None,
            "success": False,
            "has_rate": False,
            "response_keys": [],
            "sample": {"error": repr(exc)},
        }

    body_preview = response.text[:2000]
    logger.info(
        "rwa_debug_response endpoint=%s symbol=%s status=%s body_preview=%s",
        endpoint,
        symbol,
        response.status_code,
        body_preview,
    )
    _write_debug_log(
        f"RESPONSE endpoint={endpoint} symbol={symbol} status={response.status_code} body_preview={body_preview}"
    )

    try:
        payload: Any = response.json()
    except ValueError:
        payload = {"raw_text": body_preview}

    rates = payload.get("rates") if isinstance(payload, dict) else None
    has_rate = False
    if endpoint == "latest":
        has_rate = isinstance(rates, dict) and symbol in rates
    elif endpoint == "timeseries" and isinstance(rates, dict):
        has_rate = any(isinstance(row, dict) and symbol in row for row in rates.values())

    response_keys = list(payload.keys()) if isinstance(payload, dict) else []
    return {
        "endpoint": endpoint,
        "symbol": symbol,
        "url": masked_url,
        "http_status": response.status_code,
        "success": bool(isinstance(payload, dict) and payload.get("success") is True),
        "has_rate": has_rate,
        "response_keys": response_keys,
        "sample": _response_sample(payload),
    }


def _timestamp_to_iso(timestamp: Any) -> str:
    try:
        ts = int(timestamp)
        if ts > 0:
            return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError, OverflowError):
        pass
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _date_to_unix_seconds(value: str) -> int:
    dt = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _decimal_from_rate(value: Any) -> Decimal:
    try:
        rate = Decimal(str(value).strip())
    except (InvalidOperation, AttributeError):
        raise RwaReferenceBadRateError("rates.IRON62 is not a valid decimal")
    if rate <= 0:
        raise RwaReferenceBadRateError("rates.IRON62 must be greater than zero")
    return rate


def _convert_iron62_rate(raw_rate: Decimal) -> tuple[Decimal, str]:
    if raw_rate < Decimal("1"):
        return Decimal("1") / raw_rate, "inverse_rate"

    if Decimal("50") <= raw_rate <= Decimal("500"):
        return raw_rate, "direct_rate"

    return raw_rate, "direct_rate_unusual"


def _iron62_rate_to_usd_per_ton(raw_rate: Any) -> Decimal:
    usd_per_ton, _debug_note = _convert_iron62_rate(_decimal_from_rate(raw_rate))
    return usd_per_ton


def _manual_usd_per_ton() -> Optional[Decimal]:
    raw = str(
        getattr(settings, "RWA_IRON62_MANUAL_USD_PER_TON", None)
        or os.getenv("RWA_IRON62_MANUAL_USD_PER_TON", "")
        or ""
    ).strip()
    if not raw:
        return None
    try:
        value = Decimal(raw)
    except InvalidOperation:
        logger.warning("rwa_iron62_manual_fallback_invalid value=%s", raw)
        return None
    if value <= 0:
        logger.warning("rwa_iron62_manual_fallback_not_positive value=%s", raw)
        return None
    return value


def _build_manual_iron62_reference(reason: str = "manual_fallback") -> Optional[Dict[str, Any]]:
    usd_per_ton = _manual_usd_per_ton()
    if usd_per_ton is None:
        return None
    mfc_usdt_price = usd_per_ton / Decimal("1000")
    return {
        "success": True,
        "reference_symbol": "IRON62/USD",
        "raw_rate": _format_decimal(usd_per_ton),
        "iron62_usd_per_ton": _format_decimal(usd_per_ton),
        "display_price": _format_decimal(usd_per_ton),
        "display_unit": "USD/吨",
        "usd_per_ton": _format_decimal(usd_per_ton),
        "mfc_usdt_price": _format_decimal(mfc_usdt_price),
        "unit": "USD/吨",
        "source": "manual",
        "source_status": "manual_fallback",
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "debug_note": f"manual_fallback:{reason}",
    }


def _is_missing_rwa_reference_table_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "rwa_reference_prices" in message
        and (
            "doesn't exist" in message
            or "does not exist" in message
            or "no such table" in message
            or "undefined table" in message
        )
    )


def _manual_reference_for_missing_table(db: Session, exc: Exception) -> Dict[str, Any]:
    db.rollback()
    logger.warning("rwa_reference_prices table missing, fallback to manual price")
    manual = _build_manual_iron62_reference("rwa_reference_prices_table_missing")
    if manual is None:
        raise RwaReferenceConfigError("RWA_IRON62_MANUAL_USD_PER_TON is not configured") from exc
    return manual


def _build_manual_iron62_kline(limit: int) -> Optional[Dict[str, Any]]:
    reference = _build_manual_iron62_reference("kline_manual_fallback")
    if reference is None:
        return None

    latest_price = Decimal(str(reference["iron62_usd_per_ton"]))
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=max(limit - 1, 0))

    items: List[Dict[str, str]] = []
    for idx in range(limit):
        day = start + timedelta(days=idx)
        ts = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())
        items.append({"time": ts, "price": _format_decimal(latest_price)})

    return _with_kline_summary({
        "symbol": "IRON62",
        "mapped_symbol": "MFCUSDT",
        "unit": "USD/吨",
        "source": "manual",
        "source_status": "manual_fallback",
        "items": items,
    })


def _classify_unsupported_payload(payload: Any, rates: Any = None) -> RwaReferenceServiceError:
    error = payload.get("error") if isinstance(payload, dict) else None
    error_code = str(error.get("code") or "") if isinstance(error, dict) else ""
    error_type = str(error.get("type") or "").lower() if isinstance(error, dict) else ""
    error_info = str(error.get("info") or "").lower() if isinstance(error, dict) else ""
    combined = f"{error_code} {error_type} {error_info}"
    if any(token in combined for token in ("request_limit", "rate_limit", "too_many", "quota", "free_trial_50")):
        return RwaReferenceRateLimitedError("commodities-api request limit reached")
    if any(token in combined for token in ("plan", "subscription", "access_restricted", "not_allowed")):
        return RwaReferencePlanUnsupportedError("commodities-api plan does not support IRON62")
    if any(token in combined for token in ("symbol", "unsupported", "invalid")):
        return RwaReferenceSymbolUnsupportedError("commodities-api symbol IRON62 is unsupported")
    if isinstance(rates, dict):
        return RwaReferenceSymbolUnsupportedError("rates.IRON62 is missing")
    return RwaReferenceMissingRateError("rates.IRON62 is missing")


def _safe_latest_url(base_url: str, symbols: str) -> str:
    return f"{base_url}/latest?access_key=***&base=USD&symbols={symbols}"


def _extract_iron_rate(rates: Any) -> tuple[str, Any]:
    if not isinstance(rates, dict):
        raise RwaReferenceMissingRateError("rates is missing")
    for symbol in _IRON_SYMBOL_CANDIDATES:
        if symbol in rates:
            return symbol, rates[symbol]
    raise RwaReferenceMissingRateError("rates.IRON62 is missing")


def _request_latest_payload(base_url: str, api_key: str, symbol: str) -> Dict[str, Any]:
    url = f"{base_url}/latest"
    params = {
        "access_key": api_key,
        "base": "USD",
        "symbols": symbol,
    }
    logger.info("rwa_iron62_reference_request url=%s", _safe_latest_url(base_url, symbol))
    try:
        response = _session.get(url, params=params, timeout=6)
    except requests.RequestException as exc:
        logger.warning("rwa_iron62_reference_request_failed symbol=%s error=%r", symbol, exc)
        raise RwaReferenceUpstreamError("commodities-api request failed")

    logger.info(
        "rwa_iron62_reference_http_response symbol=%s status=%s body_preview=%s",
        symbol,
        response.status_code,
        response.text[:1000],
    )

    try:
        payload = response.json()
    except ValueError as exc:
        logger.warning("rwa_iron62_reference_bad_json symbol=%s error=%r body=%s", symbol, exc, response.text[:1000])
        raise RwaReferenceUpstreamError("commodities-api returned invalid json")

    if response.status_code >= 400:
        logger.warning(
            "rwa_iron62_reference_http_error symbol=%s status=%s body_preview=%s",
            symbol,
            response.status_code,
            response.text[:1000],
        )
        if isinstance(payload, dict):
            raise _classify_unsupported_payload(payload)
        raise RwaReferenceUpstreamError("commodities-api returned an error")

    if not isinstance(payload, dict):
        raise RwaReferenceUpstreamError("commodities-api response was not an object")

    return payload


def _commodities_api_config() -> tuple[str, str]:
    api_key = str(settings.COMMODITIES_API_KEY or "").strip()
    if not api_key:
        logger.warning(
            "rwa_commodities_api_config base_url=%s key_present=%s key_length=%s",
            str(settings.COMMODITIES_API_BASE_URL or "").strip().rstrip("/") or "https://commodities-api.com/api",
            False,
            0,
        )
        raise RwaReferenceConfigError("COMMODITIES_API_KEY is not configured")

    base_url = str(settings.COMMODITIES_API_BASE_URL or "").strip().rstrip("/")
    if not base_url:
        base_url = "https://commodities-api.com/api"
    logger.info(
        "rwa_commodities_api_config base_url=%s key_present=%s key_length=%s",
        base_url,
        True,
        len(api_key),
    )
    return base_url, api_key


def debug_iron62_symbols() -> Dict[str, Any]:
    base_url, api_key = _commodities_api_config()
    parsed = urlparse(base_url)
    end_date = datetime.now(timezone.utc).date()
    start_date = end_date - timedelta(days=6)

    results: List[Dict[str, Any]] = []
    for symbol in _DEBUG_SYMBOL_CANDIDATES:
        latest = _endpoint_debug_summary(
            endpoint="latest",
            symbol=symbol,
            url=f"{base_url}/latest",
            params={
                "access_key": api_key,
                "base": "USD",
                "symbols": symbol,
            },
        )
        timeseries = _endpoint_debug_summary(
            endpoint="timeseries",
            symbol=symbol,
            url=f"{base_url}/timeseries",
            params={
                "access_key": api_key,
                "base": "USD",
                "symbols": symbol,
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
            },
        )
        results.append({
            "symbol": symbol,
            "success": bool(latest.get("success") or timeseries.get("success")),
            "has_rate": bool(latest.get("has_rate") or timeseries.get("has_rate")),
            "response_keys": sorted(set(latest.get("response_keys") or []) | set(timeseries.get("response_keys") or [])),
            "sample": {
                "latest": latest.get("sample"),
                "timeseries": timeseries.get("sample"),
            },
            "latest": latest,
            "timeseries": timeseries,
        })

    return {
        "base_url": base_url,
        "hostname": parsed.netloc,
        "key_present": bool(api_key),
        "key_length": len(api_key),
        "log_file": str(_DEBUG_LOG_PATH),
        "timeseries_start_date": start_date.isoformat(),
        "timeseries_end_date": end_date.isoformat(),
        "symbols": results,
    }


def _extract_supported_symbol_entries(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {}

    raw_symbols = payload.get("symbols")
    if raw_symbols is None:
        raw_symbols = payload.get("currencies")
    if raw_symbols is None:
        raw_symbols = payload.get("data")

    if isinstance(raw_symbols, dict):
        return {str(key): value for key, value in raw_symbols.items()}

    if isinstance(raw_symbols, list):
        entries: Dict[str, Any] = {}
        for idx, item in enumerate(raw_symbols):
            if isinstance(item, dict):
                key = (
                    item.get("symbol")
                    or item.get("code")
                    or item.get("name")
                    or item.get("id")
                    or f"item_{idx}"
                )
                entries[str(key)] = item
            else:
                entries[str(item)] = item
        return entries

    return {}


def debug_supported_symbols() -> Dict[str, Any]:
    base_url, api_key = _commodities_api_config()
    parsed = urlparse(base_url)
    url = f"{base_url}/symbols"
    params = {"access_key": api_key}
    masked_url = _prepare_masked_url(url, params)
    logger.info("rwa_debug_supported_symbols_request url=%s", masked_url)
    _write_debug_log(f"REQUEST endpoint=symbols url={masked_url}")

    try:
        response = _session.get(url, params=params, timeout=10)
    except requests.RequestException as exc:
        logger.warning("rwa_debug_supported_symbols_request_failed error=%r", exc)
        _write_debug_log(f"ERROR endpoint=symbols error={repr(exc)}")
        return {
            "base_url": base_url,
            "hostname": parsed.netloc,
            "url": masked_url,
            "http_status": None,
            "success": False,
            "matched_symbols": {},
            "total_symbols": 0,
            "has_iron62": False,
            "sample": {"error": repr(exc)},
        }

    body_preview = response.text[:2000]
    logger.info(
        "rwa_debug_supported_symbols_response status=%s body_preview=%s",
        response.status_code,
        body_preview,
    )
    _write_debug_log(
        f"RESPONSE endpoint=symbols status={response.status_code} body_preview={body_preview}"
    )

    try:
        payload: Any = response.json()
    except ValueError:
        payload = {"raw_text": body_preview}

    entries = _extract_supported_symbol_entries(payload)
    search_terms = ("IRON", "IRON62", "ORE", "IO62", "STEEL")
    matched_symbols: Dict[str, Any] = {}
    for symbol, value in entries.items():
        haystack = f"{symbol} {value}".upper()
        if any(term in haystack for term in search_terms):
            matched_symbols[symbol] = value

    has_iron62 = any(
        str(symbol).upper() == "IRON62" or "IRON62" in f"{symbol} {value}".upper()
        for symbol, value in entries.items()
    )

    return {
        "base_url": base_url,
        "hostname": parsed.netloc,
        "url": masked_url,
        "http_status": response.status_code,
        "success": bool(isinstance(payload, dict) and payload.get("success") is True),
        "matched_symbols": matched_symbols,
        "total_symbols": len(entries),
        "has_iron62": has_iron62,
        "response_keys": list(payload.keys()) if isinstance(payload, dict) else [],
        "sample": _response_sample(payload),
    }


def _utc_now() -> datetime:
    return datetime.utcnow()


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


def _iso_utc(value: Optional[datetime]) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _find_today_rwa_record(db: Session, trade_date: date) -> Optional[RwaReferencePrice]:
    return (
        db.query(RwaReferencePrice)
        .filter(RwaReferencePrice.symbol == _IRON62_SYMBOL)
        .filter(RwaReferencePrice.trade_date == trade_date)
        .first()
    )


def _find_today_success_record(db: Session, trade_date: date) -> Optional[RwaReferencePrice]:
    return (
        db.query(RwaReferencePrice)
        .filter(RwaReferencePrice.symbol == _IRON62_SYMBOL)
        .filter(RwaReferencePrice.trade_date == trade_date)
        .filter(RwaReferencePrice.status == "SUCCESS")
        .first()
    )


def _find_latest_success_record(db: Session) -> Optional[RwaReferencePrice]:
    return (
        db.query(RwaReferencePrice)
        .filter(RwaReferencePrice.symbol == _IRON62_SYMBOL)
        .filter(RwaReferencePrice.status == "SUCCESS")
        .order_by(RwaReferencePrice.trade_date.desc(), RwaReferencePrice.fetched_at.desc(), RwaReferencePrice.id.desc())
        .first()
    )


def _reference_from_record(record: RwaReferencePrice, source_status: str) -> Dict[str, Any]:
    usd_per_ton = _q_decimal(record.price_usd_per_ton)
    mfc_usdt_price = usd_per_ton / Decimal("1000")
    return {
        "success": True,
        "reference_symbol": "IRON62/USD",
        "raw_rate": _format_decimal(usd_per_ton),
        "iron62_usd_per_ton": _format_decimal(usd_per_ton),
        "display_price": _format_decimal(usd_per_ton),
        "display_unit": "USD/鍚?",
        "usd_per_ton": _format_decimal(usd_per_ton),
        "mfc_usdt_price": _format_decimal(mfc_usdt_price),
        "unit": "USD/鍚?",
        "source": str(record.source or "COMMODITIES_API").lower().replace("_", "-"),
        "source_status": source_status,
        "trade_date": record.trade_date.isoformat(),
        "updated_at": _iso_utc(record.fetched_at),
        "debug_note": f"db_{source_status}",
    }


def _cached_iron62_reference_without_external(
    db: Session,
    *,
    target_date: date,
    fallback_reason: str,
) -> Dict[str, Any]:
    cache_date = _cache_date_key(target_date)
    try:
        today_record = _find_today_success_record(db, target_date)
        if today_record is not None:
            result = _reference_from_record(today_record, "cached_today")
            logger.info(
                "[RWA_CACHE_HIT] key=%s cache_date=%s source=db_today record_id=%s",
                _DAILY_CACHE_KEY,
                cache_date,
                int(today_record.id),
            )
            return _store_daily_memory_cache(result, cache_date)

        latest_record = _find_latest_success_record(db)
        if latest_record is not None:
            result = _reference_from_record(latest_record, "last_good")
            logger.warning(
                "[RWA_CACHE_FALLBACK] key=%s cache_date=%s reason=%s "
                "last_good_trade_date=%s record_id=%s",
                _DAILY_CACHE_KEY,
                cache_date,
                fallback_reason,
                latest_record.trade_date.isoformat(),
                int(latest_record.id),
            )
            return _store_daily_memory_cache(result, cache_date)

        result = _build_manual_iron62_reference(fallback_reason)
        if result is None:
            raise RwaReferenceConfigError("RWA_IRON62_MANUAL_USD_PER_TON is not configured")
        logger.warning(
            "[RWA_CACHE_FALLBACK] key=%s cache_date=%s reason=%s source=manual",
            _DAILY_CACHE_KEY,
            cache_date,
            fallback_reason,
        )
        return _store_daily_memory_cache(result, cache_date)
    except (ProgrammingError, OperationalError) as exc:
        if not _is_missing_rwa_reference_table_error(exc):
            raise
        result = _manual_reference_for_missing_table(db, exc)
        logger.warning(
            "[RWA_CACHE_FALLBACK] key=%s cache_date=%s reason=rwa_reference_prices_table_missing source=manual",
            _DAILY_CACHE_KEY,
            cache_date,
        )
        return _store_daily_memory_cache(result, cache_date)


def _q_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _successful_records_for_kline(db: Session, limit: int) -> List[RwaReferencePrice]:
    return list(
        reversed(
            db.query(RwaReferencePrice)
            .filter(RwaReferencePrice.symbol == _IRON62_SYMBOL)
            .filter(RwaReferencePrice.status == "SUCCESS")
            .filter(RwaReferencePrice.price_usd_per_ton.isnot(None))
            .order_by(RwaReferencePrice.trade_date.desc(), RwaReferencePrice.fetched_at.desc(), RwaReferencePrice.id.desc())
            .limit(limit)
            .all()
        )
    )


def _upsert_rwa_reference_record(
    db: Session,
    *,
    trade_date: date,
    source: str,
    status: str,
    price_usd_per_ton: Optional[Decimal] = None,
    raw_payload: Any = None,
    error_message: Optional[str] = None,
) -> RwaReferencePrice:
    now = _utc_now()
    record = _find_today_rwa_record(db, trade_date)
    if record is None:
        record = RwaReferencePrice(
            source=source,
            symbol=_IRON62_SYMBOL,
            trade_date=trade_date,
            fetched_at=now,
            status=status,
            created_at=now,
            updated_at=now,
        )
        db.add(record)

    record.source = source
    record.status = status
    record.price_usd_per_ton = price_usd_per_ton
    record.fetched_at = now
    record.raw_payload_json = (
        json.dumps(raw_payload, ensure_ascii=False, default=str)[:60000]
        if raw_payload is not None
        else None
    )
    record.error_message = (error_message or "")[:1000] if error_message else None
    record.updated_at = now
    db.flush()
    return record


def refresh_iron62_reference_price(db: Session, *, trade_date: Optional[date] = None) -> Dict[str, Any]:
    with _daily_refresh_lock:
        return _refresh_iron62_reference_price_unlocked(db, trade_date=trade_date)


def _refresh_iron62_reference_price_unlocked(db: Session, *, trade_date: Optional[date] = None) -> Dict[str, Any]:
    global _cache_date, _cache_expires_at, _cache_value

    target_date = trade_date or _utc_today()
    cache_date = _cache_date_key(target_date)
    try:
        existing_today = _find_today_rwa_record(db, target_date)
    except (ProgrammingError, OperationalError) as exc:
        if not _is_missing_rwa_reference_table_error(exc):
            raise
        manual = _manual_reference_for_missing_table(db, exc)
        return {
            "success": True,
            "skipped": True,
            "reason": "rwa_reference_prices_table_missing",
            "status": "MANUAL_FALLBACK",
            "trade_date": target_date.isoformat(),
            "price_usd_per_ton": manual["iron62_usd_per_ton"],
        }
    if existing_today and str(existing_today.source or "").upper() == "COMMODITIES_API":
        logger.info(
            "[RWA_CACHE_HIT] key=%s cache_date=%s source=db_today_attempt status=%s record_id=%s",
            _DAILY_CACHE_KEY,
            cache_date,
            existing_today.status,
            int(existing_today.id),
        )
        return {
            "success": existing_today.status == "SUCCESS",
            "skipped": True,
            "reason": "already_fetched_today",
            "status": existing_today.status,
            "trade_date": target_date.isoformat(),
            "record_id": int(existing_today.id),
        }

    logger.info("[RWA_CACHE_REFRESH] key=%s cache_date=%s source=commodities-api", _DAILY_CACHE_KEY, cache_date)
    _upsert_rwa_reference_record(
        db,
        trade_date=target_date,
        source="COMMODITIES_API",
        status="FAILED",
        price_usd_per_ton=None,
        raw_payload=None,
        error_message="fetch started",
    )

    try:
        live = _get_iron62_reference_price_live()
        price = _q_decimal(live.get("iron62_usd_per_ton") or live.get("usd_per_ton"))
        record = _upsert_rwa_reference_record(
            db,
            trade_date=target_date,
            source="COMMODITIES_API",
            status="SUCCESS",
            price_usd_per_ton=price,
            raw_payload=live.get("_raw_payload") or live,
            error_message=None,
        )
        _store_daily_memory_cache(_reference_from_record(record, "cached_today"), cache_date)
        _kline_cache.clear()
        return {
            "success": True,
            "skipped": False,
            "status": "SUCCESS",
            "trade_date": target_date.isoformat(),
            "record_id": int(record.id),
            "price_usd_per_ton": _format_decimal(price),
        }
    except Exception as exc:
        record = _upsert_rwa_reference_record(
            db,
            trade_date=target_date,
            source="COMMODITIES_API",
            status="FAILED",
            price_usd_per_ton=None,
            raw_payload=None,
            error_message=f"{type(exc).__name__}: {exc}",
        )
        _clear_daily_memory_cache()
        logger.warning(
            "[RWA_CACHE_FALLBACK] key=%s cache_date=%s reason=external_refresh_failed error=%r",
            _DAILY_CACHE_KEY,
            cache_date,
            exc,
        )
        return {
            "success": False,
            "skipped": False,
            "status": "FAILED",
            "trade_date": target_date.isoformat(),
            "record_id": int(record.id),
            "error_message": f"{type(exc).__name__}: {exc}",
        }


def get_iron62_reference_price(db: Session) -> Dict[str, Any]:
    target_date = _utc_today()
    cache_date = _cache_date_key(target_date)

    cached = _get_daily_memory_cache(cache_date)
    if cached is not None:
        return cached

    with _daily_refresh_lock:
        cached = _get_daily_memory_cache(cache_date)
        if cached is not None:
            return cached

        try:
            today_record = _find_today_rwa_record(db, target_date)
        except (ProgrammingError, OperationalError) as exc:
            if not _is_missing_rwa_reference_table_error(exc):
                raise
            result = _manual_reference_for_missing_table(db, exc)
            logger.warning(
                "[RWA_CACHE_FALLBACK] key=%s cache_date=%s reason=rwa_reference_prices_table_missing source=manual",
                _DAILY_CACHE_KEY,
                cache_date,
            )
            return _store_daily_memory_cache(result, cache_date)

        if today_record is not None:
            if today_record.status == "SUCCESS" and today_record.price_usd_per_ton is not None:
                result = _reference_from_record(today_record, "cached_today")
                logger.info(
                    "[RWA_CACHE_HIT] key=%s cache_date=%s source=db_today record_id=%s",
                    _DAILY_CACHE_KEY,
                    cache_date,
                    int(today_record.id),
                )
                return _store_daily_memory_cache(result, cache_date)

            return _cached_iron62_reference_without_external(
                db,
                target_date=target_date,
                fallback_reason=f"already_attempted_today_status_{today_record.status}",
            )

        refresh_result = refresh_iron62_reference_price(db, trade_date=target_date)
        try:
            db.commit()
        except Exception as exc:
            db.rollback()
            _clear_daily_memory_cache()
            logger.warning(
                "[RWA_CACHE_FALLBACK] key=%s cache_date=%s reason=refresh_commit_failed error=%r",
                _DAILY_CACHE_KEY,
                cache_date,
                exc,
            )
            return _cached_iron62_reference_without_external(
                db,
                target_date=target_date,
                fallback_reason="refresh_commit_failed",
            )
        if refresh_result.get("success") is True:
            today_success = _find_today_success_record(db, target_date)
            if today_success is not None:
                result = _reference_from_record(today_success, "cached_today")
                return _store_daily_memory_cache(result, cache_date)

        return _cached_iron62_reference_without_external(
            db,
            target_date=target_date,
            fallback_reason=str(refresh_result.get("error_message") or refresh_result.get("reason") or "refresh_failed"),
        )


def _get_iron62_reference_price_live() -> Dict[str, Any]:
    base_url, api_key = _commodities_api_config()
    last_error: Optional[RwaReferenceServiceError] = None
    payload: Dict[str, Any] = {}
    used_symbol = "IRON62"
    raw_rate_value: Any = None

    for symbol in _IRON_SYMBOL_CANDIDATES:
        try:
            payload = _request_latest_payload(base_url, api_key, symbol)
        except RwaReferenceRateLimitedError:
            raise
        except RwaReferenceServiceError as exc:
            last_error = exc
            continue

        if payload.get("success") is False:
            logger.warning("rwa_iron62_reference_unsuccessful symbol=%s payload=%s", symbol, payload)
            last_error = _classify_unsupported_payload(payload)
            if isinstance(last_error, RwaReferenceRateLimitedError):
                raise last_error
            continue

        rates = payload.get("rates")
        logger.info(
            "rwa_iron62_reference_rates_keys symbol=%s keys=%s",
            symbol,
            sorted(str(key) for key in rates.keys()) if isinstance(rates, dict) else None,
        )
        if isinstance(rates, dict) and symbol in rates:
            used_symbol = symbol
            raw_rate_value = rates[symbol]
            break
        last_error = _classify_unsupported_payload(payload, rates)
    else:
        if last_error is not None:
            raise last_error
        raise RwaReferenceMissingRateError("rates.IRON62 is missing")

    raw_rate = _decimal_from_rate(raw_rate_value)
    usd_per_ton, debug_note = _convert_iron62_rate(raw_rate)
    mfc_usdt_price = usd_per_ton / Decimal("1000")

    result: Dict[str, Any] = {
        "success": True,
        "reference_symbol": f"{used_symbol}/USD",
        "raw_rate": _format_decimal(raw_rate),
        "iron62_usd_per_ton": _format_decimal(usd_per_ton),
        "display_price": _format_decimal(usd_per_ton),
        "display_unit": "USD/吨",
        "usd_per_ton": _format_decimal(usd_per_ton),
        "mfc_usdt_price": _format_decimal(mfc_usdt_price),
        "unit": "USD/吨",
        "source": "commodities-api",
        "source_status": "live",
        "updated_at": _timestamp_to_iso(payload.get("timestamp")),
        "debug_note": debug_note if used_symbol == "IRON62" else f"{debug_note}:symbol_fallback_{used_symbol}",
        "_raw_payload": payload,
    }

    return result


def _parse_timeseries_items(payload: Dict[str, Any]) -> List[Dict[str, str]]:
    rates = payload.get("rates")
    if not isinstance(rates, dict):
        return []

    items: List[Dict[str, str]] = []
    for date_key, row in sorted(rates.items(), key=lambda item: str(item[0])):
        if not isinstance(row, dict):
            continue
        try:
            _used_symbol, raw_rate_value = _extract_iron_rate(row)
            price = _iron62_rate_to_usd_per_ton(raw_rate_value)
            ts = _date_to_unix_seconds(str(date_key))
        except (ValueError, RwaReferenceBadRateError, RwaReferenceMissingRateError):
            continue
        items.append({"time": ts, "price": _format_decimal(price)})
    return items


def _is_timeframe_too_long(response: requests.Response) -> bool:
    try:
        payload = response.json()
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    error = payload.get("error")
    if not isinstance(error, dict):
        return False
    return str(error.get("type") or "").strip().lower() == "timeframe_too_long"


def _is_request_limited(response: requests.Response) -> bool:
    if response.status_code == 429:
        return True
    try:
        payload = response.json()
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    classified = _classify_unsupported_payload(payload)
    return isinstance(classified, RwaReferenceRateLimitedError)


def _request_timeseries_chunk(
    base_url: str,
    api_key: str,
    start_date: datetime.date,
    end_date: datetime.date,
) -> List[Dict[str, str]]:
    url = f"{base_url}/timeseries"
    params = {
        "access_key": api_key,
        "base": "USD",
        "symbols": "IRON62",
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
    }
    response = _session.get(url, params=params, timeout=8)
    logger.info(
        "rwa_iron62_kline_http_response start_date=%s end_date=%s status=%s body_preview=%s",
        start_date.isoformat(),
        end_date.isoformat(),
        response.status_code,
        response.text[:300],
    )
    if response.status_code >= 400:
        if _is_request_limited(response):
            raise RwaReferenceRateLimitedError("commodities-api request limit reached")
        if _is_timeframe_too_long(response):
            raise RwaReferenceUpstreamError("commodities-api timeseries timeframe too long")
        logger.warning(
            "rwa_iron62_kline_http_error start_date=%s end_date=%s status=%s body_preview=%s",
            start_date.isoformat(),
            end_date.isoformat(),
            response.status_code,
            response.text[:300],
        )
        return []

    payload = response.json()
    rates = payload.get("rates") if isinstance(payload, dict) else None
    logger.info(
        "rwa_iron62_kline_rates_keys_sample=%s",
        list(sorted(str(key) for key in rates.keys())[:5]) if isinstance(rates, dict) else None,
    )
    if not isinstance(payload, dict) or payload.get("success") is False:
        return []
    return _parse_timeseries_items(payload)


def _fetch_timeseries_items(
    base_url: str,
    api_key: str,
    start_date: datetime.date,
    end_date: datetime.date,
    chunk_days: int,
) -> List[Dict[str, str]]:
    items: List[Dict[str, str]] = []
    cursor = start_date
    while cursor <= end_date:
        chunk_end = min(cursor + timedelta(days=max(chunk_days - 1, 0)), end_date)
        items.extend(_request_timeseries_chunk(base_url, api_key, cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    return items


def _fallback_kline_from_latest(db: Session, limit: int) -> Dict[str, Any]:
    manual = _build_manual_iron62_reference("kline_latest_unavailable")
    try:
        latest = get_iron62_reference_price(db)
    except RwaReferenceServiceError:
        if manual is None:
            raise
        latest = manual
    latest_price = Decimal(str(latest.get("iron62_usd_per_ton") or latest["usd_per_ton"]))
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=max(limit - 1, 0))

    items: List[Dict[str, str]] = []
    for idx in range(limit):
        day = start + timedelta(days=idx)
        ts = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())
        items.append({"time": ts, "price": _format_decimal(latest_price)})

    return _with_kline_summary({
        "symbol": "IRON62",
        "mapped_symbol": "MFCUSDT",
        "unit": "USD/吨",
        "source": latest.get("source", "commodities-api"),
        "source_status": "manual_fallback" if latest.get("source_status") == "manual_fallback" else "fallback_from_latest",
        "items": items,
    })


def get_iron62_reference_kline(db: Session, interval: str = "1d", limit: int = 120) -> Dict[str, Any]:
    normalized_interval = str(interval or "1d").strip().lower()
    normalized_limit = max(1, min(int(limit or 120), 365))
    cache_key = (normalized_interval, normalized_limit)
    now = time.time()
    cached = _kline_cache.get(cache_key)
    if cached and now < cached[0]:
        logger.info(
            "[RWA_CACHE_HIT] key=%s:kline interval=%s limit=%s source=memory",
            _DAILY_CACHE_KEY,
            normalized_interval,
            normalized_limit,
        )
        return dict(cached[1])

    if normalized_interval != "1d":
        normalized_interval = "1d"

    try:
        records = _successful_records_for_kline(db, normalized_limit)
    except (ProgrammingError, OperationalError) as exc:
        if not _is_missing_rwa_reference_table_error(exc):
            raise
        manual = _manual_reference_for_missing_table(db, exc)
        result = _build_manual_iron62_kline(normalized_limit)
        if result is None:
            raise RwaReferenceConfigError("RWA_IRON62_MANUAL_USD_PER_TON is not configured") from exc
        result["updated_at"] = manual["updated_at"]
        _kline_cache[cache_key] = (now + _CACHE_TTL_SECONDS, dict(result))
        return result

    items = [
        {
            "time": int(
                datetime(
                    record.trade_date.year,
                    record.trade_date.month,
                    record.trade_date.day,
                    tzinfo=timezone.utc,
                ).timestamp()
            ),
            "price": _format_decimal(_q_decimal(record.price_usd_per_ton)),
        }
        for record in records
        if record.price_usd_per_ton is not None
    ]
    if len(items) >= 2:
        result = _with_kline_summary({
            "symbol": "IRON62",
            "mapped_symbol": "MFCUSDT",
            "unit": "USD/吨",
            "source": "database",
            "source_status": "cached_success",
            "items": items[-normalized_limit:],
        })
        _kline_cache[cache_key] = (now + _CACHE_TTL_SECONDS, dict(result))
        return result

    result = _fallback_kline_from_latest(db, normalized_limit)
    _kline_cache[cache_key] = (now + _CACHE_TTL_SECONDS, dict(result))
    return result
