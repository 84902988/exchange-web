from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse

from app.core.config import settings
from app.db.session import SessionLocal
from app.services.geo_access_service import (
    DECISION_ALLOW,
    REASON_DISABLED,
    SOURCE_UNKNOWN,
    env_default_config,
    evaluate_geo_access,
    list_enabled_geo_ip_rules,
    load_geo_access_config,
    resolve_country_code,
    safe_commit_geo_access_log,
)


logger = logging.getLogger(__name__)

REGION_RESTRICTED_CODE = "REGION_RESTRICTED"
REGION_RESTRICTED_MESSAGE = (
    "Due to regional restrictions, this service is currently unavailable in your location."
)
REGION_RESTRICTED_PATH = "/region-restricted"

PASSTHROUGH_PATHS = {
    REGION_RESTRICTED_PATH,
    "/geo-access/check",
    "/favicon.ico",
    "/robots.txt",
    "/openapi.json",
}

PASSTHROUGH_PREFIXES = (
    "/static/",
    "/health",
    "/docs",
    "/redoc",
)

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
)


def get_request_ip(request: Request) -> str:
    for header_name in ("CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"):
        value = request.headers.get(header_name)
        if not value:
            continue
        if header_name == "X-Forwarded-For":
            value = value.split(",", 1)[0]
        normalized = value.strip()
        if normalized:
            return normalized
    if request.client:
        return request.client.host or ""
    return ""


def _is_passthrough_path(path: str) -> bool:
    if path in PASSTHROUGH_PATHS:
        return True
    return any(path.startswith(prefix) for prefix in PASSTHROUGH_PREFIXES)


def _looks_like_api_request(request: Request) -> bool:
    path = request.url.path
    if path.startswith(API_PREFIXES):
        return True

    accept = request.headers.get("accept", "")
    if "text/html" in accept.lower():
        return False
    return True


def _restricted_html() -> str:
    return """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>当前地区暂不提供服务</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0f;color:#f8fafc;font-family:Arial,"Microsoft YaHei",sans-serif}
    main{width:min(720px,calc(100% - 32px));text-align:center}
    .mark{display:inline-grid;place-items:center;width:56px;height:56px;border-radius:12px;border:1px solid rgba(245,158,11,.28);background:rgba(245,158,11,.10);color:#fbbf24;font-size:28px;font-weight:800}
    h1{margin:24px 0 12px;font-size:32px;line-height:1.2}
    p{margin:0;color:rgba(255,255,255,.68);font-size:16px;line-height:1.8}
  </style>
</head>
<body>
  <main>
    <div class="mark">!</div>
    <h1>当前地区暂不提供服务</h1>
    <p>Due to regional restrictions, this service is currently unavailable in your location.</p>
  </main>
</body>
</html>"""


class GeoRestrictionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if _is_passthrough_path(path):
            return await call_next(request)

        ip_address = get_request_ip(request)
        user_agent = (request.headers.get("user-agent") or "").strip()
        method = request.method.upper()

        db = SessionLocal()
        try:
            try:
                config = load_geo_access_config(db)
                rules = list_enabled_geo_ip_rules(db)
                db.commit()
            except SQLAlchemyError:
                db.rollback()
                logger.warning("Geo access settings unavailable; using env defaults", exc_info=True)
                config = env_default_config()
                rules = []

            if config.enabled:
                country = resolve_country_code(
                    headers=request.headers,
                    ip_address=ip_address,
                    geoip_db_path=str(getattr(settings, "GEOIP_DB_PATH", "") or ""),
                    trust_cf_header=bool(getattr(settings, "GEO_ACCESS_TRUST_CF_HEADER", True)),
                )
            else:
                country = resolve_country_code(
                    headers={},
                    ip_address=ip_address,
                    geoip_db_path="",
                    trust_cf_header=False,
                )

            decision = evaluate_geo_access(
                config=config,
                rules=rules,
                ip_address=ip_address,
                country_code=country.country_code,
                path=path,
            )

            safe_commit_geo_access_log(
                db,
                ip_address=ip_address,
                country_code=country.country_code,
                source=country.source,
                path=path,
                method=method,
                user_agent=user_agent,
                decision=decision.decision,
                reason=decision.reason,
            )
        finally:
            db.close()

        if not decision.should_block:
            return await call_next(request)

        if _looks_like_api_request(request):
            return JSONResponse(
                status_code=403,
                content={
                    "code": REGION_RESTRICTED_CODE,
                    "message": REGION_RESTRICTED_MESSAGE,
                },
            )

        return HTMLResponse(content=_restricted_html(), status_code=403)


def disabled_geo_access_decision() -> tuple[str, str, str]:
    return DECISION_ALLOW, REASON_DISABLED, SOURCE_UNKNOWN
