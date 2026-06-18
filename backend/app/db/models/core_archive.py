from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class CoreArchiveBatch(Base):
    __tablename__ = "core_archive_batches"
    __table_args__ = (
        UniqueConstraint("batch_id", name="uk_core_archive_batches_batch_id"),
        Index("idx_core_archive_batches_source_month", "source_table", "archive_month"),
        Index("idx_core_archive_batches_status_started", "status", "started_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(String(96), nullable=False)
    source_table: Mapped[str] = mapped_column(String(64), nullable=False)
    archive_table: Mapped[str] = mapped_column(String(64), nullable=False)
    archive_month: Mapped[str] = mapped_column(String(7), nullable=False)
    period_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="DRY_RUN")
    dry_run: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    copied_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    verified_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    deleted_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    min_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    max_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    checksum_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sum_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    approved_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
