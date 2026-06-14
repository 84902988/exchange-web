from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.response import ok
from app.schemas.support_ticket import SupportTicketCreateIn, SupportTicketMessageCreateIn
from app.services.support_ticket_service import (
    add_user_support_ticket_message,
    close_user_support_ticket,
    create_user_support_ticket,
    get_user_support_ticket,
    list_user_support_tickets,
    serialize_support_ticket,
)


router = APIRouter(prefix="/user/support-tickets", tags=["support-tickets"])


@router.get("")
@router.get("/")
def my_support_tickets(
    request: Request,
    status: str = Query("", max_length=20),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    data = list_user_support_tickets(
        db=db,
        user_id=int(user_id),
        status=status,
        page=page,
        page_size=page_size,
    )
    return ok(data=data, trace_id=trace_id)


@router.post("")
@router.post("/")
def create_my_support_ticket(
    payload: SupportTicketCreateIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = create_user_support_ticket(db=db, user_id=int(user_id), payload=payload)
        db.commit()
        return ok(data=data, trace_id=trace_id)
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "SUPPORT_TICKET_CREATE_FAILED", "message": "Support ticket create failed"},
        )


@router.get("/{ticket_id}")
def my_support_ticket_detail(
    ticket_id: int,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    ticket = get_user_support_ticket(db=db, user_id=int(user_id), ticket_id=ticket_id)
    return ok(data=serialize_support_ticket(ticket, include_messages=True), trace_id=trace_id)


@router.post("/{ticket_id}/messages")
def add_my_support_ticket_message(
    ticket_id: int,
    payload: SupportTicketMessageCreateIn,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = add_user_support_ticket_message(
            db=db,
            user_id=int(user_id),
            ticket_id=ticket_id,
            message=payload.message,
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
            detail={"code": "SUPPORT_TICKET_MESSAGE_FAILED", "message": "Support ticket message failed"},
        )


@router.post("/{ticket_id}/close")
def close_my_support_ticket(
    ticket_id: int,
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = close_user_support_ticket(db=db, user_id=int(user_id), ticket_id=ticket_id)
        db.commit()
        return ok(data=data, trace_id=trace_id)
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "SUPPORT_TICKET_CLOSE_FAILED", "message": "Support ticket close failed"},
        )
