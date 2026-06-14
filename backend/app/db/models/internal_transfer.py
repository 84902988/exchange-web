from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.asset import AMOUNT


class InternalTransfer(Base):
    __tablename__ = "internal_transfers"
    __table_args__ = (
        UniqueConstraint("transfer_no", name="uq_internal_transfer_no"),
        Index("ix_internal_transfer_user_time", "user_id", "created_at"),
        Index("ix_internal_transfer_user_symbol_time", "user_id", "coin_symbol", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    transfer_no: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)

    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    from_account: Mapped[str] = mapped_column(String(32), nullable=False)
    to_account: Mapped[str] = mapped_column(String(32), nullable=False)

    amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="SUCCESS")

    from_available_before: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    from_available_after: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    to_available_before: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    to_available_after: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))

    remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
