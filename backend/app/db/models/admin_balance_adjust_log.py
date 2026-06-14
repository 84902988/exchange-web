from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class AdminBalanceAdjustLog(Base):
    __tablename__ = "admin_balance_adjust_logs"
    __table_args__ = (
        Index("idx_admin_adjust_target_time", "target_user_id", "created_at"),
        Index("idx_admin_adjust_coin_chain_time", "coin_symbol", "chain_key", "created_at"),
        Index("idx_admin_adjust_admin_time", "admin_user", "created_at"),
        Index("idx_admin_adjust_request_id", "request_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    admin_user: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    admin_ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    request_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    target_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)
    direction: Mapped[str] = mapped_column(String(16), nullable=False)
    amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    before_available: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    after_available: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
