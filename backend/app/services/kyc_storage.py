from __future__ import annotations

import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlsplit

from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.config import BASE_DIR, settings


ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024
KYC_STORAGE_KEY_PREFIX = "kyc:"
LEGACY_KYC_URL_PREFIX = "/static/uploads/kyc/"
_SAFE_FILENAME_RE = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp)$", re.IGNORECASE)
_MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


class KycStorageError(ValueError):
    pass


@dataclass(frozen=True)
class KycStoredFile:
    path: Path
    media_type: str
    extension: str


def get_kyc_storage_dir() -> Path:
    configured = Path(str(settings.KYC_STORAGE_DIR or "").strip()).expanduser()
    if not configured.is_absolute():
        configured = BASE_DIR / configured

    root = configured.resolve(strict=False)
    public_static_root = (BASE_DIR / "static").resolve(strict=False)
    if root == public_static_root or public_static_root in root.parents:
        raise KycStorageError("KYC storage must be outside the public static root")
    return root


def _safe_filename_from_reference(reference: str) -> str:
    raw_value = str(reference or "")
    if any(ord(character) < 32 or ord(character) == 127 for character in raw_value):
        raise KycStorageError("Invalid KYC storage reference")

    value = raw_value.strip()
    if not value or "%" in value:
        raise KycStorageError("Invalid KYC storage reference")

    if value.startswith(KYC_STORAGE_KEY_PREFIX):
        filename = value[len(KYC_STORAGE_KEY_PREFIX) :]
    else:
        parsed = urlsplit(value)
        if parsed.scheme and parsed.scheme.lower() not in {"http", "https"}:
            raise KycStorageError("Invalid KYC storage reference")
        decoded_path = unquote(parsed.path)
        if not decoded_path.startswith(LEGACY_KYC_URL_PREFIX):
            raise KycStorageError("Invalid KYC storage reference")
        filename = decoded_path[len(LEGACY_KYC_URL_PREFIX) :]

    if (
        not filename
        or filename in {".", ".."}
        or "/" in filename
        or "\\" in filename
        or not _SAFE_FILENAME_RE.fullmatch(filename)
    ):
        raise KycStorageError("Invalid KYC storage reference")
    return filename


def build_kyc_storage_key(filename: str) -> str:
    safe_filename = _safe_filename_from_reference(f"{KYC_STORAGE_KEY_PREFIX}{filename}")
    return f"{KYC_STORAGE_KEY_PREFIX}{safe_filename}"


async def save_kyc_upload(file: UploadFile, label: str) -> str:
    content_type = (file.content_type or "").lower()
    extension = ALLOWED_IMAGE_TYPES.get(content_type)
    if not extension:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_IMAGE", "message": f"{label} image type is not supported"},
        )

    content = await file.read(MAX_IMAGE_BYTES + 1)
    await file.close()
    if not content:
        raise HTTPException(
            status_code=400,
            detail={"code": "IMAGE_REQUIRED", "message": f"{label} image is required"},
        )
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=400,
            detail={"code": "IMAGE_TOO_LARGE", "message": f"{label} image is too large"},
        )

    storage_root = get_kyc_storage_dir()
    storage_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(storage_root, 0o700)
    except OSError:
        pass
    filename = f"{uuid.uuid4().hex}{extension}"
    destination = storage_root / filename
    with destination.open("xb") as output:
        output.write(content)
    try:
        os.chmod(destination, 0o600)
    except OSError:
        pass
    return build_kyc_storage_key(filename)


def resolve_kyc_file(reference: str) -> KycStoredFile:
    filename = _safe_filename_from_reference(reference)
    storage_root = get_kyc_storage_dir()
    candidate = storage_root / filename
    if candidate.is_symlink():
        raise KycStorageError("KYC material is unavailable")

    try:
        resolved = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise KycStorageError("KYC material is unavailable") from exc

    if resolved.parent != storage_root or not resolved.is_file():
        raise KycStorageError("KYC material is unavailable")
    extension = resolved.suffix.lower()
    media_type = _MEDIA_TYPES.get(extension)
    if media_type is None:
        raise KycStorageError("KYC material is unavailable")
    return KycStoredFile(path=resolved, media_type=media_type, extension=extension)


def build_kyc_file_response(reference: Optional[str]) -> FileResponse:
    if not reference:
        raise HTTPException(status_code=404, detail="KYC material not found")
    try:
        stored_file = resolve_kyc_file(reference)
    except KycStorageError as exc:
        raise HTTPException(status_code=404, detail="KYC material not found") from exc

    return FileResponse(
        path=stored_file.path,
        media_type=stored_file.media_type,
        headers={
            "Cache-Control": "no-store, private",
            "Content-Disposition": f'inline; filename="kyc-document{stored_file.extension}"',
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    )
