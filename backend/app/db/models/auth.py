from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import String, DateTime, Integer, ForeignKey
from sqlalchemy.dialects.mysql import ENUM, BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class UserOtp(Base):
    __tablename__ = "user_otps"

    id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        primary_key=True,
        autoincrement=True,
    )

    account: Mapped[str] = mapped_column(String(191), nullable=False)
    account_type: Mapped[str] = mapped_column(ENUM("email", "phone"), nullable=False)

    channel: Mapped[str] = mapped_column(ENUM("email", "sms"), nullable=False)
    purpose: Mapped[str] = mapped_column(ENUM("register", "login", "reset_password"), nullable=False)

    code_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    cooldown_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class UserSession(Base):
    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        primary_key=True,
        autoincrement=True,
    )

    # ✅ 必须 unsigned，和 users.id 完全一致
    user_id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )

    refresh_token_hash: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)

    user: Mapped["User"] = relationship("User", back_populates="sessions")
