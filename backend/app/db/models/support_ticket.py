from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.mysql import BIGINT as MySQL_BIGINT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class SupportTicket(Base):
    __tablename__ = "support_tickets"
    __table_args__ = (
        Index("ix_support_tickets_user_status_updated", "user_id", "status", "updated_at"),
        Index("ix_support_tickets_status_updated", "status", "updated_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    ticket_no: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    user_id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), ForeignKey("users.id"), nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="NORMAL")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
    last_reply_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    messages: Mapped[list["SupportTicketMessage"]] = relationship(
        "SupportTicketMessage",
        back_populates="ticket",
        cascade="all, delete-orphan",
        order_by="SupportTicketMessage.created_at",
    )


class SupportTicketMessage(Base):
    __tablename__ = "support_ticket_messages"
    __table_args__ = (
        Index("ix_support_ticket_messages_ticket_created", "ticket_id", "created_at"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(MySQL_BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    ticket_id: Mapped[int] = mapped_column(
        MySQL_BIGINT(unsigned=True),
        ForeignKey("support_tickets.id", ondelete="CASCADE"),
        nullable=False,
    )
    sender_type: Mapped[str] = mapped_column(String(20), nullable=False)
    sender_user_id: Mapped[Optional[int]] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=True)
    admin_user_id: Mapped[Optional[int]] = mapped_column(MySQL_BIGINT(unsigned=True), nullable=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)

    ticket: Mapped[SupportTicket] = relationship("SupportTicket", back_populates="messages")
