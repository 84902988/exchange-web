from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserLoginLog(Base):
    __tablename__ = "user_login_logs"
    __table_args__ = (
        Index("idx_user_login_logs_user_time", "user_id", "created_at"),
        Index("idx_user_login_logs_email_time", "email", "created_at"),
        Index("idx_user_login_logs_status_time", "login_status", "created_at"),
    )

    id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        primary_key=True,
        autoincrement=True,
    )
    user_id: Mapped[Optional[int]] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    email: Mapped[Optional[str]] = mapped_column(String(191), nullable=True)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False, default="")
    user_agent: Mapped[str] = mapped_column(String(512), nullable=False, default="")
    device_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    login_status: Mapped[str] = mapped_column(String(16), nullable=False)
    failure_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
