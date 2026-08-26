from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.routers.admin_pages import render, require_admin, require_admin_permission, require_admin_post_permission
from app.services.mobile_content_service import (
    admin_get_mobile_announcement,
    admin_get_mobile_banner,
    admin_list_mobile_announcements,
    admin_list_mobile_banners,
    admin_save_mobile_announcement,
    admin_save_mobile_banner,
    admin_set_mobile_announcement_status,
    admin_toggle_mobile_banner,
    get_or_create_mobile_settings,
    mobile_settings_form,
    preview_mobile_announcement_content,
    update_mobile_settings,
)


router = APIRouter(prefix="/admin/mobile-content", tags=["AdminMobileContent"])
PERMISSION = "mobile_content.manage"


def _redirect(path: str, *, notice: str = "", error: str = "") -> RedirectResponse:
    query = urlencode({key: value for key, value in {"notice": notice, "error": error}.items() if value})
    return RedirectResponse(url=f"{path}?{query}" if query else path, status_code=302)


def _get_guard(request: Request, db: Session):
    redir = require_admin(request)
    return redir or require_admin_permission(request, db, PERMISSION)


async def _payload(request: Request) -> dict[str, Any]:
    form = await request.form()
    return {str(key): str(value) for key, value in form.items()}


@router.get("/settings", response_class=HTMLResponse)
def mobile_settings_page(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    guard = _get_guard(request, db)
    if guard:
        return guard
    return render(
        request,
        "admin/mobile_content_settings.html",
        ctx={
            "active_group": "operations",
            "active": "mobile_content_settings",
            "form": mobile_settings_form(get_or_create_mobile_settings(db), db=db),
            "notice": notice,
            "error": error,
            "errors": [],
        },
    )


@router.post("/settings")
async def mobile_settings_submit(request: Request, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    payload = await _payload(request)
    result = update_mobile_settings(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/mobile_content_settings.html",
            ctx={
                "active_group": "operations",
                "active": "mobile_content_settings",
                "form": result["form"],
                "errors": result["errors"],
                "notice": "",
                "error": "",
            },
            status_code=400,
        )
    return _redirect("/admin/mobile-content/settings", notice="移动端设置已保存")


@router.get("/banners", response_class=HTMLResponse)
def mobile_banners_page(
    request: Request,
    keyword: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    guard = _get_guard(request, db)
    if guard:
        return guard
    result = admin_list_mobile_banners(db, keyword, status, max(page, 1), min(max(page_size, 1), 100))
    return render(
        request,
        "admin/mobile_banners.html",
        ctx={
            "active_group": "operations",
            "active": "mobile_banners",
            "items": result["items"],
            "filters": {"keyword": keyword, "status": status},
            "pagination": result,
            "notice": notice,
            "error": error,
        },
    )


def _empty_banner_form() -> dict[str, Any]:
    form = {
        "title": "",
        "subtitle": "",
        "image_url": "",
        "link_url": "",
        "sort_order": 0,
        "status": "ACTIVE",
        "start_at_input": "",
        "end_at_input": "",
        "placement": "PROMO",
        "aspect_ratio": "3:1",
        "recommended_size": "1200x400",
    }
    for suffix in ("zh", "en", "zh_TW", "ja"):
        form[f"title_i18n_{suffix}"] = ""
        form[f"subtitle_i18n_{suffix}"] = ""
    return form


@router.get("/banners/new", response_class=HTMLResponse)
def mobile_banner_new_page(request: Request, db: Session = Depends(get_db)):
    guard = _get_guard(request, db)
    if guard:
        return guard
    return render(
        request,
        "admin/mobile_banner_form.html",
        ctx={
            "active_group": "operations",
            "active": "mobile_banners",
            "is_edit": False,
            "form_action": "/admin/mobile-content/banners/new",
            "form": _empty_banner_form(),
            "errors": [],
        },
    )


@router.post("/banners/new")
async def mobile_banner_new_submit(request: Request, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    result = admin_save_mobile_banner(db, await _payload(request))
    if not result["ok"]:
        return render(
            request,
            "admin/mobile_banner_form.html",
            ctx={
                "active_group": "operations",
                "active": "mobile_banners",
                "is_edit": False,
                "form_action": "/admin/mobile-content/banners/new",
                "form": result["form"],
                "errors": result["errors"],
            },
            status_code=400,
        )
    return _redirect("/admin/mobile-content/banners", notice="移动端 Banner 已新增")


@router.get("/banners/{banner_id}/edit", response_class=HTMLResponse)
def mobile_banner_edit_page(request: Request, banner_id: int, db: Session = Depends(get_db)):
    guard = _get_guard(request, db)
    if guard:
        return guard
    form = admin_get_mobile_banner(db, banner_id)
    if form is None:
        return _redirect("/admin/mobile-content/banners", error="Banner 不存在")
    return render(
        request,
        "admin/mobile_banner_form.html",
        ctx={
            "active_group": "operations",
            "active": "mobile_banners",
            "is_edit": True,
            "form_action": f"/admin/mobile-content/banners/{banner_id}/edit",
            "form": form,
            "errors": [],
        },
    )


@router.post("/banners/{banner_id}/edit")
async def mobile_banner_edit_submit(request: Request, banner_id: int, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    result = admin_save_mobile_banner(db, await _payload(request), banner_id=banner_id)
    if result.get("not_found"):
        return _redirect("/admin/mobile-content/banners", error="Banner 不存在")
    if not result["ok"]:
        return render(
            request,
            "admin/mobile_banner_form.html",
            ctx={
                "active_group": "operations",
                "active": "mobile_banners",
                "is_edit": True,
                "form_action": f"/admin/mobile-content/banners/{banner_id}/edit",
                "form": result["form"],
                "errors": result["errors"],
            },
            status_code=400,
        )
    return _redirect("/admin/mobile-content/banners", notice="移动端 Banner 已保存")


@router.post("/banners/{banner_id}/toggle")
def mobile_banner_toggle(request: Request, banner_id: int, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    result = admin_toggle_mobile_banner(db, banner_id)
    return _redirect(
        "/admin/mobile-content/banners",
        notice="Banner 状态已切换" if result["ok"] else "",
        error=result["error"] if not result["ok"] else "",
    )


@router.get("/announcements", response_class=HTMLResponse)
def mobile_announcements_page(
    request: Request,
    keyword: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    guard = _get_guard(request, db)
    if guard:
        return guard
    result = admin_list_mobile_announcements(db, keyword, status, max(page, 1), min(max(page_size, 1), 100))
    return render(
        request,
        "admin/mobile_announcements.html",
        ctx={
            "active_group": "operations",
            "active": "mobile_announcements",
            "items": result["items"],
            "filters": {"keyword": keyword, "status": status},
            "pagination": result,
            "notice": notice,
            "error": error,
        },
    )


def _empty_announcement_form() -> dict[str, Any]:
    form = {
        "title": "",
        "slug": "",
        "summary": "",
        "content": "",
        "content_format": "SANITIZED_HTML",
        "is_pinned": False,
        "status": "DRAFT",
        "publish_at_input": "",
    }
    category_defaults = {"zh": "公告", "en": "Announcement", "zh_TW": "公告", "ja": "お知らせ"}
    for suffix in ("zh", "en", "zh_TW", "ja"):
        form[f"title_i18n_{suffix}"] = ""
        form[f"summary_i18n_{suffix}"] = ""
        form[f"category_label_i18n_{suffix}"] = category_defaults[suffix]
        form[f"content_i18n_{suffix}"] = ""
    return form


@router.get("/announcements/new", response_class=HTMLResponse)
def mobile_announcement_new_page(request: Request, db: Session = Depends(get_db)):
    guard = _get_guard(request, db)
    if guard:
        return guard
    return render(
        request,
        "admin/mobile_announcement_form.html",
        ctx={
            "active_group": "operations",
            "active": "mobile_announcements",
            "is_edit": False,
            "form_action": "/admin/mobile-content/announcements/new",
            "form": _empty_announcement_form(),
            "errors": [],
        },
    )


@router.post("/announcements/new")
async def mobile_announcement_new_submit(request: Request, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    result = admin_save_mobile_announcement(db, await _payload(request))
    if not result["ok"]:
        return render(
            request,
            "admin/mobile_announcement_form.html",
            ctx={
                "active_group": "operations",
                "active": "mobile_announcements",
                "is_edit": False,
                "form_action": "/admin/mobile-content/announcements/new",
                "form": result["form"],
                "errors": result["errors"],
            },
            status_code=400,
        )
    return _redirect("/admin/mobile-content/announcements", notice="移动端公告已新增")


@router.post("/announcements/preview")
async def mobile_announcement_preview(request: Request, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    result = preview_mobile_announcement_content(await _payload(request))
    return JSONResponse(result, status_code=200 if result["ok"] else 400)


@router.get("/announcements/{announcement_id}/edit", response_class=HTMLResponse)
def mobile_announcement_edit_page(request: Request, announcement_id: int, db: Session = Depends(get_db)):
    guard = _get_guard(request, db)
    if guard:
        return guard
    form = admin_get_mobile_announcement(db, announcement_id)
    if form is None:
        return _redirect("/admin/mobile-content/announcements", error="公告不存在")
    return render(
        request,
        "admin/mobile_announcement_form.html",
        ctx={
            "active_group": "operations",
            "active": "mobile_announcements",
            "is_edit": True,
            "form_action": f"/admin/mobile-content/announcements/{announcement_id}/edit",
            "form": form,
            "errors": [],
        },
    )


@router.post("/announcements/{announcement_id}/edit")
async def mobile_announcement_edit_submit(request: Request, announcement_id: int, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    result = admin_save_mobile_announcement(db, await _payload(request), announcement_id=announcement_id)
    if result.get("not_found"):
        return _redirect("/admin/mobile-content/announcements", error="公告不存在")
    if not result["ok"]:
        return render(
            request,
            "admin/mobile_announcement_form.html",
            ctx={
                "active_group": "operations",
                "active": "mobile_announcements",
                "is_edit": True,
                "form_action": f"/admin/mobile-content/announcements/{announcement_id}/edit",
                "form": result["form"],
                "errors": result["errors"],
            },
            status_code=400,
        )
    return _redirect("/admin/mobile-content/announcements", notice="移动端公告已保存")


@router.post("/announcements/{announcement_id}/publish")
def mobile_announcement_publish(request: Request, announcement_id: int, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    ok = admin_set_mobile_announcement_status(db, announcement_id, "PUBLISHED")
    return _redirect("/admin/mobile-content/announcements", notice="公告已发布" if ok else "", error="" if ok else "公告不存在")


@router.post("/announcements/{announcement_id}/offline")
def mobile_announcement_offline(request: Request, announcement_id: int, db: Session = Depends(get_db)):
    guard = require_admin_post_permission(request, db, PERMISSION)
    if guard:
        return guard
    ok = admin_set_mobile_announcement_status(db, announcement_id, "OFFLINE")
    return _redirect("/admin/mobile-content/announcements", notice="公告已下线" if ok else "", error="" if ok else "公告不存在")
