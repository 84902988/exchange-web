from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        Index("idx_user_id", "user_id"),
        Index("idx_trading_pair_id", "trading_pair_id"),
        Index("idx_user_pair_status", "user_id", "trading_pair_id", "status"),
        Index("idx_status_created_at", "status", "created_at"),
        Index("idx_created_at", "created_at"),
        Index(
            "idx_orders_match_scan",
            "trading_pair_id",
            "side",
            "order_type",
            "execution_mode",
            "status",
            "price",
            "id",
        ),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    order_no: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    trading_pair_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("trading_pairs.id", name="fk_orders_trading_pair"),
        nullable=False,
    )

    side: Mapped[str] = mapped_column(String(10), nullable=False)
    order_type: Mapped[str] = mapped_column(String(20), nullable=False)
    execution_mode: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="MATCHING",
        server_default="MATCHING",
        index=True,
        comment="执行模式: MATCHING / DEALER",
    )

    price: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False)

    filled_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    avg_price: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))

    frozen_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    executed_quote_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    fee_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    fee_asset_symbol: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    fee_asset_id: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        ForeignKey("assets.id", name="fk_orders_fee_asset"),
        nullable=True,
    )

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="WEB")

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # ✅ 关系
    trading_pair = relationship("TradingPair", back_populates="orders")
    fee_asset = relationship("Asset", foreign_keys=[fee_asset_id])

    def __repr__(self):
        return f"<Order id={self.id} order_no={self.order_no} status={self.status}>"
