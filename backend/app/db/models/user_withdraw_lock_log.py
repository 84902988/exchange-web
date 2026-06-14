from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserWithdrawLockLog(Base):
    __tablename__ = "user_withdraw_lock_logs"
    __table_args__ = (
        Index("idx_user_withdraw_lock_logs_user_time", "user_id", "created_at"),
        Index("idx_user_withdraw_lock_logs_admin_time", "admin_user", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    admin_user: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    admin_user_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    admin_ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
