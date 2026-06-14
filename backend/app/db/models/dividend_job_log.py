from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import BigInteger, Date, DateTime, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DividendJobLog(Base):
    __tablename__ = "dividend_job_logs"
    __table_args__ = (
        Index("idx_dividend_job_logs_date", "dividend_date"),
        Index("idx_dividend_job_logs_status", "status"),
        Index("idx_dividend_job_logs_run_time", "run_time"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dividend_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    run_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(20), nullable=False, default="AUTO")
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    step: Mapped[str] = mapped_column(String(50), nullable=False)
    pool_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
