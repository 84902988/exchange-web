from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.content_locale import normalize_content_locale, resolve_content_locale
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.response import ok
from app.services.mobile_announcement_read_service import (
    MOBILE_ANNOUNCEMENT_READ_STATE_LIMIT,
    get_mobile_announcement_read_state,
    get_mobile_announcement_unread_count,
    mark_all_mobile_announcements_read,
    mark_mobile_announcement_read,
)
from app.services.mobile_content_service import (
    get_cached_mobile_content_bootstrap,
    get_public_mobile_announcement_page,
    get_public_mobile_announcement_detail,
)
from app.services.support_ticket_service import get_unread_support_reply_count


router = APIRouter(prefix="/mobile/content", tags=["mobile-content"])


@router.get("/bootstrap")
def mobile_content_bootstrap(
    request: Request,
    response: Response,
    lang: Optional[str] = Query(None),
    locale: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    requested_locale = locale or lang
    resolved_locale = resolve_content_locale(requested_locale, request.headers.get("accept-language"))
    payload = get_cached_mobile_content_bootstrap(db, locale=resolved_locale)
    response_locale = (
        requested_locale
        if (
            requested_locale
            and len(requested_locale) <= 35
            and normalize_content_locale(requested_locale) == resolved_locale
        )
        else resolved_locale
    )
    payload["locale"] = response_locale
    etag = f'"{payload["revision"]}"'
    cache_headers = {
        "Cache-Control": "public, max-age=30, stale-if-error=60",
        "ETag": etag,
        "Vary": "Accept-Language",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)
    response.headers.update(cache_headers)
    return ok(
        data=payload,
        trace_id=getattr(request.state, "trace_id", None),
    )


@router.get("/announcements/{announcement_id}")
def mobile_announcement_detail(
    announcement_id: int,
    request: Request,
    lang: Optional[str] = Query(None),
    locale: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    resolved_locale = resolve_content_locale(locale or lang, request.headers.get("accept-language"))
    item = get_public_mobile_announcement_detail(db, announcement_id, locale=resolved_locale)
    if item is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "MOBILE_ANNOUNCEMENT_NOT_FOUND", "message": "Mobile announcement not found"},
        )
    return ok(data=item, trace_id=getattr(request.state, "trace_id", None))


@router.get("/announcements")
def mobile_announcement_list(
    request: Request,
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
    lang: Optional[str] = Query(None),
    locale: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    resolved_locale = resolve_content_locale(locale or lang, request.headers.get("accept-language"))
    response.headers.update(
        {
            "Cache-Control": "public, max-age=30, stale-if-error=60",
            "Vary": "Accept-Language",
        }
    )
    return ok(
        data=get_public_mobile_announcement_page(
            db,
            page=page,
            page_size=page_size,
            locale=resolved_locale,
        ),
        trace_id=getattr(request.state, "trace_id", None),
    )


@router.get("/announcement-reads")
def mobile_announcement_read_state(
    request: Request,
    response: Response,
    announcement_id: List[int] = Query(default=[]),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    if len(announcement_id) > MOBILE_ANNOUNCEMENT_READ_STATE_LIMIT:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "MOBILE_ANNOUNCEMENT_READ_STATE_LIMIT",
                "message": "Too many mobile announcement ids",
            },
        )
    return ok(
        data=get_mobile_announcement_read_state(db, int(user_id), announcement_id),
        trace_id=getattr(request.state, "trace_id", None),
    )


@router.post("/announcement-reads/read-all")
def read_all_mobile_announcements(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    marked = mark_all_mobile_announcements_read(db, int(user_id))
    return ok(
        data={
            "marked": marked,
            "unread_count": get_mobile_announcement_unread_count(db, int(user_id)),
        },
        trace_id=getattr(request.state, "trace_id", None),
    )


@router.post("/announcement-reads/{announcement_id}")
def read_mobile_announcement(
    announcement_id: int,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    if not mark_mobile_announcement_read(db, int(user_id), announcement_id):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "MOBILE_ANNOUNCEMENT_NOT_FOUND",
                "message": "Mobile announcement not found",
            },
        )
    return ok(
        data={
            "ok": True,
            "unread_count": get_mobile_announcement_unread_count(db, int(user_id)),
        },
        trace_id=getattr(request.state, "trace_id", None),
    )


@router.get("/unread-counts")
def mobile_message_unread_counts(
    request: Request,
    response: Response,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    numeric_user_id = int(user_id)
    announcement_count = get_mobile_announcement_unread_count(db, numeric_user_id)
    support_reply_count = get_unread_support_reply_count(db, numeric_user_id)
    return ok(
        data={
            "announcements": announcement_count,
            "support_replies": support_reply_count,
            "total": announcement_count + support_reply_count,
        },
        trace_id=getattr(request.state, "trace_id", None),
    )
