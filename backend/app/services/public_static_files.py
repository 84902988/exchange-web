from __future__ import annotations

import posixpath
from urllib.parse import unquote

from starlette.responses import Response
from starlette.staticfiles import StaticFiles


class KycIsolatedStaticFiles(StaticFiles):
    """Serve public assets while permanently denying the legacy KYC subtree."""

    async def get_response(self, path: str, scope) -> Response:
        decoded = unquote(str(path or "")).replace("\\", "/")
        normalized = posixpath.normpath(f"/{decoded}").lstrip("/")
        normalized_casefold = normalized.casefold()
        if normalized_casefold == "uploads/kyc" or normalized_casefold.startswith("uploads/kyc/"):
            return Response(status_code=404)
        response = await super().get_response(path, scope)
        # Minimal Linux hosts may lack these entries in the system MIME database.
        # Keep public CMS images usable without relying on content sniffing.
        image_type = {
            ".webp": "image/webp",
            ".avif": "image/avif",
        }.get(posixpath.splitext(normalized_casefold)[1])
        if image_type and response.status_code in {200, 206}:
            response.headers["content-type"] = image_type
        return response
