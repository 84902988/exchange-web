from __future__ import annotations

from datetime import datetime
from typing import Optional, List

from sqlalchemy import Boolean, String, DateTime, Integer, Index
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("uq_users_invite_code", "invite_code", unique=True),
    )

    # ✅ 对齐数据库：bigint unsigned NOT NULL AUTO_INCREMENT
    id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        primary_key=True,
        autoincrement=True,
    )

    email: Mapped[Optional[str]] = mapped_column(String(191), unique=True, nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(32), unique=True, nullable=True)
    invite_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    status: Mapped[int] = mapped_column(Integer, nullable=False, default=1)  # 1=正常 2=禁用 3=锁定
    withdraw_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    withdraw_locked_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    withdraw_locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    withdraw_locked_by: Mapped[Optional[int]] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=True)

    kyc_status: Mapped[str] = mapped_column(String(16), nullable=False, default="NONE")
    kyc_level: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    email_verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    phone_verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    password_changed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    # sessions（1:N）
    sessions: Mapped[List["UserSession"]] = relationship(
        "UserSession",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # profile/settings（1:1）
    profile: Mapped[Optional["UserProfile"]] = relationship(
        "UserProfile",
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    settings: Mapped[Optional["UserSetting"]] = relationship(
        "UserSetting",
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
