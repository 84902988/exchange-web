from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Integer, Numeric, String
from sqlalchemy.dialects.mysql import TINYINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class StockTokenLockConfig(Base):
    __tablename__ = "stock_token_lock_configs"
    __table_args__ = (
        Index("idx_stock_token_lock_configs_lock_symbol", "lock_symbol"),
        Index("idx_stock_token_lock_configs_trade_symbol", "trade_symbol"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    lock_symbol: Mapped[str] = mapped_column(String(50), nullable=False)
    trade_symbol: Mapped[str] = mapped_column(String(50), nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    lock_days: Mapped[int] = mapped_column(Integer, nullable=False, default=90)
    daily_release_rate: Mapped[Decimal] = mapped_column(
        Numeric(18, 8),
        nullable=False,
        default=lambda: Decimal("0.05000000"),
    )
    conversion_rate: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("1.000000000000000000"),
    )
    is_active: Mapped[int] = mapped_column(TINYINT(1), nullable=False, default=1)
    remark: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
