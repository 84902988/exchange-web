from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_token
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.response import ok
from app.services.announcement_read_service import (
    get_unread_announcement_count,
    mark_all_announcements_read,
    mark_announcement_read,
)


router = APIRouter(prefix="/announcements", tags=["announcement-reads"])


def _get_bearer_token(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization") or ""
    parts = auth.split(" ", 1)
    if len(parts) != 2 or parts[0].strip().lower() != "bearer":
        return None
    return parts[1].strip() or None


def _get_cookie_token(request: Request) -> Optional[str]:
    cookie_name = getattr(settings, "ACCESS_TOKEN_COOKIE_NAME", "access_token")
    return request.cookies.get(cookie_name) or None


def _optional_current_user_id(request: Request) -> Optional[int]:
    token = _get_bearer_token(request) or _get_cookie_token(request)
    if not token:
        return None
    try:
        payload = decode_token(token, audience="user")
    except JWTError:
        return None
    if payload.get("type") != "access":
        return None
    sub = payload.get("sub")
    if not sub:
        return None
    try:
        return int(sub)
    except (TypeError, ValueError):
        return None


@router.get("/unread-count")
def announcement_unread_count(request: Request, db: Session = Depends(get_db)):
    trace_id = getattr(request.state, "trace_id", None)
    user_id = _optional_current_user_id(request)
    if user_id is None:
        return ok(data={"unread_count": 0}, trace_id=trace_id)
    return ok(data={"unread_count": get_unread_announcement_count(db, user_id)}, trace_id=trace_id)


@router.post("/read-all")
def read_all_announcements(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    marked = mark_all_announcements_read(db, int(user_id))
    return ok(data={"marked": marked}, trace_id=trace_id)


@router.post("/{announcement_id}/read")
def read_announcement(
    announcement_id: int,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    if not mark_announcement_read(db, int(user_id), announcement_id):
        raise HTTPException(
            status_code=404,
            detail={"code": "ANNOUNCEMENT_NOT_FOUND", "message": "Announcement not found"},
        )
    return ok(data={"ok": True}, trace_id=trace_id)
