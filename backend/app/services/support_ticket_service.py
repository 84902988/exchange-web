from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.db.models import SupportTicket, SupportTicketMessage


SUPPORT_TICKET_CATEGORIES: tuple[dict[str, str], ...] = (
    {"value": "ACCOUNT", "label": "账户问题"},
    {"value": "KYC", "label": "身份认证"},
    {"value": "DEPOSIT_WITHDRAW", "label": "充值提现"},
    {"value": "TRADING", "label": "交易问题"},
    {"value": "SECURITY", "label": "安全问题"},
    {"value": "OTHER", "label": "其他"},
)
SUPPORT_TICKET_STATUS_OPTIONS: tuple[dict[str, str], ...] = (
    {"value": "OPEN", "label": "待处理", "badge": "warning"},
    {"value": "IN_PROGRESS", "label": "处理中", "badge": "info"},
    {"value": "REPLIED", "label": "已回复", "badge": "success"},
    {"value": "CLOSED", "label": "已关闭", "badge": "muted"},
)
SUPPORT_TICKET_PRIORITY_OPTIONS: tuple[dict[str, str], ...] = (
    {"value": "NORMAL", "label": "普通"},
    {"value": "HIGH", "label": "高"},
)

_CATEGORY_LABELS = {item["value"]: item["label"] for item in SUPPORT_TICKET_CATEGORIES}
_STATUS_LABELS = {item["value"]: item["label"] for item in SUPPORT_TICKET_STATUS_OPTIONS}
_STATUS_BADGES = {item["value"]: item["badge"] for item in SUPPORT_TICKET_STATUS_OPTIONS}
_PRIORITY_LABELS = {item["value"]: item["label"] for item in SUPPORT_TICKET_PRIORITY_OPTIONS}


def _now() -> datetime:
    return datetime.utcnow()


def _normalize_enum(value: str, allowed: set[str], default: Optional[str] = None) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in allowed:
        return normalized
    if default is not None:
        return default
    raise HTTPException(status_code=400, detail={"code": "INVALID_VALUE", "message": "Invalid support ticket value"})


def _clean_text(value: str, max_length: int) -> str:
    text = str(value or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail={"code": "REQUIRED_FIELD", "message": "Required field is empty"})
    return text[:max_length]


def _generate_ticket_no(db: Session) -> str:
    prefix = f"TK{datetime.utcnow():%Y%m%d}"
    for _ in range(10):
        ticket_no = f"{prefix}{uuid.uuid4().hex[:8].upper()}"
        exists = db.query(SupportTicket.id).filter(SupportTicket.ticket_no == ticket_no).first()
        if not exists:
            return ticket_no
    return f"{prefix}{uuid.uuid4().hex[:12].upper()}"


def serialize_support_ticket(ticket: SupportTicket, include_messages: bool = False) -> dict[str, Any]:
    status = str(ticket.status or "OPEN").upper()
    category = str(ticket.category or "OTHER").upper()
    priority = str(ticket.priority or "NORMAL").upper()
    data: dict[str, Any] = {
        "id": ticket.id,
        "ticket_no": ticket.ticket_no,
        "user_id": ticket.user_id,
        "category": category,
        "category_label": _CATEGORY_LABELS.get(category, category),
        "subject": ticket.subject,
        "content": ticket.content,
        "status": status,
        "status_label": _STATUS_LABELS.get(status, status),
        "status_badge": _STATUS_BADGES.get(status, "muted"),
        "priority": priority,
        "priority_label": _PRIORITY_LABELS.get(priority, priority),
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
        "updated_at": ticket.updated_at.isoformat() if ticket.updated_at else None,
        "last_reply_at": ticket.last_reply_at.isoformat() if ticket.last_reply_at else None,
    }
    if include_messages:
        data["messages"] = [serialize_support_ticket_message(message) for message in ticket.messages]
    return data


def serialize_support_ticket_message(message: SupportTicketMessage) -> dict[str, Any]:
    return {
        "id": message.id,
        "ticket_id": message.ticket_id,
        "sender_type": message.sender_type,
        "sender_user_id": message.sender_user_id,
        "admin_user_id": message.admin_user_id,
        "message": message.message,
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }


def list_user_support_tickets(
    db: Session,
    user_id: int,
    status: str = "",
    page: int = 1,
    page_size: int = 20,
) -> dict[str, Any]:
    page = max(int(page or 1), 1)
    page_size = min(max(int(page_size or 20), 1), 50)
    query = db.query(SupportTicket).filter(SupportTicket.user_id == user_id)
    normalized_status = str(status or "").strip().upper()
    if normalized_status:
        query = query.filter(SupportTicket.status == normalized_status)
    total = int(query.with_entities(func.count(SupportTicket.id)).scalar() or 0)
    pages = max((total + page_size - 1) // page_size, 1)
    items = (
        query.order_by(SupportTicket.updated_at.desc(), SupportTicket.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [serialize_support_ticket(item) for item in items],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "categories": list(SUPPORT_TICKET_CATEGORIES),
        "statuses": list(SUPPORT_TICKET_STATUS_OPTIONS),
    }


def create_user_support_ticket(db: Session, user_id: int, payload: Any) -> dict[str, Any]:
    now = _now()
    category = _normalize_enum(payload.category, set(_CATEGORY_LABELS), default="OTHER")
    subject = _clean_text(payload.subject, 255)
    content = _clean_text(payload.content, 5000)
    ticket = SupportTicket(
        ticket_no=_generate_ticket_no(db),
        user_id=user_id,
        category=category,
        subject=subject,
        content=content,
        status="OPEN",
        priority="NORMAL",
        created_at=now,
        updated_at=now,
    )
    db.add(ticket)
    db.flush()
    db.add(
        SupportTicketMessage(
            ticket_id=ticket.id,
            sender_type="USER",
            sender_user_id=user_id,
            message=content,
            created_at=now,
        )
    )
    db.flush()
    return serialize_support_ticket(ticket, include_messages=True)


def get_user_support_ticket(db: Session, user_id: int, ticket_id: int) -> SupportTicket:
    ticket = (
        db.query(SupportTicket)
        .options(joinedload(SupportTicket.messages))
        .filter(SupportTicket.id == ticket_id, SupportTicket.user_id == user_id)
        .first()
    )
    if ticket is None:
        raise HTTPException(status_code=404, detail={"code": "TICKET_NOT_FOUND", "message": "Support ticket not found"})
    return ticket


def add_user_support_ticket_message(db: Session, user_id: int, ticket_id: int, message: str) -> dict[str, Any]:
    ticket = get_user_support_ticket(db, user_id, ticket_id)
    if str(ticket.status or "").upper() == "CLOSED":
        raise HTTPException(status_code=400, detail={"code": "TICKET_CLOSED", "message": "Closed ticket cannot be replied"})
    now = _now()
    db.add(
        SupportTicketMessage(
            ticket_id=ticket.id,
            sender_type="USER",
            sender_user_id=user_id,
            message=_clean_text(message, 5000),
            created_at=now,
        )
    )
    ticket.status = "OPEN"
    ticket.updated_at = now
    db.flush()
    return serialize_support_ticket(ticket, include_messages=True)


def close_user_support_ticket(db: Session, user_id: int, ticket_id: int) -> dict[str, Any]:
    ticket = get_user_support_ticket(db, user_id, ticket_id)
    ticket.status = "CLOSED"
    ticket.updated_at = _now()
    db.flush()
    return serialize_support_ticket(ticket, include_messages=True)


def admin_query_support_tickets(db: Session, filters: dict[str, Any]) -> dict[str, Any]:
    page = max(int(filters.get("page") or 1), 1)
    page_size = min(max(int(filters.get("page_size") or 20), 1), 100)
    query = db.query(SupportTicket)
    keyword = str(filters.get("keyword") or "").strip()
    user_id = str(filters.get("user_id") or "").strip()
    status = str(filters.get("status") or "").strip().upper()
    category = str(filters.get("category") or "").strip().upper()

    if keyword:
        like = f"%{keyword}%"
        query = query.filter(or_(SupportTicket.ticket_no.like(like), SupportTicket.subject.like(like)))
    if user_id.isdigit():
        query = query.filter(SupportTicket.user_id == int(user_id))
    if status:
        query = query.filter(SupportTicket.status == status)
    if category:
        query = query.filter(SupportTicket.category == category)

    total = int(query.with_entities(func.count(SupportTicket.id)).scalar() or 0)
    pages = max((total + page_size - 1) // page_size, 1)
    items = (
        query.order_by(SupportTicket.updated_at.desc(), SupportTicket.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [serialize_support_ticket(item) for item in items],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
    }


def admin_get_support_ticket(db: Session, ticket_id: int) -> Optional[dict[str, Any]]:
    ticket = (
        db.query(SupportTicket)
        .options(joinedload(SupportTicket.messages))
        .filter(SupportTicket.id == ticket_id)
        .first()
    )
    if ticket is None:
        return None
    return serialize_support_ticket(ticket, include_messages=True)


def admin_reply_support_ticket(db: Session, ticket_id: int, admin_user_id: int, message: str) -> dict[str, Any]:
    ticket = db.query(SupportTicket).filter(SupportTicket.id == ticket_id).first()
    if ticket is None:
        return {"ok": False, "message": "工单不存在", "not_found": True}
    if str(ticket.status or "").upper() == "CLOSED":
        return {"ok": False, "message": "已关闭工单不能回复"}
    now = _now()
    db.add(
        SupportTicketMessage(
            ticket_id=ticket.id,
            sender_type="ADMIN",
            admin_user_id=admin_user_id,
            message=_clean_text(message, 5000),
            created_at=now,
        )
    )
    ticket.status = "REPLIED"
    ticket.last_reply_at = now
    ticket.updated_at = now
    db.flush()
    return {"ok": True, "message": "回复已发送"}


def admin_update_support_ticket_status(db: Session, ticket_id: int, status: str) -> dict[str, Any]:
    ticket = db.query(SupportTicket).filter(SupportTicket.id == ticket_id).first()
    if ticket is None:
        return {"ok": False, "message": "工单不存在", "not_found": True}
    try:
        normalized_status = _normalize_enum(status, set(_STATUS_LABELS))
    except HTTPException:
        return {"ok": False, "message": "工单状态无效"}
    ticket.status = normalized_status
    ticket.updated_at = _now()
    db.flush()
    return {"ok": True, "message": "状态已更新"}
