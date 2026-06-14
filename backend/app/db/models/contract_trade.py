from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractTrade(Base):
    __tablename__ = "contract_trades"
    __table_args__ = (
        UniqueConstraint("trade_no", name="uk_contract_trades_trade_no"),
        Index("idx_contract_trades_order", "order_id"),
        Index("idx_contract_trades_position", "position_id"),
        Index("idx_contract_trades_user", "user_id"),
        Index("idx_contract_trades_symbol", "symbol"),
        Index("idx_contract_trades_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    trade_no: Mapped[str] = mapped_column(String(64), nullable=False)
    order_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    position_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    side: Mapped[str] = mapped_column(String(10), nullable=False)
    position_side: Mapped[str] = mapped_column(String(10), nullable=False)
    action: Mapped[str] = mapped_column(String(10), nullable=False)
    price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    notional: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    leverage: Mapped[int] = mapped_column(Integer, nullable=False)
    margin_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    fee_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    spread_fee: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    realized_pnl: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
