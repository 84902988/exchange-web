from __future__ import annotations

from datetime import datetime
from typing import Iterable

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.mobile_content import MobileAnnouncement, MobileAnnouncementRead
from app.services.mobile_content_service import MOBILE_ANNOUNCEMENT_CONTENT_FORMATS


MOBILE_ANNOUNCEMENT_READ_STATE_LIMIT = 50


def _now() -> datetime:
    return datetime.utcnow()


def _published_mobile_announcement_filter(now: datetime):
    return and_(
        MobileAnnouncement.status == "PUBLISHED",
        MobileAnnouncement.content_format.in_(MOBILE_ANNOUNCEMENT_CONTENT_FORMATS),
        or_(
            MobileAnnouncement.publish_at.is_(None),
            MobileAnnouncement.publish_at <= now,
        ),
    )


def _normalize_announcement_ids(announcement_ids: Iterable[int]) -> list[int]:
    normalized = sorted({int(value) for value in announcement_ids if int(value) > 0})
    if len(normalized) > MOBILE_ANNOUNCEMENT_READ_STATE_LIMIT:
        raise ValueError("Too many mobile announcement ids")
    return normalized


def get_mobile_announcement_unread_count(db: Session, user_id: int) -> int:
    now = _now()
    read_ids = select(MobileAnnouncementRead.announcement_id).where(
        MobileAnnouncementRead.user_id == int(user_id)
    )
    return int(
        db.query(MobileAnnouncement.id)
        .filter(_published_mobile_announcement_filter(now))
        .filter(~MobileAnnouncement.id.in_(read_ids))
        .count()
    )


def get_mobile_announcement_read_state(
    db: Session,
    user_id: int,
    announcement_ids: Iterable[int],
) -> dict[str, object]:
    normalized_ids = _normalize_announcement_ids(announcement_ids)
    read_ids: list[int] = []
    if normalized_ids:
        now = _now()
        rows = (
            db.query(MobileAnnouncementRead.announcement_id)
            .join(
                MobileAnnouncement,
                MobileAnnouncement.id == MobileAnnouncementRead.announcement_id,
            )
            .filter(
                MobileAnnouncementRead.user_id == int(user_id),
                MobileAnnouncementRead.announcement_id.in_(normalized_ids),
                _published_mobile_announcement_filter(now),
            )
            .all()
        )
        read_ids = sorted(int(row[0]) for row in rows)
    return {
        "unread_count": get_mobile_announcement_unread_count(db, user_id),
        "read_ids": read_ids,
    }


def mark_mobile_announcement_read(
    db: Session,
    user_id: int,
    announcement_id: int,
) -> bool:
    now = _now()
    published = (
        db.query(MobileAnnouncement.id)
        .filter(
            MobileAnnouncement.id == int(announcement_id),
            _published_mobile_announcement_filter(now),
        )
        .first()
    )
    if published is None:
        return False

    existing = (
        db.query(MobileAnnouncementRead.id)
        .filter(
            MobileAnnouncementRead.user_id == int(user_id),
            MobileAnnouncementRead.announcement_id == int(announcement_id),
        )
        .first()
    )
    if existing is not None:
        return True

    db.add(
        MobileAnnouncementRead(
            user_id=int(user_id),
            announcement_id=int(announcement_id),
            read_at=now,
            created_at=now,
        )
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return True


def mark_all_mobile_announcements_read(db: Session, user_id: int) -> int:
    now = _now()
    published_ids = [
        int(row[0])
        for row in (
            db.query(MobileAnnouncement.id)
            .filter(_published_mobile_announcement_filter(now))
            .all()
        )
    ]
    if not published_ids:
        return 0

    existing_ids = {
        int(row[0])
        for row in (
            db.query(MobileAnnouncementRead.announcement_id)
            .filter(
                MobileAnnouncementRead.user_id == int(user_id),
                MobileAnnouncementRead.announcement_id.in_(published_ids),
            )
            .all()
        )
    }
    new_ids = [value for value in published_ids if value not in existing_ids]
    if not new_ids:
        return 0

    db.add_all(
        [
            MobileAnnouncementRead(
                user_id=int(user_id),
                announcement_id=value,
                read_at=now,
                created_at=now,
            )
            for value in new_ids
        ]
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return 0
    return len(new_ids)
