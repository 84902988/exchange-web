from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.content_locale import resolve_content_locale
from app.db.session import get_db
from app.deps.auth import get_optional_current_user_id
from app.schemas.response import ok
from app.services.help_content_service import get_public_help_content
from app.services.site_content_service import (
    get_public_about_page,
    get_public_announcement,
    get_public_announcements,
    get_public_legal_page,
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


@router.get("/help/content")
def help_content(
    request: Request,
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data=get_public_help_content(db, locale=locale), trace_id=trace_id)


@router.get("/site/pages/about")
def about_page(
    request: Request,
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data=get_public_about_page(db, locale=locale), trace_id=trace_id)


@router.get("/site/pages/legal/{page_key}")
def legal_page(
    page_key: str,
    request: Request,
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    try:
        page = get_public_legal_page(db, page_key, locale=locale)
    except ValueError:
        raise HTTPException(
            status_code=404,
            detail={"code": "LEGAL_PAGE_NOT_FOUND", "message": "Legal page not found"},
        )
    return ok(data=page, trace_id=trace_id)


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
    user_id = get_optional_current_user_id(request)
    return ok(
        data=get_public_announcements(db, page=page, page_size=page_size, category=type, locale=locale, user_id=user_id),
        trace_id=trace_id,
    )


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
