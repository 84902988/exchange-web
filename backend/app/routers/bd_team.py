from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.bd_application import (
    BdApplicationApiResponse,
    BdApplicationCreateIn,
)
from app.schemas.bd_team import MyBdTeamOverviewApiResponse
from app.schemas.response import ok
from app.services.bd_application_service import (
    create_bd_application,
    get_latest_bd_application,
)
from app.services.bd_team_query import get_my_bd_team_overview
from app.services.bd_invite_service import bind_user_to_bd_invite, validate_invite_code_for_register


router = APIRouter(prefix="/bd", tags=["bd"])


class BindInviteIn(BaseModel):
    invite_code: str = Field(..., min_length=1, max_length=64)


@router.get("/invite/validate")
def validate_invite(
    request: Request,
    invite_code: str = Query(..., min_length=1, max_length=64),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        normalized_code = validate_invite_code_for_register(db, invite_code)
        return ok(data={"valid": True, "invite_code": normalized_code}, trace_id=trace_id)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": "INVITE_VALIDATE_FAILED", "message": "邀请信息校验失败，请稍后重试"},
        )


@router.get("/my/team", response_model=MyBdTeamOverviewApiResponse)
def my_bd_team(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    data = get_my_bd_team_overview(
        db=db,
        user_id=int(user_id),
        page=page,
        page_size=page_size,
    )
    return ok(data=data, trace_id=trace_id)


@router.get("/my/application", response_model=BdApplicationApiResponse)
def my_bd_application(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    data = get_latest_bd_application(db=db, user_id=int(user_id))
    return ok(data=data, trace_id=trace_id)


@router.post("/my/application", response_model=BdApplicationApiResponse)
def submit_my_bd_application(
    payload: BdApplicationCreateIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = create_bd_application(db=db, user_id=int(user_id), payload=payload)
        db.commit()
        return ok(data=data, trace_id=trace_id)
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "BD_APPLICATION_FAILED", "message": "submit bd application failed"},
        )


@router.post("/invite/bind")
def bind_invite(
    payload: BindInviteIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = bind_user_to_bd_invite(
            db=db,
            user_id=int(user_id),
            invite_code=payload.invite_code,
        )
        db.commit()
        return ok(data=data, trace_id=trace_id)
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INVITE_BIND_FAILED", "message": "绑定失败，请稍后重试"},
        )
