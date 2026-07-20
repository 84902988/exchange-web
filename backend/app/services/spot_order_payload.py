from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, Optional

from app.core.datetime_utils import utc_isoformat
from app.db.models.order import Order


def _fmt(value: Any) -> str:
    if value is None:
        return "0"
    if isinstance(value, Decimal):
        return format(value.normalize(), "f") if value != 0 else "0"
    return str(value)


def _normalize_symbol(symbol: Optional[str]) -> str:
    return (symbol or "").upper().strip()


def _fee_symbol(symbol: Optional[str]) -> str:
    return _normalize_symbol(symbol) or "USDT"


def serialize_spot_order(order: Order, symbol: Optional[str] = None) -> Dict[str, Any]:
    pair_symbol = symbol
    if not pair_symbol:
        trading_pair = getattr(order, "trading_pair", None)
        pair_symbol = getattr(trading_pair, "symbol", "")

    amount = order.amount or Decimal("0")
    filled_amount = order.filled_amount or Decimal("0")
    remaining = amount - filled_amount
    if remaining < 0:
        remaining = Decimal("0")

    fee_asset = getattr(order, "fee_asset", None)
    fee_asset_symbol = _fee_symbol(getattr(order, "fee_asset_symbol", None) or (fee_asset.symbol if fee_asset else None))

    return {
        "id": order.id,
        "symbol": _normalize_symbol(pair_symbol),
        "side": order.side,
        "order_type": order.order_type,
        "price": _fmt(order.price),
        "amount": _fmt(order.amount),
        "filled_amount": _fmt(order.filled_amount),
        "remaining_amount": _fmt(remaining),
        "executed_quote_amount": _fmt(order.executed_quote_amount),
        "avg_price": _fmt(order.avg_price),
        "fee_amount": _fmt(order.fee_amount),
        "fee_asset_id": order.fee_asset_id,
        "fee_asset_symbol": fee_asset_symbol,
        "status": order.status,
        "created_at": utc_isoformat(order.created_at),
        "updated_at": utc_isoformat(order.updated_at),
    }
