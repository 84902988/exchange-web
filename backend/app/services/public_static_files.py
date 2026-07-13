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
        return await super().get_response(path, scope)
