from __future__ import annotations

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.routers.admin_pages import render, require_admin, _build_site_content_redirect_url
from app.services.activity_service import (
    ACTIVITY_STATUSES,
    MEDIA_TYPES,
    ACTIVE_STATUS,
    admin_activity_banner_form_from_payload,
    admin_activity_form_from_payload,
    admin_create_activity,
    admin_create_activity_banner,
    admin_delete_activity,
    admin_delete_activity_banner,
    admin_get_activity,
    admin_get_activity_banner,
    admin_query_activities,
    admin_query_activity_banners,
    admin_toggle_activity_banner_enabled,
    admin_toggle_activity_status,
    admin_update_activity,
    admin_update_activity_banner,
)


router = APIRouter(prefix="/admin", tags=["ActivityAdmin"])


def _activity_default_form() -> dict[str, object]:
    return {
        "title": "",
        "subtitle": "",
        "description": "",
        "detail_content": "",
        "reward_text": "",
        "reward_value": "",
        "cover_url": "",
        "banner_url": "",
        "banner_type": "image",
        "video_url": "",
        "status": ACTIVE_STATUS,
        "sort_order": 0,
        "start_at_input": "",
        "end_at_input": "",
        "cta_text": "立即参与",
        "cta_url": "",
    }


def _banner_default_form() -> dict[str, object]:
    return {
        "title": "",
        "subtitle": "",
        "media_type": "image",
        "media_url": "",
        "link_url": "",
        "sort_order": 0,
        "enabled": True,
        "start_at_input": "",
        "end_at_input": "",
    }


def _activity_payload(
    *,
    title: str,
    subtitle: str,
    description: str,
    detail_content: str,
    reward_text: str,
    reward_value: str,
    cover_url: str,
    banner_url: str,
    banner_type: str,
    video_url: str,
    status: str,
    sort_order: str,
    start_at: str,
    end_at: str,
    cta_text: str,
    cta_url: str,
    **i18n_fields: str,
) -> dict[str, str]:
    payload = {
        "title": title,
        "subtitle": subtitle,
        "description": description,
        "detail_content": detail_content,
        "reward_text": reward_text,
        "reward_value": reward_value,
        "cover_url": cover_url,
        "banner_url": banner_url,
        "banner_type": banner_type,
        "video_url": video_url,
        "status": status,
        "sort_order": sort_order,
        "start_at": start_at,
        "end_at": end_at,
        "cta_text": cta_text,
        "cta_url": cta_url,
    }
    payload.update(i18n_fields)
    return payload


def _banner_payload(
    *,
    title: str,
    subtitle: str,
    media_type: str,
    media_url: str,
    link_url: str,
    sort_order: str,
    enabled: str,
    start_at: str,
    end_at: str,
    **i18n_fields: str,
) -> dict[str, str]:
    payload = {
        "title": title,
        "subtitle": subtitle,
        "media_type": media_type,
        "media_url": media_url,
        "link_url": link_url,
        "sort_order": sort_order,
        "enabled": enabled,
        "start_at": start_at,
        "end_at": end_at,
    }
    payload.update(i18n_fields)
    return payload


@router.get("/activities", response_class=HTMLResponse)
def activities_page(
    request: Request,
    keyword: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_activities(
        db,
        {"keyword": keyword, "status": status, "page": page, "page_size": page_size},
    )
    return render(
        request,
        "admin/activities.html",
        ctx={
            "active_group": "operations",
            "active": "activities",
            "items": result["items"],
            "filters": {"keyword": keyword, "status": status},
            "pagination": {
                "page": result["page"],
                "page_size": result["page_size"],
                "total": result["total"],
                "pages": result["pages"],
            },
            "notice": notice,
            "error": error,
            "statuses": ACTIVITY_STATUSES,
        },
    )


@router.get("/activities/new", response_class=HTMLResponse)
def activity_create_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir
    return render(
        request,
        "admin/activity_form.html",
        ctx={
            "active_group": "operations",
            "active": "activities",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/activities/new",
            "form": _activity_default_form(),
            "statuses": ACTIVITY_STATUSES,
            "media_types": MEDIA_TYPES,
        },
    )


@router.post("/activities/new")
def activity_create_submit(
    request: Request,
    title: str = Form(""),
    subtitle: str = Form(""),
    description: str = Form(""),
    detail_content: str = Form(""),
    reward_text: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle_i18n_zh: str = Form(""),
    subtitle_i18n_en: str = Form(""),
    subtitle_i18n_zh_TW: str = Form(""),
    subtitle_i18n_ja: str = Form(""),
    description_i18n_zh: str = Form(""),
    description_i18n_en: str = Form(""),
    description_i18n_zh_TW: str = Form(""),
    description_i18n_ja: str = Form(""),
    detail_content_i18n_zh: str = Form(""),
    detail_content_i18n_en: str = Form(""),
    detail_content_i18n_zh_TW: str = Form(""),
    detail_content_i18n_ja: str = Form(""),
    reward_text_i18n_zh: str = Form(""),
    reward_text_i18n_en: str = Form(""),
    reward_text_i18n_zh_TW: str = Form(""),
    reward_text_i18n_ja: str = Form(""),
    reward_value: str = Form(""),
    cover_url: str = Form(""),
    banner_url: str = Form(""),
    banner_type: str = Form("image"),
    video_url: str = Form(""),
    status: str = Form(ACTIVE_STATUS),
    sort_order: str = Form("0"),
    start_at: str = Form(""),
    end_at: str = Form(""),
    cta_text: str = Form("立即参与"),
    cta_text_i18n_zh: str = Form(""),
    cta_text_i18n_en: str = Form(""),
    cta_text_i18n_zh_TW: str = Form(""),
    cta_text_i18n_ja: str = Form(""),
    cta_url: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    payload = _activity_payload(
        title=title,
        subtitle=subtitle,
        description=description,
        detail_content=detail_content,
        reward_text=reward_text,
        title_i18n_zh=title_i18n_zh,
        title_i18n_en=title_i18n_en,
        title_i18n_zh_TW=title_i18n_zh_TW,
        title_i18n_ja=title_i18n_ja,
        subtitle_i18n_zh=subtitle_i18n_zh,
        subtitle_i18n_en=subtitle_i18n_en,
        subtitle_i18n_zh_TW=subtitle_i18n_zh_TW,
        subtitle_i18n_ja=subtitle_i18n_ja,
        description_i18n_zh=description_i18n_zh,
        description_i18n_en=description_i18n_en,
        description_i18n_zh_TW=description_i18n_zh_TW,
        description_i18n_ja=description_i18n_ja,
        detail_content_i18n_zh=detail_content_i18n_zh,
        detail_content_i18n_en=detail_content_i18n_en,
        detail_content_i18n_zh_TW=detail_content_i18n_zh_TW,
        detail_content_i18n_ja=detail_content_i18n_ja,
        reward_text_i18n_zh=reward_text_i18n_zh,
        reward_text_i18n_en=reward_text_i18n_en,
        reward_text_i18n_zh_TW=reward_text_i18n_zh_TW,
        reward_text_i18n_ja=reward_text_i18n_ja,
        reward_value=reward_value,
        cover_url=cover_url,
        banner_url=banner_url,
        banner_type=banner_type,
        video_url=video_url,
        status=status,
        sort_order=sort_order,
        start_at=start_at,
        end_at=end_at,
        cta_text=cta_text,
        cta_text_i18n_zh=cta_text_i18n_zh,
        cta_text_i18n_en=cta_text_i18n_en,
        cta_text_i18n_zh_TW=cta_text_i18n_zh_TW,
        cta_text_i18n_ja=cta_text_i18n_ja,
        cta_url=cta_url,
    )
    result = admin_create_activity(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/activity_form.html",
            ctx={
                "active_group": "operations",
                "active": "activities",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/activities/new",
                "form": admin_activity_form_from_payload(payload),
                "statuses": ACTIVITY_STATUSES,
                "media_types": MEDIA_TYPES,
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/activities", notice="活动已创建"),
        status_code=302,
    )


@router.get("/activities/{activity_id}/edit", response_class=HTMLResponse)
def activity_edit_page(request: Request, activity_id: int, db: Session = Depends(get_db)):
    redir = require_admin(request)
    if redir:
        return redir
    item = admin_get_activity(db, activity_id)
    if item is None:
        return RedirectResponse(
            url=_build_site_content_redirect_url("/admin/activities", error="活动不存在"),
            status_code=302,
        )
    return render(
        request,
        "admin/activity_form.html",
        ctx={
            "active_group": "operations",
            "active": "activities",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/activities/{activity_id}/edit",
            "form": item,
            "statuses": ACTIVITY_STATUSES,
            "media_types": MEDIA_TYPES,
        },
    )


@router.post("/activities/{activity_id}/edit")
def activity_edit_submit(
    request: Request,
    activity_id: int,
    title: str = Form(""),
    subtitle: str = Form(""),
    description: str = Form(""),
    detail_content: str = Form(""),
    reward_text: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle_i18n_zh: str = Form(""),
    subtitle_i18n_en: str = Form(""),
    subtitle_i18n_zh_TW: str = Form(""),
    subtitle_i18n_ja: str = Form(""),
    description_i18n_zh: str = Form(""),
    description_i18n_en: str = Form(""),
    description_i18n_zh_TW: str = Form(""),
    description_i18n_ja: str = Form(""),
    detail_content_i18n_zh: str = Form(""),
    detail_content_i18n_en: str = Form(""),
    detail_content_i18n_zh_TW: str = Form(""),
    detail_content_i18n_ja: str = Form(""),
    reward_text_i18n_zh: str = Form(""),
    reward_text_i18n_en: str = Form(""),
    reward_text_i18n_zh_TW: str = Form(""),
    reward_text_i18n_ja: str = Form(""),
    reward_value: str = Form(""),
    cover_url: str = Form(""),
    banner_url: str = Form(""),
    banner_type: str = Form("image"),
    video_url: str = Form(""),
    status: str = Form(ACTIVE_STATUS),
    sort_order: str = Form("0"),
    start_at: str = Form(""),
    end_at: str = Form(""),
    cta_text: str = Form("立即参与"),
    cta_text_i18n_zh: str = Form(""),
    cta_text_i18n_en: str = Form(""),
    cta_text_i18n_zh_TW: str = Form(""),
    cta_text_i18n_ja: str = Form(""),
    cta_url: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    payload = _activity_payload(
        title=title,
        subtitle=subtitle,
        description=description,
        detail_content=detail_content,
        reward_text=reward_text,
        title_i18n_zh=title_i18n_zh,
        title_i18n_en=title_i18n_en,
        title_i18n_zh_TW=title_i18n_zh_TW,
        title_i18n_ja=title_i18n_ja,
        subtitle_i18n_zh=subtitle_i18n_zh,
        subtitle_i18n_en=subtitle_i18n_en,
        subtitle_i18n_zh_TW=subtitle_i18n_zh_TW,
        subtitle_i18n_ja=subtitle_i18n_ja,
        description_i18n_zh=description_i18n_zh,
        description_i18n_en=description_i18n_en,
        description_i18n_zh_TW=description_i18n_zh_TW,
        description_i18n_ja=description_i18n_ja,
        detail_content_i18n_zh=detail_content_i18n_zh,
        detail_content_i18n_en=detail_content_i18n_en,
        detail_content_i18n_zh_TW=detail_content_i18n_zh_TW,
        detail_content_i18n_ja=detail_content_i18n_ja,
        reward_text_i18n_zh=reward_text_i18n_zh,
        reward_text_i18n_en=reward_text_i18n_en,
        reward_text_i18n_zh_TW=reward_text_i18n_zh_TW,
        reward_text_i18n_ja=reward_text_i18n_ja,
        reward_value=reward_value,
        cover_url=cover_url,
        banner_url=banner_url,
        banner_type=banner_type,
        video_url=video_url,
        status=status,
        sort_order=sort_order,
        start_at=start_at,
        end_at=end_at,
        cta_text=cta_text,
        cta_text_i18n_zh=cta_text_i18n_zh,
        cta_text_i18n_en=cta_text_i18n_en,
        cta_text_i18n_zh_TW=cta_text_i18n_zh_TW,
        cta_text_i18n_ja=cta_text_i18n_ja,
        cta_url=cta_url,
    )
    result = admin_update_activity(db, activity_id, payload)
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_site_content_redirect_url("/admin/activities", error="活动不存在"),
                status_code=302,
            )
        return render(
            request,
            "admin/activity_form.html",
            ctx={
                "active_group": "operations",
                "active": "activities",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/activities/{activity_id}/edit",
                "form": admin_activity_form_from_payload(payload),
                "statuses": ACTIVITY_STATUSES,
                "media_types": MEDIA_TYPES,
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/activities", notice="活动已保存"),
        status_code=302,
    )


@router.post("/activities/{activity_id}/toggle-status")
def activity_toggle_status(
    request: Request,
    activity_id: int,
    next_path: str = Form("/admin/activities"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    result = admin_toggle_activity_status(db, activity_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/activities",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/activities/{activity_id}/delete")
def activity_delete_submit(request: Request, activity_id: int, db: Session = Depends(get_db)):
    redir = require_admin(request)
    if redir:
        return redir
    result = admin_delete_activity(db, activity_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/activities",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
        ),
        status_code=302,
    )


@router.get("/activity-banners", response_class=HTMLResponse)
def activity_banners_page(
    request: Request,
    keyword: str = "",
    enabled: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_activity_banners(
        db,
        {"keyword": keyword, "enabled": enabled, "page": page, "page_size": page_size},
    )
    return render(
        request,
        "admin/activity_banners.html",
        ctx={
            "active_group": "operations",
            "active": "activity_banners",
            "items": result["items"],
            "filters": {"keyword": keyword, "enabled": enabled},
            "pagination": {
                "page": result["page"],
                "page_size": result["page_size"],
                "total": result["total"],
                "pages": result["pages"],
            },
            "notice": notice,
            "error": error,
        },
    )


@router.get("/activity-banners/new", response_class=HTMLResponse)
def activity_banner_create_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir
    return render(
        request,
        "admin/activity_banner_form.html",
        ctx={
            "active_group": "operations",
            "active": "activity_banners",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/activity-banners/new",
            "form": _banner_default_form(),
            "media_types": MEDIA_TYPES,
        },
    )


@router.post("/activity-banners/new")
def activity_banner_create_submit(
    request: Request,
    title: str = Form(""),
    subtitle: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle_i18n_zh: str = Form(""),
    subtitle_i18n_en: str = Form(""),
    subtitle_i18n_zh_TW: str = Form(""),
    subtitle_i18n_ja: str = Form(""),
    media_type: str = Form("image"),
    media_url: str = Form(""),
    link_url: str = Form(""),
    sort_order: str = Form("0"),
    enabled: str = Form(""),
    start_at: str = Form(""),
    end_at: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    payload = _banner_payload(
        title=title,
        subtitle=subtitle,
        title_i18n_zh=title_i18n_zh,
        title_i18n_en=title_i18n_en,
        title_i18n_zh_TW=title_i18n_zh_TW,
        title_i18n_ja=title_i18n_ja,
        subtitle_i18n_zh=subtitle_i18n_zh,
        subtitle_i18n_en=subtitle_i18n_en,
        subtitle_i18n_zh_TW=subtitle_i18n_zh_TW,
        subtitle_i18n_ja=subtitle_i18n_ja,
        media_type=media_type,
        media_url=media_url,
        link_url=link_url,
        sort_order=sort_order,
        enabled=enabled,
        start_at=start_at,
        end_at=end_at,
    )
    result = admin_create_activity_banner(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/activity_banner_form.html",
            ctx={
                "active_group": "operations",
                "active": "activity_banners",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/activity-banners/new",
                "form": admin_activity_banner_form_from_payload(payload),
                "media_types": MEDIA_TYPES,
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/activity-banners", notice="活动 Banner 已创建"),
        status_code=302,
    )


@router.get("/activity-banners/{banner_id}/edit", response_class=HTMLResponse)
def activity_banner_edit_page(request: Request, banner_id: int, db: Session = Depends(get_db)):
    redir = require_admin(request)
    if redir:
        return redir
    item = admin_get_activity_banner(db, banner_id)
    if item is None:
        return RedirectResponse(
            url=_build_site_content_redirect_url("/admin/activity-banners", error="活动 Banner 不存在"),
            status_code=302,
        )
    return render(
        request,
        "admin/activity_banner_form.html",
        ctx={
            "active_group": "operations",
            "active": "activity_banners",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/activity-banners/{banner_id}/edit",
            "form": item,
            "media_types": MEDIA_TYPES,
        },
    )


@router.post("/activity-banners/{banner_id}/edit")
def activity_banner_edit_submit(
    request: Request,
    banner_id: int,
    title: str = Form(""),
    subtitle: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle_i18n_zh: str = Form(""),
    subtitle_i18n_en: str = Form(""),
    subtitle_i18n_zh_TW: str = Form(""),
    subtitle_i18n_ja: str = Form(""),
    media_type: str = Form("image"),
    media_url: str = Form(""),
    link_url: str = Form(""),
    sort_order: str = Form("0"),
    enabled: str = Form(""),
    start_at: str = Form(""),
    end_at: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    payload = _banner_payload(
        title=title,
        subtitle=subtitle,
        title_i18n_zh=title_i18n_zh,
        title_i18n_en=title_i18n_en,
        title_i18n_zh_TW=title_i18n_zh_TW,
        title_i18n_ja=title_i18n_ja,
        subtitle_i18n_zh=subtitle_i18n_zh,
        subtitle_i18n_en=subtitle_i18n_en,
        subtitle_i18n_zh_TW=subtitle_i18n_zh_TW,
        subtitle_i18n_ja=subtitle_i18n_ja,
        media_type=media_type,
        media_url=media_url,
        link_url=link_url,
        sort_order=sort_order,
        enabled=enabled,
        start_at=start_at,
        end_at=end_at,
    )
    result = admin_update_activity_banner(db, banner_id, payload)
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_site_content_redirect_url("/admin/activity-banners", error="活动 Banner 不存在"),
                status_code=302,
            )
        return render(
            request,
            "admin/activity_banner_form.html",
            ctx={
                "active_group": "operations",
                "active": "activity_banners",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/activity-banners/{banner_id}/edit",
                "form": admin_activity_banner_form_from_payload(payload),
                "media_types": MEDIA_TYPES,
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/activity-banners", notice="活动 Banner 已保存"),
        status_code=302,
    )


@router.post("/activity-banners/{banner_id}/toggle-enabled")
def activity_banner_toggle_enabled(
    request: Request,
    banner_id: int,
    next_path: str = Form("/admin/activity-banners"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    result = admin_toggle_activity_banner_enabled(db, banner_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/activity-banners",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/activity-banners/{banner_id}/delete")
def activity_banner_delete_submit(request: Request, banner_id: int, db: Session = Depends(get_db)):
    redir = require_admin(request)
    if redir:
        return redir
    result = admin_delete_activity_banner(db, banner_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/activity-banners",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
        ),
        status_code=302,
    )
