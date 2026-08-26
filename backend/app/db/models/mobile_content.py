from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.dialects import mysql
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

ID_TYPE = BigInteger().with_variant(Integer, "sqlite")


class MobileContentSettings(Base):
    __tablename__ = "mobile_content_settings"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(ID_TYPE, primary_key=True, autoincrement=True)
    app_name: Mapped[str] = mapped_column(String(100), nullable=False, default="Exchange")
    app_name_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    logo_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    logo_width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    logo_height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    logo_byte_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    logo_mime_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    home_config: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class MobileHomeBanner(Base):
    __tablename__ = "mobile_home_banners"
    __table_args__ = (
        Index("idx_mobile_home_banners_status_sort", "status", "sort_order"),
        Index("idx_mobile_home_banners_window", "start_at", "end_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(ID_TYPE, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    subtitle: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    subtitle_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    image_url: Mapped[str] = mapped_column(String(500), nullable=False)
    image_width: Mapped[int] = mapped_column(Integer, nullable=False)
    image_height: Mapped[int] = mapped_column(Integer, nullable=False)
    image_byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    image_mime_type: Mapped[str] = mapped_column(String(50), nullable=False)
    placement: Mapped[str] = mapped_column(String(20), nullable=False, default="PROMO")
    action_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    action_route: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    aspect_ratio: Mapped[str] = mapped_column(String(20), nullable=False, default="3:1")
    recommended_size: Mapped[str] = mapped_column(String(20), nullable=False, default="1200x400")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE")
    start_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class MobileAnnouncement(Base):
    __tablename__ = "mobile_announcements"
    __table_args__ = (
        UniqueConstraint("slug", name="uq_mobile_announcements_slug"),
        Index("idx_mobile_announcements_status_publish", "status", "publish_at"),
        Index("idx_mobile_announcements_pinned", "is_pinned"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(ID_TYPE, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    slug: Mapped[str] = mapped_column(String(191), nullable=False)
    summary: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    summary_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    category_label: Mapped[str] = mapped_column(String(40), nullable=False, default="公告")
    category_label_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    content: Mapped[str] = mapped_column(
        Text().with_variant(mysql.MEDIUMTEXT(), "mysql"),
        nullable=False,
    )
    content_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    content_format: Mapped[str] = mapped_column(String(20), nullable=False, default="PLAIN_TEXT")
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="DRAFT")
    publish_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class MobileAnnouncementRead(Base):
    __tablename__ = "mobile_announcement_reads"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "announcement_id",
            name="uq_mobile_announcement_reads_user_announcement",
        ),
        Index("idx_mobile_announcement_reads_user_id", "user_id"),
        Index("idx_mobile_announcement_reads_announcement_id", "announcement_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(ID_TYPE, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True).with_variant(Integer, "sqlite"),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    announcement_id: Mapped[int] = mapped_column(
        ID_TYPE,
        ForeignKey("mobile_announcements.id", ondelete="CASCADE"),
        nullable=False,
    )
    read_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
    )
