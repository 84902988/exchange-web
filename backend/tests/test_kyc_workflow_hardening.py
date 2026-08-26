from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.db.models import KycSubmission, User
from app.routers import kyc as kyc_router


class _FakeQuery:
    def __init__(self, db: "_FakeDb", model):
        self.db = db
        self.model = model

    def filter(self, *_args, **_kwargs):
        return self

    def with_for_update(self):
        self.db.locked_models.append(self.model)
        return self

    def order_by(self, *_args, **_kwargs):
        return self

    def first(self):
        if self.model is User:
            return self.db.user
        if self.model is KycSubmission:
            return self.db.submission_results.pop(0) if self.db.submission_results else None
        return None


class _FakeDb:
    def __init__(self, *, commit_error: Exception | None = None):
        self.user = SimpleNamespace(
            id=7,
            profile=SimpleNamespace(kyc_status="NONE", kyc_level=0, updated_at=None),
            kyc_status="NONE",
            kyc_level=0,
        )
        self.submission_results = [None, None]
        self.commit_error = commit_error
        self.locked_models = []
        self.added = []
        self.commits = 0
        self.rollbacks = 0
        self.flushes = 0

    def query(self, model):
        return _FakeQuery(self, model)

    def add(self, item):
        self.added.append(item)

    def flush(self):
        self.flushes += 1

    def commit(self):
        self.commits += 1
        if self.commit_error is not None:
            raise self.commit_error

    def rollback(self):
        self.rollbacks += 1

    def refresh(self, _item):
        return None


def _request():
    return SimpleNamespace(state=SimpleNamespace(trace_id="test-trace"))


def _upload(filename: str):
    return SimpleNamespace(filename=filename)


def test_profile_creation_flushes_without_committing_the_outer_transaction() -> None:
    db = _FakeDb()
    user = SimpleNamespace(id=7, profile=None)

    profile = kyc_router._ensure_profile(db, user)

    assert profile.user_id == 7
    assert db.flushes == 1
    assert db.commits == 0


def test_submission_rejects_invalid_identity_fields_before_upload(monkeypatch) -> None:
    db = _FakeDb()
    upload_called = False

    async def save_upload(*_args, **_kwargs):
        nonlocal upload_called
        upload_called = True
        return "kyc:unused.jpg"

    monkeypatch.setattr(kyc_router, "save_kyc_upload", save_upload)

    with pytest.raises(HTTPException) as invalid_fields:
        asyncio.run(kyc_router.submit_my_kyc(
            request=_request(),
            kyc_level="PRIMARY",
            full_name="Test User",
            country_code="CHN",
            id_type="PASSPORT",
            id_number="P1234567",
            front_image=_upload("front.jpg"),
            back_image=None,
            selfie_image=_upload("selfie.jpg"),
            user_id="7",
            db=db,
        ))

    assert invalid_fields.value.detail["code"] == "VALIDATION_ERROR"
    assert upload_called is False
    assert User in db.locked_models


def test_submission_commit_failure_rolls_back_and_removes_every_saved_file(monkeypatch) -> None:
    db = _FakeDb(commit_error=RuntimeError("database unavailable"))
    saved = []
    removed = []

    async def save_upload(_file, label):
        reference = f"kyc:{label}.jpg"
        saved.append(reference)
        return reference

    monkeypatch.setattr(kyc_router, "save_kyc_upload", save_upload)
    monkeypatch.setattr(kyc_router, "remove_kyc_upload", lambda reference: removed.append(reference) or True)

    with pytest.raises(RuntimeError, match="database unavailable"):
        asyncio.run(kyc_router.submit_my_kyc(
            request=_request(),
            kyc_level="PRIMARY",
            full_name="Test User",
            country_code="US",
            id_type="ID_CARD",
            id_number="ID-123456",
            front_image=_upload("front.jpg"),
            back_image=_upload("back.jpg"),
            selfie_image=_upload("selfie.jpg"),
            user_id="7",
            db=db,
        ))

    assert saved == ["kyc:front.jpg", "kyc:back.jpg", "kyc:selfie.jpg"]
    assert removed == saved
    assert db.commits == 1
    assert db.rollbacks == 1
    assert User in db.locked_models
