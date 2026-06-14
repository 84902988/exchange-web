from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import String, DateTime, ForeignKey
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class UserProfile(Base):
    __tablename__ = "user_profiles"

    # ✅ 必须和 users.id = bigint unsigned 完全一致
    user_id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )

    username: Mapped[Optional[str]] = mapped_column(String(64), unique=True, nullable=True)
    nickname: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(32), unique=True, nullable=True)

    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    country_code: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)

    invite_code: Mapped[Optional[str]] = mapped_column(String(32), unique=True, nullable=True)

    # 推荐也用 unsigned，保持用户 ID 体系一致
    referrer_user_id: Mapped[Optional[int]] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        nullable=True,
    )

    # 语义上是等级，用 unsigned 更合理
    kyc_level: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        nullable=False,
        default=0,
    )
    kyc_status: Mapped[str] = mapped_column(String(16), nullable=False, default="NONE")

    remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    user: Mapped["User"] = relationship("User", back_populates="profile")


class UserSetting(Base):
    __tablename__ = "user_settings"

    # ✅ 同样必须 unsigned
    user_id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )

    language: Mapped[str] = mapped_column(String(16), nullable=False, default="zh-CN")
    timezone: Mapped[str] = mapped_column(String(16), nullable=False, default="UTC+8")
    theme: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    user: Mapped["User"] = relationship("User", back_populates="settings")
