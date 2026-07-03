from __future__ import annotations

import time
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.schemas.market import DepthResponse, TradesResponse
from app.services.market import get_depth, get_market_tickers, get_trades


SPOT_MARKET_VIEW_BUDGET_SECONDS = 2.8


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


def _best_price(depth: Optional[DepthResponse], side: str) -> Optional[str]:
    levels = getattr(depth, side, None) or []
    if not levels:
        return None
    return _to_str(getattr(levels[0], "price", None))


def _spread(best_bid: Optional[str], best_ask: Optional[str]) -> Optional[str]:
    bid = _decimal_or_none(best_bid)
    ask = _decimal_or_none(best_ask)
    if bid is None or ask is None:
        return None
    return format(ask - bid, "f")


def _latest_trade_price(trades: Optional[TradesResponse]) -> Optional[str]:
    items = getattr(trades, "trades", None) or []
    if not items:
        return None
    return _to_str(getattr(items[0], "price", None))


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
        "best_bid": None,
        "best_ask": None,
        "spread": None,
        "price_direction": "flat",
        "market_status": "UNKNOWN",
        "data_source": "UNKNOWN",
        "depth_status": "missing",
        "trades_status": "missing",
        "kline_status": "unknown",
        "executable": False,
        "updated_at": datetime.utcnow().isoformat(),
        "warnings": list(warnings or []),
        "raw_source_summary": {
            "ticker_source": None,
            "ticker_provider": None,
            "ticker_stale": None,
            "ticker_error": None,
            "depth_source": None,
            "depth_provider": None,
            "depth_stale": None,
            "trades_provider": None,
            "trades_stale": None,
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

    warnings: list[str] = []
    depth: Optional[DepthResponse] = None
    trades: Optional[TradesResponse] = None
    ticker: dict[str, Any] = {}
    depth_error: Optional[Exception] = None
    trades_error: Optional[Exception] = None
    ticker_error: Optional[Exception] = None
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

    best_bid = _best_price(depth, "bids")
    best_ask = _best_price(depth, "asks")
    latest_trade_price = _latest_trade_price(trades)
    ticker_price = _to_str(ticker.get("last_price"))
    depth_price = _to_str(getattr(depth, "last_price", None) or getattr(depth, "mid_price", None))
    display_price = latest_trade_price or ticker_price or depth_price
    display_price_source = (
        "latest_trade"
        if latest_trade_price
        else "ticker"
        if ticker_price
        else "depth"
        if depth_price
        else "missing"
    )
    market_status = str(ticker.get("market_status") or "UNKNOWN").upper()
    has_depth = bool(best_bid and best_ask)
    has_trades = bool(getattr(trades, "trades", None))
    has_kline = "unknown"

    return {
        "symbol": normalized_symbol,
        "display_price": display_price,
        "display_price_source": display_price_source,
        "last_price": latest_trade_price or ticker_price,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "spread": _spread(best_bid, best_ask),
        "price_direction": _price_direction(trades, ticker),
        "market_status": market_status,
        "data_source": ticker.get("data_source") or ticker.get("source") or "UNKNOWN",
        "depth_status": _status(has_depth, depth_error),
        "trades_status": _status(has_trades, trades_error),
        "kline_status": has_kline,
        "executable": market_status == "OPEN" and has_depth,
        "updated_at": datetime.utcnow().isoformat(),
        "warnings": warnings,
        "raw_source_summary": {
            "ticker_source": ticker.get("source"),
            "ticker_provider": ticker.get("provider"),
            "ticker_stale": ticker.get("stale"),
            "ticker_error": str(ticker_error) if ticker_error else None,
            "depth_source": getattr(depth, "source", None),
            "depth_provider": getattr(depth, "provider", None),
            "depth_stale": getattr(depth, "stale", None) if depth is not None else None,
            "trades_provider": getattr(trades, "provider", None),
            "trades_stale": getattr(trades, "stale", None) if trades is not None else None,
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
