from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserStockTokenLock(Base):
    __tablename__ = "user_stock_token_locks"
    __table_args__ = (
        Index("idx_user_stock_token_locks_user", "user_id"),
        Index("idx_user_stock_token_locks_config", "config_id"),
        Index("idx_user_stock_token_locks_status", "status"),
        Index("idx_user_stock_token_locks_symbol", "lock_symbol"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    config_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    lock_symbol: Mapped[str] = mapped_column(String(50), nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    locked_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    available_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    converted_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    conversion_rate_snapshot: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("1"),
    )
    daily_release_rate_snapshot: Mapped[Decimal] = mapped_column(
        Numeric(18, 8),
        nullable=False,
        default=lambda: Decimal("0.05000000"),
    )
    start_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="ACTIVE")
    source_type: Mapped[str] = mapped_column(String(50), nullable=False, default="OTC_DEPOSIT")
    source_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
