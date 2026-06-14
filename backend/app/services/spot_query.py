from decimal import Decimal
from typing import Dict, List

from sqlalchemy import desc, or_
from sqlalchemy.orm import Session, joinedload

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.order import Order
from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair

OPEN_STATUSES = ["OPEN", "PARTIALLY_FILLED"]


def _fmt(value) -> str:
    if value is None:
        return "0"
    if isinstance(value, Decimal):
        return format(value.normalize(), "f") if value != 0 else "0"
    return str(value)


def _fee_symbol(value) -> str:
    return str(value or "").upper().strip() or "USDT"


def _get_pair_by_symbol(db: Session, symbol: str) -> TradingPair:
    pair = (
        db.query(TradingPair)
        .filter(TradingPair.symbol == symbol.upper())
        .first()
    )
    if not pair:
        raise ValueError(f"trading pair not found: {symbol}")
    return pair


def _build_order_item(row: Order, pair: TradingPair) -> Dict:
    remaining = (row.amount or Decimal("0")) - (row.filled_amount or Decimal("0"))
    if remaining < 0:
        remaining = Decimal("0")

    fee_asset = getattr(row, "fee_asset", None)
    fee_asset_symbol = _fee_symbol(getattr(row, "fee_asset_symbol", None) or (fee_asset.symbol if fee_asset else None))

    return {
        "id": row.id,
        "symbol": pair.symbol,
        "side": row.side,
        "order_type": row.order_type,
        "price": _fmt(row.price),
        "amount": _fmt(row.amount),
        "filled_amount": _fmt(row.filled_amount),
        "remaining_amount": _fmt(remaining),
        "executed_quote_amount": _fmt(row.executed_quote_amount),
        "avg_price": _fmt(row.avg_price),
        "fee_amount": _fmt(row.fee_amount),
        "fee_asset_id": row.fee_asset_id,
        "fee_asset_symbol": fee_asset_symbol,
        "status": row.status,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


# =========================
# 1. 资产
# =========================
def get_spot_balances(db: Session, user_id: int, symbol: str) -> Dict:
    pair = _get_pair_by_symbol(db, symbol)

    # ✅ 修正点
    base_symbol = pair.base_asset.symbol
    quote_symbol = pair.quote_asset.symbol

    rows = (
        db.query(UserBalance)
        .filter(
            UserBalance.user_id == user_id,
            UserBalance.chain_key == "spot",
            UserBalance.coin_symbol.in_([base_symbol, quote_symbol]),
        )
        .all()
    )

    balance_map = {row.coin_symbol.upper(): row for row in rows}

    def build_item(coin_symbol: str) -> Dict:
        row = balance_map.get(coin_symbol.upper())
        return {
            "coin_symbol": coin_symbol.upper(),
            "available_amount": _fmt(row.available_amount if row else Decimal("0")),
            "frozen_amount": _fmt(row.frozen_amount if row else Decimal("0")),
        }

    return {
        "symbol": pair.symbol,
        "base_asset": base_symbol,
        "quote_asset": quote_symbol,
        "items": [
            build_item(base_symbol),
            build_item(quote_symbol),
        ],
    }


# =========================
# 2. 当前委托
# =========================
def get_current_orders(db: Session, user_id: int, symbol: str, limit: int = 50) -> Dict:
    pair = _get_pair_by_symbol(db, symbol)

    rows = (
        db.query(Order)
        .options(joinedload(Order.fee_asset))
        .filter(
            Order.user_id == user_id,
            Order.trading_pair_id == pair.id,
            Order.status.in_(OPEN_STATUSES),
        )
        .order_by(desc(Order.id))
        .limit(limit)
        .all()
    )

    items: List[Dict] = []
    for row in rows:
        items.append(_build_order_item(row, pair))

    return {
        "symbol": pair.symbol,
        "total": len(items),
        "items": items,
    }


# =========================
# 3. 历史委托
# =========================
def get_history_orders(db: Session, user_id: int, symbol: str, limit: int = 100) -> Dict:
    pair = _get_pair_by_symbol(db, symbol)

    rows = (
        db.query(Order)
        .options(joinedload(Order.fee_asset))
        .filter(
            Order.user_id == user_id,
            Order.trading_pair_id == pair.id,
            ~Order.status.in_(OPEN_STATUSES),
        )
        .order_by(desc(Order.id))
        .limit(limit)
        .all()
    )

    items: List[Dict] = []
    for row in rows:
        items.append(_build_order_item(row, pair))

    return {
        "symbol": pair.symbol,
        "total": len(items),
        "items": items,
    }


# =========================
# 4. 成交明细
# =========================
def get_my_trades(db: Session, user_id: int, symbol: str, limit: int = 100) -> Dict:
    pair = _get_pair_by_symbol(db, symbol)

    rows = (
        db.query(Trade)
        .filter(
            Trade.trading_pair_id == pair.id,
            or_(
                Trade.buyer_user_id == user_id,
                Trade.seller_user_id == user_id,
            ),
        )
        .order_by(desc(Trade.id))
        .limit(limit)
        .all()
    )

    items: List[Dict] = []
    for row in rows:
        side = "BUY" if row.buyer_user_id == user_id else "SELL"
        own_order_id = row.buy_order_id if side == "BUY" else row.sell_order_id
        role = "MAKER" if own_order_id == row.maker_order_id else "TAKER"
        trade_fee_amount = getattr(row, "buyer_fee_amount" if side == "BUY" else "seller_fee_amount", None)
        trade_fee_asset_symbol = getattr(row, "buyer_fee_asset_symbol" if side == "BUY" else "seller_fee_asset_symbol", None)
        fee_log = None
        if trade_fee_amount is None or not trade_fee_asset_symbol:
            fee_log = (
                db.query(BalanceLog)
                .filter(
                    BalanceLog.user_id == user_id,
                    BalanceLog.biz_type == "TRADE_FEE",
                    BalanceLog.change_type == "TRADE_FEE_DEBIT",
                    BalanceLog.biz_id == f"{int(row.id)}:{int(own_order_id)}:{side}:{role}",
                )
                .first()
            )
            if fee_log:
                trade_fee_amount = abs(fee_log.change_amount)
                trade_fee_asset_symbol = fee_log.coin_symbol

        items.append({
            "trade_id": row.id,
            "symbol": pair.symbol,
            "side": side,
            "price": _fmt(row.price),
            "amount": _fmt(row.amount),
            "quote_amount": _fmt(row.quote_amount),
            "buyer_user_id": row.buyer_user_id,
            "seller_user_id": row.seller_user_id,
            "buy_order_id": row.buy_order_id,
            "sell_order_id": row.sell_order_id,
            "maker_order_id": row.maker_order_id,
            "taker_order_id": row.taker_order_id,
            "role": role,
            "fee_amount": _fmt(trade_fee_amount) if trade_fee_amount is not None else None,
            "fee_asset": _fee_symbol(trade_fee_asset_symbol),
            "fee_asset_symbol": _fee_symbol(trade_fee_asset_symbol),
            "created_at": row.created_at.isoformat() if row.created_at else None,
        })

    return {
        "symbol": pair.symbol,
        "total": len(items),
        "items": items,
    }
