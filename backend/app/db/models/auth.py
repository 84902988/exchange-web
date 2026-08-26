from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, String, DateTime, Integer, ForeignKey, Index
from sqlalchemy.dialects.mysql import ENUM, BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


AUTH_ID_TYPE = MySQL_BIGINT(unsigned=True).with_variant(Integer(), "sqlite")
ACCOUNT_TYPE = ENUM("email", "phone").with_variant(String(16), "sqlite")
CHANNEL_TYPE = ENUM("email", "sms").with_variant(String(16), "sqlite")


class UserOtp(Base):
    __tablename__ = "user_otps"

    id: Mapped[int] = mapped_column(
        AUTH_ID_TYPE,
        primary_key=True,
        autoincrement=True,
    )

    account: Mapped[str] = mapped_column(String(191), nullable=False)
    account_type: Mapped[str] = mapped_column(ACCOUNT_TYPE, nullable=False)

    channel: Mapped[str] = mapped_column(CHANNEL_TYPE, nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)

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
        AUTH_ID_TYPE,
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


class UserSecurityEvent(Base):
    __tablename__ = "user_security_events"
    __table_args__ = (
        Index("idx_user_security_events_user_created", "user_id", "created_at"),
        Index("idx_user_security_events_type_created", "event_type", "created_at"),
    )

    id: Mapped[int] = mapped_column(
        AUTH_ID_TYPE,
        primary_key=True,
        autoincrement=True,
    )
    # Keep the audit record after a future account-deletion workflow anonymizes
    # or removes the user row, so this intentionally has no cascading FK.
    user_id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    details: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
