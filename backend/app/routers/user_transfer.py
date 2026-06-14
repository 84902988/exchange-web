from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.response import ok
from app.schemas.user_transfer import UserTransferRequest
from app.services.user_withdraw_lock_service import assert_user_withdraw_unlocked
from app.services.user_transfer_service import (
    UserTransferBadRequest,
    UserTransferInsufficientBalance,
    UserTransferNotFound,
    user_transfer_service,
)

router = APIRouter(prefix="/user-transfer", tags=["user-transfer"])


@router.get("/recipient/resolve")
def resolve_user_transfer_recipient(
    request: Request,
    email: str = Query(..., min_length=3),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = user_transfer_service.resolve_recipient(db, current_user_id=user_id, email=email)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except UserTransferNotFound as exc:
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except UserTransferBadRequest as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})


@router.post("")
def create_user_transfer(
    request: Request,
    payload: UserTransferRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        assert_user_withdraw_unlocked(db, user_id)
        data = user_transfer_service.create_transfer(db, from_user_id=user_id, payload=payload)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except UserTransferNotFound as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except (UserTransferBadRequest, UserTransferInsufficientBalance) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": "user transfer failed"},
        )


@router.get("/records")
def list_user_transfer_records(
    request: Request,
    direction: str = Query("all", pattern="^(all|in|out)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    symbol: str = Query(""),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = user_transfer_service.list_records(
            db,
            user_id=user_id,
            direction=direction,
            page=page,
            page_size=page_size,
            symbol=symbol,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except UserTransferBadRequest as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
