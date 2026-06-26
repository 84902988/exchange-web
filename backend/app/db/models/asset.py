# app/db/models/asset.py
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

AMOUNT = Numeric(36, 18)

# =========================================================
# 资产配置表
# =========================================================


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (
        UniqueConstraint("symbol", name="uniq_symbol"),
        Index("idx_enabled", "enabled"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    symbol: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        comment="唯一资产符号: USDT / MFC / BON-1 ..."
    )

    name: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        comment="展示名称"
    )

    asset_type: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="token",
        comment="token/coin(可选)"
    )

    display_precision: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=6,
        comment="UI显示精度(不等于链上decimals)"
    )

    enabled: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
        comment="是否启用"
    )

    icon_url: Mapped[Optional[str]] = mapped_column(
        String(255),
        nullable=True
    )

    sort_order: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0
    )

    deposit_sort_order: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=100
    )

    deposit_quick_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True
    )

    deposit_default_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False
    )

    withdraw_sort_order: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=100
    )

    withdraw_quick_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True
    )

    withdraw_default_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow
    )

    def __repr__(self) -> str:
        return f"<Asset id={self.id} symbol={self.symbol} enabled={self.enabled}>"


class AssetChain(Base):
    __tablename__ = "asset_chains"
    __table_args__ = (
        UniqueConstraint("asset_id", "chain_id", name="uq_asset_chain"),
        Index("idx_asset_chain_asset", "asset_id"),
        Index("idx_asset_chain_chain", "chain_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    asset_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chain_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    contract_address: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    decimals: Mapped[int] = mapped_column(Integer, nullable=False, default=18)
    deposit_enabled: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    withdraw_enabled: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    enabled: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    min_deposit: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    min_withdraw: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    collection_min_amount: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    collection_real_send_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    collection_max_single_amount: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    collection_daily_amount_limit: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    withdraw_fee: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0.005"))
    withdraw_fee_auto_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    withdraw_fee_min: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0.005"))
    withdraw_fee_max: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("100"))
    withdraw_fee_multiplier: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False, default=Decimal("1.3"))
    withdraw_fee_update_threshold: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0.001"))
    withdraw_fee_last_estimated_cost: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    withdraw_fee_suggested: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    withdraw_fee_last_estimated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    withdraw_fee_last_error: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    review_threshold_amount: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    force_manual_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    daily_withdraw_count_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    confirmations: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


# =========================================================
# ✅ 说明：
# 业务统一使用 chain_key（bsc/polygon/...）
# 因此：所有“业务流水/余额/充值/提现”表都用 chain_key
# =========================================================


# =========================================================
# ✅ 业务表：从这里开始统一 chain_key
# =========================================================


class UserChainAddress(Base):
    """
    ✅ 与 address_service/get_or_create_deposit_address 一致
    - EVM: 一个链一个地址（多 token 共用）
    - 唯一键：(user_id, chain_key)
    """

    __tablename__ = "user_chain_addresses"
    __table_args__ = (
        UniqueConstraint("user_id", "chain_key", name="uq_user_chain_addr"),
        Index("ix_user_chain_addr_user", "user_id"),
        Index("ix_user_chain_addr_chain", "chain_key"),
        Index("ix_user_chain_addr_address", "address"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    address: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    memo: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class Deposit(Base):
    __tablename__ = "deposits"
    __table_args__ = (
        UniqueConstraint("chain_key", "txid", "log_index", name="uq_deposit_chain_txid_log_index"),
        Index("ix_deposit_user_time", "user_id", "created_at"),
        Index("ix_deposit_status", "status"),
        Index("ix_deposit_tx_lookup", "chain_key", "txid", "log_index"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    address: Mapped[str] = mapped_column(String(256), nullable=False)
    memo: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    txid: Mapped[str] = mapped_column(String(256), nullable=False)
    log_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    from_address: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)

    status: Mapped[str] = mapped_column(String(32), nullable=False, default="DETECTING")
    confirmations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    confirm_required: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    block_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    block_hash: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Withdraw(Base):
    __tablename__ = "withdraws"
    __table_args__ = (
        # txid 可能为空；MySQL 的 UNIQUE 允许多条 NULL，不影响发起阶段入库
        UniqueConstraint("chain_key", "txid", name="uq_withdraw_chain_txid"),
        Index("ix_withdraw_user_time", "user_id", "created_at"),
        Index("ix_withdraw_status", "status"),
        Index("ix_withdraw_tx_lookup", "chain_key", "txid"),
        Index("ix_withdraw_coin_chain_time", "coin_symbol", "chain_key", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    to_address: Mapped[str] = mapped_column(String(256), nullable=False)
    memo: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    # 用户发起数量 / 手续费 / 实际到账
    amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    fee: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    net_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)

    # 状态：VERIFYING/PENDING/APPROVED/BROADCASTING/SUCCESS/FAILED
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="PENDING")

    confirmations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    confirm_required: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # 广播后才会有 txid
    txid: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    fail_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    request_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # ✅ 邮件验证码（通过后才冻结）
    verify_code_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    verify_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


# =========================================================
# user_balances: UNIQUE (user_id, coin_symbol, chain_key)
# balance_logs:  UNIQUE (user_id, coin_symbol, chain_key, biz_type, biz_id)
# =========================================================


class UserBalance(Base):
    __tablename__ = "user_balances"
    __table_args__ = (
        UniqueConstraint("user_id", "coin_symbol", "chain_key", name="uq_user_coin_chain"),
        Index("idx_user_id", "user_id"),
        Index("idx_coin_chain", "coin_symbol", "chain_key"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    asset_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)

    available_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    frozen_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))

    version: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


class BalanceLog(Base):
    __tablename__ = "balance_logs"
    __table_args__ = (
        UniqueConstraint("user_id", "coin_symbol", "chain_key", "biz_type", "biz_id", name="uq_user_coin_chain_biz"),
        Index("idx_user_time", "user_id", "created_at"),
        Index("idx_biz", "biz_type", "biz_id"),
        Index("idx_balance_logs_trade_id", "trade_id"),
        Index("idx_coin_chain_time", "coin_symbol", "chain_key", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    asset_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)

    change_type: Mapped[str] = mapped_column(String(64), nullable=False)
    direction: Mapped[int] = mapped_column(Integer, nullable=False)
    change_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)

    before_available: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    after_available: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    before_frozen: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))
    after_frozen: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=Decimal("0"))

    biz_type: Mapped[str] = mapped_column(String(32), nullable=False)
    biz_id: Mapped[str] = mapped_column(String(128), nullable=False)
    trade_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    request_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    remark: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
