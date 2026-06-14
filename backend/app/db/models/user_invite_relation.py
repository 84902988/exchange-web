from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Index, Numeric, String
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserInviteRelation(Base):
    __tablename__ = "user_invite_relations"
    __table_args__ = (
        Index("idx_user_invite_relations_inviter_user_id", "inviter_user_id"),
        Index("uq_user_invite_relations_invitee_user_id", "invitee_user_id", unique=True),
        Index("idx_user_invite_relations_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    inviter_user_id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=False)
    invitee_user_id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=False)
    invite_code: Mapped[str] = mapped_column(String(64), nullable=False)
    commission_rate: Mapped[Decimal] = mapped_column(
        Numeric(10, 6),
        nullable=False,
        default=lambda: Decimal("0.150000"),
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
