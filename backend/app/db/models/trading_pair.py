from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class TradingPair(Base):
    __tablename__ = "trading_pairs"
    __table_args__ = (
        UniqueConstraint("symbol", name="uk_symbol"),
        UniqueConstraint("base_asset_id", "quote_asset_id", name="uk_base_quote"),
        Index("idx_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    base_asset_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("assets.id", name="fk_trading_pairs_base_asset"),
        nullable=False,
    )

    quote_asset_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("assets.id", name="fk_trading_pairs_quote_asset"),
        nullable=False,
    )

    symbol: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    asset_type: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="CRYPTO",
        server_default="CRYPTO",
        index=True,
        comment="Asset type: CRYPTO / STOCK",
    )
    data_source: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="INTERNAL",
        server_default="INTERNAL",
        index=True,
        comment="Market data source: INTERNAL / BINANCE / ITICK",
    )
    external_symbol: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
        comment="External provider symbol, e.g. BTCUSDT or AAPL",
    )
    external_region: Mapped[Optional[str]] = mapped_column(
        String(20),
        nullable=True,
        comment="External provider region, e.g. US for iTick stocks",
    )
    market_mode: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="INTERNAL",
        server_default="INTERNAL",
        index=True,
        comment="交易模式: INTERNAL / DEALER",
    )

    market_category: Mapped[Optional[str]] = mapped_column(
        String(30),
        nullable=True,
        default="CRYPTO",
        server_default="CRYPTO",
        index=True,
        comment="Market category: CRYPTO / STOCK / INDEX / FOREX / METAL / COMMODITY",
    )
    market_sub_category: Mapped[Optional[str]] = mapped_column(
        String(50),
        nullable=True,
        index=True,
        comment="Market sub category: US_STOCK / STOCK_CONTRACT / STOCK_TOKEN",
    )
    display_category: Mapped[Optional[str]] = mapped_column(
        String(32),
        nullable=True,
        index=True,
        comment="Frontend display category: MAINSTREAM / PLATFORM / RWA / STOCK / INDEX / FOREX / METAL / COMMODITY / ETF",
    )
    display_group: Mapped[Optional[str]] = mapped_column(
        String(50),
        nullable=True,
        comment="Display group for market pages",
    )
    sort_order: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        index=True,
        comment="Market display sort order",
    )
    is_hot: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="0",
        index=True,
        comment="Whether the pair is shown in hot markets",
    )
    show_spot_logo: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="0",
        comment="Whether to show a brand logo card on the spot trading page",
    )
    spot_logo_url: Mapped[Optional[str]] = mapped_column(
        String(512),
        nullable=True,
        comment="Spot trading page brand logo URL",
    )
    spot_logo_alt: Mapped[Optional[str]] = mapped_column(
        String(120),
        nullable=True,
        comment="Spot trading page brand logo alt text",
    )

    price_precision: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    amount_precision: Mapped[int] = mapped_column(Integer, nullable=False, default=8)

    min_amount: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))
    min_notional: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=lambda: Decimal("0"))

    maker_fee_rate: Mapped[Decimal] = mapped_column(Numeric(10, 8), nullable=False, default=lambda: Decimal("0.00100000"))
    taker_fee_rate: Mapped[Decimal] = mapped_column(Numeric(10, 8), nullable=False, default=lambda: Decimal("0.00100000"))

    status: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # ✅ 关系
    base_asset = relationship("Asset", foreign_keys=[base_asset_id])
    quote_asset = relationship("Asset", foreign_keys=[quote_asset_id])

    orders = relationship("Order", back_populates="trading_pair")

    def __repr__(self):
        return f"<TradingPair id={self.id} symbol={self.symbol}>"
