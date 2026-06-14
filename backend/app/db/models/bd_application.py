from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BdApplication(Base):
    __tablename__ = "bd_applications"
    __table_args__ = (
        Index("idx_bd_applications_user_id", "user_id"),
        Index("idx_bd_applications_status", "status"),
        Index("idx_bd_applications_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    apply_level: Mapped[str] = mapped_column(String(20), nullable=False, default="BD1")
    deposit_coin_symbol: Mapped[str] = mapped_column(String(20), nullable=False, default="USDT")
    deposit_amount: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    # status values:
    # - PENDING: application submitted and waiting for review
    # - APPROVED: application approved by admin
    # - REJECTED: application rejected by admin
    # - CANCELED: application canceled by user or admin
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    admin_remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    reviewed_by: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
