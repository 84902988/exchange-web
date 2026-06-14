from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class DealerRiskHitLog(Base):
    __tablename__ = "dealer_risk_hit_logs"
    __table_args__ = (
        Index("idx_dealer_risk_hit_symbol_time", "symbol", "created_at"),
        Index("idx_dealer_risk_hit_type_time", "risk_type", "created_at"),
        Index("idx_dealer_risk_hit_order", "order_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    order_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    user_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    risk_type: Mapped[str] = mapped_column(String(32), nullable=False)
    risk_value: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    limit_value: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    message: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
