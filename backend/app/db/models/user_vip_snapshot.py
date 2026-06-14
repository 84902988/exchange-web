from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


FEE_RATE = Numeric(18, 10)
AMOUNT = Numeric(36, 18)


class UserVipSnapshot(Base):
    __tablename__ = "user_vip_snapshots"
    __table_args__ = (
        Index("idx_user_vip_snapshots_user_id", "user_id", unique=True),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    vip_level_code: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    svip_level_code: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)

    effective_spot_maker_fee: Mapped[Optional[Decimal]] = mapped_column(FEE_RATE, nullable=True)
    effective_spot_taker_fee: Mapped[Optional[Decimal]] = mapped_column(FEE_RATE, nullable=True)
    effective_contract_maker_fee: Mapped[Optional[Decimal]] = mapped_column(FEE_RATE, nullable=True)
    effective_contract_taker_fee: Mapped[Optional[Decimal]] = mapped_column(FEE_RATE, nullable=True)

    effective_level_code: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    effective_fee_source: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    volume_30d: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    rcb_available: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    rcb_locked: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))

    vip_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    svip_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
