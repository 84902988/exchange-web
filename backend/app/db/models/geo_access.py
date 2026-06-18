from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class GeoAccessSettings(Base):
    __tablename__ = "geo_access_settings"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    monitor_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    block_unknown: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    restricted_countries_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    admin_exempt: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class GeoIpRule(Base):
    __tablename__ = "geo_ip_rules"
    __table_args__ = (
        Index("idx_geo_ip_rules_type_enabled", "rule_type", "enabled"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    rule_type: Mapped[str] = mapped_column(String(16), nullable=False)
    ip_cidr: Mapped[str] = mapped_column(String(64), nullable=False)
    note: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class GeoAccessLog(Base):
    __tablename__ = "geo_access_logs"
    __table_args__ = (
        Index("idx_geo_access_logs_created", "created_at"),
        Index("idx_geo_access_logs_decision_created", "decision", "created_at"),
        Index("idx_geo_access_logs_country_created", "country_code", "created_at"),
        Index("idx_geo_access_logs_ip_created", "ip_address", "created_at"),
        Index("idx_geo_access_logs_aggregate", "ip_address", "country_code", "decision", "reason", "last_seen_at"),
        Index(
            "idx_geo_access_logs_bucket",
            "ip_address",
            "country_code",
            "source",
            "decision",
            "reason",
            "created_at",
        ),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False, default="")
    country_code: Mapped[str] = mapped_column(String(8), nullable=False, default="UNKNOWN")
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="UNKNOWN")
    path: Mapped[str] = mapped_column(String(512), nullable=False, default="")
    method: Mapped[str] = mapped_column(String(10), nullable=False, default="GET")
    user_agent: Mapped[str] = mapped_column(String(512), nullable=False, default="")
    decision: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    hit_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    last_path: Mapped[str] = mapped_column(String(512), nullable=False, default="")
