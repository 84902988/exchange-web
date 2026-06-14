from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BdCommissionRecord(Base):
    __tablename__ = "bd_commission_records"
    __table_args__ = (
        UniqueConstraint("trade_id", "bd_user_id", name="uq_bd_commission_trade_bd"),
        Index("idx_bd_commission_records_bd_user_id", "bd_user_id"),
        Index("idx_bd_commission_records_user_id", "user_id"),
        Index("idx_bd_commission_records_trade_id", "trade_id"),
        Index("idx_bd_commission_records_status", "status"),
        Index("idx_bd_commission_records_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    bd_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    order_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    trade_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    source_balance_log_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    fee_asset_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    fee_coin_symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    original_fee_amount: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    commission_rate: Mapped[Decimal] = mapped_column(
        Numeric(10, 6),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    commission_amount: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    commission_asset_symbol: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    pool_amount: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    # status values:
    # - PENDING: commission record created but not paid
    # - PAID: commission paid
    # - FAILED: payout failed or entered an abnormal state
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    paid_balance_log_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
