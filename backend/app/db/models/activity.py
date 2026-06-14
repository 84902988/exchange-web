from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Activity(Base):
    __tablename__ = "activities"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    subtitle: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    subtitle_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    description_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    detail_content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    detail_content_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    reward_text: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    reward_text_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    reward_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(28, 8), nullable=True)
    cover_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    banner_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    banner_type: Mapped[str] = mapped_column(String(20), nullable=False, default="image")
    video_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    start_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cta_text: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    cta_text_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    cta_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class ActivityBanner(Base):
    __tablename__ = "activity_banners"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    subtitle: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    subtitle_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    media_type: Mapped[str] = mapped_column(String(20), nullable=False, default="image")
    media_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    link_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    start_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
