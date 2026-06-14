from __future__ import annotations

from typing import Optional
from fastapi import Request


def get_client_ip(request: Request) -> Optional[str]:
    # 如果后面上了 Nginx / Cloudflare，会带 X-Forwarded-For
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    if request.client:
        return request.client.host
    return None


def get_user_agent(request: Request) -> Optional[str]:
    ua = request.headers.get("user-agent")
    return ua.strip() if ua else None


def get_geo_country_code(request: Request, header_name: str = "CF-IPCountry") -> str:
    code = request.headers.get(header_name)
    normalized = (code or "").strip().upper()
    return normalized or "UNKNOWN"
