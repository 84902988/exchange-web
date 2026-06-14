from __future__ import annotations

from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Numeric, String, func

from app.db.base import Base


class Trade(Base):
    __tablename__ = "trades"

    id = Column(BigInteger, primary_key=True, autoincrement=True)

    trading_pair_id = Column(BigInteger, ForeignKey("trading_pairs.id"), nullable=False)

    buy_order_id = Column(BigInteger, ForeignKey("orders.id"), nullable=False)
    sell_order_id = Column(BigInteger, ForeignKey("orders.id"), nullable=False)

    buyer_user_id = Column(BigInteger, nullable=False)
    seller_user_id = Column(BigInteger, nullable=False)

    price = Column(Numeric(36, 18), nullable=False)
    amount = Column(Numeric(36, 18), nullable=False)
    quote_amount = Column(Numeric(36, 18), nullable=False)
    fee_amount = Column(Numeric(36, 18), nullable=True)
    fee_asset_symbol = Column(String(20), nullable=True)
    buyer_fee_amount = Column(Numeric(36, 18), nullable=True)
    buyer_fee_asset_symbol = Column(String(20), nullable=True)
    seller_fee_amount = Column(Numeric(36, 18), nullable=True)
    seller_fee_asset_symbol = Column(String(20), nullable=True)
    dealer_ref_price = Column(Numeric(36, 18), nullable=True)
    dealer_best_bid = Column(Numeric(36, 18), nullable=True)
    dealer_best_ask = Column(Numeric(36, 18), nullable=True)
    dealer_price_source = Column(String(32), nullable=True)
    dealer_spread_bps = Column(Numeric(18, 8), nullable=True)

    maker_order_id = Column(BigInteger, nullable=False)
    taker_order_id = Column(BigInteger, nullable=False)
    counterparty_type = Column(
        String(20),
        nullable=False,
        default="USER",
        server_default="USER",
        index=True,
        comment="对手方类型: USER / PLATFORM",
    )

    created_at = Column(DateTime, nullable=False, server_default=func.now())
