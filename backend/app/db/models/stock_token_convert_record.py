from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class StockTokenConvertRecord(Base):
    __tablename__ = "stock_token_convert_records"
    __table_args__ = (
        Index("idx_stock_token_convert_records_user", "user_id"),
        Index("idx_stock_token_convert_records_config", "config_id"),
        Index("idx_stock_token_convert_records_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    config_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    from_symbol: Mapped[str] = mapped_column(String(50), nullable=False)
    to_symbol: Mapped[str] = mapped_column(String(50), nullable=False)
    from_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False)
    to_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False)
    conversion_rate: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="SUCCESS")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
