from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class StockTokenReleaseLog(Base):
    __tablename__ = "stock_token_release_logs"
    __table_args__ = (
        Index("idx_stock_token_release_logs_trigger", "trigger_type"),
        Index("idx_stock_token_release_logs_status", "status"),
        Index("idx_stock_token_release_logs_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_time: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    trigger_type: Mapped[str] = mapped_column(String(20), nullable=False, default="AUTO")
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="SUCCESS")
    scanned_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    released_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_release_amount: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    item_ids: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
