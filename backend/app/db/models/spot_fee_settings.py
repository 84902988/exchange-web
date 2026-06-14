from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Numeric
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SpotFeeSettings(Base):
    __tablename__ = "spot_fee_settings"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    spot_rcb_fee_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    rcb_fee_discount_rate: Mapped[Decimal] = mapped_column(
        Numeric(10, 6),
        nullable=False,
        default=lambda: Decimal("0.75"),
    )
    min_rcb_fee_amount: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    updated_by_admin_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
