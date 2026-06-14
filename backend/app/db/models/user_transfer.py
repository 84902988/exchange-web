from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.asset import AMOUNT


class UserTransfer(Base):
    __tablename__ = "user_transfers"
    __table_args__ = (
        UniqueConstraint("transfer_no", name="uq_user_transfers_transfer_no"),
        UniqueConstraint("from_user_id", "request_id", name="uq_user_transfers_from_request"),
        Index("idx_user_transfers_from_time", "from_user_id", "created_at"),
        Index("idx_user_transfers_to_time", "to_user_id", "created_at"),
        Index("idx_user_transfers_coin_time", "coin_symbol", "created_at"),
        Index("idx_user_transfers_status_time", "status", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    transfer_no: Mapped[str] = mapped_column(String(64), nullable=False)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)

    from_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    to_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    from_account: Mapped[str] = mapped_column(String(32), nullable=False, default="funding")
    to_account: Mapped[str] = mapped_column(String(32), nullable=False, default="funding")

    amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    fee_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    net_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="SUCCESS")

    recipient_email_mask: Mapped[str] = mapped_column(String(191), nullable=False)
    sender_available_before: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    sender_available_after: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    receiver_available_before: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    receiver_available_after: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))

    remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
