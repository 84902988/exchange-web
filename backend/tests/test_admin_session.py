from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from fastapi import Request
from fastapi.responses import Response

from app.core.admin_session import (
    ADMIN_SESSION_MAX_AGE_SECONDS,
    AdminSessionConfigurationError,
    create_admin_session_token,
    is_admin_session_secret_strong,
    verify_admin_session_token,
)
from app.routers import admin_pages


SECRET_A = "a" * 32
SECRET_B = "b" * 32


class _FakeAdminQuery:
    def __init__(self, admin_user):
        self._admin_user = admin_user

    def filter(self, *_args):
        return self

    def first(self):
        return self._admin_user


class _FakeAdminDb:
    def __init__(self, admin_user):
        self._admin_user = admin_user
        self.added = []
        self.commit_count = 0

    def query(self, _model):
        return _FakeAdminQuery(self._admin_user)

    def add(self, value):
        self.added.append(value)

    def commit(self):
        self.commit_count += 1


def _admin_user():
    return SimpleNamespace(
        id=7,
        username="operator",
        password_hash="test-only-hash",
        status="ACTIVE",
        last_login_at=None,
        updated_at=None,
    )


def _request(
    *,
    cookie: str = "",
    host: str = "localhost",
    method: str = "GET",
    origin: str = "",
    referer: str = "",
    scheme: str = "http",
    path: str = "/admin/dashboard",
) -> Request:
    headers = [(b"host", host.encode("ascii"))]
    if cookie:
        headers.append((b"cookie", cookie.encode("ascii")))
    if origin:
        headers.append((b"origin", origin.encode("ascii")))
    if referer:
        headers.append((b"referer", referer.encode("ascii")))
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": scheme,
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": (host, 443 if scheme == "https" else 80),
        }
    )


def _session_token(*, now: int = 1_700_000_000, max_age: int = ADMIN_SESSION_MAX_AGE_SECONDS) -> str:
    return create_admin_session_token(
        admin_id=7,
        username="operator",
        secret=SECRET_A,
        now=now,
        max_age_seconds=max_age,
    )


def _current_session_token() -> str:
    return _session_token(now=int(time.time()))


def test_admin_session_accepts_valid_signed_principal() -> None:
    principal = verify_admin_session_token(
        _session_token(),
        secret=SECRET_A,
        now=1_700_000_001,
    )

    assert principal == {
        "id": 7,
        "username": "operator",
        "issued_at": 1_700_000_000,
        "expires_at": 1_700_000_000 + ADMIN_SESSION_MAX_AGE_SECONDS,
    }


@pytest.mark.parametrize(
    ("token", "secret", "now"),
    [
        ("v1.e30." + ("A" * 43), SECRET_A, 1_700_000_001),
        (_session_token(), SECRET_B, 1_700_000_001),
        (_session_token(now=100, max_age=10), SECRET_A, 110),
        ("1", SECRET_A, 1_700_000_001),
    ],
)
def test_admin_session_rejects_forged_wrong_key_expired_and_legacy_values(
    token: str,
    secret: str,
    now: int,
) -> None:
    assert verify_admin_session_token(token, secret=secret, now=now) is None


def test_admin_session_rejects_payload_tampering() -> None:
    prefix, payload, signature = _session_token().split(".")
    replacement = "A" if payload[0] != "A" else "B"
    tampered = f"{prefix}.{replacement}{payload[1:]}.{signature}"

    assert verify_admin_session_token(tampered, secret=SECRET_A, now=1_700_000_001) is None


def test_admin_session_fails_closed_without_a_configured_secret() -> None:
    with pytest.raises(AdminSessionConfigurationError):
        create_admin_session_token(admin_id=7, username="operator", secret="   ")

    assert verify_admin_session_token(_session_token(), secret="") is None
    assert verify_admin_session_token(_session_token(), secret=None) is None


@pytest.mark.parametrize(
    "secret",
    [
        "x",
        "change-me",
        "change-me-long-random-string",
        "replace-with-at-least-32-random-bytes",
    ],
)
def test_admin_session_rejects_short_or_known_placeholder_secrets(secret: str) -> None:
    assert is_admin_session_secret_strong(secret) is False
    with pytest.raises(AdminSessionConfigurationError):
        create_admin_session_token(
            admin_id=7,
            username="operator",
            secret=secret,
        )
    assert verify_admin_session_token(
        _session_token(),
        secret=secret,
        now=1_700_000_001,
    ) is None


def test_request_principal_ignores_unsigned_identity_cookies(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(admin_pages.settings, "JWT_SECRET", SECRET_A)
    request = _request(
        cookie=(
            f"{admin_pages.COOKIE_NAME}={_current_session_token()}; "
            f"{admin_pages.ADMIN_USER_ID_COOKIE_NAME}=999; "
            f"{admin_pages.ADMIN_USERNAME_COOKIE_NAME}=forged"
        )
    )

    principal = admin_pages.get_admin_from_request(request)

    assert principal is not None
    assert principal["id"] == 7
    assert principal["username"] == "operator"


def test_legacy_unsigned_request_cookie_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(admin_pages.settings, "JWT_SECRET", SECRET_A)
    request = _request(cookie="admin_auth=1; admin_user_id=7; admin_username=operator")

    assert admin_pages.get_admin_from_request(request) is None


def test_rbac_uses_only_verified_session_admin_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(admin_pages.settings, "JWT_SECRET", SECRET_A)
    called_with: list[int] = []

    def _rbac(_db, admin_id):
        called_with.append(admin_id)
        return {"is_super_admin": False, "permissions": {"audit.view"}}

    monkeypatch.setattr(admin_pages, "admin_get_current_admin_rbac_context", _rbac)
    request = _request(
        cookie=(
            f"admin_auth={_current_session_token()}; "
            "admin_user_id=999; admin_username=forged"
        )
    )

    result = admin_pages.get_current_admin_rbac_context(request, object())

    assert called_with == [7]
    assert result["permissions"] == {"audit.view"}


def test_successful_login_issues_only_a_verified_session_principal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(admin_pages.settings, "JWT_SECRET", SECRET_A)
    monkeypatch.setattr(admin_pages.settings, "COOKIE_DOMAIN", None)
    monkeypatch.setattr(admin_pages.settings, "COOKIE_PATH", "/")
    monkeypatch.setattr(admin_pages, "_verify_admin_login_captcha", lambda *_args: (True, ""))
    monkeypatch.setattr(admin_pages, "verify_password", lambda *_args: True)
    db = _FakeAdminDb(_admin_user())
    request = _request(path="/admin/login")

    response = admin_pages.login_submit(
        request=request,
        username="operator",
        password="correct-password",
        captcha_id="captcha",
        captcha_code="ABCDE",
        db=db,
    )

    assert response.status_code == 302
    assert db.commit_count == 1
    headers = response.headers.getlist("set-cookie")
    session_header = next(header for header in headers if header.startswith("admin_auth=v1."))
    assert "HttpOnly" in session_header
    assert "SameSite=lax" in session_header
    assert "Secure" not in session_header
    session_cookie = session_header.split(";", 1)[0]
    principal = admin_pages.get_admin_from_request(_request(cookie=session_cookie))
    assert principal is not None
    assert principal["id"] == 7
    assert principal["username"] == "operator"
    assert all(
        "Max-Age=0" in header
        for header in headers
        if header.startswith(("admin_user_id=", "admin_username="))
    )


def test_login_does_not_commit_or_issue_cookie_without_session_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(admin_pages.settings, "JWT_SECRET", "")
    monkeypatch.setattr(admin_pages, "_verify_admin_login_captcha", lambda *_args: (True, ""))
    monkeypatch.setattr(admin_pages, "verify_password", lambda *_args: True)
    monkeypatch.setattr(
        admin_pages,
        "_admin_login_template_ctx",
        lambda *, error="": {"error": error},
    )
    monkeypatch.setattr(
        admin_pages,
        "render",
        lambda _request, _template, *, ctx, status_code=200: Response(
            content=ctx["error"],
            status_code=status_code,
        ),
    )
    db = _FakeAdminDb(_admin_user())

    response = admin_pages.login_submit(
        request=_request(path="/admin/login"),
        username="operator",
        password="correct-password",
        captcha_id="captcha",
        captcha_code="ABCDE",
        db=db,
    )

    assert response.status_code == 503
    assert db.commit_count == 0
    assert not response.headers.getlist("set-cookie")
    assert admin_pages.ADMIN_LOGIN_SESSION_UNAVAILABLE_MESSAGE in response.body.decode("utf-8")


def test_login_cookie_is_host_only_lax_and_clears_legacy_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(admin_pages.settings, "COOKIE_DOMAIN", ".example.test")
    monkeypatch.setattr(admin_pages.settings, "COOKIE_PATH", "/")
    monkeypatch.setattr(admin_pages.settings, "COOKIE_SECURE", False)
    monkeypatch.setattr(admin_pages.settings, "COOKIE_SAMESITE", "lax")
    response = Response()

    admin_pages._set_admin_login_cookies(
        response,
        _request(host="admin.example.test", scheme="https"),
        _session_token(),
    )

    headers = response.headers.getlist("set-cookie")
    session_header = next(header for header in headers if header.startswith("admin_auth=v1."))
    assert "HttpOnly" in session_header
    assert "Secure" in session_header
    assert "SameSite=lax" in session_header
    assert "Domain=" not in session_header
    assert "Path=/" in session_header
    assert f"Max-Age={ADMIN_SESSION_MAX_AGE_SECONDS}" in session_header
    for legacy_name in ("admin_user_id", "admin_username"):
        legacy_headers = [header for header in headers if header.startswith(f"{legacy_name}=")]
        assert legacy_headers
        assert all("Max-Age=0" in header for header in legacy_headers)


def test_admin_cookie_never_uses_a_cpolar_parent_domain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(admin_pages.settings, "COOKIE_DOMAIN", None)
    monkeypatch.setattr(admin_pages.settings, "COOKIE_PATH", "/")
    response = Response()

    admin_pages._set_admin_login_cookies(
        response,
        _request(host="tenant-a.cpolar.io", scheme="https"),
        _session_token(),
    )

    headers = response.headers.getlist("set-cookie")
    session_header = next(header for header in headers if header.startswith("admin_auth=v1."))
    assert "Secure" in session_header
    assert "SameSite=lax" in session_header
    assert "Domain=" not in session_header
    assert any(
        header.startswith("admin_auth=")
        and "Max-Age=0" in header
        and "Domain=.cpolar.io" in header
        for header in headers
    )


def test_admin_mutations_require_an_exact_same_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(admin_pages.settings, "JWT_SECRET", SECRET_A)
    monkeypatch.setattr(
        admin_pages,
        "admin_get_current_admin_rbac_context",
        lambda *_args: {"is_super_admin": True, "permissions": set()},
    )
    cookie = f"admin_auth={_current_session_token()}"

    same_origin = admin_pages.require_admin_post_permission(
        _request(
            cookie=cookie,
            host="admin.example.test",
            method="POST",
            origin="https://admin.example.test",
            scheme="https",
        ),
        object(),
        "mobile_content.manage",
    )
    cross_origin = admin_pages.require_admin_post_permission(
        _request(
            cookie=cookie,
            host="admin.example.test",
            method="POST",
            origin="https://evil.example",
            scheme="https",
        ),
        object(),
        "mobile_content.manage",
    )
    missing_origin = admin_pages.require_admin_post_permission(
        _request(
            cookie=cookie,
            host="admin.example.test",
            method="POST",
            scheme="https",
        ),
        object(),
        "mobile_content.manage",
    )

    assert same_origin is None
    assert cross_origin is not None and cross_origin.status_code == 403
    assert missing_origin is not None and missing_origin.status_code == 403


def test_logout_expires_signed_and_legacy_cookie_scopes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(admin_pages.settings, "COOKIE_DOMAIN", ".example.test")
    monkeypatch.setattr(admin_pages.settings, "COOKIE_PATH", "/")
    response = admin_pages.logout(_request(host="admin.example.test", scheme="https", path="/admin/logout"))

    assert response.status_code == 302
    assert response.headers["location"] == "/admin/login"
    headers = response.headers.getlist("set-cookie")
    for cookie_name in ("admin_auth", "admin_user_id", "admin_username"):
        matching = [header for header in headers if header.startswith(f"{cookie_name}=")]
        assert matching
        assert all("Max-Age=0" in header for header in matching)
        assert all("HttpOnly" in header for header in matching)
        assert all("Secure" in header for header in matching)
        assert all("SameSite=lax" in header for header in matching)
        assert any("Domain=.example.test" in header for header in matching)
        assert any("Domain=" not in header for header in matching)
