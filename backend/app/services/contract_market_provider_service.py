from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

import requests
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session


logger = logging.getLogger(__name__)

MARKET_TYPE_CONTRACT = "CONTRACT"
MARKET_TYPE_SPOT = "SPOT"
PROVIDER_OKX_SWAP = "OKX_SWAP"
PROVIDER_BITGET_USDT_FUTURES = "BITGET_USDT_FUTURES"
PROVIDER_BINANCE_USDM = "BINANCE_USDM"
PROVIDER_OKX_SPOT = "OKX_SPOT"
PROVIDER_BITGET_SPOT = "BITGET_SPOT"
PROVIDER_BINANCE_SPOT = "BINANCE_SPOT"
PROVIDER_LAST_GOOD = "LAST_GOOD"
PROVIDER_INTERNAL = "INTERNAL"
HIDDEN_PROVIDER_CODES = {"MANUAL"}
EXTERNAL_PROVIDER_CODES = {PROVIDER_OKX_SWAP, PROVIDER_BITGET_USDT_FUTURES, PROVIDER_BINANCE_USDM}
EXTERNAL_SPOT_PROVIDER_CODES = {PROVIDER_OKX_SPOT, PROVIDER_BITGET_SPOT, PROVIDER_BINANCE_SPOT}
PROVIDER_CACHE_SECONDS = 30


@dataclass(frozen=True)
class MarketDataProviderConfig:
    provider_code: str
    provider_name: str
    market_type: str
    enabled: bool
    priority: int
    base_url: Optional[str]
    timeout_ms: int
    cooldown_seconds: int
    status: str = "UNKNOWN"
    last_check_at: Optional[datetime] = None
    last_success_at: Optional[datetime] = None
    last_error: Optional[str] = None


class MarketDataProviderError(RuntimeError):
    pass


class ProviderCooldownError(MarketDataProviderError):
    pass


def classify_market_provider_error(raw_error: str | None) -> str:
    text_value = str(raw_error or "").strip()
    if not text_value or text_value == "-":
        return "NONE"
    lowered = text_value.lower()
    if "provider is in cooldown" in lowered or "cooldown" in lowered:
        return "COOLDOWN"
    if (
        "http 451" in lowered
        or "restricted location" in lowered
        or "service unavailable from a restricted location" in lowered
    ):
        return "REGION_RESTRICTED"
    if "timeout" in lowered or "timed out" in lowered:
        return "TIMEOUT"
    if "429" in lowered or "rate limit" in lowered or "too many requests" in lowered:
        return "RATE_LIMITED"
    if "401" in lowered or "unauthorized" in lowered or "api key" in lowered:
        return "AUTH_FAILED"
    if "404" in lowered or "symbol not found" in lowered:
        return "SYMBOL_NOT_FOUND"
    if "dns" in lowered or "name resolution" in lowered or "nodename" in lowered:
        return "DNS_FAILED"
    if "connection" in lowered or "connect" in lowered:
        return "CONNECTION_FAILED"
    return "UNKNOWN"


def normalize_market_provider_error(raw_error: str | None) -> str:
    reason = classify_market_provider_error(raw_error)
    if reason == "NONE":
        return "-"
    if reason == "COOLDOWN":
        return "行情源暂时冷却中，系统稍后会自动重试。"
    if reason == "REGION_RESTRICTED":
        return "当前访问地区受行情源限制，建议保持该行情源停用或切换备用源。"
    if reason == "TIMEOUT":
        return "连接超时，请检查网络、代理或稍后重试。"
    if reason == "RATE_LIMITED":
        return "请求过于频繁，行情源已限流，稍后自动恢复。"
    if reason == "AUTH_FAILED":
        return "认证失败，请检查 API Key 或权限配置。"
    if reason == "SYMBOL_NOT_FOUND":
        return "交易对或标的不存在，请检查 symbol 映射。"
    if reason == "DNS_FAILED":
        return "域名解析失败，请检查行情源地址或网络。"
    if reason == "CONNECTION_FAILED":
        return "连接失败，请检查网络或行情源地址。"
    return "行情源测试失败，请检查配置或联系技术查看日志。"


DEFAULT_PROVIDER_CONFIGS: tuple[MarketDataProviderConfig, ...] = (
    MarketDataProviderConfig(
        provider_code=PROVIDER_OKX_SWAP,
        provider_name="OKX Swap",
        market_type=MARKET_TYPE_CONTRACT,
        enabled=True,
        priority=10,
        base_url="https://www.okx.com",
        timeout_ms=3000,
        cooldown_seconds=60,
    ),
    MarketDataProviderConfig(
        provider_code=PROVIDER_BITGET_USDT_FUTURES,
        provider_name="Bitget USDT Futures",
        market_type=MARKET_TYPE_CONTRACT,
        enabled=True,
        priority=20,
        base_url="https://api.bitget.com",
        timeout_ms=3000,
        cooldown_seconds=60,
    ),
    MarketDataProviderConfig(
        provider_code=PROVIDER_BINANCE_USDM,
        provider_name="Binance USDM Futures",
        market_type=MARKET_TYPE_CONTRACT,
        enabled=False,
        priority=30,
        base_url="https://fapi.binance.com",
        timeout_ms=3000,
        cooldown_seconds=300,
    ),
    MarketDataProviderConfig(
        provider_code=PROVIDER_LAST_GOOD,
        provider_name="Last Good Price",
        market_type=MARKET_TYPE_CONTRACT,
        enabled=True,
        priority=999,
        base_url=None,
        timeout_ms=3000,
        cooldown_seconds=0,
    ),
    MarketDataProviderConfig(
        provider_code=PROVIDER_OKX_SPOT,
        provider_name="OKX 现货行情",
        market_type=MARKET_TYPE_SPOT,
        enabled=True,
        priority=10,
        base_url="https://www.okx.com",
        timeout_ms=3000,
        cooldown_seconds=60,
    ),
    MarketDataProviderConfig(
        provider_code=PROVIDER_BITGET_SPOT,
        provider_name="Bitget 现货行情",
        market_type=MARKET_TYPE_SPOT,
        enabled=True,
        priority=20,
        base_url="https://api.bitget.com",
        timeout_ms=3000,
        cooldown_seconds=60,
    ),
    MarketDataProviderConfig(
        provider_code=PROVIDER_BINANCE_SPOT,
        provider_name="Binance 现货行情",
        market_type=MARKET_TYPE_SPOT,
        enabled=False,
        priority=30,
        base_url="https://api.binance.com",
        timeout_ms=3000,
        cooldown_seconds=300,
    ),
)

DEFAULT_SYMBOL_MAPPINGS: dict[tuple[str, str], str] = {
    (PROVIDER_OKX_SWAP, "BTCUSDT_PERP"): "BTC-USDT-SWAP",
    (PROVIDER_BITGET_USDT_FUTURES, "BTCUSDT_PERP"): "BTCUSDT",
    (PROVIDER_OKX_SWAP, "ETHUSDT_PERP"): "ETH-USDT-SWAP",
    (PROVIDER_BITGET_USDT_FUTURES, "ETHUSDT_PERP"): "ETHUSDT",
    (PROVIDER_OKX_SPOT, "BTCUSDT"): "BTC-USDT",
    (PROVIDER_BITGET_SPOT, "BTCUSDT"): "BTCUSDT",
    (PROVIDER_BINANCE_SPOT, "BTCUSDT"): "BTCUSDT",
    (PROVIDER_OKX_SPOT, "ETHUSDT"): "ETH-USDT",
    (PROVIDER_BITGET_SPOT, "ETHUSDT"): "ETHUSDT",
    (PROVIDER_BINANCE_SPOT, "ETHUSDT"): "ETHUSDT",
}

_provider_cache: dict[str, Any] = {"expires_at": 0.0, "items": None}
_symbol_cache: dict[str, Any] = {"expires_at": 0.0, "items": None}
_provider_cooldown_until: dict[str, datetime] = {}
_http_session = requests.Session()
_http_session.trust_env = False


def clear_contract_market_provider_cache() -> None:
    _provider_cache.clear()
    _symbol_cache["expires_at"] = 0.0
    _symbol_cache["items"] = None


def _normalize_provider_code(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def normalize_market_provider_base_url(value: Any, provider_code: str) -> Optional[str]:
    code = _normalize_provider_code(provider_code)
    text_value = str(value or "").strip()
    if code == PROVIDER_LAST_GOOD:
        return None
    if not text_value:
        raise ValueError("base_url is required")
    parsed = urlsplit(text_value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an http(s) origin")
    if parsed.query or parsed.fragment:
        raise ValueError("base_url cannot include query or fragment")
    if parsed.path not in ("", "/"):
        raise ValueError("base_url cannot include endpoint path")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def _default_provider_configs(market_type: str = MARKET_TYPE_CONTRACT) -> tuple[MarketDataProviderConfig, ...]:
    normalized_type = _normalize_provider_code(market_type or MARKET_TYPE_CONTRACT)
    return tuple(
        sorted(
            [item for item in DEFAULT_PROVIDER_CONFIGS if item.market_type == normalized_type],
            key=lambda item: (item.priority, item.provider_code),
        )
    )


def _provider_from_row(row: dict[str, Any]) -> MarketDataProviderConfig:
    return MarketDataProviderConfig(
        provider_code=_normalize_provider_code(row.get("provider_code")),
        provider_name=str(row.get("provider_name") or ""),
        market_type=_normalize_provider_code(row.get("market_type") or MARKET_TYPE_CONTRACT),
        enabled=bool(row.get("enabled")),
        priority=int(row.get("priority") or 100),
        base_url=str(row.get("base_url") or "").strip() or None,
        timeout_ms=max(300, int(row.get("timeout_ms") or 3000)),
        cooldown_seconds=max(0, int(row.get("cooldown_seconds") or 0)),
        status=str(row.get("status") or "UNKNOWN").strip().upper() or "UNKNOWN",
        last_check_at=row.get("last_check_at"),
        last_success_at=row.get("last_success_at"),
        last_error=row.get("last_error"),
    )


def load_market_data_providers(db: Session, market_type: str = MARKET_TYPE_CONTRACT) -> tuple[MarketDataProviderConfig, ...]:
    normalized_type = _normalize_provider_code(market_type or MARKET_TYPE_CONTRACT)
    now = time.monotonic()
    cache_key = f"items:{normalized_type}"
    expires_key = f"expires_at:{normalized_type}"
    cached = _provider_cache.get(cache_key)
    if cached is not None and now < float(_provider_cache.get("expires_at") or 0):
        return cached
    if cached is not None and now < float(_provider_cache.get(expires_key) or 0):
        return cached
    try:
        rows = db.execute(
            text(
                """
                SELECT
                    provider_code, provider_name, market_type, enabled, priority, base_url,
                    timeout_ms, cooldown_seconds, status, last_check_at, last_success_at, last_error
                FROM market_data_providers
                WHERE market_type = :market_type
                ORDER BY priority ASC, provider_code ASC
                """
            ),
            {"market_type": normalized_type},
        ).mappings().all()
        items = tuple(_provider_from_row(dict(row)) for row in rows)
        if not items:
            items = _default_provider_configs(normalized_type)
    except Exception as exc:
        logger.warning("contract_market_provider_config_db_fallback reason=%s", exc)
        items = _default_provider_configs(normalized_type)
    _provider_cache[cache_key] = items
    _provider_cache[expires_key] = now + PROVIDER_CACHE_SECONDS
    return items


def load_contract_market_providers(db: Session) -> tuple[MarketDataProviderConfig, ...]:
    return load_market_data_providers(db, MARKET_TYPE_CONTRACT)


def load_spot_market_providers(db: Session) -> tuple[MarketDataProviderConfig, ...]:
    return load_market_data_providers(db, MARKET_TYPE_SPOT)


def enabled_market_data_providers(
    db: Session,
    *,
    market_type: str = MARKET_TYPE_CONTRACT,
    include_last_good: bool = False,
) -> tuple[MarketDataProviderConfig, ...]:
    items = [
        item
        for item in load_market_data_providers(db, market_type)
        if item.enabled and (include_last_good or item.provider_code != PROVIDER_LAST_GOOD)
    ]
    return tuple(sorted(items, key=lambda item: (item.priority, item.provider_code)))


def enabled_contract_market_providers(db: Session, *, include_last_good: bool = False) -> tuple[MarketDataProviderConfig, ...]:
    return enabled_market_data_providers(db, market_type=MARKET_TYPE_CONTRACT, include_last_good=include_last_good)


def enabled_spot_market_providers(db: Session) -> tuple[MarketDataProviderConfig, ...]:
    return tuple(
        item
        for item in enabled_market_data_providers(db, market_type=MARKET_TYPE_SPOT)
        if item.provider_code in EXTERNAL_SPOT_PROVIDER_CODES
    )


def contract_market_last_good_enabled(db: Session) -> bool:
    return any(
        item.provider_code == PROVIDER_LAST_GOOD and item.enabled
        for item in load_contract_market_providers(db)
    )


def _load_symbol_mappings(db: Session) -> dict[tuple[str, str], str]:
    now = time.monotonic()
    cached = _symbol_cache.get("items")
    if cached is not None and now < float(_symbol_cache.get("expires_at") or 0):
        return cached
    mappings = dict(DEFAULT_SYMBOL_MAPPINGS)
    try:
        rows = db.execute(
            text(
                """
                SELECT provider_code, local_symbol, provider_symbol
                FROM market_data_provider_symbols
                WHERE enabled = TRUE
                """
            )
        ).mappings().all()
        for row in rows:
            provider_code = _normalize_provider_code(row.get("provider_code"))
            local_symbol = _normalize_symbol(row.get("local_symbol"))
            provider_symbol = _normalize_symbol(row.get("provider_symbol"))
            if provider_code and local_symbol and provider_symbol:
                mappings[(provider_code, local_symbol)] = provider_symbol
    except Exception as exc:
        logger.warning("contract_market_provider_symbol_db_fallback reason=%s", exc)
    _symbol_cache["items"] = mappings
    _symbol_cache["expires_at"] = now + PROVIDER_CACHE_SECONDS
    return mappings


def resolve_contract_provider_symbol(
    db: Session,
    *,
    provider_code: str,
    local_symbol: str,
    fallback_symbol: Optional[str] = None,
) -> str:
    code = _normalize_provider_code(provider_code)
    local = _normalize_symbol(local_symbol)
    mapped = _load_symbol_mappings(db).get((code, local))
    if mapped:
        return mapped
    if code == PROVIDER_OKX_SWAP and local.endswith("USDT_PERP"):
        base = local[: -len("USDT_PERP")]
        if base:
            return f"{base}-USDT-SWAP"
    if code in {PROVIDER_BITGET_USDT_FUTURES, PROVIDER_BINANCE_USDM} and local.endswith("_PERP"):
        return local[: -len("_PERP")]
    return _normalize_symbol(fallback_symbol) or local.replace("_PERP", "")


def resolve_spot_provider_symbol(
    db: Session,
    *,
    provider_code: str,
    local_symbol: str,
    fallback_symbol: Optional[str] = None,
) -> str:
    code = _normalize_provider_code(provider_code)
    local = _normalize_symbol(local_symbol)
    mapped = _load_symbol_mappings(db).get((code, local))
    if mapped:
        return mapped
    if code == PROVIDER_OKX_SPOT and local.endswith("USDT"):
        base = local[: -len("USDT")]
        if base:
            return f"{base}-USDT"
    return _normalize_symbol(fallback_symbol) or local


def _raise_if_in_cooldown(provider_code: str) -> None:
    until = _provider_cooldown_until.get(_normalize_provider_code(provider_code))
    if until is not None and until > datetime.utcnow():
        raise ProviderCooldownError("provider is in cooldown")


def is_contract_market_provider_in_cooldown(provider_code: str) -> bool:
    until = _provider_cooldown_until.get(_normalize_provider_code(provider_code))
    return until is not None and until > datetime.utcnow()


def mark_contract_market_provider_failure(
    db: Session,
    provider_code: str,
    error: Any,
    *,
    cooldown_seconds: int = 0,
    market_type: str = MARKET_TYPE_CONTRACT,
) -> None:
    code = _normalize_provider_code(provider_code)
    normalized_type = _normalize_provider_code(market_type or MARKET_TYPE_CONTRACT)
    if cooldown_seconds > 0:
        _provider_cooldown_until[code] = datetime.utcnow() + timedelta(seconds=int(cooldown_seconds))
    try:
        db.execute(
            text(
                """
                UPDATE market_data_providers
                SET status = 'ERROR',
                    last_check_at = UTC_TIMESTAMP(),
                    last_error = :last_error,
                    updated_at = UTC_TIMESTAMP()
                WHERE provider_code = :provider_code AND market_type = :market_type
                """
            ),
            {
                "provider_code": code,
                "market_type": normalized_type,
                "last_error": str(error or "")[:1000],
            },
        )
        db.flush()
        clear_contract_market_provider_cache()
    except SQLAlchemyError:
        logger.debug("contract_market_provider_failure_status_update_failed", exc_info=True)


def mark_contract_market_provider_success(
    db: Session,
    provider_code: str,
    *,
    market_type: str = MARKET_TYPE_CONTRACT,
) -> None:
    code = _normalize_provider_code(provider_code)
    normalized_type = _normalize_provider_code(market_type or MARKET_TYPE_CONTRACT)
    _provider_cooldown_until.pop(code, None)
    try:
        db.execute(
            text(
                """
                UPDATE market_data_providers
                SET status = 'OK',
                    last_check_at = UTC_TIMESTAMP(),
                    last_success_at = UTC_TIMESTAMP(),
                    last_error = NULL,
                    updated_at = UTC_TIMESTAMP()
                WHERE provider_code = :provider_code AND market_type = :market_type
                """
            ),
            {"provider_code": code, "market_type": normalized_type},
        )
        db.flush()
        clear_contract_market_provider_cache()
    except SQLAlchemyError:
        logger.debug("contract_market_provider_success_status_update_failed", exc_info=True)


def _endpoint_request(provider_code: str, endpoint_type: str, provider_symbol: str, limit: int) -> tuple[str, dict[str, Any]]:
    code = _normalize_provider_code(provider_code)
    endpoint = str(endpoint_type or "").strip().lower()
    symbol = _normalize_symbol(provider_symbol)
    safe_limit = max(1, min(int(limit or 5), 1000))
    if code == PROVIDER_OKX_SWAP:
        if endpoint == "ticker":
            return "/api/v5/market/ticker", {"instId": symbol}
        if endpoint == "depth":
            return "/api/v5/market/books", {"instId": symbol, "sz": min(safe_limit, 400)}
        if endpoint == "kline":
            return "/api/v5/market/candles", {"instId": symbol, "bar": "1m", "limit": min(safe_limit, 300)}
        if endpoint == "trades":
            return "/api/v5/market/trades", {"instId": symbol, "limit": min(safe_limit, 500)}
        if endpoint == "funding":
            return "/api/v5/public/funding-rate", {"instId": symbol}
    if code == PROVIDER_BITGET_USDT_FUTURES:
        params = {"symbol": symbol, "productType": "USDT-FUTURES"}
        if endpoint == "ticker":
            return "/api/v2/mix/market/ticker", params
        if endpoint == "depth":
            return "/api/v2/mix/market/orderbook", {**params, "limit": min(safe_limit, 100)}
        if endpoint == "kline":
            return "/api/v2/mix/market/candles", {**params, "granularity": "1m", "limit": min(safe_limit, 1000)}
        if endpoint == "trades":
            return "/api/v2/mix/market/fills", {**params, "limit": min(safe_limit, 100)}
        if endpoint == "funding":
            return "/api/v2/mix/market/current-fund-rate", params
    if code == PROVIDER_BINANCE_USDM:
        if endpoint == "ticker":
            return "/fapi/v1/ticker/24hr", {"symbol": symbol}
        if endpoint == "depth":
            return "/fapi/v1/depth", {"symbol": symbol, "limit": min(safe_limit, 1000)}
        if endpoint == "kline":
            return "/fapi/v1/klines", {"symbol": symbol, "interval": "1m", "limit": min(safe_limit, 1000)}
        if endpoint == "trades":
            return "/fapi/v1/trades", {"symbol": symbol, "limit": min(safe_limit, 1000)}
        if endpoint == "funding":
            return "/fapi/v1/fundingRate", {"symbol": symbol, "limit": 1}
    if code == PROVIDER_OKX_SPOT:
        if endpoint == "ticker":
            return "/api/v5/market/ticker", {"instId": symbol}
        if endpoint == "depth":
            return "/api/v5/market/books", {"instId": symbol, "sz": min(safe_limit, 400)}
        if endpoint == "kline":
            return "/api/v5/market/candles", {"instId": symbol, "bar": "1m", "limit": min(safe_limit, 300)}
        if endpoint == "trades":
            return "/api/v5/market/trades", {"instId": symbol, "limit": min(safe_limit, 500)}
    if code == PROVIDER_BITGET_SPOT:
        if endpoint == "ticker":
            return "/api/v2/spot/market/tickers", {"symbol": symbol}
        if endpoint == "depth":
            return "/api/v2/spot/market/orderbook", {"symbol": symbol, "type": "step0", "limit": min(safe_limit, 200)}
        if endpoint == "kline":
            return "/api/v2/spot/market/candles", {"symbol": symbol, "granularity": "1min", "limit": min(safe_limit, 1000)}
        if endpoint == "trades":
            return "/api/v2/spot/market/fills", {"symbol": symbol, "limit": min(safe_limit, 100)}
    if code == PROVIDER_BINANCE_SPOT:
        if endpoint == "ticker":
            return "/api/v3/ticker/24hr", {"symbol": symbol}
        if endpoint == "depth":
            return "/api/v3/depth", {"symbol": symbol, "limit": min(safe_limit, 1000)}
        if endpoint == "kline":
            return "/api/v3/klines", {"symbol": symbol, "interval": "1m", "limit": min(safe_limit, 1000)}
        if endpoint == "trades":
            return "/api/v3/trades", {"symbol": symbol, "limit": min(safe_limit, 1000)}
    raise MarketDataProviderError(f"unsupported provider endpoint: {provider_code}.{endpoint_type}")


def request_contract_market_provider_json(
    provider: MarketDataProviderConfig,
    endpoint_type: str,
    provider_symbol: str,
    *,
    limit: int = 5,
    extra_params: Optional[dict[str, Any]] = None,
) -> Any:
    if provider.provider_code not in EXTERNAL_PROVIDER_CODES and provider.provider_code not in EXTERNAL_SPOT_PROVIDER_CODES:
        raise MarketDataProviderError(f"provider {provider.provider_code} has no external endpoint")
    _raise_if_in_cooldown(provider.provider_code)
    base_url = normalize_market_provider_base_url(provider.base_url, provider.provider_code)
    if not base_url:
        raise MarketDataProviderError("base_url is required")
    path, params = _endpoint_request(provider.provider_code, endpoint_type, provider_symbol, limit)
    if extra_params:
        params.update(extra_params)
    timeout = max(0.3, int(provider.timeout_ms or 3000) / 1000)
    response = _http_session.get(f"{base_url}{path}", params=params, timeout=timeout)
    if response.status_code >= 400:
        raise MarketDataProviderError(f"HTTP {response.status_code}: {(response.text or '')[:240]}")
    try:
        return response.json()
    except ValueError as exc:
        raise MarketDataProviderError("invalid json response") from exc


def _sample_ok(provider_code: str, endpoint_type: str, payload: Any) -> bool:
    code = _normalize_provider_code(provider_code)
    endpoint = str(endpoint_type or "").lower()
    if code == PROVIDER_OKX_SWAP:
        rows = payload.get("data") if isinstance(payload, dict) else None
        return isinstance(rows, list) and bool(rows)
    if code == PROVIDER_BITGET_USDT_FUTURES:
        data = payload.get("data") if isinstance(payload, dict) else None
        return bool(data)
    if code == PROVIDER_BINANCE_USDM:
        if endpoint in {"kline", "trades", "funding"}:
            return isinstance(payload, list) and bool(payload)
        return isinstance(payload, dict) and bool(payload)
    if code == PROVIDER_OKX_SPOT:
        rows = payload.get("data") if isinstance(payload, dict) else None
        return isinstance(rows, list) and bool(rows)
    if code == PROVIDER_BITGET_SPOT:
        data = payload.get("data") if isinstance(payload, dict) else None
        return bool(data)
    if code == PROVIDER_BINANCE_SPOT:
        if endpoint in {"kline", "trades"}:
            return isinstance(payload, list) and bool(payload)
        return isinstance(payload, dict) and bool(payload)
    return code == PROVIDER_LAST_GOOD


def test_contract_market_provider_connection(
    db: Session,
    provider_code: str,
    *,
    local_symbol: str = "BTCUSDT_PERP",
) -> dict[str, Any]:
    code = _normalize_provider_code(provider_code)
    market_type = MARKET_TYPE_SPOT if code in EXTERNAL_SPOT_PROVIDER_CODES else MARKET_TYPE_CONTRACT
    provider = next((item for item in load_market_data_providers(db, market_type) if item.provider_code == code), None)
    if provider is None:
        provider = next((item for item in DEFAULT_PROVIDER_CONFIGS if item.provider_code == code and item.market_type == market_type), None)
    if provider is None:
        return {"ok": False, "message": "provider not found", "checks": []}
    if code == PROVIDER_LAST_GOOD:
        mark_contract_market_provider_success(db, code)
        return {"ok": True, "message": "LAST_GOOD uses stored contract_market_quotes only", "checks": []}

    provider_symbol = (
        resolve_spot_provider_symbol(db, provider_code=code, local_symbol=local_symbol.replace("_PERP", ""))
        if market_type == MARKET_TYPE_SPOT
        else resolve_contract_provider_symbol(db, provider_code=code, local_symbol=local_symbol)
    )
    checks: list[dict[str, Any]] = []
    ok = True
    endpoint_types = ("ticker", "depth", "kline", "trades") if market_type == MARKET_TYPE_SPOT else ("ticker", "depth", "kline", "trades", "funding")
    for endpoint_type in endpoint_types:
        started = time.perf_counter()
        try:
            payload = request_contract_market_provider_json(
                provider,
                endpoint_type,
                provider_symbol,
                limit=5,
            )
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            endpoint_ok = _sample_ok(code, endpoint_type, payload)
            ok = ok and endpoint_ok
            checks.append({"endpoint_type": endpoint_type, "ok": endpoint_ok, "latency_ms": elapsed_ms, "error": ""})
        except Exception as exc:
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            ok = False
            checks.append({"endpoint_type": endpoint_type, "ok": False, "latency_ms": elapsed_ms, "error": str(exc)[:240]})
    if ok:
        mark_contract_market_provider_success(db, code, market_type=market_type)
        message = "OK"
    else:
        first_error = next((item["error"] for item in checks if item.get("error")), "provider check failed")
        mark_contract_market_provider_failure(db, code, first_error, cooldown_seconds=0, market_type=market_type)
        message = first_error
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
    return {"ok": ok, "message": message, "checks": checks, "provider_symbol": provider_symbol}


def admin_list_contract_market_providers(db: Session) -> list[dict[str, Any]]:
    has_last_good_price = False
    try:
        has_last_good_price = bool(
            db.execute(text("SELECT 1 FROM contract_market_quotes LIMIT 1")).scalar()
        )
    except SQLAlchemyError:
        has_last_good_price = False

    rows: list[dict[str, Any]] = []
    for market_type, default_group in (
        (MARKET_TYPE_SPOT, "外部现货行情"),
        (MARKET_TYPE_CONTRACT, "外部合约行情"),
    ):
        for item in load_market_data_providers(db, market_type):
            if item.provider_code in HIDDEN_PROVIDER_CODES:
                continue
            is_last_good = item.provider_code == PROVIDER_LAST_GOOD
            display_name = "最近有效价格兜底" if is_last_good else item.provider_name
            provider_group = "兜底保护" if is_last_good else default_group
            if is_last_good:
                if not item.enabled:
                    display_status = "兜底停用"
                    display_status_badge = "secondary"
                elif has_last_good_price:
                    display_status = "兜底启用"
                    display_status_badge = "success"
                else:
                    display_status = "等待行情缓存"
                    display_status_badge = "warning"
            elif item.status == "OK":
                display_status = "正常"
                display_status_badge = "success"
            elif item.status == "ERROR":
                display_status = "异常"
                display_status_badge = "danger"
            elif item.status == "COOLDOWN":
                display_status = "冷却中"
                display_status_badge = "warning"
            elif item.status == "DISABLED":
                display_status = "已停用"
                display_status_badge = "secondary"
            elif item.status in {"SYSTEM", "INTERNAL"}:
                display_status = "系统内置"
                display_status_badge = "success"
            else:
                display_status = item.status
                display_status_badge = "secondary"
            if not item.enabled:
                display_status = "已停用"
                display_status_badge = "secondary"
            last_error_display = "已停用，不参与行情请求。" if not item.enabled else normalize_market_provider_error(item.last_error)
            rows.append(
                {
                    "provider_code": item.provider_code,
                    "provider_name": item.provider_name,
                    "display_name": display_name,
                    "provider_group": provider_group,
                    "market_type": item.market_type,
                    "enabled": item.enabled,
                    "priority": item.priority,
                    "base_url": item.base_url or "",
                    "timeout_ms": item.timeout_ms,
                    "cooldown_seconds": item.cooldown_seconds,
                    "status": item.status,
                    "display_status": display_status,
                    "display_status_badge": display_status_badge,
                    "is_last_good": is_last_good,
                    "is_internal": False,
                    "is_readonly": False,
                    "readonly_note": "",
                    "has_last_good_price": has_last_good_price if is_last_good else None,
                    "can_test_connection": item.provider_code in EXTERNAL_PROVIDER_CODES or item.provider_code in EXTERNAL_SPOT_PROVIDER_CODES,
                    "last_check_at": item.last_check_at,
                    "last_success_at": item.last_success_at,
                    "last_error": item.last_error or "",
                    "last_error_display": last_error_display,
                }
            )
    existing_codes = {str(row.get("provider_code") or "").upper() for row in rows}
    readonly_sources = (
        ("BINANCE_SPOT", "外部现货行情", "Binance Spot", "SPOT", 100, "外部现货行情由现货行情服务使用固定公开行情接口，不在此配置 endpoint path。"),
        ("ITICK_STOCK", "iTick 行情", "iTick 股票行情", "STOCK", 200, "iTick 行情由 iTick 行情服务提供，不在此接入 API key 或账户接口。"),
        ("ITICK_FOREX", "iTick 行情", "iTick 外汇行情", "FOREX", 201, "iTick 行情由 iTick 行情服务提供，不在此接入 API key 或账户接口。"),
        ("ITICK_INDEX", "iTick 行情", "iTick 指数行情", "INDEX", 202, "iTick 行情由 iTick 行情服务提供，不在此接入 API key 或账户接口。"),
        ("ITICK_METAL", "iTick 行情", "iTick 贵金属行情", "METAL", 203, "iTick 行情由 iTick 行情服务提供，不在此接入 API key 或账户接口。"),
        ("ITICK_COMMODITY", "iTick 行情", "iTick 大宗商品行情", "COMMODITY", 204, "iTick 行情由 iTick 行情服务提供，不在此接入 API key 或账户接口。"),
        (PROVIDER_INTERNAL, "内部撮合行情", "内部撮合行情", "SPOT", 900, "内部撮合行情由系统撮合服务提供，不连接外部 API，不需要 base_url、timeout 或 cooldown。"),
    )
    for provider_code, provider_group, display_name, market_type, priority, readonly_note in readonly_sources:
        if provider_code in existing_codes:
            continue
        rows.append(
            {
                "provider_code": provider_code,
                "provider_name": display_name,
                "display_name": display_name,
                "provider_group": provider_group,
                "market_type": market_type,
                "enabled": True,
                "priority": priority,
                "base_url": "",
                "timeout_ms": 0,
                "cooldown_seconds": 0,
                "status": "OK",
                "display_status": "系统内置",
                "display_status_badge": "success",
                "is_last_good": False,
                "is_internal": provider_code == PROVIDER_INTERNAL,
                "is_readonly": True,
                "readonly_note": readonly_note,
                "has_last_good_price": None,
                "can_test_connection": False,
                "last_check_at": None,
                "last_success_at": None,
                "last_error": "",
                "last_error_display": "-",
            }
        )
    rows.sort(key=lambda item: (str(item.get("provider_group") or ""), int(item.get("priority") or 9999), str(item.get("provider_code") or "")))
    return rows


def admin_update_contract_market_provider(
    db: Session,
    provider_code: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    code = _normalize_provider_code(provider_code)
    current = next(
        (
            item
            for market_type in (MARKET_TYPE_SPOT, MARKET_TYPE_CONTRACT)
            for item in load_market_data_providers(db, market_type)
            if item.provider_code == code
        ),
        None,
    )
    if current is None:
        return {"ok": False, "message": "provider not found"}
    try:
        enabled = str(payload.get("enabled") or "").lower() in {"1", "true", "yes", "on"}
        priority = max(1, min(int(payload.get("priority") or current.priority), 9999))
        timeout_ms = max(300, min(int(payload.get("timeout_ms") or current.timeout_ms), 15000))
        cooldown_seconds = max(0, min(int(payload.get("cooldown_seconds") or current.cooldown_seconds), 3600))
        base_url = None if code == PROVIDER_LAST_GOOD else normalize_market_provider_base_url(payload.get("base_url"), code)
    except Exception as exc:
        return {"ok": False, "message": str(exc)}
    try:
        db.execute(
            text(
                """
                UPDATE market_data_providers
                SET enabled = :enabled,
                    priority = :priority,
                    base_url = :base_url,
                    timeout_ms = :timeout_ms,
                    cooldown_seconds = :cooldown_seconds,
                    updated_at = UTC_TIMESTAMP()
                WHERE provider_code = :provider_code AND market_type = :market_type
                """
            ),
            {
                "enabled": enabled,
                "priority": priority,
                "base_url": base_url,
                "timeout_ms": timeout_ms,
                "cooldown_seconds": cooldown_seconds,
                "provider_code": code,
                "market_type": current.market_type,
            },
        )
        db.commit()
        clear_contract_market_provider_cache()
    except SQLAlchemyError:
        db.rollback()
        logger.exception("admin_update_contract_market_provider failed provider=%s", code)
        return {"ok": False, "message": "provider update failed"}
    return {"ok": True, "message": "provider updated"}
