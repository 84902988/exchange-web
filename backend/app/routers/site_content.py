from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.content_locale import resolve_content_locale
from app.db.session import get_db
from app.schemas.response import ok
from app.services.site_content_service import (
    get_public_announcement,
    get_public_announcements,
    get_latest_announcements,
    get_public_home_banners,
    get_public_site_config,
)


router = APIRouter(tags=["site-content"])


@router.get("/site/config")
def site_config(
    request: Request,
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data=get_public_site_config(db, locale=locale), trace_id=trace_id)


@router.get("/home/banners")
def home_banners(
    request: Request,
    limit: int = Query(6, ge=1, le=20),
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data={"items": get_public_home_banners(db, limit=limit, locale=locale)}, trace_id=trace_id)


@router.get("/announcements/latest")
def announcements_latest(
    request: Request,
    limit: int = Query(3, ge=1, le=10),
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data={"items": get_latest_announcements(db, limit=limit, locale=locale)}, trace_id=trace_id)


@router.get("/announcements")
def announcements(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    type: str = Query("latest"),
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data=get_public_announcements(db, page=page, page_size=page_size, category=type, locale=locale), trace_id=trace_id)


@router.get("/announcements/{identifier}")
def announcement_detail(
    identifier: str,
    request: Request,
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    item = get_public_announcement(db, identifier, locale=locale)
    if item is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "ANNOUNCEMENT_NOT_FOUND", "message": "Announcement not found"},
        )
    return ok(data={"item": item}, trace_id=trace_id)
