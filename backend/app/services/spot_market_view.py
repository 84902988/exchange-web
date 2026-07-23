from __future__ import annotations

import time
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.schemas.market import DepthResponse, TradesResponse
from app.services.market import _get_active_pair, get_depth, get_klines, get_market_tickers, get_trades


SPOT_MARKET_VIEW_BUDGET_SECONDS = 2.8
SPOT_MARKET_VIEW_KLINE_INTERVAL = "1m"


def _dump_model(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, dict):
        return dict(value)
    return {}


def _decimal_or_none(value: Any) -> Optional[Decimal]:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _to_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def _int_or_none(value: Any) -> Optional[int]:
    try:
        number = int(value)
    except Exception:
        return None
    if 0 <= number <= 12:
        return number
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
    return min(max(0, -int(tick.normalize().as_tuple().exponent)), 12)


def _tick_size_from_precision(precision: Optional[int]) -> Optional[str]:
    normalized = _int_or_none(precision)
    if normalized is None:
        return None
    if normalized <= 0:
        return "1"
    return "0." + ("0" * (normalized - 1)) + "1"


def _best_price(depth: Optional[DepthResponse], side: str) -> Optional[str]:
    levels = getattr(depth, side, None) or []
    if not levels:
        return None
    return _to_str(getattr(levels[0], "price", None))


def _has_depth_levels(depth: Optional[DepthResponse]) -> bool:
    if depth is None:
        return False
    return bool(getattr(depth, "bids", None) or getattr(depth, "asks", None))


def _spread(best_bid: Optional[str], best_ask: Optional[str]) -> Optional[str]:
    bid = _decimal_or_none(best_bid)
    ask = _decimal_or_none(best_ask)
    if bid is None or ask is None:
        return None
    return format(ask - bid, "f")


def _format_price(value: Decimal, precision: Optional[int]) -> str:
    if precision is None:
        return format(value, "f")
    return format(value.quantize(Decimal("1").scaleb(-precision)), "f")


def _orderbook_mid_price(
    best_bid: Optional[str],
    best_ask: Optional[str],
    precision: Optional[int],
) -> Optional[str]:
    bid = _decimal_or_none(best_bid)
    ask = _decimal_or_none(best_ask)
    if bid is None or ask is None or bid <= 0 or ask <= 0:
        return None
    return _format_price((bid + ask) / Decimal("2"), precision)


def _is_stale(payload: Any) -> bool:
    if payload is None:
        return False
    if isinstance(payload, dict):
        return bool(payload.get("stale"))
    return bool(getattr(payload, "stale", False))


def _payload_value(payload: Any, key: str) -> Any:
    if payload is None:
        return None
    if isinstance(payload, dict):
        return payload.get(key)
    return getattr(payload, key, None)


def _normalized_source(payload: Any, *, has_data: bool, default: str = "MISSING") -> str:
    if not has_data or payload is None:
        return "MISSING"
    provider = str(_payload_value(payload, "provider") or "").upper()
    raw_source = str(_payload_value(payload, "source") or "").upper()
    if _is_stale(payload) or provider == "LAST_GOOD":
        return "LAST_GOOD"
    if raw_source == "LIVE_WS":
        return "LIVE_WS"
    if raw_source == "EXTERNAL":
        return "REST"
    if raw_source == "INTERNAL":
        return "INTERNAL"
    if raw_source:
        return raw_source
    if provider:
        return "REST"
    return default


def _freshness_from_source(
    source: str,
    *,
    has_data: bool,
    quote_freshness: Optional[str] = None,
) -> str:
    if not has_data:
        return "MISSING"
    quote_value = str(quote_freshness or "").upper()
    if quote_value in {"LAST_GOOD", "LAST_VALID", "FALLBACK"}:
        return "LAST_GOOD"
    if quote_value == "STALE":
        return "STALE"
    if quote_value == "LIVE":
        return "LIVE"
    if source == "LIVE_WS":
        return "LIVE"
    if source == "LAST_GOOD":
        return "LAST_GOOD"
    if source == "MISSING":
        return "MISSING"
    return "RECENT"


def _latest_trade_price(trades: Optional[TradesResponse]) -> Optional[str]:
    items = getattr(trades, "trades", None) or []
    if not items:
        return None
    return _to_str(getattr(items[0], "price", None))


def _latest_kline_close(kline: dict[str, Any]) -> Optional[str]:
    items = list((kline or {}).get("items") or [])
    if not items:
        return None
    latest_item = items[-1]
    if not isinstance(latest_item, dict):
        return None
    return _to_str(latest_item.get("close"))


def _price_direction(trades: Optional[TradesResponse], ticker: dict[str, Any]) -> str:
    items = getattr(trades, "trades", None) or []
    if len(items) >= 2:
        current = _decimal_or_none(getattr(items[0], "price", None))
        previous = _decimal_or_none(getattr(items[1], "price", None))
        if current is not None and previous is not None:
            if current > previous:
                return "up"
            if current < previous:
                return "down"
            return "flat"

    change = _decimal_or_none(
        ticker.get("price_change_percent_24h")
        or ticker.get("price_change_percent")
        or ticker.get("change_24h")
    )
    if change is None:
        return "flat"
    if change > 0:
        return "up"
    if change < 0:
        return "down"
    return "flat"


def _status(has_data: bool, error: Optional[Exception]) -> str:
    if has_data:
        return "ok"
    if error is not None:
        return "error"
    return "missing"


def _serialize_depth(depth: Optional[DepthResponse]) -> Optional[dict[str, Any]]:
    if depth is None:
        return None
    data = _dump_model(depth)
    data["bids"] = [_dump_model(item) for item in getattr(depth, "bids", [])]
    data["asks"] = [_dump_model(item) for item in getattr(depth, "asks", [])]
    return data


def _serialize_trades(trades: Optional[TradesResponse]) -> Optional[dict[str, Any]]:
    if trades is None:
        return None
    return {
        **_dump_model(trades),
        "items": [_dump_model(item) for item in getattr(trades, "trades", [])],
    }


def build_empty_spot_market_view(*, symbol: str, warnings: Optional[list[str]] = None) -> dict[str, Any]:
    normalized_symbol = str(symbol or "").upper().strip()
    return {
        "symbol": normalized_symbol,
        "display_price": None,
        "display_price_source": "missing",
        "last_price": None,
        "last_trade_price": None,
        "orderbook_mid_price": None,
        "ticker_last_price": None,
        "ticker_24h_change": None,
        "ticker_24h_change_percent": None,
        "ticker_24h_high": None,
        "ticker_24h_low": None,
        "ticker_volume": None,
        "ticker_quote_volume": None,
        "price_precision": None,
        "price_tick_size": None,
        "display_price_precision": 2,
        "price_precision_source": "FALLBACK",
        "price_precision_provider": None,
        "amount_precision": None,
        "best_bid": None,
        "best_ask": None,
        "spread": None,
        "price_direction": "flat",
        "market_status": "UNKNOWN",
        "data_source": "UNKNOWN",
        "depth_status": "missing",
        "trades_status": "missing",
        "kline_status": "unknown",
        "depth_source": "MISSING",
        "trades_source": "MISSING",
        "ticker_source": "MISSING",
        "kline_source": "UNKNOWN",
        "depth_freshness": "MISSING",
        "trades_freshness": "MISSING",
        "ticker_freshness": "MISSING",
        "kline_freshness": "UNKNOWN",
        "quote_freshness": "MISSING",
        "executable": False,
        "updated_at": datetime.utcnow().isoformat(),
        "warnings": list(warnings or []),
        "raw_source_summary": {
            "ticker_source": None,
            "ticker_provider": None,
            "ticker_stale": None,
            "ticker_freshness": "MISSING",
            "ticker_error": None,
            "depth_source": None,
            "depth_provider": None,
            "depth_stale": None,
            "depth_freshness": "MISSING",
            "trades_provider": None,
            "trades_stale": None,
            "trades_source": None,
            "trades_freshness": "MISSING",
            "kline_source": "UNKNOWN",
            "kline_freshness": "UNKNOWN",
            "price_precision": None,
            "price_tick_size": None,
            "display_price_precision": 2,
            "price_precision_source": "FALLBACK",
            "price_precision_provider": None,
            "amount_precision": None,
        },
        "ticker": None,
        "depth": None,
        "trades": None,
    }


def build_spot_market_snapshot_payload(view: dict[str, Any]) -> dict[str, Any]:
    symbol = str(view.get("symbol") or "").upper().strip()
    return {
        "type": "spot_market_snapshot",
        "symbol": symbol,
        "market_view": view,
        "depth": view.get("depth") or {"symbol": symbol, "bids": [], "asks": []},
        "trades": view.get("trades") or {"symbol": symbol, "items": []},
    }


def get_spot_market_view(
    db: Session,
    *,
    symbol: str,
    depth_limit: int = 20,
    trades_limit: int = 30,
    total_budget_seconds: Optional[float] = SPOT_MARKET_VIEW_BUDGET_SECONDS,
    fast_external: bool = True,
) -> dict[str, Any]:
    normalized_symbol = str(symbol or "").upper().strip()
    if not normalized_symbol:
        raise ValueError("symbol is required")
    # MarketView is a public bootstrap authority. It must reject a configured
    # disabled pair before independent domain fallbacks can synthesize an
    # empty-but-successful view for a symbol that is no longer tradable.
    _get_active_pair(db, normalized_symbol)

    warnings: list[str] = []
    depth: Optional[DepthResponse] = None
    trades: Optional[TradesResponse] = None
    ticker: dict[str, Any] = {}
    kline: dict[str, Any] = {}
    depth_error: Optional[Exception] = None
    trades_error: Optional[Exception] = None
    ticker_error: Optional[Exception] = None
    kline_error: Optional[Exception] = None
    deadline = (
        time.monotonic() + max(0.0, float(total_budget_seconds))
        if total_budget_seconds is not None
        else None
    )

    def budget_exhausted(stage: str) -> bool:
        if deadline is None or time.monotonic() < deadline:
            return False
        warnings.append(f"{stage}_skipped:budget_exhausted")
        return True

    if not budget_exhausted("depth"):
        try:
            depth = get_depth(db=db, symbol=normalized_symbol, limit=depth_limit, fast=fast_external)
        except Exception as exc:
            depth_error = exc
            warnings.append(f"depth_unavailable:{exc}")

    if not budget_exhausted("trades"):
        try:
            trades = get_trades(db=db, symbol=normalized_symbol, limit=trades_limit, fast=fast_external)
        except Exception as exc:
            trades_error = exc
            warnings.append(f"trades_unavailable:{exc}")

    if not budget_exhausted("ticker"):
        try:
            tickers = get_market_tickers(db=db, symbol=normalized_symbol, spot_fast=fast_external)
            ticker = tickers[0] if tickers else {}
            if not ticker:
                warnings.append("ticker_unavailable")
        except Exception as exc:
            ticker_error = exc
            warnings.append(f"ticker_unavailable:{exc}")

    if not budget_exhausted("kline"):
        try:
            kline = get_klines(
                db=db,
                symbol=normalized_symbol,
                interval=SPOT_MARKET_VIEW_KLINE_INTERVAL,
                limit=1,
            ) or {}
            if not kline.get("items"):
                warnings.append("kline_unavailable")
        except Exception as exc:
            kline_error = exc
            warnings.append(f"kline_unavailable:{exc}")

    best_bid = _best_price(depth, "bids")
    best_ask = _best_price(depth, "asks")
    last_trade_price = _latest_trade_price(trades)
    ticker_last_price = _to_str(ticker.get("last_price"))
    price_precision = (
        _int_or_none(getattr(depth, "price_precision", None))
        or _int_or_none(ticker.get("price_precision"))
    )
    amount_precision = (
        _int_or_none(getattr(depth, "amount_precision", None))
        or _int_or_none(ticker.get("amount_precision"))
    )
    ticker_price_tick_size = ticker.get("price_tick_size") or ticker.get("tick_size")
    depth_price_tick_size = getattr(depth, "price_tick_size", None) or getattr(depth, "tick_size", None)
    ticker_display_precision = _int_or_none(ticker.get("display_price_precision"))
    depth_display_precision = _int_or_none(getattr(depth, "display_price_precision", None))
    display_price_precision = next(
        (
            item
            for item in (
                ticker_display_precision,
                _precision_from_tick_size(ticker_price_tick_size),
                depth_display_precision,
                _precision_from_tick_size(depth_price_tick_size),
                price_precision,
                2,
            )
            if item is not None
        ),
        2,
    )
    price_tick_size_value = next(
        (
            item
            for item in (ticker_price_tick_size, depth_price_tick_size, _tick_size_from_precision(display_price_precision))
            if item not in (None, "")
        ),
        None,
    )
    price_tick_size = _to_str(price_tick_size_value)
    price_precision_source = (
        ticker.get("price_precision_source")
        or getattr(depth, "price_precision_source", None)
        or ("TRADING_PAIR" if price_precision is not None else "FALLBACK")
    )
    price_precision_provider = (
        ticker.get("price_precision_provider")
        or getattr(depth, "price_precision_provider", None)
    )
    orderbook_mid_price = _orderbook_mid_price(best_bid, best_ask, display_price_precision)
    market_status = str(ticker.get("market_status") or "UNKNOWN").upper()
    has_depth = _has_depth_levels(depth)
    has_trades = bool(getattr(trades, "trades", None))
    has_kline = bool(kline.get("items"))
    has_ticker = bool(ticker_last_price)
    kline_last_price = _latest_kline_close(kline)
    depth_source = _normalized_source(depth, has_data=has_depth)
    trades_source = _normalized_source(trades, has_data=has_trades, default="INTERNAL")
    ticker_source = _normalized_source(ticker, has_data=has_ticker)
    kline_source = _normalized_source(kline, has_data=has_kline, default="UNKNOWN")
    depth_freshness = _freshness_from_source(depth_source, has_data=has_depth)
    trades_freshness = _freshness_from_source(trades_source, has_data=has_trades)
    ticker_freshness = _freshness_from_source(
        ticker_source,
        has_data=has_ticker,
        quote_freshness=ticker.get("quote_freshness"),
    )
    kline_freshness = _freshness_from_source(
        kline_source,
        has_data=has_kline,
        quote_freshness=kline.get("freshness"),
    )
    if last_trade_price:
        display_price = last_trade_price
        display_price_source = (
            "last_good_trade"
            if trades_freshness in {"LAST_GOOD", "STALE"}
            else "last_trade"
        )
    elif ticker_last_price:
        display_price = ticker_last_price
        display_price_source = (
            "last_good_ticker"
            if ticker_freshness in {"LAST_GOOD", "STALE"}
            else "ticker"
        )
    elif kline_last_price:
        display_price = kline_last_price
        display_price_source = (
            "last_good_kline"
            if kline_freshness in {"LAST_GOOD", "STALE"}
            else "kline_close"
        )
    else:
        display_price = None
        display_price_source = "missing"

    return {
        "symbol": normalized_symbol,
        "display_price": display_price,
        "display_price_source": display_price_source,
        "last_price": last_trade_price or ticker_last_price or kline_last_price,
        "last_trade_price": last_trade_price,
        "orderbook_mid_price": orderbook_mid_price,
        "ticker_last_price": ticker_last_price,
        "ticker_24h_change": ticker.get("price_change_24h"),
        "ticker_24h_change_percent": (
            ticker.get("price_change_percent_24h")
            or ticker.get("price_change_percent")
            or ticker.get("change_24h")
        ),
        "ticker_24h_high": ticker.get("high_24h"),
        "ticker_24h_low": ticker.get("low_24h"),
        "ticker_volume": ticker.get("base_volume_24h") or ticker.get("volume_24h"),
        "ticker_quote_volume": ticker.get("quote_volume_24h"),
        "price_precision": price_precision,
        "price_tick_size": price_tick_size,
        "display_price_precision": display_price_precision,
        "price_precision_source": price_precision_source,
        "price_precision_provider": price_precision_provider,
        "amount_precision": amount_precision,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "spread": _spread(best_bid, best_ask),
        "price_direction": _price_direction(trades, ticker),
        "market_status": market_status,
        "data_source": ticker.get("data_source") or ticker.get("source") or "UNKNOWN",
        "depth_status": _status(has_depth, depth_error),
        "trades_status": _status(has_trades, trades_error),
        "kline_status": _status(has_kline, kline_error),
        "depth_source": depth_source,
        "trades_source": trades_source,
        "ticker_source": ticker_source,
        "kline_source": kline_source,
        "depth_freshness": depth_freshness,
        "trades_freshness": trades_freshness,
        "ticker_freshness": ticker_freshness,
        "kline_freshness": kline_freshness,
        "quote_freshness": ticker_freshness,
        "executable": market_status == "OPEN" and has_depth,
        "updated_at": datetime.utcnow().isoformat(),
        "warnings": warnings,
        "raw_source_summary": {
            "ticker_source": ticker.get("source"),
            "ticker_provider": ticker.get("provider"),
            "ticker_stale": ticker.get("stale"),
            "ticker_freshness": ticker_freshness,
            "ticker_error": str(ticker_error) if ticker_error else None,
            "depth_source": getattr(depth, "source", None),
            "depth_provider": getattr(depth, "provider", None),
            "depth_stale": getattr(depth, "stale", None) if depth is not None else None,
            "depth_freshness": depth_freshness,
            "trades_source": getattr(trades, "source", None),
            "trades_provider": getattr(trades, "provider", None),
            "trades_stale": getattr(trades, "stale", None) if trades is not None else None,
            "trades_freshness": trades_freshness,
            "kline_source": kline_source,
            "kline_provider": kline.get("provider"),
            "kline_stale": kline.get("stale"),
            "kline_freshness": kline_freshness,
            "kline_interval": kline.get("interval") or SPOT_MARKET_VIEW_KLINE_INTERVAL,
            "kline_error": str(kline_error) if kline_error else None,
            "price_precision": price_precision,
            "price_tick_size": price_tick_size,
            "display_price_precision": display_price_precision,
            "price_precision_source": price_precision_source,
            "price_precision_provider": price_precision_provider,
            "amount_precision": amount_precision,
        },
        "ticker": ticker or None,
        "depth": _serialize_depth(depth),
        "trades": _serialize_trades(trades),
    }


def get_spot_market_snapshot_payload(
    db: Session,
    *,
    symbol: str,
    depth_limit: int = 20,
    trades_limit: int = 30,
    total_budget_seconds: Optional[float] = SPOT_MARKET_VIEW_BUDGET_SECONDS,
    fast_external: bool = True,
) -> dict[str, Any]:
    view = get_spot_market_view(
        db,
        symbol=symbol,
        depth_limit=depth_limit,
        trades_limit=trades_limit,
        total_budget_seconds=total_budget_seconds,
        fast_external=fast_external,
    )
    return build_spot_market_snapshot_payload(view)
