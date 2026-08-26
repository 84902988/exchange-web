from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app.core.security import hash_password, verify_password
from app.db.models import User, UserOtp, UserSecurityEvent, UserSession
from app.routers import auth
from app.routers.auth import RegisterIn, ResetPasswordIn


def _request() -> Request:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/auth/test",
            "headers": [(b"user-agent", b"ExchangeMobile Android")],
            "client": ("203.0.113.10", 12345),
        }
    )
    request.state.trace_id = "auth-security-test"
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


def _otp(db, *, email: str, purpose: str, code: str = "123456") -> UserOtp:
    now = datetime.utcnow()
    otp = UserOtp(
        account=email,
        account_type="email",
        channel="email",
        purpose=purpose,
        code_hash=auth._hash_otp(code),
        expires_at=now + timedelta(minutes=10),
        cooldown_until=now + timedelta(seconds=60),
        attempts=0,
        created_at=now,
    )
    db.add(otp)
    db.commit()
    return otp


def test_registration_requires_the_same_strong_password_contract() -> None:
    with pytest.raises(ValidationError):
        RegisterIn(email="member@example.com", otp="123456", password="abcdef")
    with pytest.raises(HTTPException) as weak:
        auth._validate_password_strength("Abcdefgh1")
    assert weak.value.detail["code"] == "PASSWORD_WEAK"
    auth._validate_password_strength("Abcdef!1")


def test_unknown_otp_scene_is_not_silently_treated_as_registration() -> None:
    assert auth._scene_to_purpose("register") == "register"
    assert auth._scene_to_purpose("reset") == "reset_password"
    with pytest.raises(HTTPException) as invalid:
        auth._scene_to_purpose("change-email-typo")
    assert invalid.value.detail["code"] == "OTP_SCENE_INVALID"


def test_registration_marks_the_otp_proven_email_verified(db, monkeypatch) -> None:
    _otp(db, email="member@example.com", purpose="register")
    monkeypatch.setattr(auth, "ensure_user_invite_code", lambda *_args: None)
    monkeypatch.setattr(auth, "create_access_token", lambda _user_id: ("access", 900))
    monkeypatch.setattr(
        auth,
        "create_refresh_token",
        lambda _user_id: ("refresh", "refresh-jti", 4102444800),
    )
    monkeypatch.setattr(auth, "set_refresh_jti", lambda **_kwargs: None)
    monkeypatch.setattr(auth, "hash_refresh_token", lambda _token: "refresh-hash")
    monkeypatch.setattr(auth, "set_refresh_cookie", lambda *_args: None)
    monkeypatch.setattr(auth, "set_access_cookie", lambda *_args: None)

    result = asyncio.run(
        auth.register(
            _request(),
            RegisterIn(
                email="Member@Example.com",
                otp="123456",
                password="StrongPass!123",
            ),
            Response(),
            db,
        )
    )
    user = db.query(User).one()
    assert user.email == "member@example.com"
    assert user.email_verified_at is not None
    assert result["data"]["user"]["email"] == "member@example.com"
    event = db.query(UserSecurityEvent).one()
    assert event.event_type == "EMAIL_VERIFIED"
    assert event.details["source"] == "registration"


def test_password_reset_revokes_every_refresh_session_and_records_event(db) -> None:
    now = datetime.utcnow()
    user = User(
        email="member@example.com",
        password_hash=hash_password("OldPass!123"),
        status=1,
        created_at=now,
        updated_at=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    db.add_all(
        [
            UserSession(
                user_id=user.id,
                refresh_token_hash="reset-session-1",
                expires_at=now + timedelta(days=1),
                created_at=now,
            ),
            UserSession(
                user_id=user.id,
                refresh_token_hash="reset-session-2",
                expires_at=now + timedelta(days=1),
                created_at=now,
            ),
        ]
    )
    db.commit()
    _otp(db, email=user.email, purpose="reset_password")

    result = asyncio.run(
        auth.reset_password(
            _request(),
            ResetPasswordIn(
                email=user.email,
                otp="123456",
                new_password="NewStrong!123",
                confirm_password="NewStrong!123",
            ),
            db,
        )
    )
    db.refresh(user)
    assert result["data"]["message"] == "密码重置成功，请使用新密码登录"
    assert verify_password("NewStrong!123", user.password_hash)
    assert user.password_changed_at is not None
    assert all(item.revoked_at is not None for item in db.query(UserSession).all())
    event = db.query(UserSecurityEvent).one()
    assert event.event_type == "PASSWORD_RESET"
