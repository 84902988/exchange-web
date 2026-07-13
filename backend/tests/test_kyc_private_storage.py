from __future__ import annotations

import asyncio
import os
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

import pytest
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import Response
from starlette.datastructures import Headers

from app.core.config import settings
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.routers import kyc as kyc_router
from app.services import kyc_storage
from app.services.public_static_files import KycIsolatedStaticFiles


TEST_FILENAME = f"{'a' * 32}.jpg"
TEST_BYTES = b"synthetic-kyc-test-material"


class _FakeQuery:
    def __init__(self, item):
        self.item = item

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self.item


class _FakeDb:
    def __init__(self, item):
        self.item = item

    def query(self, _model):
        return _FakeQuery(self.item)


def _submission(*, user_id: int = 7, reference: str | None = None):
    return SimpleNamespace(
        id=11,
        user_id=user_id,
        front_image_url=reference or f"kyc:{TEST_FILENAME}",
        back_image_url=None,
        selfie_image_url=None,
        kyc_level="PRIMARY",
        full_name="Test User",
        country_code="US",
        id_type="PASSPORT",
        id_number="test-only",
        review_status="PENDING",
        review_note=None,
        reviewed_by=None,
        reviewed_at=None,
        created_at=None,
        updated_at=None,
    )


def _app_with_submission(item, user_dependency=lambda: "7") -> FastAPI:
    app = FastAPI()
    app.include_router(kyc_router.router)
    app.dependency_overrides[get_db] = lambda: _FakeDb(item)
    app.dependency_overrides[get_current_user_id] = user_dependency
    return app


async def _asgi_get(app: FastAPI, url: str):
    parsed = urlsplit(url)
    messages = []
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": unquote(parsed.path),
        "raw_path": parsed.path.encode("ascii", "ignore"),
        "query_string": parsed.query.encode("ascii"),
        "headers": [],
        "client": ("testclient", 1234),
        "server": ("testserver", 80),
        "root_path": "",
    }
    await app(scope, receive, send)

    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    headers = {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in start.get("headers", [])
    }
    return SimpleNamespace(
        status_code=start["status"],
        headers=headers,
        content=body,
        text=body.decode("utf-8", "replace"),
    )


def _get(app: FastAPI, url: str):
    return asyncio.run(_asgi_get(app, url))


def _synthetic_upload(content: bytes, content_type: str, filename: str = "test.jpg") -> UploadFile:
    return UploadFile(
        file=BytesIO(content),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


def _prepare_private_file(monkeypatch, tmp_path: Path) -> Path:
    storage_root = tmp_path / "private" / "kyc"
    storage_root.mkdir(parents=True)
    (storage_root / TEST_FILENAME).write_bytes(TEST_BYTES)
    monkeypatch.setattr(settings, "KYC_STORAGE_DIR", str(storage_root))
    return storage_root


def test_new_upload_uses_private_storage_key_and_not_public_static(monkeypatch, tmp_path):
    storage_root = tmp_path / "private" / "kyc"
    monkeypatch.setattr(settings, "KYC_STORAGE_DIR", str(storage_root))

    storage_key = asyncio.run(
        kyc_storage.save_kyc_upload(
            _synthetic_upload(TEST_BYTES, "image/jpeg"),
            "front",
        )
    )

    assert storage_key.startswith("kyc:")
    stored = kyc_storage.resolve_kyc_file(storage_key)
    assert stored.path.parent == storage_root.resolve()
    assert "static" not in stored.path.parts


def test_anonymous_user_material_access_returns_401(monkeypatch, tmp_path):
    _prepare_private_file(monkeypatch, tmp_path)

    def anonymous():
        raise HTTPException(status_code=401, detail="Not authenticated")

    response = _get(
        _app_with_submission(_submission(), anonymous),
        "/me/kyc/submissions/11/materials/front",
    )
    assert response.status_code == 401


def test_owner_can_read_material_with_safe_headers(monkeypatch, tmp_path, caplog):
    storage_root = _prepare_private_file(monkeypatch, tmp_path)
    response = _get(
        _app_with_submission(_submission()),
        "/me/kyc/submissions/11/materials/front",
    )

    assert response.status_code == 200
    assert response.content == TEST_BYTES
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.headers["content-disposition"] == 'inline; filename="kyc-document.jpg"'
    assert response.headers["cache-control"] == "no-store, private"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert str(storage_root) not in repr(response.headers)
    assert str(storage_root) not in caplog.text


def test_other_user_cannot_read_material(monkeypatch, tmp_path):
    _prepare_private_file(monkeypatch, tmp_path)
    response = _get(
        _app_with_submission(_submission(), lambda: "8"),
        "/me/kyc/submissions/11/materials/front",
    )
    assert response.status_code == 404


def test_authorized_admin_can_read_material(monkeypatch, tmp_path):
    _prepare_private_file(monkeypatch, tmp_path)
    monkeypatch.setattr(kyc_router, "_admin_required", lambda _request, _db: None)
    response = _get(
        _app_with_submission(_submission()),
        "/admin/kyc/11/materials/front",
    )
    assert response.status_code == 200
    assert response.content == TEST_BYTES


def test_admin_without_kyc_permission_is_rejected(monkeypatch, tmp_path):
    _prepare_private_file(monkeypatch, tmp_path)
    monkeypatch.setattr(
        kyc_router,
        "_admin_required",
        lambda _request, _db: Response(status_code=403),
    )
    response = _get(
        _app_with_submission(_submission()),
        "/admin/kyc/11/materials/front",
    )
    assert response.status_code == 403


def test_unknown_submission_and_material_return_safe_404(monkeypatch, tmp_path):
    _prepare_private_file(monkeypatch, tmp_path)
    missing_submission = _get(
        _app_with_submission(None),
        "/me/kyc/submissions/999/materials/front",
    )
    invalid_material = _get(
        _app_with_submission(_submission()),
        "/me/kyc/submissions/11/materials/not-a-material",
    )

    assert missing_submission.status_code == 404
    assert invalid_material.status_code == 404
    assert "private" not in missing_submission.text.lower()


@pytest.mark.parametrize(
    "reference",
    [
        "kyc:../secret.jpg",
        "kyc:C:\\secret.jpg",
        "/absolute/path.jpg",
        "/static/uploads/kyc/../secret.jpg",
        "/static/uploads/kyc/%2e%2e%2fsecret.jpg",
        "kyc:%2e%2e%2fsecret.jpg",
        "kyc:%252e%252e%252fsecret.jpg",
        f"kyc:{TEST_FILENAME}\x00.jpg",
        f"\nkyc:{TEST_FILENAME}",
        f"kyc:{TEST_FILENAME}.exe",
    ],
)
def test_storage_reference_traversal_is_rejected(reference):
    with pytest.raises(kyc_storage.KycStorageError):
        kyc_storage.resolve_kyc_file(reference)


@pytest.mark.parametrize("encoded_material", ["%2e%2e", "%2fetc%2fpasswd", "C:%5csecret"])
def test_route_traversal_inputs_are_rejected(monkeypatch, tmp_path, encoded_material):
    _prepare_private_file(monkeypatch, tmp_path)
    response = _get(
        _app_with_submission(_submission()),
        f"/me/kyc/submissions/11/materials/{encoded_material}",
    )
    assert response.status_code in {404, 422}


def test_legacy_public_url_reference_reads_only_from_private_storage(monkeypatch, tmp_path):
    _prepare_private_file(monkeypatch, tmp_path)
    legacy_reference = f"/static/uploads/kyc/{TEST_FILENAME}"
    item = _submission(reference=legacy_reference)

    response = _get(
        _app_with_submission(item),
        "/me/kyc/submissions/11/materials/front",
    )

    serialized = kyc_router._serialize_submission(item)
    admin_serialized = kyc_router._serialize_admin_submission(item)
    assert response.status_code == 200
    assert response.content == TEST_BYTES
    assert serialized is not None
    assert serialized["front_image_url"].startswith("/me/kyc/submissions/")
    assert "/static/uploads/kyc/" not in repr(serialized)
    assert admin_serialized["front_image_read_url"].startswith("/admin/kyc/")
    assert "/static/uploads/kyc/" not in repr(admin_serialized)


def test_legacy_public_static_subtree_is_always_404(tmp_path):
    public_root = tmp_path / "static"
    legacy_root = public_root / "uploads" / "kyc"
    legacy_root.mkdir(parents=True)
    (legacy_root / TEST_FILENAME).write_bytes(TEST_BYTES)
    (public_root / "public.txt").write_text("public", encoding="utf-8")

    app = FastAPI()
    app.mount("/static", KycIsolatedStaticFiles(directory=str(public_root)), name="static")
    denied = _get(app, f"/static/uploads/kyc/{TEST_FILENAME}")
    denied_case_variant = _get(app, f"/static/uploads/KYC/{TEST_FILENAME}")
    denied_root = _get(app, "/static/uploads/kyc")
    denied_trailing_slash = _get(app, "/static/uploads/kyc/")
    denied_encoded = _get(app, f"/static/uploads%2fkyc/{TEST_FILENAME}")
    denied_double_encoded = _get(app, f"/static/uploads%252fkyc/{TEST_FILENAME}")
    denied_normalized = _get(app, f"/static/uploads/other/../kyc/{TEST_FILENAME}")
    public = _get(app, "/static/public.txt")

    assert denied.status_code == 404
    assert denied_case_variant.status_code == 404
    assert denied_root.status_code == 404
    assert denied_trailing_slash.status_code == 404
    assert denied_encoded.status_code == 404
    assert denied_double_encoded.status_code == 404
    assert denied_normalized.status_code == 404
    assert public.status_code == 200


def test_upload_type_and_five_megabyte_limit_are_preserved(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "KYC_STORAGE_DIR", str(tmp_path / "private" / "kyc"))

    with pytest.raises(HTTPException) as invalid_type:
        asyncio.run(kyc_storage.save_kyc_upload(
            _synthetic_upload(TEST_BYTES, "text/plain", "test.txt"),
            "front",
        ))
    assert invalid_type.value.status_code == 400
    assert invalid_type.value.detail["code"] == "INVALID_IMAGE"

    with pytest.raises(HTTPException) as too_large:
        asyncio.run(kyc_storage.save_kyc_upload(
            _synthetic_upload(b"x" * (kyc_storage.MAX_IMAGE_BYTES + 1), "image/jpeg"),
            "front",
        ))
    assert too_large.value.status_code == 400
    assert too_large.value.detail["code"] == "IMAGE_TOO_LARGE"


def test_public_static_storage_configuration_is_rejected(monkeypatch):
    monkeypatch.setattr(
        settings,
        "KYC_STORAGE_DIR",
        str(kyc_storage.BASE_DIR / "static" / "uploads" / "kyc"),
    )
    with pytest.raises(kyc_storage.KycStorageError):
        kyc_storage.get_kyc_storage_dir()


def test_relative_and_absolute_storage_configuration_are_stable(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "KYC_STORAGE_DIR", "private/kyc")
    assert kyc_storage.get_kyc_storage_dir() == (kyc_storage.BASE_DIR / "private" / "kyc").resolve()

    absolute_root = (tmp_path / "external-kyc").resolve()
    monkeypatch.setattr(settings, "KYC_STORAGE_DIR", str(absolute_root))
    assert kyc_storage.get_kyc_storage_dir() == absolute_root


def test_upload_requests_private_directory_permissions(monkeypatch, tmp_path):
    storage_root = tmp_path / "private" / "kyc"
    monkeypatch.setattr(settings, "KYC_STORAGE_DIR", str(storage_root))
    chmod_calls = []
    real_chmod = os.chmod

    def record_chmod(path, mode):
        chmod_calls.append((Path(path), mode))
        real_chmod(path, mode)

    monkeypatch.setattr(kyc_storage.os, "chmod", record_chmod)
    asyncio.run(
        kyc_storage.save_kyc_upload(
            _synthetic_upload(TEST_BYTES, "image/jpeg"),
            "front",
        )
    )

    assert (storage_root, 0o700) in chmod_calls
    assert any(mode == 0o600 and path.parent == storage_root for path, mode in chmod_calls)


def test_admin_kyc_permission_matches_existing_rbac_scope(monkeypatch):
    from app.routers import admin_pages

    observed = {}
    request = SimpleNamespace()
    db = object()
    monkeypatch.setattr(admin_pages, "require_admin", lambda _request: None)

    def require_permission(_request, _db, permission_code):
        observed["permission_code"] = permission_code
        return Response(status_code=403)

    monkeypatch.setattr(admin_pages, "require_admin_permission", require_permission)
    response = kyc_router._admin_required(request, db)

    assert response.status_code == 403
    assert observed["permission_code"] == "users.view"


def test_symlinked_material_is_rejected(monkeypatch, tmp_path):
    _prepare_private_file(monkeypatch, tmp_path)
    original_is_symlink = Path.is_symlink

    def report_material_as_symlink(path: Path):
        if path.name == TEST_FILENAME:
            return True
        return original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", report_material_as_symlink)
    with pytest.raises(kyc_storage.KycStorageError):
        kyc_storage.resolve_kyc_file(f"kyc:{TEST_FILENAME}")
