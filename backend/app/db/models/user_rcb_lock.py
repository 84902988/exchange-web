from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Index, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class UserRcbLock(Base):
    __tablename__ = "user_rcb_locks"
    __table_args__ = (
        CheckConstraint(
            "status IN ('LOCKED', 'UNLOCKED', 'EXPIRED', 'CANCELED')",
            name="ck_user_rcb_locks_status",
        ),
        Index("idx_user_rcb_locks_user_status", "user_id", "status"),
        Index("idx_user_rcb_locks_asset_status", "asset_symbol", "status"),
        Index("idx_user_rcb_locks_end_time", "end_time"),
        Index("idx_user_rcb_locks_user_end", "user_id", "end_time"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    asset_symbol: Mapped[str] = mapped_column(String(20), nullable=False, default="RCB")
    lock_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    lock_period_days: Mapped[int] = mapped_column(Integer, nullable=False)
    start_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
