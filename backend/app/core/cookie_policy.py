from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import Request, Response

from app.core.config import settings


def _extract_hostname(value: str) -> str:
    raw = (value or "").split(",", 1)[0].strip()
    if not raw:
        return ""
    if "://" in raw:
        parsed = urlparse(raw)
    else:
        parsed = urlparse(f"//{raw}")
    return (parsed.hostname or raw.split(":", 1)[0]).strip().lower()


def _request_hostname(request: Request) -> str:
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",", 1)[0].strip()
    host = forwarded_host or request.headers.get("host") or request.url.hostname or ""
    return _extract_hostname(host)


def _request_cookie_scope_hostname(request: Request) -> str:
    for value in (
        request.headers.get("x-forwarded-host"),
        request.headers.get("host"),
        request.headers.get("origin"),
        request.headers.get("referer"),
        request.url.hostname or "",
    ):
        hostname = _extract_hostname(value or "")
        if hostname:
            return hostname
    return _request_hostname(request)


def _is_localhost(hostname: str) -> bool:
    return hostname in {"localhost", "127.0.0.1", "::1"} or hostname.endswith(".localhost")


def _cpolar_cookie_domain(hostname: str) -> Optional[str]:
    if hostname.endswith(".cpolar.io"):
        return ".cpolar.io"
    if hostname.endswith(".zaf.cpolar.io"):
        return ".zaf.cpolar.io"
    if hostname.endswith(".cpolar.top"):
        return ".cpolar.top"
    if hostname.endswith(".cpolar.cn"):
        return ".cpolar.cn"
    return None


def _is_cpolar_hostname(hostname: str) -> bool:
    return hostname.endswith((".cpolar.io", ".cpolar.top", ".cpolar.cn"))


def _domain_matches_hostname(hostname: str, domain: str) -> bool:
    normalized_domain = domain.strip().lstrip(".").lower()
    return bool(normalized_domain) and (
        hostname == normalized_domain or hostname.endswith(f".{normalized_domain}")
    )


def _configured_cookie_domain() -> Optional[str]:
    domain = getattr(settings, "COOKIE_DOMAIN", None)
    if domain is None:
        return None
    domain = str(domain).strip()
    return domain or None


def _cookie_options(request: Request) -> dict[str, Any]:
    hostname = _request_cookie_scope_hostname(request)
    if _is_localhost(hostname):
        return {
            "domain": None,
            "secure": False,
            "samesite": "lax",
        }

    cpolar_domain = _cpolar_cookie_domain(hostname)
    if cpolar_domain:
        return {
            "domain": cpolar_domain,
            "secure": True,
            "samesite": "none",
        }

    configured_domain = _configured_cookie_domain()
    if configured_domain and _domain_matches_hostname(hostname, configured_domain):
        return {
            "domain": configured_domain,
            "secure": True,
            "samesite": "none",
        }

    if _is_cpolar_hostname(hostname):
        return {
            "domain": None,
            "secure": True,
            "samesite": "none",
        }

    return {
        "domain": None,
        "secure": getattr(settings, "COOKIE_SECURE", False),
        "samesite": getattr(settings, "COOKIE_SAMESITE", "lax"),
    }


def set_refresh_cookie(response: Response, request: Request, token: str, *, remember_me: bool = False) -> None:
    options = _cookie_options(request)
    cookie_args: dict[str, Any] = {}
    if remember_me:
        cookie_args["max_age"] = getattr(settings, "REFRESH_TOKEN_MAX_AGE", 60 * 60 * 24 * 30)

    response.set_cookie(
        key=getattr(settings, "REFRESH_TOKEN_COOKIE_NAME", "refresh_token"),
        value=token,
        httponly=True,
        secure=options["secure"],
        samesite=options["samesite"],
        path=getattr(settings, "COOKIE_PATH", "/"),
        domain=options["domain"],
        **cookie_args,
    )


def set_access_cookie(response: Response, request: Request, token: str) -> None:
    options = _cookie_options(request)
    response.set_cookie(
        key=getattr(settings, "ACCESS_TOKEN_COOKIE_NAME", "access_token"),
        value=token,
        httponly=True,
        secure=options["secure"],
        samesite=options["samesite"],
        max_age=getattr(settings, "ACCESS_TOKEN_MAX_AGE", 60 * 15),
        path=getattr(settings, "COOKIE_PATH", "/"),
        domain=options["domain"],
    )


def clear_auth_cookies(response: Response, request: Request) -> None:
    options = _cookie_options(request)
    cookie_path = getattr(settings, "COOKIE_PATH", "/")
    response.delete_cookie(
        key=getattr(settings, "ACCESS_TOKEN_COOKIE_NAME", "access_token"),
        path=cookie_path,
        domain=options["domain"],
        secure=options["secure"],
        httponly=True,
        samesite=options["samesite"],
    )
    response.delete_cookie(
        key=getattr(settings, "REFRESH_TOKEN_COOKIE_NAME", "refresh_token"),
        path=cookie_path,
        domain=options["domain"],
        secure=options["secure"],
        httponly=True,
        samesite=options["samesite"],
    )
