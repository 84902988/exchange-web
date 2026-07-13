from __future__ import annotations

from datetime import datetime
from math import ceil
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy.orm import Session

from app.deps.auth import get_current_user_id
from app.db.models import KycSubmission, User, UserProfile
from app.db.session import get_db
from app.services.kyc_storage import build_kyc_file_response, save_kyc_upload

router = APIRouter(tags=["kyc"])

KYC_LEVEL_VALUE = {"PRIMARY": 1, "ADVANCED": 2}
VALID_KYC_LEVELS = set(KYC_LEVEL_VALUE)
VALID_ID_TYPES = {"PASSPORT", "ID_CARD", "DRIVER_LICENSE"}
BACK_IMAGE_REQUIRED_ID_TYPES = {"ID_CARD", "DRIVER_LICENSE"}
ADMIN_KYC_STATUSES = {"PENDING", "APPROVED", "REJECTED"}
ADMIN_KYC_TABS = {
    "pending": "PENDING",
    "approved": "APPROVED",
    "rejected": "REJECTED",
    "all": "",
}
KYC_STATUS_LABELS = {
    "PENDING": "待审核",
    "APPROVED": "已通过",
    "REJECTED": "已拒绝",
}
KYC_STATUS_BADGES = {
    "PENDING": "warning",
    "APPROVED": "success",
    "REJECTED": "danger",
}
# The current RBAC catalog has no KYC-specific permission. Keep KYC review
# access aligned with the existing Admin KYC page until a narrower permission
# is introduced in a dedicated RBAC change.
ADMIN_KYC_PERMISSION = "users.view"
KYC_MATERIAL_FIELDS = {
    "front": "front_image_url",
    "back": "back_image_url",
    "selfie": "selfie_image_url",
}


def _ok(data: dict, trace_id: Optional[str] = None) -> dict:
    return {"ok": True, "data": data, "error": None, "trace_id": trace_id}


def _material_read_url(item: KycSubmission, material_kind: str, *, admin: bool = False) -> Optional[str]:
    field_name = KYC_MATERIAL_FIELDS[material_kind]
    if not getattr(item, field_name, None):
        return None
    if admin:
        return f"/admin/kyc/{int(item.id)}/materials/{material_kind}"
    return f"/me/kyc/submissions/{int(item.id)}/materials/{material_kind}"


def _serialize_submission(item: KycSubmission | None) -> Optional[dict]:
    if item is None:
        return None
    return {
        "id": int(item.id),
        "user_id": int(item.user_id),
        "kyc_level": item.kyc_level,
        "full_name": item.full_name,
        "country_code": item.country_code,
        "id_type": item.id_type,
        "id_number": item.id_number,
        "front_image_url": _material_read_url(item, "front"),
        "back_image_url": _material_read_url(item, "back"),
        "selfie_image_url": _material_read_url(item, "selfie"),
        "review_status": item.review_status,
        "review_note": item.review_note,
        "reviewed_by": item.reviewed_by,
        "reviewed_at": item.reviewed_at.isoformat() if item.reviewed_at else None,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


def _ensure_profile(db: Session, user: User) -> UserProfile:
    if user.profile is None:
        db.add(UserProfile(user_id=user.id, kyc_level=0, kyc_status="NONE", updated_at=datetime.utcnow()))
        db.commit()
        db.refresh(user)
    return user.profile


def _latest_submission(db: Session, user_id: int) -> KycSubmission | None:
    return (
        db.query(KycSubmission)
        .filter(KycSubmission.user_id == int(user_id))
        .order_by(KycSubmission.created_at.desc(), KycSubmission.id.desc())
        .first()
    )


def _has_upload_file(file: Optional[UploadFile]) -> bool:
    return bool(file and file.filename)


def _admin_required(request: Request, db: Session) -> Optional[Response]:
    from app.routers.admin_pages import require_admin, require_admin_permission

    redirect = require_admin(request)
    if redirect:
        return redirect
    return require_admin_permission(request, db, ADMIN_KYC_PERMISSION)


def _admin_reviewer_id(request: Request) -> str:
    try:
        from app.routers.admin_pages import get_admin_from_request
    except Exception:
        return "legacy_admin_cookie"
    admin = get_admin_from_request(request) or {}
    admin_id = admin.get("id")
    if admin_id is not None:
        return str(admin_id)[:64]
    username = str(admin.get("username") or "").strip()
    return username[:64] if username else "legacy_admin_cookie"


def _status_label(status: str) -> str:
    return KYC_STATUS_LABELS.get(str(status or "").upper(), status or "-")


def _status_badge(status: str) -> str:
    return KYC_STATUS_BADGES.get(str(status or "").upper(), "neutral")


def _fmt_datetime(value: Optional[datetime]) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S") if value else "-"


def _normalize_page(value: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 1


def _normalize_page_size(value: int) -> int:
    try:
        return min(100, max(1, int(value)))
    except (TypeError, ValueError):
        return 20


def _normalize_admin_kyc_tab(value: str) -> str:
    tab = str(value or "").strip().lower()
    return tab if tab in ADMIN_KYC_TABS else "pending"


def _parse_date_start(value: str) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None


def _parse_date_end(value: str) -> Optional[datetime]:
    start = _parse_date_start(value)
    if not start:
        return None
    return start.replace(hour=23, minute=59, second=59, microsecond=999999)


def _serialize_admin_submission(item: KycSubmission) -> dict:
    status = str(item.review_status or "").upper()
    return {
        "id": int(item.id),
        "user_id": int(item.user_id),
        "full_name": item.full_name,
        "country_code": item.country_code,
        "id_type": item.id_type,
        "id_number": item.id_number,
        "front_image_read_url": _material_read_url(item, "front", admin=True),
        "back_image_read_url": _material_read_url(item, "back", admin=True),
        "selfie_image_read_url": _material_read_url(item, "selfie", admin=True),
        "review_status": status,
        "status_label": _status_label(status),
        "status_badge": _status_badge(status),
        "review_note": item.review_note or "-",
        "reviewed_by": item.reviewed_by or "-",
        "reviewed_at": _fmt_datetime(item.reviewed_at),
        "created_at": _fmt_datetime(item.created_at),
        "can_review": status == "PENDING",
    }


@router.get("/me/kyc")
def get_my_kyc(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "User not found"})
    profile = _ensure_profile(db, user)
    latest = _latest_submission(db, int(user.id))
    return _ok(
        {
            "kyc_status": getattr(user, "kyc_status", None) or profile.kyc_status or "NONE",
            "kyc_level": int(getattr(user, "kyc_level", None) or profile.kyc_level or 0),
            "latest_submission": _serialize_submission(latest),
        },
        trace_id,
    )


def _submission_material_reference(item: KycSubmission, material_kind: str) -> Optional[str]:
    field_name = KYC_MATERIAL_FIELDS.get(str(material_kind or "").strip().lower())
    if field_name is None:
        raise HTTPException(status_code=404, detail="KYC material not found")
    return getattr(item, field_name, None)


@router.get("/me/kyc/submissions/{submission_id}/materials/{material_kind}")
def read_my_kyc_material(
    submission_id: int,
    material_kind: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    item = db.query(KycSubmission).filter(KycSubmission.id == int(submission_id)).first()
    if item is None or int(item.user_id) != int(user_id):
        raise HTTPException(status_code=404, detail="KYC material not found")
    return build_kyc_file_response(_submission_material_reference(item, material_kind))


@router.post("/me/kyc/submit")
async def submit_my_kyc(
    request: Request,
    kyc_level: str = Form("PRIMARY"),
    full_name: str = Form(...),
    country_code: str = Form(...),
    id_type: str = Form(...),
    id_number: str = Form(...),
    front_image: Optional[UploadFile] = File(None),
    back_image: Optional[UploadFile] = File(None),
    selfie_image: Optional[UploadFile] = File(None),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "User not found"})

    level = (kyc_level or "").strip().upper()
    doc_type = (id_type or "").strip().upper()
    if level not in VALID_KYC_LEVELS:
        raise HTTPException(status_code=400, detail={"code": "INVALID_KYC_LEVEL", "message": "Invalid KYC level"})
    if doc_type not in VALID_ID_TYPES:
        raise HTTPException(status_code=400, detail={"code": "INVALID_ID_TYPE", "message": "Invalid ID type"})
    if not full_name.strip() or not country_code.strip() or not id_number.strip():
        raise HTTPException(status_code=400, detail={"code": "VALIDATION_ERROR", "message": "Required fields are missing"})
    if not _has_upload_file(front_image):
        raise HTTPException(status_code=400, detail={"code": "IMAGE_REQUIRED", "message": "Front image is required"})
    if doc_type in BACK_IMAGE_REQUIRED_ID_TYPES and not _has_upload_file(back_image):
        raise HTTPException(status_code=400, detail={"code": "KYC_BACK_IMAGE_REQUIRED", "message": "Back image is required"})
    if not _has_upload_file(selfie_image):
        raise HTTPException(status_code=400, detail={"code": "KYC_SELFIE_IMAGE_REQUIRED", "message": "Selfie image is required"})

    pending = (
        db.query(KycSubmission)
        .filter(KycSubmission.user_id == int(user.id), KycSubmission.review_status == "PENDING")
        .first()
    )
    if pending:
        raise HTTPException(status_code=400, detail={"code": "KYC_PENDING_EXISTS", "message": "KYC submission is under review"})

    approved_same_level = (
        db.query(KycSubmission)
        .filter(
            KycSubmission.user_id == int(user.id),
            KycSubmission.kyc_level == level,
            KycSubmission.review_status == "APPROVED",
        )
        .first()
    )
    if approved_same_level:
        raise HTTPException(status_code=400, detail={"code": "KYC_LEVEL_APPROVED", "message": "KYC level is already approved"})

    front_url = await save_kyc_upload(front_image, "front")
    back_url = await save_kyc_upload(back_image, "back") if _has_upload_file(back_image) else None
    selfie_url = await save_kyc_upload(selfie_image, "selfie")

    now = datetime.utcnow()
    item = KycSubmission(
        user_id=int(user.id),
        kyc_level=level,
        full_name=full_name.strip(),
        country_code=country_code.strip().upper(),
        id_type=doc_type,
        id_number=id_number.strip(),
        front_image_url=front_url,
        back_image_url=back_url,
        selfie_image_url=selfie_url,
        review_status="PENDING",
        created_at=now,
        updated_at=now,
    )
    db.add(item)
    profile = _ensure_profile(db, user)
    user.kyc_status = "PENDING"
    profile.kyc_status = "PENDING"
    profile.updated_at = now
    db.commit()
    db.refresh(item)
    return _ok({"submission": _serialize_submission(item)}, trace_id)


@router.get("/admin/kyc/submissions", response_class=HTMLResponse)
def admin_kyc_submissions(
    request: Request,
    tab: str = Query("pending"),
    user_id: str = Query(""),
    status: str = Query(""),
    country_code: str = Query(""),
    id_type: str = Query(""),
    created_from: str = Query(""),
    created_to: str = Query(""),
    page: int = Query(1),
    page_size: int = Query(20),
    notice: str = Query(""),
    error: str = Query(""),
    db: Session = Depends(get_db),
):
    redirect = _admin_required(request, db)
    if redirect:
        return redirect

    query = db.query(KycSubmission)
    normalized_user_id = str(user_id or "").strip()
    normalized_status = (status or "").strip().upper()
    normalized_country = (country_code or "").strip().upper()
    normalized_id_type = (id_type or "").strip().upper()
    created_start = _parse_date_start(created_from)
    created_end = _parse_date_end(created_to)
    page = _normalize_page(page)
    page_size = _normalize_page_size(page_size)
    active_tab = _normalize_admin_kyc_tab(tab)
    if "tab" not in request.query_params and normalized_status in ADMIN_KYC_STATUSES:
        active_tab = normalized_status.lower()
    tab_status = ADMIN_KYC_TABS[active_tab]

    if normalized_user_id.isdigit():
        query = query.filter(KycSubmission.user_id == int(normalized_user_id))
    if normalized_country:
        query = query.filter(KycSubmission.country_code == normalized_country)
    if normalized_id_type:
        query = query.filter(KycSubmission.id_type == normalized_id_type)
    if created_start:
        query = query.filter(KycSubmission.created_at >= created_start)
    if created_end:
        query = query.filter(KycSubmission.created_at <= created_end)

    base_query = query
    tab_counts = {
        "pending": int(base_query.filter(KycSubmission.review_status == "PENDING").count()),
        "approved": int(base_query.filter(KycSubmission.review_status == "APPROVED").count()),
        "rejected": int(base_query.filter(KycSubmission.review_status == "REJECTED").count()),
        "all": int(base_query.count()),
    }

    effective_status = ""
    if tab_status:
        effective_status = tab_status
        query = base_query.filter(KycSubmission.review_status == tab_status)
    elif normalized_status in ADMIN_KYC_STATUSES:
        effective_status = normalized_status
        query = base_query.filter(KycSubmission.review_status == normalized_status)
    else:
        query = base_query

    total = int(query.count())
    rows = (
        query.order_by(KycSubmission.created_at.desc(), KycSubmission.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [_serialize_admin_submission(item) for item in rows]

    from app.routers.admin_pages import render as render_admin_template

    return render_admin_template(
        request,
        "admin/kyc_submissions.html",
        {
            "items": items,
            "active_group": "users",
            "active": "kyc_submissions",
            "notice": notice,
            "error": error,
            "active_tab": active_tab,
            "tab_counts": tab_counts,
            "status_filter_disabled": active_tab != "all",
            "filters": {
                "tab": active_tab,
                "user_id": normalized_user_id,
                "status": effective_status,
                "country_code": normalized_country,
                "id_type": normalized_id_type,
                "created_from": str(created_from or "").strip(),
                "created_to": str(created_to or "").strip(),
            },
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "pages": max(1, ceil(total / page_size)) if page_size else 1,
            },
        },
    )


@router.get("/admin/kyc/{submission_id}/materials/{material_kind}")
def read_admin_kyc_material(
    request: Request,
    submission_id: int,
    material_kind: str,
    db: Session = Depends(get_db),
):
    blocked = _admin_required(request, db)
    if blocked:
        return blocked
    item = db.query(KycSubmission).filter(KycSubmission.id == int(submission_id)).first()
    if item is None:
        raise HTTPException(status_code=404, detail="KYC material not found")
    return build_kyc_file_response(_submission_material_reference(item, material_kind))


def _admin_review_redirect(next_path: str = "", notice: str = "", error: str = "") -> RedirectResponse:
    base = next_path if str(next_path or "").startswith("/admin/kyc/submissions") else "/admin/kyc/submissions"
    parts = urlsplit(base)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if notice:
        query["notice"] = notice
    if error:
        query["error"] = error
    return RedirectResponse(
        url=urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)),
        status_code=302,
    )


@router.post("/admin/kyc/{submission_id}/approve")
def approve_kyc_submission(
    request: Request,
    submission_id: int,
    review_note: str = Form(""),
    next_path: str = Form("/admin/kyc/submissions"),
    db: Session = Depends(get_db),
):
    redirect = _admin_required(request, db)
    if redirect:
        return redirect
    item = db.query(KycSubmission).filter(KycSubmission.id == submission_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="KYC submission not found")
    if str(item.review_status or "").upper() != "PENDING":
        return _admin_review_redirect(next_path, error="该 KYC 记录已审核，不能重复操作")

    user = db.query(User).filter(User.id == int(item.user_id)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    profile = _ensure_profile(db, user)
    level_value = KYC_LEVEL_VALUE.get(item.kyc_level, 1)
    now = datetime.utcnow()
    item.review_status = "APPROVED"
    item.review_note = review_note.strip() or None
    item.reviewed_by = _admin_reviewer_id(request)
    item.reviewed_at = now
    item.updated_at = now
    user.kyc_status = "APPROVED"
    user.kyc_level = max(int(getattr(user, "kyc_level", 0) or 0), level_value)
    profile.kyc_status = "APPROVED"
    profile.kyc_level = max(int(profile.kyc_level or 0), level_value)
    profile.updated_at = now
    db.commit()
    return _admin_review_redirect(next_path, notice="KYC 已通过")


@router.post("/admin/kyc/{submission_id}/reject")
def reject_kyc_submission(
    request: Request,
    submission_id: int,
    review_note: str = Form(...),
    next_path: str = Form("/admin/kyc/submissions"),
    db: Session = Depends(get_db),
):
    redirect = _admin_required(request, db)
    if redirect:
        return redirect
    item = db.query(KycSubmission).filter(KycSubmission.id == submission_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="KYC submission not found")
    if str(item.review_status or "").upper() != "PENDING":
        return _admin_review_redirect(next_path, error="该 KYC 记录已审核，不能重复操作")
    user = db.query(User).filter(User.id == int(item.user_id)).first()
    profile = _ensure_profile(db, user) if user else None
    now = datetime.utcnow()
    item.review_status = "REJECTED"
    item.review_note = review_note.strip() or "资料未通过审核"
    item.reviewed_by = _admin_reviewer_id(request)
    item.reviewed_at = now
    item.updated_at = now
    if user:
        user.kyc_status = "REJECTED"
    if profile:
        profile.kyc_status = "REJECTED"
        profile.updated_at = now
    db.commit()
    return _admin_review_redirect(next_path, notice="KYC 已拒绝")
