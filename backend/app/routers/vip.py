from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.redis import get_refresh_jti_owner
from app.core.security import decode_token
from app.core.security import hash_refresh_token, verify_refresh_token
from app.db.models import User, UserSession
from app.db.models.user_fee_preference import UserFeePreference
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.response import ok
from app.schemas.vip import (
    VipFeePreferenceApiResponse,
    VipFeePreferenceIn,
    VipOverviewApiResponse,
    VipRcbLockCreateApiResponse,
    VipRcbLockIn,
    VipRcbLocksApiResponse,
)
from app.services.rcb_lock_service import RcbLockError, create_user_rcb_lock, list_user_rcb_locks
from app.services.vip_query import get_vip_overview
from app.services.vip_service import calculate_user_vip_snapshot


router = APIRouter(prefix="/vip", tags=["vip"])
logger = logging.getLogger(__name__)


def _get_optional_bearer_token(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization") or ""
    if not auth:
        return None
    parts = auth.split(" ", 1)
    if len(parts) != 2:
        return None
    scheme, token = parts[0].strip().lower(), parts[1].strip()
    if scheme != "bearer" or not token:
        return None
    return token


def _get_optional_cookie_token(request: Request) -> Optional[str]:
    cookie_name = getattr(settings, "ACCESS_TOKEN_COOKIE_NAME", "access_token")
    return request.cookies.get(cookie_name) or None


def _get_optional_refresh_token(request: Request) -> Optional[str]:
    cookie_name = getattr(settings, "REFRESH_TOKEN_COOKIE_NAME", "refresh_token")
    return request.cookies.get(cookie_name) or None


def _get_user_id_from_refresh_token(db: Session, refresh_token: str) -> Optional[int]:
    try:
        payload = verify_refresh_token(refresh_token)
    except JWTError:
        return None

    jti = str(payload.get("jti") or "")
    sub = str(payload.get("sub") or "")
    if not jti or not sub:
        return None

    try:
        owner = get_refresh_jti_owner(jti)
    except Exception:
        logger.warning("Failed to verify VIP overview refresh token jti", exc_info=True)
        return None
    if (not owner) or owner != sub:
        return None

    try:
        user_id = int(sub)
    except (TypeError, ValueError):
        return None

    user = db.query(User).filter(User.id == user_id).first()
    if not user or int(user.status) != 1:
        return None

    token_hash = hash_refresh_token(refresh_token)
    session = (
        db.query(UserSession)
        .filter(
            UserSession.user_id == user_id,
            UserSession.refresh_token_hash == token_hash,
            UserSession.revoked_at.is_(None),
        )
        .first()
    )
    if session is not None and session.expires_at and session.expires_at <= datetime.utcnow():
        return None

    return user_id


def _resolve_optional_user_auth(request: Request, db: Session) -> tuple[Optional[int], str]:
    token = _get_optional_bearer_token(request) or _get_optional_cookie_token(request)
    token_seen = bool(token)
    if token:
        try:
            payload = decode_token(token, audience="user")
            if payload.get("type") == "access" and payload.get("sub"):
                return int(payload["sub"]), "authenticated"
        except (JWTError, TypeError, ValueError):
            pass

    refresh_token = _get_optional_refresh_token(request)
    token_seen = token_seen or bool(refresh_token)
    if refresh_token:
        user_id = _get_user_id_from_refresh_token(db, refresh_token)
        if user_id is not None:
            return user_id, "authenticated"

    return None, "expired" if token_seen else "anonymous"


@router.get("/overview", response_model=VipOverviewApiResponse)
def vip_overview(
    request: Request,
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    user_id, auth_state = _resolve_optional_user_auth(request, db)
    if user_id is not None:
        try:
            calculate_user_vip_snapshot(db=db, user_id=user_id)
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("Failed to calculate VIP snapshot for user_id=%s", user_id)
            raise

    data = get_vip_overview(db=db, user_id=user_id, auth_state=auth_state)
    return ok(data=data, trace_id=trace_id)


def _get_or_create_fee_preference(db: Session, user_id: int) -> UserFeePreference:
    preference = (
        db.query(UserFeePreference)
        .filter(UserFeePreference.user_id == user_id)
        .first()
    )
    if preference:
        return preference

    preference = UserFeePreference(
        user_id=user_id,
        use_rcb_fee=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(preference)
    db.flush()
    return preference


@router.get("/fee-preference", response_model=VipFeePreferenceApiResponse)
def get_fee_preference(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    preference = _get_or_create_fee_preference(db, int(user_id))
    db.commit()
    return ok(data={"use_rcb_fee": bool(preference.use_rcb_fee)}, trace_id=trace_id)


@router.post("/fee-preference", response_model=VipFeePreferenceApiResponse)
def update_fee_preference(
    request: Request,
    payload: VipFeePreferenceIn,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    preference = _get_or_create_fee_preference(db, int(user_id))
    preference.use_rcb_fee = bool(payload.use_rcb_fee)
    preference.updated_at = datetime.utcnow()
    db.add(preference)
    db.commit()
    return ok(data={"use_rcb_fee": bool(preference.use_rcb_fee)}, trace_id=trace_id)


@router.post("/lock-rcb", response_model=VipRcbLockCreateApiResponse)
def lock_rcb(
    request: Request,
    payload: VipRcbLockIn,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = create_user_rcb_lock(
            db,
            user_id=int(user_id),
            amount=payload.amount,
            lock_period_days=payload.lock_period_days,
        )
        db.commit()
        return ok(data=data, trace_id=trace_id)
    except RcbLockError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": "RCB_LOCK_ERROR", "message": str(exc)})
    except Exception:
        db.rollback()
        logger.exception("Failed to lock RCB for user_id=%s", user_id)
        raise HTTPException(status_code=500, detail={"code": "INTERNAL_ERROR", "message": "RCB lock failed"})


@router.get("/rcb-locks", response_model=VipRcbLocksApiResponse)
def my_rcb_locks(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    return ok(data=list_user_rcb_locks(db, user_id=int(user_id)), trace_id=trace_id)
