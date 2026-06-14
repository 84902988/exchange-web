from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum

from sqlalchemy import BigInteger, DateTime, Index, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractLiquidationStatus(str, Enum):
    TRIGGERED = "TRIGGERED"
    DONE = "DONE"
    FAILED = "FAILED"


class ContractLiquidationRecord(Base):
    __tablename__ = "contract_liquidation_records"
    __table_args__ = (
        Index("idx_contract_liquidation_records_user", "user_id"),
        Index("idx_contract_liquidation_records_position", "position_id"),
        Index("idx_contract_liquidation_records_symbol", "symbol"),
        Index("idx_contract_liquidation_records_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    position_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    side: Mapped[str] = mapped_column(String(10), nullable=False)
    leverage: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    entry_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    mark_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    liquidation_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    margin_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    unrealized_pnl: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    remaining_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=ContractLiquidationStatus.TRIGGERED.value)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
