from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Numeric, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


AMOUNT = Numeric(36, 18)
RATE = Numeric(18, 10)


class VipFeeLevelCondition(Base):
    __tablename__ = "vip_fee_level_conditions"
    __table_args__ = (
        UniqueConstraint("vip_fee_level_id", name="uq_vip_fee_level_conditions_level_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    vip_fee_level_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("vip_fee_levels.id", ondelete="CASCADE", name="fk_vip_fee_level_conditions_level"),
        nullable=False,
    )

    min_30d_volume: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    min_rcb_hold: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    min_lock_amount: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    lock_period_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    user_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    dividend_rate: Mapped[Optional[Decimal]] = mapped_column(RATE, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    vip_fee_level: Mapped["VipFeeLevel"] = relationship("VipFeeLevel", back_populates="condition")
