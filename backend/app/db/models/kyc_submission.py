from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class KycSubmission(Base):
    __tablename__ = "kyc_submissions"
    __table_args__ = (
        Index("idx_kyc_submissions_user_status", "user_id", "review_status"),
        Index("idx_kyc_submissions_status_time", "review_status", "created_at"),
    )

    id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    kyc_level: Mapped[str] = mapped_column(String(16), nullable=False)
    full_name: Mapped[str] = mapped_column(String(128), nullable=False)
    country_code: Mapped[str] = mapped_column(String(16), nullable=False)
    id_type: Mapped[str] = mapped_column(String(32), nullable=False)
    id_number: Mapped[str] = mapped_column(String(128), nullable=False)
    front_image_url: Mapped[str] = mapped_column(String(512), nullable=False)
    back_image_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    selfie_image_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    review_status: Mapped[str] = mapped_column(String(16), nullable=False, default="PENDING")
    review_note: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    reviewed_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
