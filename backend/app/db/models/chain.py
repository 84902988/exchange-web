from __future__ import annotations

from datetime import datetime
from typing import Optional

from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Chain(Base):
    __tablename__ = "chains"
    __table_args__ = (
        UniqueConstraint("chain_key", name="uniq_chain_key"),
        Index("idx_chain_enabled", "enabled"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    icon_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    chain_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    native_symbol: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    confirmations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    explorer_tx_url: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    rpc_url: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    collection_address: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    hot_wallet_address: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    hot_wallet_private_key_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    hot_wallet_key_status: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    hot_wallet_key_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    collection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    collection_real_send_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    collection_max_single_gas_native: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    collection_daily_gas_native_limit: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    moralis_stream_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    moralis_stream_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    moralis_chain_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    webhook_chain_key: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    watch_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_watch_check_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    watch_status: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    watch_error: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    withdraw_fee: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=Decimal("0.005"))
    withdraw_fee_auto_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    withdraw_fee_min: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=Decimal("0.005"))
    withdraw_fee_max: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=Decimal("100"))
    withdraw_fee_multiplier: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False, default=Decimal("1.3"))
    withdraw_fee_update_threshold: Mapped[Decimal] = mapped_column(Numeric(36, 18), nullable=False, default=Decimal("0.001"))
    withdraw_fee_maintenance_interval_sec: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    withdraw_fee_last_estimated: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    withdraw_fee_last_suggested: Mapped[Optional[Decimal]] = mapped_column(Numeric(36, 18), nullable=True)
    withdraw_fee_last_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    withdraw_fee_last_error: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    enabled: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
