from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class SiteSettings(Base):
    __tablename__ = "site_settings"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    site_name: Mapped[str] = mapped_column(String(100), nullable=False, default="Royal Exchange")
    site_name_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    site_slogan: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    site_slogan_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    logo_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    support_email: Mapped[Optional[str]] = mapped_column(String(191), nullable=True)
    risk_disclaimer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    risk_disclaimer_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    footer_disclaimer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    footer_disclaimer_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    stock_token_locks_notice_title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    stock_token_locks_notice_title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    stock_token_locks_notice_content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    stock_token_locks_notice_content_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    home_hero_title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    home_hero_title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    home_hero_subtitle: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    home_hero_subtitle_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    home_hero_cta_text: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    home_hero_cta_text_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    home_hero_cta_link: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    home_hero_image: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    about_page_sections_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    legal_pages_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    show_risk_link: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    risk_link_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    show_terms_link: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    terms_link_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    show_privacy_link: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    privacy_link_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class HomeBanner(Base):
    __tablename__ = "home_banners"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    subtitle: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    subtitle_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    image_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    link_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
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


class Announcement(Base):
    __tablename__ = "announcements"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    slug: Mapped[str] = mapped_column(String(191), nullable=False, unique=True)
    category: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    summary: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    summary_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    content_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PUBLISHED")
    publish_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class HelpCategory(Base):
    __tablename__ = "help_categories"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    category_key: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    description_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    articles: Mapped[list["HelpArticle"]] = relationship(
        "HelpArticle",
        back_populates="category",
        cascade="all, delete-orphan",
    )


class HelpArticle(Base):
    __tablename__ = "help_articles"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    category_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("help_categories.id", ondelete="CASCADE"),
        nullable=False,
    )
    slug: Mapped[str] = mapped_column(String(191), nullable=False, unique=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    title_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    summary: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    summary_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    content_i18n: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    tags_json: Mapped[Optional[list[str]]] = mapped_column(JSON, nullable=True)
    is_hot: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_type: Mapped[str] = mapped_column(String(50), nullable=False, default="cms")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    category: Mapped[HelpCategory] = relationship("HelpCategory", back_populates="articles")
