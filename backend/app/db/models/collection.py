from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


AMOUNT = Numeric(36, 18)


class CollectionBatchTriggerType(str, Enum):
    MANUAL = "MANUAL"
    AUTO = "AUTO"
    DEPOSIT_TRIGGER = "DEPOSIT_TRIGGER"


class CollectionBatchStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PARTIAL = "PARTIAL"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


class CollectionTaskStatus(str, Enum):
    PENDING = "PENDING"
    QUEUED = "QUEUED"
    GAS_REQUIRED = "GAS_REQUIRED"
    GAS_QUEUED = "GAS_QUEUED"
    READY = "READY"
    SENDING = "SENDING"
    SENT = "SENT"
    CONFIRMED = "CONFIRMED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"
    CANCELED = "CANCELED"


class GasTaskStatus(str, Enum):
    PENDING = "PENDING"
    QUEUED = "QUEUED"
    SENDING = "SENDING"
    SENT = "SENT"
    CONFIRMING = "CONFIRMING"
    CONFIRMED = "CONFIRMED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"
    CANCELED = "CANCELED"


class CollectionCandidateStatus(str, Enum):
    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


class CollectionBatch(Base):
    __tablename__ = "collection_batches"
    __table_args__ = (
        UniqueConstraint("batch_no", name="uk_collection_batches_batch_no"),
        Index("idx_collection_batches_status", "status"),
        Index("idx_collection_batches_chain_coin", "chain_key", "coin_symbol"),
        Index("idx_collection_batches_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    batch_no: Mapped[str] = mapped_column(String(64), nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_address: Mapped[str] = mapped_column(String(128), nullable=False)
    chain_key: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    coin_symbol: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default=CollectionBatchStatus.PENDING.value)
    total_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    success_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_tasks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    success_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class CollectionCandidate(Base):
    __tablename__ = "collection_candidates"
    __table_args__ = (
        UniqueConstraint("chain_key", "token_contract", "address", name="uk_collection_candidates_chain_token_address"),
        Index("idx_collection_candidates_chain_symbol_status", "chain_key", "asset_symbol", "status"),
        Index("idx_collection_candidates_user", "user_id"),
        Index("idx_collection_candidates_latest_deposit", "latest_deposit_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)
    asset_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    asset_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    asset_chain_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    token_contract: Mapped[str] = mapped_column(String(255), nullable=False)
    address: Mapped[str] = mapped_column(String(256), nullable=False)
    total_detected_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    latest_deposit_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    latest_tx_hash: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="DEPOSIT")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default=CollectionCandidateStatus.PENDING.value)
    detected_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    latest_deposit_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    last_scan_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_balance_amount: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class CollectionTask(Base):
    __tablename__ = "collection_tasks"
    __table_args__ = (
        UniqueConstraint("task_no", name="uk_collection_tasks_task_no"),
        UniqueConstraint("idempotency_key", name="uk_collection_tasks_idempotency_key"),
        Index("idx_collection_tasks_batch", "batch_id"),
        Index("idx_collection_tasks_user", "user_id"),
        Index("idx_collection_tasks_chain_coin_status", "chain_key", "coin_symbol", "status"),
        Index("idx_collection_tasks_tx_hash", "tx_hash"),
        Index("idx_collection_tasks_status_next_retry", "status", "next_retry_at"),
        Index("idx_collection_tasks_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    task_no: Mapped[str] = mapped_column(String(64), nullable=False)
    batch_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)
    coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    asset_chain_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    from_address: Mapped[str] = mapped_column(String(128), nullable=False)
    to_address: Mapped[str] = mapped_column(String(128), nullable=False)
    amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    status: Mapped[str] = mapped_column(String(32), nullable=False, default=CollectionTaskStatus.PENDING.value)
    reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    tx_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    block_number: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    gas_task_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retry: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    next_retry_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class GasTask(Base):
    __tablename__ = "gas_tasks"
    __table_args__ = (
        UniqueConstraint("task_no", name="uk_gas_tasks_task_no"),
        UniqueConstraint("idempotency_key", name="uk_gas_tasks_idempotency_key"),
        Index("idx_gas_tasks_collection_task", "collection_task_id"),
        Index("idx_gas_tasks_user", "user_id"),
        Index("idx_gas_tasks_chain_status", "chain_key", "status"),
        Index("idx_gas_tasks_tx_hash", "tx_hash"),
        Index("idx_gas_tasks_status_next_retry", "status", "next_retry_at"),
        Index("idx_gas_tasks_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    task_no: Mapped[str] = mapped_column(String(64), nullable=False)
    collection_task_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)
    gas_coin_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    from_address: Mapped[str] = mapped_column(String(128), nullable=False)
    to_address: Mapped[str] = mapped_column(String(128), nullable=False)
    target_balance: Mapped[Optional[Decimal]] = mapped_column(AMOUNT, nullable=True)
    topup_amount: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False, default=lambda: Decimal("0"))
    gas_topup_mode: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    estimate_source: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default=GasTaskStatus.PENDING.value)
    tx_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    block_number: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retry: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    next_retry_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class CollectionGasCostRecord(Base):
    __tablename__ = "collection_gas_cost_records"
    __table_args__ = (
        UniqueConstraint("collection_task_id", name="uk_collection_gas_cost_task"),
        UniqueConstraint("tx_hash", name="uk_collection_gas_cost_tx_hash"),
        Index("idx_collection_gas_cost_chain_token_confirmed", "chain_key", "token_symbol", "confirmed_at"),
        Index("idx_collection_gas_cost_created_at", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    collection_task_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chain_key: Mapped[str] = mapped_column(String(32), nullable=False)
    token_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    tx_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    gas_used: Mapped[int] = mapped_column(BigInteger, nullable=False)
    gas_price_wei: Mapped[Decimal] = mapped_column(Numeric(65, 0), nullable=False)
    native_fee: Mapped[Decimal] = mapped_column(AMOUNT, nullable=False)
    native_symbol: Mapped[str] = mapped_column(String(32), nullable=False)
    receipt_status: Mapped[int] = mapped_column(Integer, nullable=False)
    transfer_verified: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    confirmed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
