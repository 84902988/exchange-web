from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class DividendPool(Base):
    __tablename__ = "dividend_pools"
    __table_args__ = (
        UniqueConstraint("dividend_date", name="uq_dividend_pools_date"),
        Index("idx_dividend_pools_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dividend_date: Mapped[date] = mapped_column(Date, nullable=False)
    total_fee_usdt: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    rcb_price_used: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    total_dividend_usdt: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    total_dividend_rcb: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    source: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, default="MANUAL")
    run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    items = relationship("DividendPoolItem", back_populates="pool")
    records = relationship("UserDividendRecord", back_populates="pool")


class DividendPoolItem(Base):
    __tablename__ = "dividend_pool_items"
    __table_args__ = (
        Index("idx_dividend_pool_items_pool_id", "pool_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    pool_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("dividend_pools.id", name="fk_dividend_pool_items_pool"),
        nullable=False,
    )
    level_code: Mapped[str] = mapped_column(String(30), nullable=False)
    level_dividend_rate: Mapped[Decimal] = mapped_column(
        Numeric(18, 8),
        nullable=False,
        default=lambda: Decimal("0.05"),
    )
    level_fee_usdt: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    eligible_user_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    per_user_usdt: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    per_user_rcb: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)

    pool = relationship("DividendPool", back_populates="items")


class UserDividendRecord(Base):
    __tablename__ = "user_dividend_records"
    __table_args__ = (
        UniqueConstraint("pool_id", "user_id", name="uq_user_dividend_records_pool_user"),
        Index("idx_user_dividend_records_user_id", "user_id"),
        Index("idx_user_dividend_records_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    pool_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("dividend_pools.id", name="fk_user_dividend_records_pool"),
        nullable=False,
    )
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    level_code: Mapped[str] = mapped_column(String(30), nullable=False)
    dividend_usdt: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    rcb_price_used: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    dividend_rcb: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    pool = relationship("DividendPool", back_populates="records")
