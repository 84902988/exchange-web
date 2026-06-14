from __future__ import annotations

from decimal import Decimal, ROUND_DOWN

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


def get_rcb_price_usdt(db: Session) -> Decimal:
    price = (
        db.query(Trade.price)
        .join(TradingPair, TradingPair.id == Trade.trading_pair_id)
        .filter(
            TradingPair.symbol == RCB_USDT_SYMBOL,
            TradingPair.status == ACTIVE_TRADING_PAIR_STATUS,
        )
        .order_by(Trade.created_at.desc(), Trade.id.desc())
        .limit(1)
        .scalar()
    )
    if price is None:
        raise ValueError("RCBUSDT price not available")

    normalized_price = Decimal(str(price))
    if normalized_price <= Decimal("0"):
        raise ValueError("Invalid RCBUSDT price")
    if normalized_price < MIN_VALID_RCB_PRICE or normalized_price > MAX_VALID_RCB_PRICE:
        raise ValueError("Invalid RCBUSDT price")
    return _q18(normalized_price)
