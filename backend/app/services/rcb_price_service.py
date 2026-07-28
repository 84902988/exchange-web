from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from typing import Optional

from sqlalchemy.orm import Session

from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair


RCB_USDT_SYMBOL = "RCBUSDT"
ACTIVE_TRADING_PAIR_STATUS = 1
MIN_VALID_RCB_PRICE = Decimal("0.00000001")
MAX_VALID_RCB_PRICE = Decimal("1000000")
Q18 = Decimal("0.000000000000000001")


def _q18(value: Decimal) -> Decimal:
    return Decimal(str(value or 0)).quantize(Q18, rounding=ROUND_DOWN)


def get_rcb_price_snapshot_usdt(
    db: Session,
    snapshot_at: Optional[datetime] = None,
) -> tuple[Decimal, int, datetime]:
    query = (
        db.query(Trade.id, Trade.price, Trade.created_at)
        .join(TradingPair, TradingPair.id == Trade.trading_pair_id)
        .filter(
            TradingPair.symbol == RCB_USDT_SYMBOL,
            TradingPair.status == ACTIVE_TRADING_PAIR_STATUS,
        )
    )
    if snapshot_at is not None:
        query = query.filter(Trade.created_at <= snapshot_at)
    row = query.order_by(Trade.created_at.desc(), Trade.id.desc()).limit(1).first()
    if row is None:
        raise ValueError("RCBUSDT price not available")

    normalized_price = Decimal(str(row.price))
    if normalized_price <= Decimal("0"):
        raise ValueError("Invalid RCBUSDT price")
    if normalized_price < MIN_VALID_RCB_PRICE or normalized_price > MAX_VALID_RCB_PRICE:
        raise ValueError("Invalid RCBUSDT price")
    return _q18(normalized_price), int(row.id), row.created_at


def get_rcb_price_usdt(db: Session) -> Decimal:
    price, _, _ = get_rcb_price_snapshot_usdt(db)
    return price
