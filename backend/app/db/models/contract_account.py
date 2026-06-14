from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractAccount(Base):
    __tablename__ = "contract_accounts"
    __table_args__ = (
        UniqueConstraint("user_id", "margin_asset", name="uk_contract_accounts_user_asset"),
        Index("idx_contract_accounts_user", "user_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    margin_asset: Mapped[str] = mapped_column(String(20), nullable=False, default="USDT")
    available_margin: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    frozen_margin: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    position_margin: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    realized_pnl: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    unrealized_pnl: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    version: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
