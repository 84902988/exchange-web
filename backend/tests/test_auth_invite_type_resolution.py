from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routers import auth


def test_missing_invite_type_defaults_to_ordinary_invite(monkeypatch) -> None:
    calls: list[str] = []

    def validate_user(_db, code: str):
        calls.append(f"user:{code}")
        return SimpleNamespace(invite_code="U29")

    def validate_bd(_db, code: str):
        calls.append(f"bd:{code}")
        return "BD100000029"

    monkeypatch.setattr(auth, "validate_user_invite_code_for_register", validate_user)
    monkeypatch.setattr(auth, "validate_invite_code_for_register", validate_bd)

    resolved = auth._resolve_register_invite(object(), "u29")

    assert resolved == {"type": "user", "invite_code": "U29"}
    assert calls == ["user:U29"]


def test_bd_invite_requires_explicit_bd_type(monkeypatch) -> None:
    calls: list[str] = []

    def validate_user(_db, code: str):
        calls.append(f"user:{code}")
        return SimpleNamespace(invite_code="U29")

    def validate_bd(_db, code: str):
        calls.append(f"bd:{code}")
        return "BD100000029"

    monkeypatch.setattr(auth, "validate_user_invite_code_for_register", validate_user)
    monkeypatch.setattr(auth, "validate_invite_code_for_register", validate_bd)

    resolved = auth._resolve_register_invite(object(), "bd100000029", "bd")

    assert resolved == {"type": "bd", "invite_code": "BD100000029"}
    assert calls == ["bd:BD100000029"]


def test_unknown_explicit_invite_type_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(
        auth,
        "validate_user_invite_code_for_register",
        lambda *_args: pytest.fail("ordinary validator must not run"),
    )
    monkeypatch.setattr(
        auth,
        "validate_invite_code_for_register",
        lambda *_args: pytest.fail("BD validator must not run"),
    )

    with pytest.raises(HTTPException) as invalid:
        auth._resolve_register_invite(object(), "BD100000029", "agent")

    assert invalid.value.status_code == 400
    assert invalid.value.detail["code"] == "INVITE_TYPE_INVALID"
