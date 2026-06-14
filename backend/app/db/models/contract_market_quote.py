from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractMarketQuote(Base):
    __tablename__ = "contract_market_quotes"
    __table_args__ = (
        UniqueConstraint("symbol", name="uk_contract_market_quotes_symbol"),
        Index("idx_contract_market_quotes_provider", "provider"),
        Index("idx_contract_market_quotes_updated_at", "updated_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    provider_symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    bid_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    ask_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    last_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    mark_price: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="LIVE")
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
