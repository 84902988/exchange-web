from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractPositionSide(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


class ContractMarginMode(str, Enum):
    ISOLATED = "ISOLATED"


class ContractPositionStatus(str, Enum):
    OPEN = "OPEN"
    CLOSED = "CLOSED"
    LIQUIDATED = "LIQUIDATED"


class ContractPosition(Base):
    __tablename__ = "contract_positions"
    __table_args__ = (
        Index("idx_contract_positions_user", "user_id"),
        Index("idx_contract_positions_symbol", "symbol"),
        Index("idx_contract_positions_user_symbol_status", "user_id", "symbol", "status"),
        Index("idx_contract_positions_status", "status"),
        Index("idx_contract_positions_liquidatable", "is_liquidatable"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    side: Mapped[str] = mapped_column(String(10), nullable=False)
    margin_mode: Mapped[str] = mapped_column(String(20), nullable=False, default=ContractMarginMode.ISOLATED.value)
    leverage: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    mark_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    margin_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    open_fee: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    unrealized_pnl: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    realized_pnl: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    liquidation_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    warning_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    take_profit_price: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    stop_loss_price: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=ContractPositionStatus.OPEN.value)
    close_reason: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    is_liquidatable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_risk_check_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
