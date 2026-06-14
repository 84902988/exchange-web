from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ReferenceOverlay(Base):
    __tablename__ = "reference_overlays"
    __table_args__ = (
        Index("uq_reference_overlays_symbol", "symbol", unique=True),
        Index("idx_reference_overlays_enabled_sort", "enabled", "sort_order"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    enabled: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    reference_type: Mapped[str] = mapped_column(String(20), nullable=False, default="STOCK")
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(64), nullable=False)
    source_label: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    line_title: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    line_color: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    badge_color: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    display_value_label: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    display_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    display_unit: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    data_source: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    price_source: Mapped[str] = mapped_column(String(20), nullable=False, default="MANUAL")
    auto_source: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    source_symbol: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    source_region: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    conversion_type: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    conversion_factor: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    refresh_interval_sec: Mapped[int] = mapped_column(Integer, nullable=False, default=300)
    last_ref_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    last_ref_label: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    sync_status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    sync_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    market_status: Mapped[str] = mapped_column(String(20), nullable=False, default="UNKNOWN")
    market_status_text: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    price_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    is_realtime: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
