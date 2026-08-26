from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace

import pytest
from datetime import datetime, timedelta

from fastapi import HTTPException, Response
from PIL import Image
from starlette.requests import Request

from app.routers import auth_jwt, me


def _request(path: str) -> Request:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": [],
            "client": ("127.0.0.1", 12345),
        }
    )
    request.state.trace_id = "account-security-test"
    return request


class _Query:
    def __init__(self, model, user, session=None):
        self.model = model
        self.user = user
        self.session = session
        self.updated_values = None

    def filter(self, *_args):
        return self

    def first(self):
        if self.model is me.User or self.model is auth_jwt.User:
            return self.user
        return self.session

    def with_for_update(self):
        return self

    def update(self, values, **_kwargs):
        self.updated_values = {
            getattr(column, "key", str(column)): value
            for column, value in values.items()
        }
        return 2


class _Db:
    def __init__(self, user, session=None):
        self.user = user
        self.session = session
        self.queries = []
        self.added = []
        self.commits = 0

    def query(self, model):
        query = _Query(model, self.user, self.session)
        self.queries.append(query)
        return query

    def commit(self):
        self.commits += 1

    def add(self, value):
        self.added.append(value)


def test_password_change_revokes_all_active_refresh_sessions(monkeypatch) -> None:
    user = SimpleNamespace(
        id=7,
        password_hash="old-hash",
        password_changed_at=None,
        updated_at=None,
    )
    db = _Db(user)
    monkeypatch.setattr(
        me,
        "verify_password",
        lambda raw, _hashed: raw == "OldPass1!",
    )
    monkeypatch.setattr(me, "hash_password", lambda _raw: "new-hash")

    result = me.change_password(
        me.PasswordChangeIn(
            old_password="OldPass1!",
            new_password="NewPass2@",
        ),
        _request("/me/password"),
        user_id="7",
        db=db,
    )

    session_query = next(query for query in db.queries if query.model is me.UserSession)
    assert session_query.updated_values["revoked_at"] is not None
    assert session_query.updated_values["last_used_at"] is not None
    assert user.password_hash == "new-hash"
    assert len(db.added) == 1
    assert db.added[0].event_type == "PASSWORD_CHANGED"
    assert db.added[0].details == {"revoked_sessions": 2}
    assert db.commits == 1
    assert result["ok"] is True


def test_refresh_fails_closed_without_active_durable_session(monkeypatch) -> None:
    user = SimpleNamespace(id=7, status=1)
    db = _Db(user, session=None)
    revoked = []
    monkeypatch.setattr(
        auth_jwt,
        "verify_refresh_token",
        lambda _token: {"jti": "old-jti", "sub": "7", "remember_me": True},
    )
    monkeypatch.setattr(auth_jwt, "get_refresh_jti_owner", lambda _jti: "7")
    monkeypatch.setattr(auth_jwt, "hash_refresh_token", lambda _token: "hash")
    monkeypatch.setattr(auth_jwt, "revoke_refresh_jti", revoked.append)

    with pytest.raises(HTTPException) as exc_info:
        auth_jwt.refresh(
            _request("/auth/refresh"),
            body=auth_jwt.RefreshIn(refresh_token="old-refresh"),
            response=Response(),
            db=db,
        )

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail["message"] == "Refresh session revoked"
    assert revoked == ["old-jti"]
    assert db.commits == 0


def _image_bytes(image_format: str) -> bytes:
    output = BytesIO()
    Image.new("RGB", (128, 128), color=(214, 168, 50)).save(
        output,
        format=image_format,
    )
    return output.getvalue()


def test_avatar_content_validation_checks_real_format_and_dimensions() -> None:
    me._validate_avatar_content(_image_bytes("JPEG"), ".jpg")

    with pytest.raises(HTTPException) as mismatch:
        me._validate_avatar_content(_image_bytes("PNG"), ".jpg")
    assert mismatch.value.detail["code"] == "INVALID_IMAGE"

    with pytest.raises(HTTPException) as invalid:
        me._validate_avatar_content(b"not-an-image", ".png")
    assert invalid.value.detail["code"] == "INVALID_IMAGE"


def test_mobile_user_agents_have_stable_device_names() -> None:
    assert auth_jwt._device_name("okhttp/4.12.0") == "ExchangeMobile / Android"
    assert (
        auth_jwt._device_name("ExchangeMobile/1 CFNetwork/1496 Darwin/23.5")
        == "ExchangeMobile / iOS"
    )


class _SessionQuery:
    def __init__(self, *, first=None, all_rows=None, update_count=0):
        self.first_value = first
        self.all_rows = list(all_rows or [])
        self.update_count = update_count
        self.updated_values = None

    def filter(self, *_args):
        return self

    def order_by(self, *_args):
        return self

    def limit(self, _value):
        return self

    def with_for_update(self):
        return self

    def first(self):
        return self.first_value

    def all(self):
        return self.all_rows

    def update(self, values, **_kwargs):
        self.updated_values = {
            getattr(column, "key", str(column)): value
            for column, value in values.items()
        }
        return self.update_count


class _SessionDb:
    def __init__(self, queries):
        self.pending_queries = list(queries)
        self.queries = []
        self.added = []
        self.commits = 0

    def query(self, model):
        assert model is auth_jwt.UserSession
        query = self.pending_queries.pop(0)
        self.queries.append(query)
        return query

    def commit(self):
        self.commits += 1

    def add(self, value):
        self.added.append(value)


def _session(session_id: int, *, current=False):
    now = datetime.utcnow()
    return SimpleNamespace(
        id=session_id,
        user_id=7,
        refresh_token_hash="current-hash" if current else f"hash-{session_id}",
        ip="203.0.113.%s" % session_id,
        user_agent="ExchangeMobile Android" if current else "Chrome Windows",
        created_at=now - timedelta(days=1),
        last_used_at=now,
        expires_at=now + timedelta(days=10),
        revoked_at=None,
    )


def _mock_current_session_proof(monkeypatch) -> None:
    monkeypatch.setattr(
        auth_jwt,
        "verify_refresh_token",
        lambda _token: {"jti": "current-jti", "sub": "7"},
    )
    monkeypatch.setattr(
        auth_jwt,
        "hash_refresh_token",
        lambda _token: "current-hash",
    )


def test_active_sessions_are_scoped_and_mark_exactly_one_current(monkeypatch) -> None:
    _mock_current_session_proof(monkeypatch)
    current = _session(11, current=True)
    other = _session(12)
    db = _SessionDb([
        _SessionQuery(first=current),
        _SessionQuery(all_rows=[other]),
    ])

    result = auth_jwt.list_active_sessions(
        _request("/auth/sessions/list"),
        auth_jwt.SessionProofIn(refresh_token="current-token"),
        user_id="7",
        db=db,
    )

    assert result["data"]["current_session_id"] == 11
    assert result["data"]["total"] == 2
    assert [item["is_current"] for item in result["data"]["items"]] == [True, False]
    assert db.commits == 0


def test_session_management_rejects_cross_user_refresh_proof(monkeypatch) -> None:
    monkeypatch.setattr(
        auth_jwt,
        "verify_refresh_token",
        lambda _token: {"jti": "other-jti", "sub": "99"},
    )
    db = _SessionDb([])

    with pytest.raises(HTTPException) as exc_info:
        auth_jwt.list_active_sessions(
            _request("/auth/sessions/list"),
            auth_jwt.SessionProofIn(refresh_token="other-token"),
            user_id="7",
            db=db,
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail["code"] == "CURRENT_SESSION_MISMATCH"
    assert db.commits == 0


def test_current_session_cannot_be_revoked_from_device_management(monkeypatch) -> None:
    _mock_current_session_proof(monkeypatch)
    current = _session(11, current=True)
    db = _SessionDb([_SessionQuery(first=current)])

    with pytest.raises(HTTPException) as exc_info:
        auth_jwt.revoke_active_session(
            11,
            _request("/auth/sessions/11/revoke"),
            auth_jwt.SessionProofIn(refresh_token="current-token"),
            user_id="7",
            db=db,
        )

    assert exc_info.value.detail["code"] == "CANNOT_REVOKE_CURRENT_SESSION"
    assert db.commits == 0


def test_revoke_specific_other_session_is_confirmed_once(monkeypatch) -> None:
    _mock_current_session_proof(monkeypatch)
    current = _session(11, current=True)
    other = _session(12)
    db = _SessionDb([
        _SessionQuery(first=current),
        _SessionQuery(first=other),
    ])

    result = auth_jwt.revoke_active_session(
        12,
        _request("/auth/sessions/12/revoke"),
        auth_jwt.SessionProofIn(refresh_token="current-token"),
        user_id="7",
        db=db,
    )

    assert result["data"] == {"session_id": 12, "revoked": True}
    assert other.revoked_at is not None
    assert other.last_used_at == other.revoked_at
    assert len(db.added) == 1
    assert db.added[0].event_type == "SESSION_REVOKED"
    assert db.added[0].details == {"target_device": "Chrome / Windows"}
    assert db.commits == 1


def test_revoke_other_sessions_preserves_current_session(monkeypatch) -> None:
    _mock_current_session_proof(monkeypatch)
    current = _session(11, current=True)
    update_query = _SessionQuery(update_count=3)
    db = _SessionDb([_SessionQuery(first=current), update_query])

    result = auth_jwt.revoke_other_sessions(
        _request("/auth/sessions/revoke-others"),
        auth_jwt.SessionProofIn(refresh_token="current-token"),
        user_id="7",
        db=db,
    )

    assert result["data"] == {"revoked_count": 3, "current_session_id": 11}
    assert update_query.updated_values["revoked_at"] is not None
    assert update_query.updated_values["last_used_at"] is not None
    assert len(db.added) == 1
    assert db.added[0].event_type == "SESSIONS_REVOKED"
    assert db.added[0].details == {"revoked_count": 3}
    assert db.commits == 1
