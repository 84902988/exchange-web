from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional


TIMEOUT_SECONDS = 5

RESULT_OK = "OK"
RESULT_REGION_BLOCKED = "REGION_BLOCKED"
RESULT_TIMEOUT = "TIMEOUT"
RESULT_RATE_LIMITED = "RATE_LIMITED"
RESULT_HTTP_ERROR = "HTTP_ERROR"
RESULT_PARSE_ERROR = "PARSE_ERROR"

EndpointParser = Callable[[Any], Optional[str]]


@dataclass(frozen=True)
class Endpoint:
    provider: str
    endpoint_type: str
    url: str
    parser: EndpointParser


@dataclass(frozen=True)
class CheckResult:
    provider: str
    endpoint_type: str
    url: str
    http_status: int | None
    result: str
    latency_ms: int | None
    sample_price_or_size: str
    error_summary: str


def _first_present(data: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = data.get(key)
        if value not in (None, "", [], {}):
            return str(value)
    return None


def _require_sequence(data: Any) -> list[Any] | None:
    return data if isinstance(data, list) and data else None


def _binance_ticker(data: Any) -> str | None:
    if isinstance(data, dict):
        return _first_present(data, ("price",))
    return None


def _binance_depth(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    bids = _require_sequence(data.get("bids"))
    asks = _require_sequence(data.get("asks"))
    if bids and asks:
        return f"bid={bids[0][0]},ask={asks[0][0]}"
    return None


def _binance_kline(data: Any) -> str | None:
    rows = _require_sequence(data)
    if rows and isinstance(rows[0], list) and len(rows[0]) > 4:
        return f"close={rows[0][4]}"
    return None


def _binance_trades(data: Any) -> str | None:
    rows = _require_sequence(data)
    if rows and isinstance(rows[0], dict):
        return _first_present(rows[0], ("price", "qty"))
    return None


def _binance_funding(data: Any) -> str | None:
    rows = _require_sequence(data)
    if rows and isinstance(rows[0], dict):
        return _first_present(rows[0], ("fundingRate",))
    return None


def _okx_data_row(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    rows = _require_sequence(data.get("data"))
    return rows[0] if rows and isinstance(rows[0], dict) else None


def _okx_ticker(data: Any) -> str | None:
    row = _okx_data_row(data)
    return _first_present(row, ("last", "askPx", "bidPx")) if row else None


def _okx_depth(data: Any) -> str | None:
    row = _okx_data_row(data)
    if not row:
        return None
    bids = _require_sequence(row.get("bids"))
    asks = _require_sequence(row.get("asks"))
    if bids and asks:
        return f"bid={bids[0][0]},ask={asks[0][0]}"
    return None


def _okx_kline(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    rows = _require_sequence(data.get("data"))
    if rows and isinstance(rows[0], list) and len(rows[0]) > 4:
        return f"close={rows[0][4]}"
    return None


def _okx_trades(data: Any) -> str | None:
    row = _okx_data_row(data)
    return _first_present(row, ("px", "sz")) if row else None


def _okx_funding(data: Any) -> str | None:
    row = _okx_data_row(data)
    return _first_present(row, ("fundingRate",)) if row else None


def _bybit_result_row(data: Any, key: str = "list") -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    result = data.get("result")
    if not isinstance(result, dict):
        return None
    rows = _require_sequence(result.get(key))
    return rows[0] if rows and isinstance(rows[0], dict) else None


def _bybit_ticker(data: Any) -> str | None:
    row = _bybit_result_row(data)
    return _first_present(row, ("lastPrice", "ask1Price", "bid1Price")) if row else None


def _bybit_depth(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    result = data.get("result")
    if not isinstance(result, dict):
        return None
    bids = _require_sequence(result.get("b"))
    asks = _require_sequence(result.get("a"))
    if bids and asks:
        return f"bid={bids[0][0]},ask={asks[0][0]}"
    return None


def _bybit_kline(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    result = data.get("result")
    if not isinstance(result, dict):
        return None
    rows = _require_sequence(result.get("list"))
    if rows and isinstance(rows[0], list) and len(rows[0]) > 4:
        return f"close={rows[0][4]}"
    return None


def _bybit_trades(data: Any) -> str | None:
    row = _bybit_result_row(data)
    return _first_present(row, ("price", "size")) if row else None


def _bybit_funding(data: Any) -> str | None:
    row = _bybit_result_row(data)
    return _first_present(row, ("fundingRate",)) if row else None


def _bitget_data(data: Any) -> Any:
    return data.get("data") if isinstance(data, dict) else None


def _bitget_ticker(data: Any) -> str | None:
    payload = _bitget_data(data)
    if isinstance(payload, list) and payload and isinstance(payload[0], dict):
        return _first_present(payload[0], ("lastPr", "askPr", "bidPr"))
    if isinstance(payload, dict):
        return _first_present(payload, ("lastPr", "askPr", "bidPr"))
    return None


def _bitget_depth(data: Any) -> str | None:
    payload = _bitget_data(data)
    if not isinstance(payload, dict):
        return None
    bids = _require_sequence(payload.get("bids"))
    asks = _require_sequence(payload.get("asks"))
    if bids and asks:
        return f"bid={bids[0][0]},ask={asks[0][0]}"
    return None


def _bitget_kline(data: Any) -> str | None:
    rows = _require_sequence(_bitget_data(data))
    if rows and isinstance(rows[0], list) and len(rows[0]) > 4:
        return f"close={rows[0][4]}"
    return None


def _bitget_trades(data: Any) -> str | None:
    rows = _require_sequence(_bitget_data(data))
    if rows and isinstance(rows[0], dict):
        return _first_present(rows[0], ("price", "size"))
    return None


def _bitget_funding(data: Any) -> str | None:
    payload = _bitget_data(data)
    if isinstance(payload, dict):
        return _first_present(payload, ("fundingRate",))
    if isinstance(payload, list) and payload and isinstance(payload[0], dict):
        return _first_present(payload[0], ("fundingRate",))
    return None


ENDPOINTS: tuple[Endpoint, ...] = (
    Endpoint(
        "Binance USDM Futures",
        "ticker",
        "https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT",
        _binance_ticker,
    ),
    Endpoint(
        "Binance USDM Futures",
        "depth",
        "https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=5",
        _binance_depth,
    ),
    Endpoint(
        "Binance USDM Futures",
        "kline",
        "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=5",
        _binance_kline,
    ),
    Endpoint(
        "Binance USDM Futures",
        "trades",
        "https://fapi.binance.com/fapi/v1/trades?symbol=BTCUSDT&limit=5",
        _binance_trades,
    ),
    Endpoint(
        "Binance USDM Futures",
        "funding",
        "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1",
        _binance_funding,
    ),
    Endpoint(
        "OKX Swap",
        "ticker",
        "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP",
        _okx_ticker,
    ),
    Endpoint(
        "OKX Swap",
        "depth",
        "https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=5",
        _okx_depth,
    ),
    Endpoint(
        "OKX Swap",
        "kline",
        "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1m&limit=5",
        _okx_kline,
    ),
    Endpoint(
        "OKX Swap",
        "trades",
        "https://www.okx.com/api/v5/market/trades?instId=BTC-USDT-SWAP&limit=5",
        _okx_trades,
    ),
    Endpoint(
        "OKX Swap",
        "funding",
        "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP",
        _okx_funding,
    ),
    Endpoint(
        "Bybit Linear",
        "ticker",
        "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT",
        _bybit_ticker,
    ),
    Endpoint(
        "Bybit Linear",
        "depth",
        "https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=5",
        _bybit_depth,
    ),
    Endpoint(
        "Bybit Linear",
        "kline",
        "https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&limit=5",
        _bybit_kline,
    ),
    Endpoint(
        "Bybit Linear",
        "trades",
        "https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=5",
        _bybit_trades,
    ),
    Endpoint(
        "Bybit Linear",
        "funding",
        "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=1",
        _bybit_funding,
    ),
    Endpoint(
        "Bitget USDT Futures",
        "ticker",
        "https://api.bitget.com/api/v2/mix/market/ticker?symbol=BTCUSDT&productType=USDT-FUTURES",
        _bitget_ticker,
    ),
    Endpoint(
        "Bitget USDT Futures",
        "depth",
        "https://api.bitget.com/api/v2/mix/market/orderbook?symbol=BTCUSDT&productType=USDT-FUTURES&limit=5",
        _bitget_depth,
    ),
    Endpoint(
        "Bitget USDT Futures",
        "kline",
        "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1m&limit=5",
        _bitget_kline,
    ),
    Endpoint(
        "Bitget USDT Futures",
        "trades",
        "https://api.bitget.com/api/v2/mix/market/fills?symbol=BTCUSDT&productType=USDT-FUTURES&limit=5",
        _bitget_trades,
    ),
    Endpoint(
        "Bitget USDT Futures",
        "funding",
        "https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=BTCUSDT&productType=USDT-FUTURES",
        _bitget_funding,
    ),
)


def _looks_region_blocked(status: int | None, body: str) -> bool:
    lower_body = body.lower()
    return status == 451 or "restricted" in lower_body or "unavailable from a restricted location" in lower_body


def _short_error(text: str, limit: int = 180) -> str:
    cleaned = " ".join(text.replace("\r", " ").replace("\n", " ").split())
    return cleaned[:limit]


def _read_http_error(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def _is_timeout(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return True
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        return isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in str(reason).lower()
    return "timed out" in str(exc).lower()


def check_endpoint(endpoint: Endpoint) -> CheckResult:
    request = urllib.request.Request(
        endpoint.url,
        headers={
            "Accept": "application/json",
            "User-Agent": "exchange-web-contract-market-provider-check/1.0",
        },
        method="GET",
    )
    started = time.perf_counter()
    http_status: int | None = None
    body = ""

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            http_status = response.status
            body_bytes = response.read()
            body = body_bytes.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        http_status = exc.code
        body = _read_http_error(exc)
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000)
        if _is_timeout(exc):
            return CheckResult(
                endpoint.provider,
                endpoint.endpoint_type,
                endpoint.url,
                http_status,
                RESULT_TIMEOUT,
                latency_ms,
                "",
                type(exc).__name__,
            )
        return CheckResult(
            endpoint.provider,
            endpoint.endpoint_type,
            endpoint.url,
            http_status,
            RESULT_HTTP_ERROR,
            latency_ms,
            "",
            _short_error(f"{type(exc).__name__}: {exc}"),
        )

    latency_ms = round((time.perf_counter() - started) * 1000)
    if _looks_region_blocked(http_status, body):
        return CheckResult(
            endpoint.provider,
            endpoint.endpoint_type,
            endpoint.url,
            http_status,
            RESULT_REGION_BLOCKED,
            latency_ms,
            "",
            _short_error(body),
        )
    if http_status == 429:
        return CheckResult(
            endpoint.provider,
            endpoint.endpoint_type,
            endpoint.url,
            http_status,
            RESULT_RATE_LIMITED,
            latency_ms,
            "",
            _short_error(body),
        )
    if http_status != 200:
        return CheckResult(
            endpoint.provider,
            endpoint.endpoint_type,
            endpoint.url,
            http_status,
            RESULT_HTTP_ERROR,
            latency_ms,
            "",
            _short_error(body),
        )

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        return CheckResult(
            endpoint.provider,
            endpoint.endpoint_type,
            endpoint.url,
            http_status,
            RESULT_PARSE_ERROR,
            latency_ms,
            "",
            _short_error(f"JSONDecodeError: {exc}"),
        )

    sample = endpoint.parser(parsed)
    if not sample:
        return CheckResult(
            endpoint.provider,
            endpoint.endpoint_type,
            endpoint.url,
            http_status,
            RESULT_PARSE_ERROR,
            latency_ms,
            "",
            _short_error(body),
        )

    return CheckResult(
        endpoint.provider,
        endpoint.endpoint_type,
        endpoint.url,
        http_status,
        RESULT_OK,
        latency_ms,
        sample,
        "",
    )


def _format_table(rows: list[dict[str, Any]], columns: tuple[str, ...]) -> str:
    rendered_rows = [{column: "" if row.get(column) is None else str(row.get(column)) for column in columns} for row in rows]
    widths = {
        column: max(
            len(column),
            *(len(row[column]) for row in rendered_rows),
        )
        for column in columns
    }
    header = " | ".join(column.ljust(widths[column]) for column in columns)
    separator = "-+-".join("-" * widths[column] for column in columns)
    lines = [header, separator]
    for row in rendered_rows:
        lines.append(" | ".join(row[column].ljust(widths[column]) for column in columns))
    return "\n".join(lines)


def _result_to_row(result: CheckResult) -> dict[str, Any]:
    return {
        "provider": result.provider,
        "endpoint_type": result.endpoint_type,
        "url": result.url,
        "http_status": result.http_status if result.http_status is not None else "",
        "result": result.result,
        "latency_ms": result.latency_ms if result.latency_ms is not None else "",
        "sample_price_or_size": result.sample_price_or_size,
        "error_summary": result.error_summary,
    }


def _build_summary(results: list[CheckResult]) -> list[dict[str, Any]]:
    providers = dict.fromkeys(result.provider for result in results)
    summary_rows: list[dict[str, Any]] = []
    for provider in providers:
        provider_results = {result.endpoint_type: result for result in results if result.provider == provider}
        ticker_ok = provider_results.get("ticker") is not None and provider_results["ticker"].result == RESULT_OK
        depth_ok = provider_results.get("depth") is not None and provider_results["depth"].result == RESULT_OK
        kline_ok = provider_results.get("kline") is not None and provider_results["kline"].result == RESULT_OK
        trades_ok = provider_results.get("trades") is not None and provider_results["trades"].result == RESULT_OK
        funding_ok = provider_results.get("funding") is not None and provider_results["funding"].result == RESULT_OK
        required_ok_count = sum((ticker_ok, depth_ok, kline_ok))
        summary_rows.append(
            {
                "provider": provider,
                "quote_ok": str(ticker_ok),
                "depth_ok": str(depth_ok),
                "kline_ok": str(kline_ok),
                "trades_ok": str(trades_ok),
                "funding_ok": str(funding_ok),
                "overall_usable": str(required_ok_count >= 3),
            }
        )
    return summary_rows


def main() -> None:
    results = [check_endpoint(endpoint) for endpoint in ENDPOINTS]
    print("Contract public market API checks")
    print()
    print(
        _format_table(
            [_result_to_row(result) for result in results],
            (
                "provider",
                "endpoint_type",
                "url",
                "http_status",
                "result",
                "latency_ms",
                "sample_price_or_size",
                "error_summary",
            ),
        )
    )
    print()
    print("Provider summary")
    print()
    print(
        _format_table(
            _build_summary(results),
            (
                "provider",
                "quote_ok",
                "depth_ok",
                "kline_ok",
                "trades_ok",
                "funding_ok",
                "overall_usable",
            ),
        )
    )


if __name__ == "__main__":
    main()
