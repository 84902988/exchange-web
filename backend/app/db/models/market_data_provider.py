from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MarketDataProvider(Base):
    __tablename__ = "market_data_providers"
    __table_args__ = (
        UniqueConstraint("provider_code", "market_type", name="uk_market_data_providers_code_type"),
        Index("idx_market_data_providers_market_priority", "market_type", "enabled", "priority"),
        Index("idx_market_data_providers_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    provider_code: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_name: Mapped[str] = mapped_column(String(100), nullable=False)
    market_type: Mapped[str] = mapped_column(String(32), nullable=False, default="CONTRACT")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    base_url: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    timeout_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=3000)
    cooldown_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="UNKNOWN")
    last_check_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_success_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class MarketDataProviderSymbol(Base):
    __tablename__ = "market_data_provider_symbols"
    __table_args__ = (
        UniqueConstraint("provider_code", "local_symbol", name="uk_market_data_provider_symbols_provider_local"),
        Index("idx_market_data_provider_symbols_local", "local_symbol", "enabled"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    provider_code: Mapped[str] = mapped_column(String(32), nullable=False)
    local_symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    provider_symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
