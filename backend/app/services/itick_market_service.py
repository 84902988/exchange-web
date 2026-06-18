import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)


class ItickMarketServiceError(RuntimeError):
    pass


class ItickMarketBadRequest(ItickMarketServiceError, ValueError):
    pass


class ItickMarketUpstreamError(ItickMarketServiceError):
    pass


class ItickMarketRateLimited(ItickMarketUpstreamError):
    pass


class ItickMarketService:
    DEFAULT_BASE_URL = "https://api0.itick.org/stock"
    DEFAULT_API0_BASE_URL = "https://api0.itick.org"
    REQUEST_TIMEOUT = 5
    STOCK_KLINE_REQUEST_TIMEOUT = 8
    STOCK_KLINE_CACHE_TTL_SECONDS = 45
    QUOTE_DEPTH_CACHE_TTL_SECONDS = 60
    QUOTE_DEPTH_STALE_TTL_SECONDS = 300
    QUOTE_DEPTH_COOLDOWN_SECONDS = 45
    UPSTREAM_ERROR_LOG_COOLDOWN_SECONDS = 60
    QUOTES_BATCH_SIZE = 10

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.trust_env = False
        self._stock_kline_cache: Dict[str, Dict[str, Any]] = {}
        self._quote_item_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
        self._response_cache: Dict[str, Tuple[float, Any]] = {}
        self._cooldown_until = 0.0
        self._last_cooldown_log_at = 0.0
        self._last_error_log_at: Dict[str, float] = {}

    def get_stock_quote(self, region: str, code: str, timeout: Optional[int] = None) -> Any:
        normalized_region = self._normalize_region(region)
        normalized_code = self._normalize_code(code)
        cache_key = self._quote_cache_key("stock", normalized_region, normalized_code)
        cached_item = self._get_cached_quote_item(cache_key, allow_stale=self.is_quote_depth_cooldown_active())
        if cached_item is not None:
            return {"data": cached_item}
        if self.is_quote_depth_cooldown_active():
            return {"data": {}}

        payload = self._request_json(
            "/quote",
            {
                "region": normalized_region,
                "code": normalized_code,
            },
            timeout=timeout,
        )
        quote_item = self._first_quote_item(payload)
        if quote_item is not None:
            self._set_quote_item_cache(cache_key, quote_item)
        return payload

    def get_stock_quotes(self, region: str, codes: List[str], timeout: Optional[int] = None) -> Dict[str, Dict[str, Any]]:
        normalized_region = self._normalize_region(region)
        normalized_codes: List[str] = []
        seen_codes = set()
        for code in codes or []:
            if not str(code or "").strip():
                continue
            normalized_code = self._normalize_code(code)
            if normalized_code in seen_codes:
                continue
            seen_codes.add(normalized_code)
            normalized_codes.append(normalized_code)

        if not normalized_codes:
            return {}

        quote_by_code: Dict[str, Dict[str, Any]] = {}
        missing_codes: List[str] = []
        allow_stale = self.is_quote_depth_cooldown_active()
        for code in normalized_codes:
            cached_item = self._get_cached_quote_item(
                self._quote_cache_key("stock", normalized_region, code),
                allow_stale=allow_stale,
            )
            if cached_item is not None:
                quote_by_code[code] = cached_item
                self._index_quote_aliases(quote_by_code, cached_item)
            else:
                missing_codes.append(code)

        if not missing_codes or self.is_quote_depth_cooldown_active():
            return quote_by_code

        logger.debug(
            "itick stock batch quotes request region=%s count=%s",
            normalized_region,
            len(missing_codes),
        )

        for index in range(0, len(missing_codes), self.QUOTES_BATCH_SIZE):
            chunk = missing_codes[index : index + self.QUOTES_BATCH_SIZE]
            try:
                payload = self._request_json(
                    "/quotes",
                    {
                        "region": normalized_region,
                        "codes": ",".join(chunk),
                    },
                    timeout=timeout,
                )
            except ItickMarketRateLimited:
                break

            for item in self._extract_quote_items(payload):
                enriched_item = self._enrich_stock_quote_item(item)
                self._index_quote_aliases(quote_by_code, enriched_item)
                for raw_code in [
                    enriched_item.get("s"),
                    enriched_item.get("code"),
                    enriched_item.get("symbol"),
                    enriched_item.get("c"),
                ]:
                    code = str(raw_code or "").upper().strip()
                    if code:
                        self._set_quote_item_cache(
                            self._quote_cache_key("stock", normalized_region, code),
                            enriched_item,
                        )
        return quote_by_code

    def get_stock_info(self, region: str, code: str) -> Any:
        return self._request_json(
            "/info",
            {
                "type": "stock",
                "region": self._normalize_region(region),
                "code": self._normalize_code(code),
            },
        )

    def get_stock_kline(
        self,
        region: str,
        code: str,
        kType: int,
        limit: int,
        end_time_ms: Optional[int] = None,
    ) -> Any:
        normalized_region = self._normalize_region(region)
        normalized_code = self._normalize_code(code)
        normalized_k_type = self._normalize_k_type(kType)
        normalized_limit = self._normalize_limit(limit)
        normalized_end_time = int(end_time_ms) if end_time_ms else None
        cache_key = "stock:kline:{0}:{1}:{2}:{3}:{4}".format(
            normalized_region,
            normalized_code,
            normalized_k_type,
            normalized_limit,
            normalized_end_time or "latest",
        )
        cached = self._stock_kline_cache.get(cache_key)
        now = time.time()
        if cached and now - float(cached.get("ts", 0)) <= self.STOCK_KLINE_CACHE_TTL_SECONDS:
            return cached.get("payload")

        try:
            params = {
                "region": normalized_region,
                "code": normalized_code,
                "kType": normalized_k_type,
                "limit": normalized_limit,
            }
            if normalized_end_time:
                params["endTime"] = max(normalized_end_time - 1, 1)
            payload = self._request_json(
                "/kline",
                params,
                timeout=self.STOCK_KLINE_REQUEST_TIMEOUT,
            )
        except Exception as exc:
            if cached:
                logger.warning(
                    "itick stock kline stale cache fallback region=%s code=%s kType=%s limit=%s error=%s",
                    normalized_region,
                    normalized_code,
                    normalized_k_type,
                    normalized_limit,
                    exc,
                )
                return cached.get("payload")
            raise

        self._stock_kline_cache[cache_key] = {
            "ts": now,
            "payload": payload,
        }
        return payload

    def get_stock_depth(self, region: str, code: str, limit: int = 20) -> Any:
        self._normalize_limit(limit)
        normalized_region = self._normalize_region(region)
        normalized_code = self._normalize_code(code)
        extra_depth_params = self._get_stock_depth_extra_params()
        params = {
            "region": normalized_region,
            "code": normalized_code,
        }
        params.update(extra_depth_params)
        cache_key = self._response_cache_key(self._get_base_url(), "/depth", params)
        cached_payload = self._get_response_cache(cache_key, allow_stale=self.is_quote_depth_cooldown_active())
        if cached_payload is not None:
            return cached_payload
        if self.is_quote_depth_cooldown_active():
            return {"data": {}}

        return self._request_json(
            "/depth",
            params,
        )

    def get_market_quote(self, market: str, region: str, code: str, timeout: Optional[int] = None) -> Any:
        normalized_market = (market or "stock").strip().lower()
        normalized_region = self._normalize_region(region)
        normalized_code = self._normalize_code(code)
        use_cache = normalized_market != "forex"
        cache_key = self._quote_cache_key(normalized_market, normalized_region, normalized_code)
        if use_cache:
            cached_item = self._get_cached_quote_item(cache_key, allow_stale=self.is_quote_depth_cooldown_active())
            if cached_item is not None:
                return {"data": cached_item}
        if self.is_quote_depth_cooldown_active():
            return {"data": {}}

        payload = self._request_json(
            "/quote",
            {
                "region": normalized_region,
                "code": normalized_code,
            },
            base_url=self._get_market_base_url(normalized_market),
            timeout=timeout,
            use_cache=use_cache,
        )
        quote_item = self._first_quote_item(payload)
        if use_cache and quote_item is not None:
            self._set_quote_item_cache(cache_key, quote_item)
        return payload

    def get_market_quotes(self, market: str, region: str, codes: str) -> Any:
        normalized_codes = ",".join(
            sorted(
                {
                    self._normalize_code(code)
                    for code in str(codes or "").split(",")
                    if str(code or "").strip()
                }
            )
        )
        if not normalized_codes:
            raise ItickMarketBadRequest("codes cannot be empty")

        return self._request_json(
            "/quotes",
            {
                "region": self._normalize_region(region),
                "codes": normalized_codes,
            },
            base_url=self._get_market_base_url(market),
        )

    def get_market_kline(
        self,
        market: str,
        region: str,
        code: str,
        kType: int,
        limit: int,
        end_time_ms: Optional[int] = None,
        timeout: Optional[int] = None,
    ) -> Any:
        params = {
            "region": self._normalize_region(region),
            "code": self._normalize_code(code),
            "kType": self._normalize_k_type(kType),
            "limit": self._normalize_limit(limit),
        }
        if end_time_ms:
            params["endTime"] = max(int(end_time_ms) - 1, 1)
        return self._request_json(
            "/kline",
            params,
            base_url=self._get_market_base_url(market),
            timeout=timeout,
        )

    def _request_json(
        self,
        path: str,
        params: Dict[str, Any],
        base_url: Optional[str] = None,
        timeout: Optional[int] = None,
        use_cache: bool = True,
    ) -> Any:
        token = (os.getenv("ITICK_API_TOKEN") or os.getenv("ITICK_API_KEY") or "").strip()
        if not token:
            raise ItickMarketBadRequest("ITICK_API_TOKEN is not configured")

        base_url = (base_url or self._get_base_url()).strip().rstrip("/")
        url = "{0}{1}".format(base_url, path)
        response_cache_key = self._response_cache_key(base_url, path, params)
        if use_cache and self._is_quote_depth_endpoint(path):
            cached_payload = self._get_response_cache(response_cache_key)
            if cached_payload is not None:
                return cached_payload
        if self._is_quote_depth_endpoint(path) and self.is_quote_depth_cooldown_active():
            cached_payload = self._get_response_cache(response_cache_key, allow_stale=True)
            if cached_payload is not None:
                return cached_payload
            return {"data": [] if path == "/quotes" else {}}
        headers = {
            "token": token,
            "accept": "application/json",
        }

        try:
            response = self._session.get(
                url,
                params=params,
                headers=headers,
                timeout=timeout or self.REQUEST_TIMEOUT,
            )
            if path == "/depth":
                logger.debug("itick_depth_request_url url=%s", response.url)
        except requests.RequestException as exc:
            self._log_upstream_error(endpoint=path, params=params, error=exc)
            if self._is_quote_depth_endpoint(path):
                cached_payload = self._get_response_cache(response_cache_key, allow_stale=True)
                if cached_payload is not None:
                    logger.warning("itick quote/depth stale cache fallback endpoint=%s params=%s error=%s", path, params, exc)
                    return cached_payload
            raise ItickMarketUpstreamError("iTick stock market request failed") from exc

        if response.status_code >= 400:
            message = self._extract_error_message(response)
            if response.status_code == 429:
                self._activate_cooldown(message)
                cached_payload = self._get_response_cache(response_cache_key, allow_stale=True)
                if cached_payload is not None:
                    return cached_payload
                raise ItickMarketRateLimited(message)

            self._log_upstream_error(endpoint=path, params=params, error="{0} {1}".format(response.status_code, message))
            if response.status_code >= 500 and self._is_quote_depth_endpoint(path):
                cached_payload = self._get_response_cache(response_cache_key, allow_stale=True)
                if cached_payload is not None:
                    logger.warning(
                        "itick quote/depth stale cache fallback endpoint=%s params=%s status=%s",
                        path,
                        params,
                        response.status_code,
                    )
                    return cached_payload

            if response.status_code in (400, 401, 403, 404):
                raise ItickMarketBadRequest(message)

            raise ItickMarketUpstreamError(message)

        try:
            payload = response.json()
        except ValueError as exc:
            self._log_upstream_error(endpoint=path, params=params, error=exc)
            raise ItickMarketUpstreamError("iTick returned non-JSON response") from exc

        if self._is_quote_depth_endpoint(path) and self._is_payload_rate_limited(payload):
            message = self._payload_error_message(payload)
            self._activate_cooldown(message)
            cached_payload = self._get_response_cache(response_cache_key, allow_stale=True)
            if cached_payload is not None:
                return cached_payload
            raise ItickMarketRateLimited(message)

        if path == "/kline" and "kType" in params:
            data = payload.get("data") if isinstance(payload, dict) else None
            data_len = len(data) if isinstance(data, list) else 0
            logger.debug(
                "itick stock kline response path=%s region=%s code=%s kType=%s limit=%s status=%s url=%s data_len=%s",
                path,
                params.get("region"),
                params.get("code"),
                params.get("kType"),
                params.get("limit"),
                response.status_code,
                response.url,
                data_len,
            )
            if data_len == 0:
                logger.debug(
                    "itick stock kline empty body path=%s region=%s code=%s kType=%s limit=%s body=%s",
                    path,
                    params.get("region"),
                    params.get("code"),
                    params.get("kType"),
                    params.get("limit"),
                    (response.text or "")[:300],
                )

            if use_cache and self._is_quote_depth_endpoint(path):
                self._set_response_cache(response_cache_key, payload)

        return payload

    def _extract_quote_items(self, payload: Any) -> List[Dict[str, Any]]:
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

    def _first_quote_item(self, payload: Any) -> Optional[Dict[str, Any]]:
        for item in self._extract_quote_items(payload):
            return self._enrich_stock_quote_item(item)
        return None

    def _index_quote_aliases(self, quote_by_code: Dict[str, Dict[str, Any]], enriched_item: Dict[str, Any]) -> None:
        raw_codes = [
            enriched_item.get("s"),
            enriched_item.get("code"),
            enriched_item.get("symbol"),
            enriched_item.get("c"),
        ]
        for raw_code in raw_codes:
            code = str(raw_code or "").upper().strip()
            if not code:
                continue
            quote_by_code[code] = enriched_item
            for delimiter in (".", ":", "-"):
                if delimiter in code:
                    parts = [part for part in code.split(delimiter) if part]
                    for part in parts:
                        quote_by_code.setdefault(part, enriched_item)

    def _quote_cache_key(self, market: str, region: str, code: str) -> str:
        return "{0}:{1}:{2}".format(
            str(market or "stock").strip().lower(),
            self._normalize_region(region),
            self._normalize_code(code),
        )

    def _cache_ttl_seconds(self) -> float:
        return self._float_env("ITICK_QUOTE_DEPTH_CACHE_TTL_SECONDS", self.QUOTE_DEPTH_CACHE_TTL_SECONDS)

    def _stale_ttl_seconds(self) -> float:
        return self._float_env("ITICK_QUOTE_DEPTH_STALE_TTL_SECONDS", self.QUOTE_DEPTH_STALE_TTL_SECONDS)

    def _cooldown_seconds(self) -> float:
        return self._float_env("ITICK_QUOTE_DEPTH_COOLDOWN_SECONDS", self.QUOTE_DEPTH_COOLDOWN_SECONDS)

    def _float_env(self, name: str, default: float) -> float:
        try:
            value = float(str(os.getenv(name, str(default))).strip())
        except Exception:
            value = float(default)
        return value if value > 0 else float(default)

    def _get_cached_quote_item(self, key: str, *, allow_stale: bool = False) -> Optional[Dict[str, Any]]:
        cached = self._quote_item_cache.get(key)
        if cached is None:
            return None
        cached_at, item = cached
        ttl = self._stale_ttl_seconds() if allow_stale else self._cache_ttl_seconds()
        if time.monotonic() - cached_at > ttl:
            return None
        return dict(item)

    def _set_quote_item_cache(self, key: str, item: Dict[str, Any]) -> None:
        self._quote_item_cache[key] = (time.monotonic(), dict(item))

    def _response_cache_key(self, base_url: str, path: str, params: Dict[str, Any]) -> str:
        sorted_params = "&".join(
            "{0}={1}".format(str(key), str(value))
            for key, value in sorted((params or {}).items(), key=lambda item: str(item[0]))
        )
        return "{0}|{1}|{2}".format(str(base_url or "").rstrip("/"), path, sorted_params)

    def _get_response_cache(self, key: str, *, allow_stale: bool = False) -> Any:
        cached = self._response_cache.get(key)
        if cached is None:
            return None
        cached_at, payload = cached
        ttl = self._stale_ttl_seconds() if allow_stale else self._cache_ttl_seconds()
        if time.monotonic() - cached_at > ttl:
            return None
        return payload

    def _set_response_cache(self, key: str, payload: Any) -> None:
        self._response_cache[key] = (time.monotonic(), payload)

    def _is_quote_depth_endpoint(self, path: str) -> bool:
        return path in ("/quote", "/quotes", "/depth")

    def _is_payload_rate_limited(self, payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        code = str(payload.get("code") or payload.get("status") or "").strip()
        message = self._payload_error_message(payload).lower()
        return code == "429" or "request limit exceeded" in message or "rate limit" in message

    def _payload_error_message(self, payload: Dict[str, Any]) -> str:
        return str(
            payload.get("msg")
            or payload.get("message")
            or payload.get("error")
            or payload
        )[:200]

    def is_quote_depth_cooldown_active(self) -> bool:
        return time.monotonic() < self._cooldown_until

    def quote_depth_cooldown_remaining_seconds(self) -> int:
        return max(0, int(self._cooldown_until - time.monotonic()))

    def _activate_cooldown(self, message: str) -> None:
        now = time.monotonic()
        self._cooldown_until = max(self._cooldown_until, now + self._cooldown_seconds())
        if now - self._last_cooldown_log_at >= 10:
            self._last_cooldown_log_at = now
            logger.warning(
                "itick quote/depth rate limited; cooldown_active_for=%ss reason=%s",
                self.quote_depth_cooldown_remaining_seconds(),
                message,
            )

    def _pick_quote_value(self, item: Dict[str, Any], keys: List[str]) -> Any:
        for key in keys:
            value = item.get(key)
            if value not in (None, ""):
                return value
        return None

    def _to_quote_number(self, value: Any) -> Optional[float]:
        if value in (None, ""):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _set_quote_default(self, item: Dict[str, Any], keys: List[str], value: Any) -> None:
        if value in (None, ""):
            return
        for key in keys:
            item.setdefault(key, value)

    def _enrich_stock_quote_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        enriched = dict(item)
        latest_price = self._pick_quote_value(
            enriched,
            ["p", "price", "last", "latest_price", "close", "ld", "c"],
        )
        change_percent = self._pick_quote_value(
            enriched,
            [
                "rate",
                "change_percent",
                "price_change_percent",
                "percent",
                "pct_chg",
                "chp",
                "changePercent",
                "priceChangePercent",
            ],
        )
        change_amount = self._pick_quote_value(
            enriched,
            ["change", "price_change", "price_change_24h", "ch", "priceChange", "changePrice"],
        )
        high = self._pick_quote_value(enriched, ["h", "high", "high_price", "highPrice"])
        low = self._pick_quote_value(enriched, ["l", "low", "low_price", "lowPrice"])
        volume = self._pick_quote_value(enriched, ["v", "volume", "vol"])
        turnover = self._pick_quote_value(
            enriched,
            ["turnover", "amount", "turnover_value", "trade_amount", "value", "tu", "qv"],
        )
        market_cap = self._pick_quote_value(enriched, ["market_cap", "marketValue", "mc"])
        pe = self._pick_quote_value(enriched, ["pe", "pe_ttm", "pe_ratio"])

        quote_volume = turnover
        if quote_volume in (None, ""):
            volume_number = self._to_quote_number(volume)
            latest_number = self._to_quote_number(latest_price)
            if volume_number is not None and latest_number is not None:
                # iTick may omit quote turnover; estimate quote turnover from latest price and base volume.
                quote_volume = volume_number * latest_number

        self._set_quote_default(enriched, ["latest_price", "price"], latest_price)
        self._set_quote_default(enriched, ["price_change_percent_24h", "change_percent"], change_percent)
        self._set_quote_default(enriched, ["price_change_24h", "price_change"], change_amount)
        self._set_quote_default(enriched, ["high_24h", "high_price"], high)
        self._set_quote_default(enriched, ["low_24h", "low_price"], low)
        self._set_quote_default(enriched, ["base_volume_24h", "volume_24h"], volume)
        self._set_quote_default(enriched, ["quote_volume_24h"], quote_volume)
        self._set_quote_default(enriched, ["market_cap"], market_cap)
        self._set_quote_default(enriched, ["pe"], pe)
        return enriched

    def _normalize_region(self, region: str) -> str:
        normalized_region = (region or "").upper().strip()
        if not normalized_region:
            raise ItickMarketBadRequest("region cannot be empty")
        return normalized_region

    def _get_base_url(self) -> str:
        return (os.getenv("ITICK_API_BASE_URL") or self.DEFAULT_BASE_URL).strip().rstrip("/")

    def _get_api0_base_url(self) -> str:
        return (os.getenv("ITICK_API0_BASE_URL") or self.DEFAULT_API0_BASE_URL).strip().rstrip("/")

    def _get_market_base_url(self, market: str) -> str:
        normalized_market = (market or "stock").strip().lower()
        market_aliases = {
            "index": "indices",
            "metal": "forex",
            "commodity": "forex",
        }
        normalized_market = market_aliases.get(normalized_market, normalized_market)
        env_names = {
            "stock": "ITICK_API_BASE_URL",
            "indices": "ITICK_INDICES_API_BASE_URL",
            "forex": "ITICK_FOREX_API_BASE_URL",
            "future": "ITICK_FUTURE_API_BASE_URL",
            "fund": "ITICK_FUND_API_BASE_URL",
            "crypto": "ITICK_CRYPTO_API_BASE_URL",
        }
        env_name = env_names.get(normalized_market)
        if env_name:
            configured_url = (os.getenv(env_name) or "").strip()
            if configured_url:
                return configured_url.rstrip("/")

        stock_base_url = self._get_base_url()
        if normalized_market == "stock":
            return stock_base_url

        return "{0}/{1}".format(self._get_api0_base_url(), normalized_market)

    def _get_stock_depth_extra_params(self) -> Dict[str, Any]:
        """Optional depth parameters for vendor-side experiments.

        iTick's public stock-depth example uses only region and code. Keep extra
        params opt-in so the default request remains aligned with the documented
        contract while still allowing a configured plan-specific depth key.
        """

        param_name = (os.getenv("ITICK_STOCK_DEPTH_PARAM_NAME") or "").strip()
        param_value = (os.getenv("ITICK_STOCK_DEPTH_PARAM_VALUE") or "").strip()
        if param_name and param_value:
            return {param_name: param_value}
        return {}

    def _normalize_code(self, code: str) -> str:
        normalized_code = (code or "").upper().strip()
        if not normalized_code:
            raise ItickMarketBadRequest("code cannot be empty")
        return normalized_code

    def _normalize_k_type(self, kType: int) -> int:
        try:
            normalized_k_type = int(kType)
        except Exception as exc:
            raise ItickMarketBadRequest("kType must be an integer") from exc

        if normalized_k_type <= 0:
            raise ItickMarketBadRequest("kType must be greater than 0")

        return normalized_k_type

    def _normalize_limit(self, limit: int) -> int:
        try:
            normalized_limit = int(limit)
        except Exception as exc:
            raise ItickMarketBadRequest("limit must be an integer") from exc

        if normalized_limit <= 0:
            raise ItickMarketBadRequest("limit must be greater than 0")

        return min(normalized_limit, 1000)

    def _extract_error_message(self, response: requests.Response) -> str:
        raw_message = ""
        try:
            payload = response.json()
        except ValueError:
            payload = None

        if isinstance(payload, dict):
            raw_message = str(
                payload.get("msg")
                or payload.get("message")
                or payload.get("error")
                or ""
            ).strip()

        if not raw_message:
            raw_message = (response.text or "").strip()

        if raw_message:
            return "iTick returned error: {0}".format(raw_message[:200])

        return "iTick stock market service is unavailable"

    def _log_upstream_error(self, endpoint: str, params: Dict[str, Any], error: Any) -> None:
        safe_params = dict(params)
        region = str(safe_params.get("region") or "").strip().upper()
        code = str(safe_params.get("code") or safe_params.get("codes") or "").strip().upper()
        log_key = "{0}:{1}:{2}".format(endpoint, region, code)
        now = time.monotonic()
        last_log_at = self._last_error_log_at.get(log_key, 0.0)
        if now - last_log_at < self.UPSTREAM_ERROR_LOG_COOLDOWN_SECONDS:
            logger.debug(
                "itick stock market request failed endpoint=%s params=%s error=%s",
                endpoint,
                safe_params,
                error,
            )
            return
        self._last_error_log_at[log_key] = now
        logger.warning(
            "itick stock market request failed endpoint=%s params=%s error=%s",
            endpoint,
            safe_params,
            error,
        )


itick_market_service = ItickMarketService()
