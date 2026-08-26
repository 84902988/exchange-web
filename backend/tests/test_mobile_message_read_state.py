from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.models.mobile_content import MobileAnnouncement, MobileAnnouncementRead
from app.db.models.support_ticket import SupportTicket, SupportTicketMessage
from app.services.mobile_announcement_read_service import (
    get_mobile_announcement_read_state,
    get_mobile_announcement_unread_count,
    mark_all_mobile_announcements_read,
    mark_mobile_announcement_read,
)
from app.services.mobile_content_service import get_public_mobile_announcement_page
from app.services.support_ticket_service import (
    get_unread_support_reply_count,
    list_user_support_tickets,
    mark_user_support_ticket_read,
)


def _database() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    MobileAnnouncement.__table__.create(engine)
    MobileAnnouncementRead.__table__.create(engine)
    SupportTicket.__table__.create(engine)
    SupportTicketMessage.__table__.create(engine)
    return Session(engine)


def _mobile_announcement(
    announcement_id: int,
    *,
    status: str = "PUBLISHED",
    publish_at: Optional[datetime] = None,
) -> MobileAnnouncement:
    return MobileAnnouncement(
        id=announcement_id,
        title=f"公告 {announcement_id}",
        slug=f"notice-{announcement_id}",
        summary="摘要",
        category_label="系统公告",
        content="正文",
        content_format="PLAIN_TEXT",
        status=status,
        publish_at=publish_at,
    )


def test_mobile_announcement_reads_are_isolated_idempotent_and_published_only() -> None:
    db = _database()
    now = datetime.utcnow()
    db.add_all(
        [
            _mobile_announcement(1, publish_at=now - timedelta(minutes=3)),
            _mobile_announcement(2, publish_at=now - timedelta(minutes=2)),
            _mobile_announcement(3, publish_at=None),
            _mobile_announcement(4, publish_at=now + timedelta(hours=1)),
            _mobile_announcement(5, status="DRAFT", publish_at=now - timedelta(minutes=1)),
        ]
    )
    db.commit()

    first_page = get_public_mobile_announcement_page(db, page=1, page_size=2)
    assert first_page["total"] == 3
    assert first_page["pages"] == 2
    assert [item["id"] for item in first_page["items"]] == [2, 1]
    assert "content" not in first_page["items"][0]

    assert get_mobile_announcement_unread_count(db, 7) == 3
    assert get_mobile_announcement_read_state(db, 7, [1, 2, 5]) == {
        "unread_count": 3,
        "read_ids": [],
    }

    assert mark_mobile_announcement_read(db, 7, 1) is True
    assert mark_mobile_announcement_read(db, 7, 1) is True
    assert mark_mobile_announcement_read(db, 7, 5) is False
    assert get_mobile_announcement_read_state(db, 7, [1, 2, 5]) == {
        "unread_count": 2,
        "read_ids": [1],
    }
    assert get_mobile_announcement_unread_count(db, 8) == 3

    assert mark_all_mobile_announcements_read(db, 7) == 2
    assert mark_all_mobile_announcements_read(db, 7) == 0
    assert get_mobile_announcement_unread_count(db, 7) == 0

    with pytest.raises(ValueError):
        get_mobile_announcement_read_state(db, 7, range(1, 52))


def _ticket(ticket_id: int, user_id: int) -> SupportTicket:
    now = datetime.utcnow()
    return SupportTicket(
        id=ticket_id,
        ticket_no=f"TK{ticket_id}",
        user_id=user_id,
        category="ACCOUNT",
        subject=f"工单 {ticket_id}",
        content="问题描述",
        status="REPLIED",
        priority="NORMAL",
        created_at=now,
        updated_at=now,
    )


def _message(
    message_id: int,
    ticket_id: int,
    sender_type: str,
) -> SupportTicketMessage:
    return SupportTicketMessage(
        id=message_id,
        ticket_id=ticket_id,
        sender_type=sender_type,
        sender_user_id=7 if sender_type == "USER" else None,
        admin_user_id=3 if sender_type == "ADMIN" else None,
        message=f"消息 {message_id}",
        created_at=datetime.utcnow(),
    )


def test_support_reply_cursor_never_marks_messages_newer_than_the_seen_cursor() -> None:
    db = _database()
    db.add_all([_ticket(10, 7), _ticket(11, 7), _ticket(12, 8)])
    db.add_all(
        [
            _message(100, 10, "ADMIN"),
            _message(101, 10, "USER"),
            _message(102, 10, "ADMIN"),
            _message(103, 11, "ADMIN"),
            _message(104, 12, "ADMIN"),
        ]
    )
    db.commit()

    listing = list_user_support_tickets(db, user_id=7)
    assert listing["unread_reply_count"] == 2
    assert [item["has_unread_admin_reply"] for item in listing["items"]] == [True, True]

    first = mark_user_support_ticket_read(db, 7, 10, 100)
    assert first["last_read_message_id"] == 100
    assert first["unread_reply_count"] == 2

    user_cursor = mark_user_support_ticket_read(db, 7, 10, 101)
    assert user_cursor["last_read_message_id"] == 101
    assert user_cursor["unread_reply_count"] == 2

    final = mark_user_support_ticket_read(db, 7, 10, 102)
    assert final["last_read_message_id"] == 102
    assert final["unread_reply_count"] == 1
    assert get_unread_support_reply_count(db, 7) == 1

    older_retry = mark_user_support_ticket_read(db, 7, 10, 100)
    assert older_retry["last_read_message_id"] == 102

    with pytest.raises(HTTPException) as exc:
        mark_user_support_ticket_read(db, 7, 10, 103)
    assert exc.value.status_code == 400
    assert exc.value.detail["code"] == "SUPPORT_TICKET_READ_CURSOR_INVALID"
