from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractMarginChangeType(str, Enum):
    TRANSFER_IN = "TRANSFER_IN"
    TRANSFER_OUT = "TRANSFER_OUT"
    OPEN_MARGIN_FREEZE = "OPEN_MARGIN_FREEZE"
    OPEN_MARGIN_USED = "OPEN_MARGIN_USED"
    OPEN_FEE = "OPEN_FEE"
    CLOSE_RELEASE = "CLOSE_RELEASE"
    CLOSE_FEE = "CLOSE_FEE"
    REALIZED_PNL = "REALIZED_PNL"
    LIQUIDATION_ZERO = "LIQUIDATION_ZERO"
    ADD_MARGIN = "ADD_MARGIN"


class ContractMarginLog(Base):
    __tablename__ = "contract_margin_logs"
    __table_args__ = (
        Index("idx_contract_margin_logs_user", "user_id"),
        Index("idx_contract_margin_logs_account", "account_id"),
        Index("idx_contract_margin_logs_position", "position_id"),
        Index("idx_contract_margin_logs_order", "order_id"),
        Index("idx_contract_margin_logs_change_type", "change_type"),
        Index("idx_contract_margin_logs_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    account_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    position_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    order_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    symbol: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    change_type: Mapped[str] = mapped_column(String(40), nullable=False)
    change_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    before_available: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    after_available: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    before_frozen: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    after_frozen: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    remark: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
