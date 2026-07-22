from decimal import Decimal
from typing import Dict, List, Optional, Union

from sqlalchemy import desc, or_
from sqlalchemy.orm import Session, joinedload

from app.core.datetime_utils import spot_trade_utc_isoformat, utc_isoformat
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


def _fmt_optional(value) -> Optional[str]:
    return _fmt(value) if value is not None else None


def _spot_trade_dealer_evidence(row: Trade) -> Dict:
    return {
        "dealer_ref_price": _fmt_optional(getattr(row, "dealer_ref_price", None)),
        "dealer_best_bid": _fmt_optional(getattr(row, "dealer_best_bid", None)),
        "dealer_best_ask": _fmt_optional(getattr(row, "dealer_best_ask", None)),
        "dealer_price_source": getattr(row, "dealer_price_source", None),
        "dealer_spread_bps": _fmt_optional(getattr(row, "dealer_spread_bps", None)),
        "dealer_provider": getattr(row, "dealer_provider", None),
        "dealer_provider_symbol": getattr(row, "dealer_provider_symbol", None),
        "dealer_event_time_ms": getattr(row, "dealer_event_time_ms", None),
        "dealer_received_at_ms": getattr(row, "dealer_received_at_ms", None),
        "dealer_freshness": getattr(row, "dealer_freshness", None),
        "dealer_snapshot_id": getattr(row, "dealer_snapshot_id", None),
        "dealer_provider_generation": getattr(row, "dealer_provider_generation", None),
        "dealer_snapshot_max_age_ms": getattr(row, "dealer_snapshot_max_age_ms", None),
    }


def _get_pair_by_symbol(db: Session, symbol: str) -> TradingPair:
    pair = (
        db.query(TradingPair)
        .filter(TradingPair.symbol == symbol.upper())
        .first()
    )
    if not pair:
        raise ValueError(f"trading pair not found: {symbol}")
    return pair


def _remaining_amount(row: Order) -> Decimal:
    remaining = (row.amount or Decimal("0")) - (row.filled_amount or Decimal("0"))
    return max(remaining, Decimal("0"))


def _is_effectively_open(row: Order) -> bool:
    return str(row.status or "").upper().strip() in OPEN_STATUSES and _remaining_amount(row) > 0


def _build_order_item(row: Order, pair: TradingPair) -> Dict:
    remaining = _remaining_amount(row)
    amount = row.amount or Decimal("0")
    filled_amount = row.filled_amount or Decimal("0")
    status = row.status
    if str(status or "").upper().strip() in OPEN_STATUSES and amount > 0 and filled_amount >= amount:
        # Historical rows created before the matching status invariant was
        # enforced can retain PARTIALLY_FILLED after their remaining amount
        # reaches zero. Keep the database immutable here, but expose the
        # effective terminal state consistently to current/history consumers.
        status = "FILLED"

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
        "status": status,
        "created_at": utc_isoformat(row.created_at),
        "updated_at": utc_isoformat(row.updated_at),
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
            Order.amount > Order.filled_amount,
        )
        .order_by(desc(Order.id))
        .limit(limit)
        .all()
    )

    items: List[Dict] = []
    for row in rows:
        # Keep a fail-closed read guard in addition to the SQL predicate so a
        # stale ORM row can never reappear through a private-event snapshot.
        if _is_effectively_open(row):
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
            or_(
                ~Order.status.in_(OPEN_STATUSES),
                Order.amount <= Order.filled_amount,
            ),
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
def get_my_trades(db: Session, user_id: Union[int, str], symbol: str, limit: int = 100) -> Dict:
    # get_current_user_id currently returns the JWT subject as a string. SQL
    # comparisons coerce it for us, but Python does not: comparing an integer
    # buyer_user_id with a string user_id would classify every trade as SELL
    # and expose the counterparty's fee snapshot. Normalize once at the service
    # boundary so both the query and the ownership checks use the same type.
    normalized_user_id = int(user_id)
    pair = _get_pair_by_symbol(db, symbol)

    rows = (
        db.query(Trade)
        .filter(
            Trade.trading_pair_id == pair.id,
            or_(
                Trade.buyer_user_id == normalized_user_id,
                Trade.seller_user_id == normalized_user_id,
            ),
        )
        .order_by(desc(Trade.id))
        .limit(limit)
        .all()
    )

    items: List[Dict] = []
    for row in rows:
        side = "BUY" if row.buyer_user_id == normalized_user_id else "SELL"
        own_order_id = row.buy_order_id if side == "BUY" else row.sell_order_id
        role = "MAKER" if own_order_id == row.maker_order_id else "TAKER"
        trade_fee_amount = getattr(row, "buyer_fee_amount" if side == "BUY" else "seller_fee_amount", None)
        trade_fee_asset_symbol = getattr(row, "buyer_fee_asset_symbol" if side == "BUY" else "seller_fee_asset_symbol", None)
        fee_log = None
        if trade_fee_amount is None or not trade_fee_asset_symbol:
            fee_log = (
                db.query(BalanceLog)
                .filter(
                    BalanceLog.user_id == normalized_user_id,
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
            **_spot_trade_dealer_evidence(row),
            "created_at": spot_trade_utc_isoformat(row.created_at),
        })

    return {
        "symbol": pair.symbol,
        "total": len(items),
        "items": items,
    }
