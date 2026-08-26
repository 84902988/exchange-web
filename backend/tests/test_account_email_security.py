from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app.core.security import hash_password
from app.db.models import User, UserOtp, UserSecurityEvent, UserSession
from app.routers import account_email
from app.routers.account_email import EmailChangeConfirmIn, EmailChangeSendIn, EmailOtpConfirmIn


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def exists(self, key: str) -> bool:
        return key in self.values

    def setex(self, key: str, _ttl: int, value: str) -> None:
        self.values[key] = value


def _request() -> Request:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/me/email",
            "headers": [(b"user-agent", b"ExchangeMobile Android")],
            "client": ("203.0.113.9", 12345),
        }
    )
    request.state.trace_id = "email-security-test"
    return request


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    for table in (
        User.__table__,
        UserOtp.__table__,
        UserSession.__table__,
        UserSecurityEvent.__table__,
    ):
        table.create(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def otp_dependencies(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(account_email, "redis", FakeRedis())
    monkeypatch.setattr(account_email, "_generate_code", lambda: "123456")
    monkeypatch.setattr(
        account_email,
        "enqueue_send_verify_code_email",
        lambda **kwargs: sent.append(kwargs) or "job-1",
    )
    return sent


def _user(db, *, email: str = "member@example.com", verified: bool = False) -> User:
    user = User(
        id=db.query(User).count() + 1,
        email=email,
        password_hash=hash_password("OldPass!123"),
        status=1,
        email_verified_at=datetime.utcnow() if verified else None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_current_email_verification_is_one_time_and_audited(db, otp_dependencies) -> None:
    user = _user(db)
    request = _request()

    result = account_email.send_current_email_verification(
        request=request,
        user_id=str(user.id),
        db=db,
    )
    assert result["data"] == {
        "message": "verification code sent",
        "email": "me***@example.com",
    }
    assert otp_dependencies[0]["scene"] == "verify_email"

    confirmed = account_email.confirm_current_email_verification(
        EmailOtpConfirmIn(code="123456"),
        request=request,
        user_id=str(user.id),
        db=db,
    )
    db.refresh(user)
    assert confirmed["data"]["email"] == "member@example.com"
    assert user.email_verified_at is not None
    otp = db.query(UserOtp).one()
    assert otp.purpose == "verify_email"
    assert otp.used_at is not None
    event = db.query(UserSecurityEvent).one()
    assert event.event_type == "EMAIL_VERIFIED"
    assert event.details == {"email": "me***@example.com"}


def test_email_change_reauthenticates_revokes_sessions_and_keeps_audit(db, otp_dependencies) -> None:
    user = _user(db, verified=True)
    other = _user(db, email="taken@example.com", verified=True)
    now = datetime.utcnow()
    db.add_all(
        [
            UserSession(
                id=1,
                user_id=user.id,
                refresh_token_hash="session-1",
                expires_at=now + timedelta(days=1),
                created_at=now,
            ),
            UserSession(
                id=2,
                user_id=user.id,
                refresh_token_hash="session-2",
                expires_at=now + timedelta(days=1),
                created_at=now,
            ),
        ]
    )
    db.commit()
    request = _request()

    with pytest.raises(HTTPException) as wrong_password:
        account_email.send_email_change_verification(
            EmailChangeSendIn(
                new_email="next@example.com",
                current_password="wrong-password",
            ),
            request=request,
            user_id=str(user.id),
            db=db,
        )
    assert wrong_password.value.detail["code"] == "INVALID_PASSWORD"

    with pytest.raises(HTTPException) as duplicate:
        account_email.send_email_change_verification(
            EmailChangeSendIn(
                new_email=other.email,
                current_password="OldPass!123",
            ),
            request=request,
            user_id=str(user.id),
            db=db,
        )
    assert duplicate.value.detail["code"] == "EMAIL_TAKEN"

    account_email.send_email_change_verification(
        EmailChangeSendIn(
            new_email="Next@Example.com",
            current_password="OldPass!123",
        ),
        request=request,
        user_id=str(user.id),
        db=db,
    )
    changed = account_email.confirm_email_change(
        EmailChangeConfirmIn(
            new_email="next@example.com",
            current_password="OldPass!123",
            code="123456",
        ),
        request=request,
        user_id=str(user.id),
        db=db,
    )

    db.refresh(user)
    assert changed["data"] == {
        "email": "next@example.com",
        "email_verified_at": user.email_verified_at.isoformat(),
        "reauthenticate": True,
    }
    assert user.email == "next@example.com"
    assert all(item.revoked_at is not None for item in db.query(UserSession).all())
    event = db.query(UserSecurityEvent).one()
    assert event.event_type == "EMAIL_CHANGED"
    assert event.details == {
        "old_email": "me***@example.com",
        "new_email": "ne***@example.com",
    }


def test_invalid_otp_counts_attempt_without_changing_email(db, otp_dependencies) -> None:
    user = _user(db, verified=True)
    request = _request()
    account_email.send_email_change_verification(
        EmailChangeSendIn(
            new_email="next@example.com",
            current_password="OldPass!123",
        ),
        request=request,
        user_id=str(user.id),
        db=db,
    )

    with pytest.raises(HTTPException) as invalid:
        account_email.confirm_email_change(
            EmailChangeConfirmIn(
                new_email="next@example.com",
                current_password="OldPass!123",
                code="000000",
            ),
            request=request,
            user_id=str(user.id),
            db=db,
        )
    assert invalid.value.detail["code"] == "OTP_INVALID"
    db.refresh(user)
    assert user.email == "member@example.com"
    assert db.query(UserOtp).one().attempts == 1
    assert db.query(UserSecurityEvent).count() == 0
