from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AnnouncementRead(Base):
    __tablename__ = "announcement_reads"
    __table_args__ = (
        UniqueConstraint("user_id", "announcement_id", name="uq_announcement_reads_user_announcement"),
        Index("idx_announcement_reads_user_id", "user_id"),
        Index("idx_announcement_reads_announcement_id", "announcement_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    announcement_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("announcements.id", ondelete="CASCADE"),
        nullable=False,
    )
    read_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
