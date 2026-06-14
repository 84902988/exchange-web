import logging
import time
from typing import Any, Dict, List, Optional

import requests

from app.schemas.market_external import (
    ExternalDepthItem,
    ExternalDepthResponse,
    ExternalKlineItem,
    ExternalKlineResponse,
    ExternalTradeItem,
    ExternalTradesResponse,
    ExternalTickerResponse,
)

logger = logging.getLogger(__name__)


class BinanceMarketServiceError(RuntimeError):
    pass


class BinanceMarketBadRequest(BinanceMarketServiceError, ValueError):
    pass


class BinanceMarketUpstreamError(BinanceMarketServiceError):
    pass


class BinanceMarketService:
    BASE_URL = "https://data-api.binance.vision"
    PROVIDER = "binance"
    REQUEST_TIMEOUT = 4
    SUPPORTED_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")
    INTERVAL_MS = {
        "1m": 60 * 1000,
        "5m": 5 * 60 * 1000,
        "15m": 15 * 60 * 1000,
        "1h": 60 * 60 * 1000,
        "4h": 4 * 60 * 60 * 1000,
        "1d": 24 * 60 * 60 * 1000,
    }
    DEPTH_LIMIT_OPTIONS = (5, 10, 20, 50, 100, 500, 1000, 5000)

    def __init__(self) -> None:
        # Public Binance market requests should not inherit broken proxy env vars.
        self._session = requests.Session()
        self._session.trust_env = False

    def get_trades(self, symbol: str, limit: int = 50) -> ExternalTradesResponse:
        normalized_symbol = self._normalize_symbol(symbol)
        normalized_limit = self._normalize_trade_limit(limit)

        payload = self._request_json(
            "/api/v3/trades",
            {"symbol": normalized_symbol, "limit": normalized_limit},
        )

        items: List[ExternalTradeItem] = []
        if isinstance(payload, list):
            for row in payload:
                if not isinstance(row, dict):
                    continue

                items.append(
                    ExternalTradeItem(
                        price=str(row.get("price") or "0"),
                        amount=str(row.get("qty") or "0"),
                        ts=int(row.get("time") or self._now_ms()),
                        side="SELL" if bool(row.get("isBuyerMaker")) else "BUY",
                    )
                )

        return ExternalTradesResponse(
            symbol=normalized_symbol,
            items=items,
        )

    def get_ticker(self, symbol: str) -> ExternalTickerResponse:
        normalized_symbol = self._normalize_symbol(symbol)
        payload = self._request_json(
            "/api/v3/ticker/24hr",
            {"symbol": normalized_symbol},
        )

        return ExternalTickerResponse(
            symbol=normalized_symbol,
            price=str(payload.get("lastPrice") or "0"),
            price_change=str(payload.get("priceChange") or "0"),
            price_change_percent=str(payload.get("priceChangePercent") or "0"),
            volume=str(payload.get("volume") or "0"),
            quote_volume=str(payload.get("quoteVolume") or "0"),
            high_price=str(payload.get("highPrice") or "0"),
            low_price=str(payload.get("lowPrice") or "0"),
            ts=int(payload.get("closeTime") or self._now_ms()),
        )

    def get_depth(self, symbol: str, limit: int = 20) -> ExternalDepthResponse:
        normalized_symbol = self._normalize_symbol(symbol)
        requested_limit = self._normalize_depth_limit(limit)
        upstream_limit = self._pick_depth_limit(requested_limit)

        payload = self._request_json(
            "/api/v3/depth",
            {"symbol": normalized_symbol, "limit": upstream_limit},
        )

        bids = self._adapt_depth_side(payload.get("bids"), requested_limit)
        asks = self._adapt_depth_side(payload.get("asks"), requested_limit)

        return ExternalDepthResponse(
            symbol=normalized_symbol,
            bids=bids,
            asks=asks,
            ts=self._now_ms(),
        )

    def get_klines(
        self,
        symbol: str,
        interval: str,
        limit: int = 200,
        end_time_ms: Optional[int] = None,
    ) -> ExternalKlineResponse:
        normalized_symbol = self._normalize_symbol(symbol)
        normalized_interval = self._normalize_interval(interval)
        normalized_limit = self._normalize_kline_limit(limit)
        normalized_end_time = self._normalize_end_time_ms(end_time_ms)

        params: Dict[str, Any] = {
            "symbol": normalized_symbol,
            "interval": normalized_interval,
            "limit": normalized_limit,
        }
        if normalized_end_time is not None:
            # 对齐现有 /market/kline 的语义：返回 open_time < end_time 的更早数据。
            params["endTime"] = max(normalized_end_time - 1, 1)

        payload = self._request_json("/api/v3/klines", params)
        items: List[ExternalKlineItem] = []
        interval_ms = self.INTERVAL_MS[normalized_interval]

        for row in payload:
            if not isinstance(row, list) or len(row) < 8:
                continue

            open_time = int(row[0])
            items.append(
                ExternalKlineItem(
                    open_time=open_time,
                    close_time=open_time + interval_ms,
                    open=str(row[1]),
                    high=str(row[2]),
                    low=str(row[3]),
                    close=str(row[4]),
                    volume=str(row[5]),
                    quote_volume=str(row[7]),
                )
            )

        return ExternalKlineResponse(
            symbol=normalized_symbol,
            interval=normalized_interval,
            items=items,
        )

    def _request_json(self, path: str, params: Dict[str, Any]) -> Any:
        url = "{0}{1}".format(self.BASE_URL, path)
        symbol = str(params.get("symbol") or "")

        try:
            response = self._session.get(url, params=params, timeout=self.REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            self._log_upstream_error(symbol=symbol, endpoint=path, error=exc)
            raise BinanceMarketUpstreamError("Binance 行情请求失败，请稍后重试") from exc

        if response.status_code >= 400:
            message = self._extract_error_message(response)
            self._log_upstream_error(
                symbol=symbol,
                endpoint=path,
                error="{0} {1}".format(response.status_code, message),
            )

            if response.status_code in (400, 404):
                raise BinanceMarketBadRequest(message)

            if response.status_code in (418, 429):
                raise BinanceMarketUpstreamError("Binance 请求过于频繁，请稍后重试")

            raise BinanceMarketUpstreamError(message)

        try:
            return response.json()
        except ValueError as exc:
            self._log_upstream_error(symbol=symbol, endpoint=path, error=exc)
            raise BinanceMarketUpstreamError("Binance 返回了无法解析的数据") from exc

    def _log_upstream_error(self, symbol: str, endpoint: str, error: Any) -> None:
        logger.warning(
            "external market request failed provider=%s symbol=%s endpoint=%s error=%s",
            self.PROVIDER,
            symbol or "-",
            endpoint,
            error,
        )

    def _extract_error_message(self, response: requests.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            payload = None

        raw_message = ""
        if isinstance(payload, dict):
            raw_message = str(payload.get("msg") or "").strip()

        if not raw_message:
            raw_message = (response.text or "").strip()

        if "Invalid symbol" in raw_message:
            return "symbol 不存在或 Binance 不支持该交易对"
        if "Invalid interval" in raw_message:
            return "interval 不支持，仅支持 1m / 5m / 15m / 1h / 4h / 1d"
        if "Too many requests" in raw_message:
            return "Binance 请求过于频繁，请稍后重试"

        if raw_message:
            return "Binance 返回错误: {0}".format(raw_message[:200])

        return "Binance 行情服务暂时不可用"

    def _normalize_symbol(self, symbol: str) -> str:
        normalized_symbol = (symbol or "").upper().strip()
        if not normalized_symbol:
            raise BinanceMarketBadRequest("symbol 不能为空")
        return normalized_symbol

    def _normalize_interval(self, interval: str) -> str:
        normalized_interval = (interval or "").strip()
        if normalized_interval not in self.SUPPORTED_INTERVALS:
            raise BinanceMarketBadRequest("interval 仅支持 1m / 5m / 15m / 1h / 4h / 1d")
        return normalized_interval

    def _normalize_depth_limit(self, limit: int) -> int:
        try:
            normalized_limit = int(limit)
        except Exception as exc:
            raise BinanceMarketBadRequest("limit 必须是整数") from exc

        if normalized_limit <= 0:
            raise BinanceMarketBadRequest("limit 必须大于 0")

        return min(normalized_limit, 200)

    def _normalize_kline_limit(self, limit: int) -> int:
        try:
            normalized_limit = int(limit)
        except Exception as exc:
            raise BinanceMarketBadRequest("limit 必须是整数") from exc

        if normalized_limit <= 0:
            raise BinanceMarketBadRequest("limit 必须大于 0")

        return min(normalized_limit, 1000)

    def _normalize_trade_limit(self, limit: int) -> int:
        try:
            normalized_limit = int(limit)
        except Exception as exc:
            raise BinanceMarketBadRequest("limit 必须是整数") from exc

        if normalized_limit <= 0:
            raise BinanceMarketBadRequest("limit 必须大于 0")

        return min(normalized_limit, 200)

    def _normalize_end_time_ms(self, end_time_ms: Optional[int]) -> Optional[int]:
        if end_time_ms in (None, "", 0):
            return None

        try:
            normalized_end_time = int(end_time_ms)
        except Exception as exc:
            raise BinanceMarketBadRequest("end_time 必须是毫秒时间戳") from exc

        if normalized_end_time <= 0:
            raise BinanceMarketBadRequest("end_time 必须大于 0")

        return normalized_end_time

    def _pick_depth_limit(self, requested_limit: int) -> int:
        for option in self.DEPTH_LIMIT_OPTIONS:
            if requested_limit <= option:
                return option
        return self.DEPTH_LIMIT_OPTIONS[-1]

    def _adapt_depth_side(
        self,
        rows: Any,
        requested_limit: int,
    ) -> List[ExternalDepthItem]:
        items: List[ExternalDepthItem] = []

        if not isinstance(rows, list):
            return items

        for row in rows[:requested_limit]:
            if not isinstance(row, list) or len(row) < 2:
                continue

            items.append(
                ExternalDepthItem(
                    price=str(row[0]),
                    amount=str(row[1]),
                )
            )

        return items

    def _now_ms(self) -> int:
        return int(time.time() * 1000)


binance_market_service = BinanceMarketService()
