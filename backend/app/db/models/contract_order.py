from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractOrderSide(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class ContractOrderAction(str, Enum):
    OPEN = "OPEN"
    CLOSE = "CLOSE"


class ContractOrderType(str, Enum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"


class ContractOrderStatus(str, Enum):
    NEW = "NEW"
    OPEN = "OPEN"
    FILLED = "FILLED"
    CANCELED = "CANCELED"
    FAILED = "FAILED"


class ContractOrder(Base):
    __tablename__ = "contract_orders"
    __table_args__ = (
        UniqueConstraint("order_no", name="uk_contract_orders_order_no"),
        Index("idx_contract_orders_user", "user_id"),
        Index("idx_contract_orders_symbol", "symbol"),
        Index("idx_contract_orders_position", "position_id"),
        Index("idx_contract_orders_user_symbol_status", "user_id", "symbol", "status"),
        Index("idx_contract_orders_status_created_at", "status", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    order_no: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    position_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    side: Mapped[str] = mapped_column(String(10), nullable=False)
    position_side: Mapped[str] = mapped_column(String(10), nullable=False)
    action: Mapped[str] = mapped_column(String(10), nullable=False)
    order_type: Mapped[str] = mapped_column(String(20), nullable=False)
    price: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    leverage: Mapped[int] = mapped_column(Integer, nullable=False)
    margin_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    fee_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    spread_x_snapshot: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    spread_fee: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    trigger_price: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    take_profit_price: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    stop_loss_price: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    filled_quantity: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    avg_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=ContractOrderStatus.NEW.value)
    fail_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
