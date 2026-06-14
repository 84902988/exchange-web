from __future__ import annotations

from datetime import datetime
import re
from math import ceil
from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.content_locale import DEFAULT_CONTENT_LOCALE, localize_i18n_value
from app.db.models.site_content import HelpArticle, HelpCategory


ADMIN_I18N_LOCALES = (
    ("zh", "zh"),
    ("en", "en"),
    ("zh-TW", "zh_TW"),
    ("ja", "ja"),
)
HELP_CATEGORY_I18N_FIELDS = {
    "title": "title_i18n",
    "description": "description_i18n",
}
HELP_ARTICLE_I18N_FIELDS = {
    "title": "title_i18n",
    "summary": "summary_i18n",
    "content": "content_i18n",
}


def _now() -> datetime:
    return datetime.utcnow()


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _clean_optional(value: Any) -> Optional[str]:
    cleaned = _clean(value)
    return cleaned or None


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value or default).strip())
    except (TypeError, ValueError):
        return default


def _parse_bool(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _slugify(value: str) -> str:
    candidate = _clean(value).lower()
    candidate = re.sub(r"\s+", "-", candidate)
    candidate = re.sub(r"[^a-z0-9\u4e00-\u9fff._-]+", "-", candidate)
    candidate = re.sub(r"-{2,}", "-", candidate).strip("-._")
    return candidate[:191]


def _i18n_form_key(field_name: str, suffix: str) -> str:
    return f"{field_name}_i18n_{suffix}"


def _read_i18n_dict(source: Any, field_name: str) -> dict[str, str]:
    if isinstance(source, dict):
        raw = source.get(field_name)
    else:
        raw = getattr(source, field_name, None)
    return raw if isinstance(raw, dict) else {}


def _build_i18n_payload(payload: dict[str, Any], field_name: str) -> Optional[dict[str, str]]:
    values: dict[str, str] = {}
    for locale, suffix in ADMIN_I18N_LOCALES:
        value = _clean(payload.get(_i18n_form_key(field_name, suffix)))
        if value:
            values[locale] = value
    return values or None


def _append_i18n_form_fields(form: dict[str, Any], source: Any, field_map: dict[str, str]) -> dict[str, Any]:
    for field_name, i18n_field_name in field_map.items():
        translations = _read_i18n_dict(source, i18n_field_name)
        for locale, suffix in ADMIN_I18N_LOCALES:
            key = _i18n_form_key(field_name, suffix)
            if isinstance(source, dict) and key in source:
                value = _clean(source.get(key))
            else:
                value = str(translations.get(locale) or "")
            if not value and locale == "zh":
                value = _clean(source.get(field_name)) if isinstance(source, dict) else _clean(getattr(source, field_name, ""))
            form[key] = value
    return form


def _localize(row: Any, field_name: str, i18n_field_name: str, locale: str) -> str:
    fallback = str(getattr(row, field_name, "") or "")
    return localize_i18n_value(getattr(row, i18n_field_name, None), locale, fallback)


def _parse_tags(value: Any) -> list[str]:
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = re.split(r"[,，\n]", str(value or ""))
    tags: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        tag = _clean(item)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag[:50])
    return tags[:20]


def _tags_text(tags: Any) -> str:
    return ", ".join(_parse_tags(tags))


def _primary_text_from_payload(payload: dict[str, Any], field_name: str) -> str:
    return _clean(payload.get(_i18n_form_key(field_name, "zh"))) or _clean(payload.get(field_name))


def _content_to_sections(content: str, locale: str) -> list[dict[str, Any]]:
    body: list[str] = []
    bullets: list[str] = []
    for raw_line in (content or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        bullet = re.sub(r"^[-*•]\s*", "", line)
        if bullet != line or re.match(r"^\d+[.)、]\s+", line):
            bullets.append(re.sub(r"^\d+[.)、]\s+", "", bullet).strip())
        else:
            body.append(line)
    return [
        {
            "heading": "正文内容" if locale.startswith("zh") else "Content",
            "body": body,
            "bullets": bullets,
        }
    ]


def _serialize_category(row: HelpCategory, *, locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    return {
        "id": row.category_key,
        "category_key": row.category_key,
        "title": _localize(row, "title", "title_i18n", locale),
        "description": _localize(row, "description", "description_i18n", locale),
        "sort_order": row.sort_order,
        "enabled": bool(row.enabled),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _serialize_article(row: HelpArticle, *, category: Optional[HelpCategory] = None, locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    content = _localize(row, "content", "content_i18n", locale)
    data = {
        "id": f"cms-{row.id}",
        "article_id": row.id,
        "slug": row.slug,
        "title": _localize(row, "title", "title_i18n", locale),
        "summary": _localize(row, "summary", "summary_i18n", locale),
        "content": content,
        "sections": _content_to_sections(content, locale),
        "tags": _parse_tags(row.tags_json),
        "hot": bool(row.is_hot),
        "is_hot": bool(row.is_hot),
        "sort_order": row.sort_order,
        "enabled": bool(row.enabled),
        "source_type": row.source_type,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if category is not None:
        data["category_id"] = category.category_key
        data["category_title"] = _localize(category, "title", "title_i18n", locale)
    else:
        data["category_id"] = row.category_id
    return data


def get_public_help_content(db: Session, *, locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    categories = (
        db.query(HelpCategory)
        .options(joinedload(HelpCategory.articles))
        .filter(HelpCategory.enabled.is_(True))
        .order_by(HelpCategory.sort_order.asc(), HelpCategory.id.asc())
        .all()
    )

    serialized_categories: list[dict[str, Any]] = []
    hot_articles: list[dict[str, Any]] = []
    for category in categories:
        articles = [
            article
            for article in sorted(category.articles, key=lambda item: (item.sort_order, item.id))
            if article.enabled
        ]
        if not articles:
            continue
        category_data = _serialize_category(category, locale=locale)
        category_data["articles"] = [
            _serialize_article(article, category=category, locale=locale) for article in articles
        ]
        serialized_categories.append(category_data)
        hot_articles.extend(article for article in category_data["articles"] if article.get("hot"))

    return {
        "categories": serialized_categories,
        "hotArticles": sorted(hot_articles, key=lambda item: (item.get("sort_order", 0), item.get("article_id", 0)))[:12],
    }


def admin_query_help_categories(db: Session, filters: dict[str, Any]) -> dict[str, Any]:
    page = max(1, _parse_int(filters.get("page"), 1))
    page_size = min(max(1, _parse_int(filters.get("page_size"), 20)), 100)
    query = db.query(HelpCategory)

    keyword = _clean(filters.get("keyword"))
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(or_(HelpCategory.category_key.ilike(like), HelpCategory.title.ilike(like)))

    enabled = _clean(filters.get("enabled"))
    if enabled in {"1", "0"}:
        query = query.filter(HelpCategory.enabled.is_(enabled == "1"))

    total = query.count()
    rows = (
        query.order_by(HelpCategory.sort_order.asc(), HelpCategory.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [admin_help_category_form(row) for row in rows]
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": max(1, ceil(total / page_size)) if total else 1,
    }


def admin_list_help_category_options(db: Session) -> list[dict[str, Any]]:
    rows = db.query(HelpCategory).order_by(HelpCategory.sort_order.asc(), HelpCategory.id.asc()).all()
    return [
        {
            "id": row.id,
            "category_key": row.category_key,
            "title": row.title,
            "enabled": bool(row.enabled),
        }
        for row in rows
    ]


def admin_get_help_category(db: Session, category_id: int) -> Optional[dict[str, Any]]:
    row = db.get(HelpCategory, category_id)
    return admin_help_category_form(row) if row else None


def admin_help_category_form(row: HelpCategory) -> dict[str, Any]:
    form = {
        "id": row.id,
        "category_key": row.category_key,
        "title": row.title,
        "description": row.description or "",
        "sort_order": row.sort_order,
        "enabled": bool(row.enabled),
        "status_label": "启用" if row.enabled else "禁用",
        "status_badge": "success" if row.enabled else "secondary",
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }
    return _append_i18n_form_fields(form, row, HELP_CATEGORY_I18N_FIELDS)


def admin_help_category_form_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = {
        "category_key": _slugify(payload.get("category_key")),
        "title": _primary_text_from_payload(payload, "title"),
        "description": _primary_text_from_payload(payload, "description"),
        "sort_order": _parse_int(payload.get("sort_order"), 0),
        "enabled": _parse_bool(payload.get("enabled")),
    }
    return _append_i18n_form_fields(form, payload, HELP_CATEGORY_I18N_FIELDS)


def _normalize_category_payload(payload: dict[str, Any]) -> dict[str, Any]:
    title = _primary_text_from_payload(payload, "title")
    description = _primary_text_from_payload(payload, "description")
    return {
        "category_key": _slugify(payload.get("category_key")),
        "title": title,
        "description": description or None,
        "title_i18n": _build_i18n_payload(payload, "title"),
        "description_i18n": _build_i18n_payload(payload, "description"),
        "sort_order": _parse_int(payload.get("sort_order"), 0),
        "enabled": _parse_bool(payload.get("enabled")),
    }


def _validate_category(db: Session, data: dict[str, Any], *, category_id: Optional[int] = None) -> list[str]:
    errors: list[str] = []
    if not data["category_key"]:
        errors.append("分类 Key 不能为空")
    if not data["title"]:
        errors.append("分类标题不能为空")
    if data["category_key"]:
        query = db.query(HelpCategory).filter(HelpCategory.category_key == data["category_key"])
        if category_id:
            query = query.filter(HelpCategory.id != category_id)
        if query.first() is not None:
            errors.append("分类 Key 已存在")
    return errors


def admin_create_help_category(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    data = _normalize_category_payload(payload)
    errors = _validate_category(db, data)
    if errors:
        return {"ok": False, "errors": errors}
    row = HelpCategory(**data, created_at=_now(), updated_at=_now())
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"ok": False, "errors": ["分类 Key 已存在"]}
    return {"ok": True, "item": admin_help_category_form(row)}


def admin_update_help_category(db: Session, category_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    row = db.get(HelpCategory, category_id)
    if row is None:
        return {"ok": False, "not_found": True, "errors": ["分类不存在"]}
    data = _normalize_category_payload(payload)
    errors = _validate_category(db, data, category_id=category_id)
    if errors:
        return {"ok": False, "errors": errors}
    for key, value in data.items():
        setattr(row, key, value)
    row.updated_at = _now()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"ok": False, "errors": ["分类 Key 已存在"]}
    db.refresh(row)
    return {"ok": True, "item": admin_help_category_form(row)}


def admin_toggle_help_category_enabled(db: Session, category_id: int) -> dict[str, Any]:
    row = db.get(HelpCategory, category_id)
    if row is None:
        return {"ok": False, "message": "分类不存在"}
    row.enabled = not bool(row.enabled)
    row.updated_at = _now()
    db.commit()
    return {"ok": True, "message": "分类已启用" if row.enabled else "分类已禁用"}


def admin_query_help_articles(db: Session, filters: dict[str, Any]) -> dict[str, Any]:
    page = max(1, _parse_int(filters.get("page"), 1))
    page_size = min(max(1, _parse_int(filters.get("page_size"), 20)), 100)
    query = db.query(HelpArticle).options(joinedload(HelpArticle.category))

    keyword = _clean(filters.get("keyword"))
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(or_(HelpArticle.slug.ilike(like), HelpArticle.title.ilike(like), HelpArticle.summary.ilike(like)))

    category_id = _parse_int(filters.get("category_id"), 0)
    if category_id > 0:
        query = query.filter(HelpArticle.category_id == category_id)

    enabled = _clean(filters.get("enabled"))
    if enabled in {"1", "0"}:
        query = query.filter(HelpArticle.enabled.is_(enabled == "1"))

    hot = _clean(filters.get("hot"))
    if hot in {"1", "0"}:
        query = query.filter(HelpArticle.is_hot.is_(hot == "1"))

    total = query.count()
    rows = (
        query.order_by(HelpArticle.sort_order.asc(), HelpArticle.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [admin_help_article_form(row) for row in rows]
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": max(1, ceil(total / page_size)) if total else 1,
    }


def admin_get_help_article(db: Session, article_id: int) -> Optional[dict[str, Any]]:
    row = db.query(HelpArticle).options(joinedload(HelpArticle.category)).filter(HelpArticle.id == article_id).first()
    return admin_help_article_form(row) if row else None


def admin_help_article_form(row: HelpArticle) -> dict[str, Any]:
    form = {
        "id": row.id,
        "category_id": row.category_id,
        "category_title": row.category.title if row.category else "",
        "slug": row.slug,
        "title": row.title,
        "summary": row.summary or "",
        "content": row.content or "",
        "tags": _tags_text(row.tags_json),
        "tags_json": _parse_tags(row.tags_json),
        "is_hot": bool(row.is_hot),
        "sort_order": row.sort_order,
        "enabled": bool(row.enabled),
        "source_type": row.source_type or "cms",
        "status_label": "启用" if row.enabled else "禁用",
        "status_badge": "success" if row.enabled else "secondary",
        "hot_label": "热门" if row.is_hot else "普通",
        "hot_badge": "brand" if row.is_hot else "secondary",
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }
    return _append_i18n_form_fields(form, row, HELP_ARTICLE_I18N_FIELDS)


def admin_help_article_form_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = {
        "category_id": _parse_int(payload.get("category_id"), 0),
        "slug": _slugify(payload.get("slug")),
        "title": _primary_text_from_payload(payload, "title"),
        "summary": _primary_text_from_payload(payload, "summary"),
        "content": _primary_text_from_payload(payload, "content"),
        "tags": str(payload.get("tags") or ""),
        "is_hot": _parse_bool(payload.get("is_hot")),
        "sort_order": _parse_int(payload.get("sort_order"), 0),
        "enabled": _parse_bool(payload.get("enabled")),
        "source_type": _clean(payload.get("source_type")) or "cms",
    }
    return _append_i18n_form_fields(form, payload, HELP_ARTICLE_I18N_FIELDS)


def _normalize_article_payload(payload: dict[str, Any]) -> dict[str, Any]:
    title = _primary_text_from_payload(payload, "title")
    summary = _primary_text_from_payload(payload, "summary")
    content = _primary_text_from_payload(payload, "content")
    return {
        "category_id": _parse_int(payload.get("category_id"), 0),
        "slug": _slugify(payload.get("slug")),
        "title": title,
        "summary": summary or None,
        "content": content,
        "title_i18n": _build_i18n_payload(payload, "title"),
        "summary_i18n": _build_i18n_payload(payload, "summary"),
        "content_i18n": _build_i18n_payload(payload, "content"),
        "tags_json": _parse_tags(payload.get("tags")),
        "is_hot": _parse_bool(payload.get("is_hot")),
        "sort_order": _parse_int(payload.get("sort_order"), 0),
        "enabled": _parse_bool(payload.get("enabled")),
        "source_type": _clean(payload.get("source_type")) or "cms",
    }


def _validate_article(db: Session, data: dict[str, Any], *, article_id: Optional[int] = None) -> list[str]:
    errors: list[str] = []
    if data["category_id"] <= 0 or db.get(HelpCategory, data["category_id"]) is None:
        errors.append("请选择有效分类")
    if not data["slug"]:
        errors.append("文章 slug 不能为空")
    if not data["title"]:
        errors.append("文章标题不能为空")
    if data["slug"]:
        query = db.query(HelpArticle).filter(HelpArticle.slug == data["slug"])
        if article_id:
            query = query.filter(HelpArticle.id != article_id)
        if query.first() is not None:
            errors.append("文章 slug 已存在")
    return errors


def admin_create_help_article(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    data = _normalize_article_payload(payload)
    errors = _validate_article(db, data)
    if errors:
        return {"ok": False, "errors": errors}
    row = HelpArticle(**data, created_at=_now(), updated_at=_now())
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"ok": False, "errors": ["文章 slug 已存在"]}
    db.refresh(row)
    return {"ok": True, "item": admin_help_article_form(row)}


def admin_update_help_article(db: Session, article_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    row = db.get(HelpArticle, article_id)
    if row is None:
        return {"ok": False, "not_found": True, "errors": ["文章不存在"]}
    data = _normalize_article_payload(payload)
    errors = _validate_article(db, data, article_id=article_id)
    if errors:
        return {"ok": False, "errors": errors}
    for key, value in data.items():
        setattr(row, key, value)
    row.updated_at = _now()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"ok": False, "errors": ["文章 slug 已存在"]}
    db.refresh(row)
    return {"ok": True, "item": admin_help_article_form(row)}


def admin_toggle_help_article_enabled(db: Session, article_id: int) -> dict[str, Any]:
    row = db.get(HelpArticle, article_id)
    if row is None:
        return {"ok": False, "message": "文章不存在"}
    row.enabled = not bool(row.enabled)
    row.updated_at = _now()
    db.commit()
    return {"ok": True, "message": "文章已启用" if row.enabled else "文章已禁用"}


def admin_toggle_help_article_hot(db: Session, article_id: int) -> dict[str, Any]:
    row = db.get(HelpArticle, article_id)
    if row is None:
        return {"ok": False, "message": "文章不存在"}
    row.is_hot = not bool(row.is_hot)
    row.updated_at = _now()
    db.commit()
    return {"ok": True, "message": "已设为热门" if row.is_hot else "已取消热门"}
