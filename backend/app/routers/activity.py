from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.content_locale import resolve_content_locale
from app.db.session import get_db
from app.schemas.response import ok
from app.services.activity_service import (
    get_public_activities,
    get_public_activity,
    get_public_activity_banners,
)


router = APIRouter(tags=["activities"])


@router.get("/activities")
def activities(
    request: Request,
    limit: int = Query(6, ge=1, le=20),
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data={"items": get_public_activities(db, limit=limit, locale=locale)}, trace_id=trace_id)


@router.get("/activities/banners")
def activity_banners(
    request: Request,
    limit: int = Query(6, ge=1, le=20),
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    return ok(data={"items": get_public_activity_banners(db, limit=limit, locale=locale)}, trace_id=trace_id)


@router.get("/activities/{activity_id}")
def activity_detail(
    activity_id: int,
    request: Request,
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    locale = resolve_content_locale(lang, request.headers.get("accept-language"))
    item = get_public_activity(db, activity_id, locale=locale)
    if item is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "ACTIVITY_NOT_FOUND", "message": "活动不存在或已下线"},
        )
    return ok(data={"item": item}, trace_id=trace_id)
