from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Index, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


FEE_RATE = Numeric(18, 10)


class VipFeeLevel(Base):
    __tablename__ = "vip_fee_levels"
    __table_args__ = (
        UniqueConstraint("vip_type", "level_code", name="uq_vip_fee_levels_type_code"),
        CheckConstraint("vip_type IN ('VIP', 'SVIP')", name="ck_vip_fee_levels_vip_type"),
        Index("idx_vip_fee_levels_type_enabled", "vip_type", "is_enabled"),
        Index("idx_vip_fee_levels_sort_order", "sort_order"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    vip_type: Mapped[str] = mapped_column(String(20), nullable=False)
    level_code: Mapped[str] = mapped_column(String(30), nullable=False)
    level_name: Mapped[str] = mapped_column(String(50), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    spot_maker_fee: Mapped[Decimal] = mapped_column(FEE_RATE, nullable=False, default=lambda: Decimal("0"))
    spot_taker_fee: Mapped[Decimal] = mapped_column(FEE_RATE, nullable=False, default=lambda: Decimal("0"))
    contract_maker_fee: Mapped[Optional[Decimal]] = mapped_column(FEE_RATE, nullable=True)
    contract_taker_fee: Mapped[Optional[Decimal]] = mapped_column(FEE_RATE, nullable=True)
    rcb_discount_rate: Mapped[Optional[Decimal]] = mapped_column(FEE_RATE, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    condition: Mapped[Optional["VipFeeLevelCondition"]] = relationship(
        "VipFeeLevelCondition",
        back_populates="vip_fee_level",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
