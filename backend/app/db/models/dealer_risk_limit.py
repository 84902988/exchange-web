from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class DealerRiskLimit(Base):
    __tablename__ = "dealer_risk_limits"
    __table_args__ = (
        UniqueConstraint("symbol", name="uq_dealer_risk_symbol"),
        Index("idx_dealer_risk_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    enabled: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1)
    max_single_notional: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    max_net_base_position: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    max_net_quote_exposure: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ACTIVE")
    remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
