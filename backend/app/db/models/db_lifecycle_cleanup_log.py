from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DbLifecycleCleanupLog(Base):
    __tablename__ = "db_lifecycle_cleanup_logs"
    __table_args__ = (
        Index("idx_db_lifecycle_cleanup_logs_job_started", "job_name", "started_at"),
        Index("idx_db_lifecycle_cleanup_logs_table_started", "table_name", "started_at"),
        Index("idx_db_lifecycle_cleanup_logs_status_started", "status", "started_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    job_name: Mapped[str] = mapped_column(String(64), nullable=False)
    dry_run: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    table_name: Mapped[str] = mapped_column(String(64), nullable=False)
    matched_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    deleted_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    retention_days: Mapped[int] = mapped_column(Integer, nullable=False, default=90)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="SUCCESS")
    skipped: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reason: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    operation_mode: Mapped[str] = mapped_column(String(32), nullable=False, default="DRY_RUN")
    risk_level: Mapped[str] = mapped_column(String(32), nullable=False, default="SAFE_DRY_RUN")
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
