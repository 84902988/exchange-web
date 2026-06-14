from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import DateTime, Index, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserInviteCommissionRecord(Base):
    __tablename__ = "user_invite_commission_records"
    __table_args__ = (
        UniqueConstraint(
            "trade_id",
            "invitee_user_id",
            "fee_coin_symbol",
            name="uq_user_invite_commission_trade_fee",
        ),
        Index("idx_user_invite_comm_records_inviter_user_id", "inviter_user_id"),
        Index("idx_user_invite_comm_records_invitee_user_id", "invitee_user_id"),
        Index("idx_user_invite_comm_records_status", "status"),
        Index("idx_user_invite_comm_records_trade_id", "trade_id"),
        Index("idx_user_invite_comm_records_order_id", "order_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    inviter_user_id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=False)
    invitee_user_id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=False)
    trade_id: Mapped[Optional[int]] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=True)
    order_id: Mapped[Optional[int]] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=True)
    fee_asset_id: Mapped[Optional[int]] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=True)
    fee_coin_symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    fee_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False)
    fee_usdt_value: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    rcb_price_used: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    commission_asset_symbol: Mapped[str] = mapped_column(String(20), nullable=False, default="RCB")
    commission_rate: Mapped[Decimal] = mapped_column(
        Numeric(10, 6),
        nullable=False,
        default=lambda: Decimal("0.150000"),
    )
    commission_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False)
    commission_rcb_amount: Mapped[Decimal] = mapped_column(
        Numeric(36, 18),
        nullable=False,
        default=lambda: Decimal("0"),
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    fail_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
