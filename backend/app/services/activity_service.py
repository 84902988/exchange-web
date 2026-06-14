from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from math import ceil
from typing import Any, Optional

from sqlalchemy import inspect, or_, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.core.content_locale import DEFAULT_CONTENT_LOCALE, localize_i18n_value
from app.db.models.activity import Activity, ActivityBanner


ACTIVE_STATUS = "active"
INACTIVE_STATUS = "inactive"
ENDED_STATUS = "ended"
ACTIVITY_STATUSES = (ACTIVE_STATUS, INACTIVE_STATUS, ENDED_STATUS)
MEDIA_TYPES = ("image", "video")
ACTIVITY_I18N_FIELDS = {
    "title": "title_i18n",
    "subtitle": "subtitle_i18n",
    "description": "description_i18n",
    "detail_content": "detail_content_i18n",
    "reward_text": "reward_text_i18n",
    "cta_text": "cta_text_i18n",
}
ACTIVITY_BANNER_I18N_FIELDS = {
    "title": "title_i18n",
    "subtitle": "subtitle_i18n",
}
ADMIN_I18N_LOCALES = (
    ("zh", "zh"),
    ("en", "en"),
    ("zh-TW", "zh_TW"),
    ("ja", "ja"),
)


DEFAULT_ACTIVITIES: list[dict[str, Any]] = [
    {
        "id": 1,
        "title": "New User Welcome",
        "subtitle": "Complete registration and verification to claim rewards",
        "description": "New users can claim trial rewards after registration, login, and basic verification.",
        "detail_content": "Rules:\n1. Available to new users during the campaign period.\n2. Rewards are credited after basic verification.\n3. Rewards are non-transferable and subject to platform risk review.\nRequirements: complete registration, login, and basic identity verification.",
        "reward_text": "Up to 100 USDT trial reward",
        "reward_value": Decimal("100"),
        "cover_url": "/icons/logo-1.svg",
        "banner_url": "",
        "banner_type": "image",
        "video_url": "",
        "status": ACTIVE_STATUS,
        "sort_order": 10,
        "start_at": None,
        "end_at": datetime(2026, 12, 31, 23, 59, 59),
        "cta_text": "Join now",
        "cta_url": "/register",
    },
    {
        "id": 2,
        "title": "Invite Friends",
        "subtitle": "Earn commission when invited users trade",
        "description": "Generate an invitation link and earn commission rewards after friends complete valid trades.",
        "detail_content": "Rules:\n1. Invited users must register and complete valid trades.\n2. Commission is settled according to platform rules.\n3. Abnormal or wash trades are excluded.\nRequirements: log in and share your invitation link.",
        "reward_text": "Up to 30% commission",
        "reward_value": Decimal("30"),
        "cover_url": "/icons/logo-1.svg",
        "banner_url": "",
        "banner_type": "image",
        "video_url": "",
        "status": ACTIVE_STATUS,
        "sort_order": 20,
        "start_at": None,
        "end_at": datetime(2026, 12, 31, 23, 59, 59),
        "cta_text": "View invite link",
        "cta_url": "/invite",
    },
    {
        "id": 3,
        "title": "Weekly Trading Race",
        "subtitle": "Weekly ranking by trading volume",
        "description": "Reach the weekly trading threshold to enter the leaderboard and compete for rewards.",
        "detail_content": "Rules:\n1. The cycle runs from Monday 00:00 to Sunday 23:59.\n2. Ranking is based on valid trading volume.\n3. Rewards are distributed after the campaign ends.\nRequirements: complete valid spot or contract trades during the campaign.",
        "reward_text": "5,000 USDT reward pool",
        "reward_value": Decimal("5000"),
        "cover_url": "/icons/logo-1.svg",
        "banner_url": "",
        "banner_type": "image",
        "video_url": "",
        "status": ACTIVE_STATUS,
        "sort_order": 30,
        "start_at": None,
        "end_at": datetime(2026, 12, 31, 23, 59, 59),
        "cta_text": "Start trading",
        "cta_url": "/trade/spot",
    },
]


DEFAULT_BANNERS: list[dict[str, Any]] = [
    {
        "id": 1,
        "title": "Royal Exchange Activity Center",
        "subtitle": "Campaigns and rewards are updated regularly",
        "media_type": "image",
        "media_url": "/icons/logo-1.svg",
        "link_url": "/activity",
        "sort_order": 10,
        "enabled": True,
        "start_at": None,
        "end_at": datetime(2026, 12, 31, 23, 59, 59),
    }
]

def _now() -> datetime:
    return datetime.utcnow()


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _clean_optional(value: Any) -> Optional[str]:
    cleaned = _clean(value)
    return cleaned or None


def _i18n_form_key(field_name: str, suffix: str) -> str:
    return f"{field_name}_i18n_{suffix}"


def _normalize_i18n_payload(payload: dict[str, Any], field_map: dict[str, str]) -> dict[str, dict[str, str]]:
    data: dict[str, dict[str, str]] = {}
    for field_name, i18n_field_name in field_map.items():
        translations: dict[str, str] = {}
        for locale, suffix in ADMIN_I18N_LOCALES:
            translations[locale] = _clean(payload.get(_i18n_form_key(field_name, suffix)))
        data[i18n_field_name] = translations
    return data


def _read_i18n_dict(source: Any, i18n_field_name: str) -> dict[str, Any]:
    value = source.get(i18n_field_name) if isinstance(source, dict) else getattr(source, i18n_field_name, None)
    return value if isinstance(value, dict) else {}


def _append_i18n_form_fields(form: dict[str, Any], source: Any, field_map: dict[str, str]) -> dict[str, Any]:
    for field_name, i18n_field_name in field_map.items():
        translations = _read_i18n_dict(source, i18n_field_name)
        for locale, suffix in ADMIN_I18N_LOCALES:
            key = _i18n_form_key(field_name, suffix)
            form[key] = _clean(source.get(key)) if isinstance(source, dict) and key in source else str(translations.get(locale) or "")
    return form


def _i18n_value_complete(row: Any, field_name: str, i18n_field_name: str, locale: str) -> bool:
    getter = row.get if isinstance(row, dict) else lambda key, default=None: getattr(row, key, default)
    base_value = getter(field_name, None)
    if str(base_value or "").strip() == "":
        return True
    translations = _read_i18n_dict(row, i18n_field_name)
    return str(translations.get(locale) or "").strip() != ""


def _translation_status(row: Any, field_map: dict[str, str]) -> dict[str, Any]:
    complete_locales: list[str] = []
    missing_locales: list[str] = []
    for locale, _suffix in ADMIN_I18N_LOCALES:
        is_complete = all(_i18n_value_complete(row, field_name, i18n_field_name, locale) for field_name, i18n_field_name in field_map.items())
        if is_complete:
            complete_locales.append(locale)
        else:
            missing_locales.append(locale)
    label = f"{len(complete_locales)}/{len(ADMIN_I18N_LOCALES)}"
    if missing_locales:
        label = "\u7f3a " + "/".join(missing_locales)
    return {
        "i18n_status_label": label,
        "i18n_complete_count": len(complete_locales),
        "i18n_total_count": len(ADMIN_I18N_LOCALES),
        "i18n_missing_locales": missing_locales,
    }


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value if value is not None else default).strip())
    except (TypeError, ValueError):
        return default


def _parse_decimal(value: Any) -> Optional[Decimal]:
    cleaned = _clean(value)
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except Exception:
        return None


def _parse_bool(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _parse_datetime(value: Any) -> Optional[datetime]:
    cleaned = _clean(value)
    if not cleaned:
        return None
    normalized = cleaned.replace("T", " ")
    if len(normalized) == 16:
        normalized = f"{normalized}:00"
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _format_datetime(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _format_admin_datetime(value: Optional[datetime]) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S") if value else ""


def _format_datetime_local(value: Optional[datetime]) -> str:
    return value.strftime("%Y-%m-%dT%H:%M") if value else ""


def _normalize_status(value: Any) -> str:
    status = _clean(value).lower()
    return status if status in ACTIVITY_STATUSES else INACTIVE_STATUS


def _normalize_media_type(value: Any) -> str:
    media_type = _clean(value).lower()
    return media_type if media_type in MEDIA_TYPES else "image"


def _status_label(status: str) -> str:
    return {
        ACTIVE_STATUS: "Active",
        INACTIVE_STATUS: "Inactive",
        ENDED_STATUS: "Ended",
    }.get(status, "Inactive")

def _status_badge(status: str) -> str:
    return {
        ACTIVE_STATUS: "success",
        INACTIVE_STATUS: "neutral",
        ENDED_STATUS: "warning",
    }.get(status, "neutral")


def _pagination(page: int, page_size: int, total: int) -> dict[str, int]:
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": max(1, ceil(total / page_size)) if page_size else 1,
    }


def _table_exists(db: Session, table_name: str) -> bool:
    bind = db.get_bind()
    try:
        return inspect(bind).has_table(table_name)
    except Exception:
        return True


def _fallback_for_missing_table(exc: Exception) -> bool:
    return isinstance(exc, (OperationalError, ProgrammingError))


def _localized_value(getter, i18n_field_name: str, locale: str, fallback: Any = "", *, include_i18n: bool) -> Any:
    if not include_i18n:
        return fallback
    return localize_i18n_value(getter(i18n_field_name, None), locale, fallback)


def serialize_activity(
    row: Activity | dict[str, Any],
    *,
    locale: str = DEFAULT_CONTENT_LOCALE,
    include_i18n: bool = False,
    include_translation_status: bool = False,
) -> dict[str, Any]:
    getter = row.get if isinstance(row, dict) else lambda key, default=None: getattr(row, key, default)
    status = _normalize_status(getter("status", ACTIVE_STATUS))
    data = {
        "id": int(getter("id", 0) or 0),
        "title": _localized_value(getter, "title_i18n", locale, getter("title", "") or "", include_i18n=include_i18n),
        "subtitle": _localized_value(getter, "subtitle_i18n", locale, getter("subtitle", "") or "", include_i18n=include_i18n),
        "description": _localized_value(getter, "description_i18n", locale, getter("description", "") or "", include_i18n=include_i18n),
        "detail_content": _localized_value(getter, "detail_content_i18n", locale, getter("detail_content", "") or "", include_i18n=include_i18n),
        "reward_text": _localized_value(getter, "reward_text_i18n", locale, getter("reward_text", "") or "", include_i18n=include_i18n),
        "reward_value": getter("reward_value", None),
        "cover_url": getter("cover_url", "") or "",
        "banner_url": getter("banner_url", "") or "",
        "banner_type": _normalize_media_type(getter("banner_type", "image")),
        "video_url": getter("video_url", "") or "",
        "status": status,
        "status_label": _status_label(status),
        "status_badge": _status_badge(status),
        "sort_order": int(getter("sort_order", 0) or 0),
        "start_at": _format_datetime(getter("start_at", None)),
        "end_at": _format_datetime(getter("end_at", None)),
        "start_at_admin": _format_admin_datetime(getter("start_at", None)),
        "end_at_admin": _format_admin_datetime(getter("end_at", None)),
        "start_at_input": _format_datetime_local(getter("start_at", None)),
        "end_at_input": _format_datetime_local(getter("end_at", None)),
        "cta_text": _localized_value(getter, "cta_text_i18n", locale, getter("cta_text", "") or "绔嬪嵆鍙備笌", include_i18n=include_i18n),
        "cta_url": getter("cta_url", "") or "",
        "created_at": _format_admin_datetime(getter("created_at", None)),
        "updated_at": _format_admin_datetime(getter("updated_at", None)),
    }
    if include_translation_status:
        data.update(_translation_status(row, ACTIVITY_I18N_FIELDS))
    return data


def serialize_activity_banner(
    row: ActivityBanner | dict[str, Any],
    *,
    locale: str = DEFAULT_CONTENT_LOCALE,
    include_i18n: bool = False,
    include_translation_status: bool = False,
) -> dict[str, Any]:
    getter = row.get if isinstance(row, dict) else lambda key, default=None: getattr(row, key, default)
    enabled = bool(getter("enabled", True))
    data = {
        "id": int(getter("id", 0) or 0),
        "title": _localized_value(getter, "title_i18n", locale, getter("title", "") or "", include_i18n=include_i18n),
        "subtitle": _localized_value(getter, "subtitle_i18n", locale, getter("subtitle", "") or "", include_i18n=include_i18n),
        "media_type": _normalize_media_type(getter("media_type", "image")),
        "media_url": getter("media_url", "") or "",
        "link_url": getter("link_url", "") or "",
        "sort_order": int(getter("sort_order", 0) or 0),
        "enabled": enabled,
        "status_label": "启用" if enabled else "禁用",
        "status_badge": "success" if enabled else "neutral",
        "start_at": _format_datetime(getter("start_at", None)),
        "end_at": _format_datetime(getter("end_at", None)),
        "start_at_admin": _format_admin_datetime(getter("start_at", None)),
        "end_at_admin": _format_admin_datetime(getter("end_at", None)),
        "start_at_input": _format_datetime_local(getter("start_at", None)),
        "end_at_input": _format_datetime_local(getter("end_at", None)),
        "created_at": _format_admin_datetime(getter("created_at", None)),
        "updated_at": _format_admin_datetime(getter("updated_at", None)),
    }
    if include_translation_status:
        data.update(_translation_status(row, ACTIVITY_BANNER_I18N_FIELDS))
    return data


def _seed_defaults_if_empty(db: Session) -> None:
    if not _table_exists(db, "activities") or not _table_exists(db, "activity_banners"):
        return
    if db.query(Activity.id).first() is None:
        for item in DEFAULT_ACTIVITIES:
            db.add(Activity(**{k: v for k, v in item.items() if k != "id"}))
    if db.query(ActivityBanner.id).first() is None:
        for item in DEFAULT_BANNERS:
            db.add(ActivityBanner(**{k: v for k, v in item.items() if k != "id"}))
    db.commit()


def get_public_activities(
    db: Session,
    limit: int = 6,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> list[dict[str, Any]]:
    try:
        _seed_defaults_if_empty(db)
        now = _now()
        rows = (
            db.query(Activity)
            .filter(Activity.status == ACTIVE_STATUS)
            .filter(or_(Activity.start_at.is_(None), Activity.start_at <= now))
            .filter(or_(Activity.end_at.is_(None), Activity.end_at >= now))
            .order_by(Activity.sort_order.asc(), Activity.id.asc())
            .limit(max(1, min(int(limit or 6), 20)))
            .all()
        )
        return [serialize_activity(row, locale=locale, include_i18n=True) for row in rows]
    except Exception as exc:
        db.rollback()
        if _fallback_for_missing_table(exc):
            return [serialize_activity(item, locale=locale, include_i18n=True) for item in DEFAULT_ACTIVITIES[:limit]]
        raise


def get_public_activity(
    db: Session,
    activity_id: int,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> Optional[dict[str, Any]]:
    try:
        _seed_defaults_if_empty(db)
        now = _now()
        row = (
            db.query(Activity)
            .filter(Activity.id == activity_id)
            .filter(Activity.status == ACTIVE_STATUS)
            .filter(or_(Activity.start_at.is_(None), Activity.start_at <= now))
            .filter(or_(Activity.end_at.is_(None), Activity.end_at >= now))
            .first()
        )
        return serialize_activity(row, locale=locale, include_i18n=True) if row else None
    except Exception as exc:
        db.rollback()
        if _fallback_for_missing_table(exc):
            for item in DEFAULT_ACTIVITIES:
                if int(item["id"]) == int(activity_id):
                    return serialize_activity(item, locale=locale, include_i18n=True)
            return None
        raise


def get_public_activity_banners(
    db: Session,
    limit: int = 6,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> list[dict[str, Any]]:
    try:
        _seed_defaults_if_empty(db)
        now = _now()
        rows = (
            db.query(ActivityBanner)
            .filter(ActivityBanner.enabled.is_(True))
            .filter(or_(ActivityBanner.start_at.is_(None), ActivityBanner.start_at <= now))
            .filter(or_(ActivityBanner.end_at.is_(None), ActivityBanner.end_at >= now))
            .order_by(ActivityBanner.sort_order.asc(), ActivityBanner.id.asc())
            .limit(max(1, min(int(limit or 6), 20)))
            .all()
        )
        return [serialize_activity_banner(row, locale=locale, include_i18n=True) for row in rows]
    except Exception as exc:
        db.rollback()
        if _fallback_for_missing_table(exc):
            return [serialize_activity_banner(item, locale=locale, include_i18n=True) for item in DEFAULT_BANNERS[:limit]]
        raise


def admin_query_activities(db: Session, filters: dict[str, Any]) -> dict[str, Any]:
    _seed_defaults_if_empty(db)
    page = max(1, _parse_int(filters.get("page"), 1))
    page_size = min(max(1, _parse_int(filters.get("page_size"), 20)), 100)
    query = db.query(Activity)
    count_query = db.query(Activity.id)

    status = _clean(filters.get("status")).lower()
    if status in ACTIVITY_STATUSES:
        query = query.filter(Activity.status == status)
        count_query = count_query.filter(Activity.status == status)

    keyword = _clean(filters.get("keyword"))
    if keyword:
        condition = or_(Activity.title.like(f"%{keyword}%"), Activity.description.like(f"%{keyword}%"))
        query = query.filter(condition)
        count_query = count_query.filter(condition)

    total = int(count_query.count())
    rows = (
        query.order_by(Activity.sort_order.asc(), Activity.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [serialize_activity(row, include_translation_status=True) for row in rows],
        **_pagination(page, page_size, total),
    }


def admin_query_activity_banners(db: Session, filters: dict[str, Any]) -> dict[str, Any]:
    _seed_defaults_if_empty(db)
    page = max(1, _parse_int(filters.get("page"), 1))
    page_size = min(max(1, _parse_int(filters.get("page_size"), 20)), 100)
    query = db.query(ActivityBanner)
    count_query = db.query(ActivityBanner.id)

    enabled = _clean(filters.get("enabled")).lower()
    if enabled in {"1", "0"}:
        value = enabled == "1"
        query = query.filter(ActivityBanner.enabled.is_(value))
        count_query = count_query.filter(ActivityBanner.enabled.is_(value))

    keyword = _clean(filters.get("keyword"))
    if keyword:
        condition = ActivityBanner.title.like(f"%{keyword}%")
        query = query.filter(condition)
        count_query = count_query.filter(condition)

    total = int(count_query.count())
    rows = (
        query.order_by(ActivityBanner.sort_order.asc(), ActivityBanner.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [serialize_activity_banner(row, include_translation_status=True) for row in rows],
        **_pagination(page, page_size, total),
    }


def admin_get_activity(db: Session, activity_id: int) -> Optional[dict[str, Any]]:
    _seed_defaults_if_empty(db)
    row = db.query(Activity).filter(Activity.id == activity_id).first()
    return _append_i18n_form_fields(serialize_activity(row, include_translation_status=True), row, ACTIVITY_I18N_FIELDS) if row else None


def admin_get_activity_banner(db: Session, banner_id: int) -> Optional[dict[str, Any]]:
    _seed_defaults_if_empty(db)
    row = db.query(ActivityBanner).filter(ActivityBanner.id == banner_id).first()
    return _append_i18n_form_fields(serialize_activity_banner(row, include_translation_status=True), row, ACTIVITY_BANNER_I18N_FIELDS) if row else None


def _normalize_activity_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": _clean(payload.get("title")),
        "subtitle": _clean_optional(payload.get("subtitle")),
        "description": _clean_optional(payload.get("description")),
        "detail_content": _clean_optional(payload.get("detail_content")),
        "reward_text": _clean_optional(payload.get("reward_text")),
        "reward_value": _parse_decimal(payload.get("reward_value")),
        "cover_url": _clean_optional(payload.get("cover_url")),
        "banner_url": _clean_optional(payload.get("banner_url")),
        "banner_type": _normalize_media_type(payload.get("banner_type")),
        "video_url": _clean_optional(payload.get("video_url")),
        "status": _normalize_status(payload.get("status")),
        "sort_order": _parse_int(payload.get("sort_order"), 0),
        "start_at": _parse_datetime(payload.get("start_at")),
        "end_at": _parse_datetime(payload.get("end_at")),
        "cta_text": _clean_optional(payload.get("cta_text")) or "绔嬪嵆鍙備笌",
        "cta_url": _clean_optional(payload.get("cta_url")),
    }


def _normalize_banner_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": _clean(payload.get("title")),
        "subtitle": _clean_optional(payload.get("subtitle")),
        "media_type": _normalize_media_type(payload.get("media_type")),
        "media_url": _clean_optional(payload.get("media_url")),
        "link_url": _clean_optional(payload.get("link_url")),
        "sort_order": _parse_int(payload.get("sort_order"), 0),
        "enabled": _parse_bool(payload.get("enabled")),
        "start_at": _parse_datetime(payload.get("start_at")),
        "end_at": _parse_datetime(payload.get("end_at")),
    }


def _validate_window(form: dict[str, Any]) -> list[str]:
    if form["start_at"] and form["end_at"] and form["start_at"] > form["end_at"]:
        return ["Start time cannot be later than end time"]
    return []


def _validate_activity_form(form: dict[str, Any]) -> list[str]:
    errors = []
    if not form["title"]:
        errors.append("Activity title is required")
    if form["banner_type"] == "video" and not form["video_url"] and not form["banner_url"]:
        errors.append("Video activity requires a video URL or banner media URL")
    errors.extend(_validate_window(form))
    return errors


def _validate_banner_form(form: dict[str, Any]) -> list[str]:
    errors = []
    if not form["title"]:
        errors.append("Banner title is required")
    if form["media_type"] == "video" and not form["media_url"]:
        errors.append("Video banner requires a media URL")
    errors.extend(_validate_window(form))
    return errors


def admin_activity_form_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_activity_payload(payload)
    form_with_inputs = {
        **form,
        "start_at_input": _clean(payload.get("start_at")),
        "end_at_input": _clean(payload.get("end_at")),
    }
    return _append_i18n_form_fields(form_with_inputs, payload, ACTIVITY_I18N_FIELDS)


def admin_activity_banner_form_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_banner_payload(payload)
    form_with_inputs = {
        **form,
        "start_at_input": _clean(payload.get("start_at")),
        "end_at_input": _clean(payload.get("end_at")),
    }
    return _append_i18n_form_fields(form_with_inputs, payload, ACTIVITY_BANNER_I18N_FIELDS)


def admin_create_activity(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_activity_payload(payload)
    errors = _validate_activity_form(form)
    if errors:
        return {"ok": False, "errors": errors, "form": admin_activity_form_from_payload(payload)}
    form.update(_normalize_i18n_payload(payload, ACTIVITY_I18N_FIELDS))
    row = Activity(**form)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"ok": True, "id": int(row.id), "form": serialize_activity(row, include_translation_status=True)}


def admin_update_activity(db: Session, activity_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    row = db.query(Activity).filter(Activity.id == activity_id).first()
    if row is None:
        return {"ok": False, "errors": ["Activity does not exist"], "not_found": True}
    form = _normalize_activity_payload(payload)
    errors = _validate_activity_form(form)
    if errors:
        return {"ok": False, "errors": errors, "form": admin_activity_form_from_payload(payload)}
    for key, value in form.items():
        setattr(row, key, value)
    for key, value in _normalize_i18n_payload(payload, ACTIVITY_I18N_FIELDS).items():
        setattr(row, key, value)
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return {"ok": True, "id": int(row.id), "form": serialize_activity(row, include_translation_status=True)}


def admin_toggle_activity_status(db: Session, activity_id: int) -> dict[str, Any]:
    row = db.query(Activity).filter(Activity.id == activity_id).first()
    if row is None:
        return {"ok": False, "message": "Activity does not exist"}
    row.status = INACTIVE_STATUS if row.status == ACTIVE_STATUS else ACTIVE_STATUS
    row.updated_at = _now()
    db.commit()
    return {"ok": True, "message": f"Activity is now {_status_label(row.status)}"}


def admin_delete_activity(db: Session, activity_id: int) -> dict[str, Any]:
    row = db.query(Activity).filter(Activity.id == activity_id).first()
    if row is None:
        return {"ok": False, "message": "Activity does not exist"}
    db.delete(row)
    db.commit()
    return {"ok": True, "message": "Activity deleted"}


def admin_create_activity_banner(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_banner_payload(payload)
    errors = _validate_banner_form(form)
    if errors:
        return {"ok": False, "errors": errors, "form": admin_activity_banner_form_from_payload(payload)}
    form.update(_normalize_i18n_payload(payload, ACTIVITY_BANNER_I18N_FIELDS))
    row = ActivityBanner(**form)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"ok": True, "id": int(row.id), "form": serialize_activity_banner(row, include_translation_status=True)}


def admin_update_activity_banner(db: Session, banner_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    row = db.query(ActivityBanner).filter(ActivityBanner.id == banner_id).first()
    if row is None:
        return {"ok": False, "errors": ["Banner does not exist"], "not_found": True}
    form = _normalize_banner_payload(payload)
    errors = _validate_banner_form(form)
    if errors:
        return {"ok": False, "errors": errors, "form": admin_activity_banner_form_from_payload(payload)}
    for key, value in form.items():
        setattr(row, key, value)
    for key, value in _normalize_i18n_payload(payload, ACTIVITY_BANNER_I18N_FIELDS).items():
        setattr(row, key, value)
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return {"ok": True, "id": int(row.id), "form": serialize_activity_banner(row, include_translation_status=True)}


def admin_toggle_activity_banner_enabled(db: Session, banner_id: int) -> dict[str, Any]:
    row = db.query(ActivityBanner).filter(ActivityBanner.id == banner_id).first()
    if row is None:
        return {"ok": False, "message": "Banner does not exist"}
    row.enabled = not bool(row.enabled)
    row.updated_at = _now()
    db.commit()
    return {"ok": True, "message": f"Banner is now {'enabled' if row.enabled else 'disabled'}"}


def admin_delete_activity_banner(db: Session, banner_id: int) -> dict[str, Any]:
    row = db.query(ActivityBanner).filter(ActivityBanner.id == banner_id).first()
    if row is None:
        return {"ok": False, "message": "Banner does not exist"}
    db.delete(row)
    db.commit()
    return {"ok": True, "message": "Banner deleted"}
