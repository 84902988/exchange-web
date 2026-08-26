from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


ID_TYPE = BigInteger().with_variant(Integer(), "sqlite")


class TradeIdempotencyRequest(Base):
    __tablename__ = "trade_idempotency_requests"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "market",
            "client_order_id",
            name="uq_trade_idempotency_user_market_client",
        ),
        Index(
            "idx_trade_idempotency_user_created",
            "user_id",
            "created_at",
        ),
        Index("idx_trade_idempotency_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(ID_TYPE, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    market: Mapped[str] = mapped_column(String(16), nullable=False)
    operation: Mapped[str] = mapped_column(String(48), nullable=False)
    client_order_id: Mapped[str] = mapped_column(String(64), nullable=False)
    fingerprint_version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
        server_default="1",
    )
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="PENDING",
        server_default="PENDING",
    )
    response_json: Mapped[Optional[str]] = mapped_column(
        Text().with_variant(mysql.LONGTEXT(), "mysql"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
