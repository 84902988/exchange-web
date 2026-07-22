from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BdCommissionRateChangeLog(Base):
    __tablename__ = "bd_commission_rate_change_logs"
    __table_args__ = (
        Index("idx_bd_rate_change_logs_bd_user_id_id", "bd_user_id", "id"),
        Index("idx_bd_rate_change_logs_admin_created", "changed_by_admin_id", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    bd_account_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    bd_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    application_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    old_commission_rate: Mapped[Decimal] = mapped_column(Numeric(10, 6), nullable=False)
    new_commission_rate: Mapped[Decimal] = mapped_column(Numeric(10, 6), nullable=False)
    changed_by_admin_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
