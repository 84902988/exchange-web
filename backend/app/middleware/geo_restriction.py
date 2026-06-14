from __future__ import annotations

from typing import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse

from app.core.config import settings


REGION_RESTRICTED_CODE = "REGION_RESTRICTED"
REGION_RESTRICTED_MESSAGE = "Service is not available in your region."
REGION_RESTRICTED_PATH = "/region-restricted"

PASSTHROUGH_PATHS = {
    REGION_RESTRICTED_PATH,
    "/favicon.ico",
    "/robots.txt",
}

API_PREFIXES = (
    "/api",
    "/auth",
    "/me",
    "/user",
    "/user-transfer",
    "/asset",
    "/account",
    "/order",
    "/match",
    "/market",
    "/contract",
    "/spot",
    "/bd",
    "/vip",
    "/dividend",
    "/stock-token",
    "/announcements",
    "/site",
    "/home",
    "/activities",
    "/kyc",
    "/webhooks",
    "/withdraw",
    "/health",
    "/openapi.json",
)


def _restricted_country_set(raw: str) -> set[str]:
    return {item.strip().upper() for item in str(raw or "").split(",") if item.strip()}


def _is_restricted_country(country_code: str | None, restricted_countries: Iterable[str]) -> bool:
    normalized = str(country_code or "").strip().upper()
    return bool(normalized) and normalized in set(restricted_countries)


def _looks_like_api_request(request: Request) -> bool:
    path = request.url.path
    if path.startswith(API_PREFIXES):
        return True

    accept = request.headers.get("accept", "")
    if "text/html" in accept.lower():
        return False
    return True


class GeoRestrictionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not bool(getattr(settings, "GEO_RESTRICTION_ENABLED", False)):
            return await call_next(request)

        path = request.url.path
        if path in PASSTHROUGH_PATHS:
            return await call_next(request)

        header_name = str(getattr(settings, "GEO_RESTRICTION_HEADER", "CF-IPCountry") or "CF-IPCountry")
        country_code = request.headers.get(header_name)
        restricted_countries = _restricted_country_set(
            str(getattr(settings, "GEO_RESTRICTED_COUNTRIES", "CN") or "CN")
        )
        if not _is_restricted_country(country_code, restricted_countries):
            return await call_next(request)

        if _looks_like_api_request(request):
            return JSONResponse(
                status_code=403,
                content={
                    "code": REGION_RESTRICTED_CODE,
                    "message": REGION_RESTRICTED_MESSAGE,
                },
            )

        return RedirectResponse(url=REGION_RESTRICTED_PATH, status_code=302)
