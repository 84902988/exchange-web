from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Index, Integer, Numeric, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class ContractSymbolCategory(str, Enum):
    CRYPTO = "CRYPTO"
    STOCK = "STOCK"
    GOLD = "GOLD"
    FUTURES = "FUTURES"


class ContractPriceProvider(str, Enum):
    BINANCE = "BINANCE"
    ITICK = "ITICK"
    INTERNAL = "INTERNAL"
    MANUAL = "MANUAL"


class ContractSymbol(Base):
    __tablename__ = "contract_symbols"
    __table_args__ = (
        UniqueConstraint("symbol", name="uk_contract_symbols_symbol"),
        CheckConstraint("spread_x >= 0 AND spread_x <= 100", name="ck_contract_symbols_spread_x_range"),
        CheckConstraint("max_leverage >= 1 AND max_leverage <= 200", name="ck_contract_symbols_max_leverage_range"),
        CheckConstraint("status IN (0, 1)", name="ck_contract_symbols_status"),
        CheckConstraint("tp_sl_trigger_price_type IN ('MARK_PRICE', 'LAST_PRICE')", name="ck_contract_symbols_tp_sl_trigger_price_type"),
        Index("idx_contract_symbols_category", "category"),
        Index("idx_contract_symbols_provider", "provider"),
        Index("idx_contract_symbols_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    provider_symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    quote_asset: Mapped[str] = mapped_column(String(20), nullable=False, default="USDT")
    tp_sl_trigger_price_type: Mapped[str] = mapped_column(String(20), nullable=False, default="MARK_PRICE")
    price_precision: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    quantity_precision: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    min_quantity: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    max_quantity: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    min_margin: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    max_leverage: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    spread_x: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    liquidation_threshold: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    warning_threshold: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    status: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
