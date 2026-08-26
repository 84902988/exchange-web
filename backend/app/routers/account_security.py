from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.db.models import UserSecurityEvent
from app.db.session import get_db
from app.deps.auth import get_current_user_id


router = APIRouter(prefix="/me/security-events", tags=["account-security"])

VISIBLE_EVENT_TYPES = frozenset(
    {
        "EMAIL_VERIFIED",
        "EMAIL_CHANGED",
        "PASSWORD_CHANGED",
        "PASSWORD_RESET",
        "SESSION_REVOKED",
        "SESSIONS_REVOKED",
    }
)


class SecurityEventItem(BaseModel):
    id: int
    event_type: str
    ip_address: str
    user_agent: str
    details: Dict[str, Any] = Field(default_factory=dict)
    created_at: str


class SecurityEventPage(BaseModel):
    items: list[SecurityEventItem]
    has_more: bool
    next_cursor: Optional[int] = None


class ApiResponse(BaseModel):
    ok: bool
    data: SecurityEventPage
    error: Optional[Dict[str, Any]] = None
    trace_id: Optional[str] = None


def _safe_text(value: Any, *, max_length: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = "".join(char for char in value.strip() if char.isprintable())
    if not normalized:
        return None
    return normalized[:max_length]


def _safe_masked_email(value: Any) -> Optional[str]:
    normalized = _safe_text(value, max_length=191)
    if not normalized or "@" not in normalized or "*" not in normalized:
        return None
    return normalized


def _safe_count(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > 10_000:
        return None
    return value


def _public_details(event_type: str, value: Any) -> Dict[str, Any]:
    details = value if isinstance(value, dict) else {}
    public: Dict[str, Any] = {}
    if event_type == "EMAIL_VERIFIED":
        email = _safe_masked_email(details.get("email"))
        if email:
            public["email"] = email
        if details.get("source") == "registration":
            public["source"] = "registration"
    elif event_type == "EMAIL_CHANGED":
        old_email = _safe_masked_email(details.get("old_email"))
        new_email = _safe_masked_email(details.get("new_email"))
        if old_email:
            public["old_email"] = old_email
        if new_email:
            public["new_email"] = new_email
    elif event_type in {"PASSWORD_CHANGED", "PASSWORD_RESET"}:
        revoked_sessions = _safe_count(details.get("revoked_sessions"))
        if revoked_sessions is not None:
            public["revoked_sessions"] = revoked_sessions
    elif event_type == "SESSION_REVOKED":
        target_device = _safe_text(details.get("target_device"), max_length=120)
        if target_device:
            public["target_device"] = target_device
    elif event_type == "SESSIONS_REVOKED":
        revoked_count = _safe_count(details.get("revoked_count"))
        if revoked_count is not None:
            public["revoked_count"] = revoked_count
    return public


def _iso_utc(value: datetime) -> str:
    aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@router.get("", response_model=ApiResponse)
def list_my_security_events(
    request: Request,
    limit: int = Query(20, ge=1, le=50),
    before_id: Optional[int] = Query(None, ge=1),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    owner_id = int(user_id)
    cursor: Optional[UserSecurityEvent] = None
    if before_id is not None:
        cursor = (
            db.query(UserSecurityEvent)
            .filter(
                UserSecurityEvent.id == int(before_id),
                UserSecurityEvent.user_id == owner_id,
                UserSecurityEvent.event_type.in_(VISIBLE_EVENT_TYPES),
            )
            .first()
        )
        if cursor is None:
            raise HTTPException(
                status_code=400,
                detail={"code": "INVALID_CURSOR", "message": "Invalid security event cursor"},
            )

    query = db.query(UserSecurityEvent).filter(
        UserSecurityEvent.user_id == owner_id,
        UserSecurityEvent.event_type.in_(VISIBLE_EVENT_TYPES),
    )
    if cursor is not None:
        query = query.filter(
            or_(
                UserSecurityEvent.created_at < cursor.created_at,
                and_(
                    UserSecurityEvent.created_at == cursor.created_at,
                    UserSecurityEvent.id < cursor.id,
                ),
            )
        )
    rows = (
        query.order_by(UserSecurityEvent.created_at.desc(), UserSecurityEvent.id.desc())
        .limit(int(limit) + 1)
        .all()
    )
    has_more = len(rows) > int(limit)
    visible_rows = rows[: int(limit)]
    return {
        "ok": True,
        "data": {
            "items": [
                {
                    "id": int(item.id),
                    "event_type": item.event_type,
                    "ip_address": item.ip or "unknown",
                    "user_agent": item.user_agent or "",
                    "details": _public_details(item.event_type, item.details),
                    "created_at": _iso_utc(item.created_at),
                }
                for item in visible_rows
            ],
            "has_more": has_more,
            "next_cursor": int(visible_rows[-1].id) if has_more and visible_rows else None,
        },
        "error": None,
        "trace_id": getattr(request.state, "trace_id", None),
    }
