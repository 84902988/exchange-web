from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app.db.models import UserSecurityEvent
from app.routers.account_security import list_my_security_events


def _request() -> Request:
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/me/security-events",
            "headers": [],
            "client": ("203.0.113.9", 12345),
        }
    )
    request.state.trace_id = "security-events-test"
    return request


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    UserSecurityEvent.__table__.create(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _event(
    event_id: int,
    *,
    user_id: int = 7,
    event_type: str,
    created_at: datetime,
    details=None,
) -> UserSecurityEvent:
    return UserSecurityEvent(
        id=event_id,
        user_id=user_id,
        event_type=event_type,
        ip="203.0.113.10",
        user_agent="ExchangeMobile Android",
        details=details,
        created_at=created_at,
    )


def test_security_events_are_scoped_sanitized_and_cursor_paginated(db) -> None:
    now = datetime.utcnow().replace(microsecond=0)
    db.add_all(
        [
            _event(
                1,
                event_type="EMAIL_VERIFIED",
                created_at=now - timedelta(minutes=3),
                details={"email": "member@example.com", "source": "registration", "secret": "x"},
            ),
            _event(
                2,
                event_type="PASSWORD_CHANGED",
                created_at=now - timedelta(minutes=2),
                details={"revoked_sessions": 2, "password": "never-return"},
            ),
            _event(
                3,
                event_type="SESSION_REVOKED",
                created_at=now - timedelta(minutes=1),
                details={"target_device": "Chrome / Windows", "session_id": 99},
            ),
            _event(
                4,
                event_type="INTERNAL_ONLY",
                created_at=now,
                details={"secret": "hidden"},
            ),
            _event(
                5,
                user_id=8,
                event_type="EMAIL_CHANGED",
                created_at=now,
                details={"old_email": "ol***@example.com", "new_email": "ne***@example.com"},
            ),
        ]
    )
    db.commit()

    first = list_my_security_events(
        request=_request(),
        limit=2,
        before_id=None,
        user_id="7",
        db=db,
    )
    assert [item["id"] for item in first["data"]["items"]] == [3, 2]
    assert first["data"]["has_more"] is True
    assert first["data"]["next_cursor"] == 2
    assert first["data"]["items"][0]["details"] == {
        "target_device": "Chrome / Windows"
    }
    assert first["data"]["items"][1]["details"] == {"revoked_sessions": 2}
    assert first["data"]["items"][0]["created_at"].endswith("Z")

    second = list_my_security_events(
        request=_request(),
        limit=2,
        before_id=2,
        user_id="7",
        db=db,
    )
    assert [item["id"] for item in second["data"]["items"]] == [1]
    assert second["data"]["has_more"] is False
    assert second["data"]["next_cursor"] is None
    assert second["data"]["items"][0]["details"] == {"source": "registration"}


def test_security_event_cursor_must_belong_to_current_user(db) -> None:
    db.add(
        _event(
            9,
            user_id=8,
            event_type="EMAIL_VERIFIED",
            created_at=datetime.utcnow(),
            details={"email": "us***@example.com"},
        )
    )
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        list_my_security_events(
            request=_request(),
            limit=20,
            before_id=9,
            user_id="7",
            db=db,
        )
    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["code"] == "INVALID_CURSOR"
