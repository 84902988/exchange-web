from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.models.site_content import Announcement
from app.services import site_content_service
from app.services.site_content_service import (
    admin_toggle_announcement_status,
    admin_update_announcement,
    serialize_announcement,
)


def _database() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Announcement.__table__.create(engine)
    return Session(engine)


def _announcement(*, status: str = "PUBLISHED", publish_at: datetime | None = None) -> Announcement:
    created_at = datetime(2026, 7, 30, 11, 26, 49)
    return Announcement(
        id=2,
        title="Exchange 将于 8月3日 正式上线",
        slug="launch",
        category="platform",
        summary="公告摘要",
        content="<p>公告正文</p>",
        status=status,
        publish_at=publish_at,
        created_at=created_at,
        updated_at=created_at,
    )


def test_legacy_published_announcement_uses_created_at_as_stable_public_time() -> None:
    row = _announcement(publish_at=None)

    item = serialize_announcement(row)

    assert item["publish_at"] == "2026-07-30T11:26:49Z"
    assert item["publish_at_input"] == ""


def test_enabling_announcement_records_publish_time_when_missing(monkeypatch) -> None:
    db = _database()
    row = _announcement(status="DISABLED", publish_at=None)
    db.add(row)
    db.commit()
    published_at = row.created_at + timedelta(days=1)
    monkeypatch.setattr(site_content_service, "_now", lambda: published_at)

    result = admin_toggle_announcement_status(db, row.id)

    db.refresh(row)
    assert result["ok"] is True
    assert row.status == "PUBLISHED"
    assert row.publish_at == published_at


def test_edit_transition_to_published_records_publish_time_when_missing(monkeypatch) -> None:
    db = _database()
    row = _announcement(status="DISABLED", publish_at=None)
    db.add(row)
    db.commit()
    published_at = row.created_at + timedelta(days=2)
    monkeypatch.setattr(site_content_service, "_now", lambda: published_at)

    result = admin_update_announcement(
        db,
        row.id,
        {
            "title": row.title,
            "slug": row.slug,
            "category": row.category,
            "summary": row.summary,
            "content": row.content,
            "status": "PUBLISHED",
            "publish_at": "",
        },
    )

    db.refresh(row)
    assert result["ok"] is True
    assert row.publish_at == published_at
