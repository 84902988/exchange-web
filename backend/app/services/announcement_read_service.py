from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.announcement_read import AnnouncementRead
from app.db.models.site_content import Announcement
from app.services.site_content_service import PUBLISHED_ANNOUNCEMENT_STATUS


def _now() -> datetime:
    return datetime.utcnow()


def _published_announcement_filter(now: datetime):
    return and_(
        Announcement.status == PUBLISHED_ANNOUNCEMENT_STATUS,
        or_(Announcement.publish_at.is_(None), Announcement.publish_at <= now),
    )


def get_unread_announcement_count(db: Session, user_id: int) -> int:
    now = _now()
    read_announcement_ids = (
        select(AnnouncementRead.announcement_id)
        .where(AnnouncementRead.user_id == int(user_id))
    )
    return (
        db.query(Announcement.id)
        .filter(_published_announcement_filter(now))
        .filter(~Announcement.id.in_(read_announcement_ids))
        .count()
    )


def mark_announcement_read(db: Session, user_id: int, announcement_id: int) -> bool:
    now = _now()
    exists = (
        db.query(Announcement.id)
        .filter(Announcement.id == int(announcement_id))
        .filter(_published_announcement_filter(now))
        .first()
    )
    if exists is None:
        return False

    already_read = (
        db.query(AnnouncementRead.id)
        .filter(
            AnnouncementRead.user_id == int(user_id),
            AnnouncementRead.announcement_id == int(announcement_id),
        )
        .first()
    )
    if already_read:
        return True

    db.add(
        AnnouncementRead(
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


def mark_all_announcements_read(db: Session, user_id: int) -> int:
    now = _now()
    published_ids = [
        int(row[0])
        for row in (
            db.query(Announcement.id)
            .filter(_published_announcement_filter(now))
            .all()
        )
    ]
    if not published_ids:
        return 0

    read_ids = {
        int(row[0])
        for row in (
            db.query(AnnouncementRead.announcement_id)
            .filter(
                AnnouncementRead.user_id == int(user_id),
                AnnouncementRead.announcement_id.in_(published_ids),
            )
            .all()
        )
    }
    new_ids = [announcement_id for announcement_id in published_ids if announcement_id not in read_ids]
    if not new_ids:
        return 0

    db.add_all(
        [
            AnnouncementRead(
                user_id=int(user_id),
                announcement_id=announcement_id,
                read_at=now,
                created_at=now,
            )
            for announcement_id in new_ids
        ]
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return 0
    return len(new_ids)
