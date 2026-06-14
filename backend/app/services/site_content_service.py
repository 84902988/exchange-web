from __future__ import annotations

from datetime import datetime
from html import escape
from html.parser import HTMLParser
import logging
from math import ceil
import re
from typing import Any, Optional
from urllib.parse import urlparse

from sqlalchemy import inspect, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, load_only

from app.core.content_locale import DEFAULT_CONTENT_LOCALE, localize_i18n_value
from app.db.models.site_content import Announcement, HomeBanner, SiteSettings


logger = logging.getLogger(__name__)

ACTIVE_BANNER_STATUS = "ACTIVE"
PUBLISHED_ANNOUNCEMENT_STATUS = "PUBLISHED"
DISABLED_STATUS = "DISABLED"
ANNOUNCEMENT_CATEGORY_DEFAULT = "platform"
ANNOUNCEMENT_CATEGORIES = ("platform", "activity", "system")
ANNOUNCEMENT_CATEGORY_OPTIONS = [
    {"value": "platform", "label": "平台公告", "badge": "success"},
    {"value": "activity", "label": "活动公告", "badge": "brand"},
    {"value": "system", "label": "系统公告", "badge": "neutral"},
]
ANNOUNCEMENT_ALLOWED_HTML_TAGS = {
    "a",
    "blockquote",
    "br",
    "b",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
}
ANNOUNCEMENT_ALLOWED_LINK_SCHEMES = {"", "http", "https", "mailto", "tel"}
ANNOUNCEMENT_ALLOWED_STYLE_PROPS = {
    "background-color",
    "border",
    "border-collapse",
    "border-color",
    "border-style",
    "border-width",
    "color",
    "font-size",
    "font-style",
    "font-weight",
    "height",
    "margin",
    "max-width",
    "padding",
    "text-align",
    "text-decoration",
    "vertical-align",
    "width",
}
ANNOUNCEMENT_SELF_CLOSING_TAGS = {"br", "hr", "img"}
ANNOUNCEMENT_FORBIDDEN_DROP_CONTENT_TAGS = {"script", "style", "iframe", "object", "form"}
ANNOUNCEMENT_FORBIDDEN_VOID_TAGS = {"embed", "input"}
ANNOUNCEMENT_SITE_IMAGE_PREFIX = "/static/uploads/site/"
_HOME_BANNER_SUBTITLE_WARNING_LOGGED = False
_ANNOUNCEMENT_CATEGORY_WARNING_LOGGED = False
_HOME_BANNER_SAFE_LOAD_COLUMNS = (
    HomeBanner.id,
    HomeBanner.title,
    HomeBanner.image_url,
    HomeBanner.link_url,
    HomeBanner.sort_order,
    HomeBanner.status,
    HomeBanner.start_at,
    HomeBanner.end_at,
    HomeBanner.created_at,
    HomeBanner.updated_at,
)
_SITE_SETTINGS_SAFE_LOAD_COLUMNS = (
    SiteSettings.id,
    SiteSettings.site_name,
    SiteSettings.site_slogan,
    SiteSettings.logo_url,
    SiteSettings.support_email,
    SiteSettings.risk_disclaimer,
    SiteSettings.footer_disclaimer,
    SiteSettings.stock_token_locks_notice_title,
    SiteSettings.stock_token_locks_notice_content,
    SiteSettings.home_hero_title,
    SiteSettings.home_hero_subtitle,
    SiteSettings.home_hero_cta_text,
    SiteSettings.home_hero_cta_link,
    SiteSettings.home_hero_image,
    SiteSettings.show_risk_link,
    SiteSettings.risk_link_url,
    SiteSettings.show_terms_link,
    SiteSettings.terms_link_url,
    SiteSettings.show_privacy_link,
    SiteSettings.privacy_link_url,
    SiteSettings.created_at,
    SiteSettings.updated_at,
)
_ANNOUNCEMENT_SAFE_LOAD_COLUMNS = (
    Announcement.id,
    Announcement.title,
    Announcement.slug,
    Announcement.summary,
    Announcement.content,
    Announcement.is_pinned,
    Announcement.status,
    Announcement.publish_at,
    Announcement.created_at,
    Announcement.updated_at,
)
SITE_SETTINGS_I18N_FIELDS = {
    "site_name": "site_name_i18n",
    "site_slogan": "site_slogan_i18n",
    "risk_disclaimer": "risk_disclaimer_i18n",
    "footer_disclaimer": "footer_disclaimer_i18n",
    "stock_token_locks_notice_title": "stock_token_locks_notice_title_i18n",
    "stock_token_locks_notice_content": "stock_token_locks_notice_content_i18n",
    "home_hero_title": "home_hero_title_i18n",
    "home_hero_subtitle": "home_hero_subtitle_i18n",
    "home_hero_cta_text": "home_hero_cta_text_i18n",
}
HOME_BANNER_I18N_FIELDS = {
    "title": "title_i18n",
    "subtitle": "subtitle_i18n",
}
ANNOUNCEMENT_I18N_FIELDS = {
    "title": "title_i18n",
    "summary": "summary_i18n",
    "content": "content_i18n",
}
ADMIN_I18N_LOCALES = (
    ("zh", "zh"),
    ("en", "en"),
    ("zh-TW", "zh_TW"),
    ("ja", "ja"),
)

DEFAULT_SITE_CONFIG = {
    "site_name": "Royal Exchange",
    "site_slogan": "Global digital asset trading platform",
    "logo_url": "/icons/logo-1.svg",
    "support_email": "support@example.com",
    "risk_disclaimer": "Digital asset trading involves risk. Please trade responsibly.",
    "footer_disclaimer": "Digital asset trading involves risk. Please trade responsibly.",
    "stock_token_locks_notice_title": "股票代币兑换股票说明",
    "stock_token_locks_notice_content": "\n".join(
        [
            "1. 请在凯恩斯券商平台完成注册（手机应用市场搜索：Keynes Securities）",
            "2. 请与英交易所官方客服取得联系，联系方式请以官方公告或客服页面为准",
            "3. 沟通相关股票配发事项",
        ]
    ),
    "home_hero_title": "Reconstructing a New Order of Global Crypto Finance",
    "home_hero_subtitle": "Trade digital assets with a fast, secure, and configurable exchange experience.",
    "home_hero_cta_text": "Get Started",
    "home_hero_cta_link": "/register",
    "home_hero_image": "/homepage-bg.mp4",
    "show_risk_link": True,
    "risk_link_url": "/risk",
    "show_terms_link": True,
    "terms_link_url": "/terms",
    "show_privacy_link": True,
    "privacy_link_url": "/privacy",
    "locale": "zh-CN",
}


def _now() -> datetime:
    return datetime.utcnow()


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _clean_optional(value: Any) -> Optional[str]:
    cleaned = _clean(value)
    return cleaned or None


class _AnnouncementHTMLSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._drop_content_depth = 0

    def _clean_style(self, value: str) -> str:
        declarations: list[str] = []
        for declaration in value.split(";"):
            if ":" not in declaration:
                continue
            prop, raw_value = declaration.split(":", 1)
            prop = prop.strip().lower()
            style_value = raw_value.strip()
            lowered_value = style_value.lower()
            if prop not in ANNOUNCEMENT_ALLOWED_STYLE_PROPS:
                continue
            if any(token in lowered_value for token in ("url(", "expression", "javascript:", "@import", "behavior:", "-moz-binding")):
                continue
            if any(char in style_value for char in "<>"):
                continue
            if prop == "text-align" and lowered_value not in {"left", "center", "right", "justify", "start", "end"}:
                continue
            if prop == "font-size" and not re.fullmatch(r"[0-9.]+(px|em|rem|%)", lowered_value):
                continue
            if prop in {"width", "height", "max-width"} and not re.fullmatch(r"(auto|[0-9.]+(px|em|rem|%))", lowered_value):
                continue
            if prop in {"padding", "margin", "border-width"} and not re.fullmatch(
                r"(0|[0-9.]+(px|em|rem|%))(\s+(0|[0-9.]+(px|em|rem|%))){0,3}",
                lowered_value,
            ):
                continue
            if prop == "font-weight" and not re.fullmatch(r"(normal|bold|bolder|lighter|[1-9]00)", lowered_value):
                continue
            if prop == "font-style" and lowered_value not in {"normal", "italic", "oblique"}:
                continue
            if prop == "text-decoration" and not re.fullmatch(r"(none|underline|line-through|overline)(\s+(solid|double|dotted|dashed|wavy))?", lowered_value):
                continue
            if prop == "border-style" and lowered_value not in {"none", "solid", "dashed", "dotted", "double"}:
                continue
            if prop == "border-collapse" and lowered_value not in {"collapse", "separate"}:
                continue
            if prop == "vertical-align" and not re.fullmatch(r"(baseline|top|middle|bottom|text-top|text-bottom|sub|super|[0-9.]+(px|em|rem|%))", lowered_value):
                continue
            if prop == "border" and not re.fullmatch(r"[#a-zA-Z0-9(),.\s%-]+", style_value):
                continue
            if prop in {"color", "background-color"} and not re.fullmatch(r"[#a-zA-Z0-9(),.\s%-]+", style_value):
                continue
            if prop == "border-color" and not re.fullmatch(r"[#a-zA-Z0-9(),.\s%-]+", style_value):
                continue
            declarations.append(f"{prop}: {style_value}")
        return "; ".join(declarations)

    def _clean_site_image_src(self, value: str) -> str:
        candidate = value.strip()
        if candidate.startswith(ANNOUNCEMENT_SITE_IMAGE_PREFIX):
            return candidate
        if candidate.startswith(ANNOUNCEMENT_SITE_IMAGE_PREFIX.lstrip("/")):
            return f"/{candidate}"
        parsed = urlparse(candidate)
        if not parsed.scheme and not parsed.netloc and parsed.path.startswith(ANNOUNCEMENT_SITE_IMAGE_PREFIX):
            return parsed.path
        if parsed.scheme in {"http", "https"} and parsed.path.startswith(ANNOUNCEMENT_SITE_IMAGE_PREFIX):
            return parsed.path
        return ""

    def _clean_number_attr(self, value: str) -> str:
        candidate = value.strip()
        return candidate if re.fullmatch(r"[1-9][0-9]{0,3}", candidate) else ""

    def _clean_size_attr(self, value: str) -> str:
        candidate = value.strip()
        return candidate if re.fullmatch(r"[0-9]{1,4}%?", candidate) else ""

    def _attrs_to_html(self, attrs: list[tuple[str, str]]) -> str:
        if not attrs:
            return ""
        return "".join(f' {name}="{escape(value, quote=True)}"' for name, value in attrs)

    def _clean_attrs(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> list[tuple[str, str]]:
        cleaned: list[tuple[str, str]] = []
        for raw_name, raw_value in attrs:
            name = raw_name.lower().strip()
            value = (raw_value or "").strip()
            if not name or name.startswith("on"):
                continue
            if tag == "a":
                if name == "href":
                    parsed_href = urlparse(value)
                    scheme = parsed_href.scheme.lower()
                    if scheme in ANNOUNCEMENT_ALLOWED_LINK_SCHEMES:
                        cleaned.append(("href", value))
                elif name == "title":
                    cleaned.append(("title", value))
                elif name == "target" and value in {"_blank", "_self", "_parent", "_top"}:
                    cleaned.append(("target", value))
                elif name == "rel":
                    rel = " ".join(part for part in value.split() if re.fullmatch(r"[a-zA-Z0-9_-]+", part))
                    if rel:
                        cleaned.append(("rel", rel))
            elif tag == "img":
                if name == "src":
                    src = self._clean_site_image_src(value)
                    if src:
                        cleaned.append(("src", src))
                elif name in {"alt", "title"}:
                    cleaned.append((name, value))
                elif name in {"width", "height"}:
                    size = self._clean_size_attr(value)
                    if size:
                        cleaned.append((name, size))
            elif tag in {"th", "td"} and name in {"colspan", "rowspan"}:
                number = self._clean_number_attr(value)
                if number:
                    cleaned.append((name, number))
            if name == "title" and tag not in {"a", "img"}:
                cleaned.append(("title", value))
            elif name == "style":
                style = self._clean_style(value)
                if style:
                    cleaned.append(("style", style))
        if tag == "a" and any(name == "target" and value == "_blank" for name, value in cleaned):
            rel_value = next((value for name, value in cleaned if name == "rel"), "")
            rel_parts = set(rel_value.split())
            rel_parts.update({"noopener", "noreferrer"})
            cleaned = [(name, value) for name, value in cleaned if name != "rel"]
            cleaned.append(("rel", " ".join(sorted(rel_parts))))
        return cleaned

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        if tag in ANNOUNCEMENT_FORBIDDEN_VOID_TAGS:
            return
        if tag in ANNOUNCEMENT_FORBIDDEN_DROP_CONTENT_TAGS:
            self._drop_content_depth += 1
            return
        if self._drop_content_depth:
            return
        if tag not in ANNOUNCEMENT_ALLOWED_HTML_TAGS:
            return
        cleaned_attrs = self._clean_attrs(tag, attrs)
        if tag == "img" and not any(name == "src" for name, _ in cleaned_attrs):
            return
        if tag in ANNOUNCEMENT_SELF_CLOSING_TAGS:
            self.parts.append(f"<{tag}{self._attrs_to_html(cleaned_attrs)}>")
            return
        self.parts.append(f"<{tag}{self._attrs_to_html(cleaned_attrs)}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ANNOUNCEMENT_FORBIDDEN_DROP_CONTENT_TAGS and self._drop_content_depth:
            self._drop_content_depth -= 1
            return
        if self._drop_content_depth:
            return
        if tag in ANNOUNCEMENT_ALLOWED_HTML_TAGS and tag not in ANNOUNCEMENT_SELF_CLOSING_TAGS:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self._drop_content_depth:
            return
        self.parts.append(escape(data, quote=False))

    def handle_entityref(self, name: str) -> None:
        if self._drop_content_depth:
            return
        self.parts.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self._drop_content_depth:
            return
        self.parts.append(f"&#{name};")

    def get_html(self) -> str:
        return "".join(self.parts)


def _sanitize_announcement_content(value: Any) -> Optional[str]:
    raw = _clean(value)
    if not raw or raw in {"<p><br></p>", "<p></p>"}:
        return None
    parser = _AnnouncementHTMLSanitizer()
    parser.feed(raw)
    parser.close()
    cleaned = parser.get_html().strip()
    return cleaned or None


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value or default).strip())
    except (TypeError, ValueError):
        return default


def _parse_bool(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


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
    if value is None:
        return None
    return value.isoformat()


def _format_admin_datetime(value: Optional[datetime]) -> str:
    if value is None:
        return ""
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _format_datetime_local(value: Optional[datetime]) -> str:
    if value is None:
        return ""
    return value.strftime("%Y-%m-%dT%H:%M")


def _normalize_status(value: Any, *, active_value: str) -> str:
    status = _clean(value).upper()
    if status in {active_value, DISABLED_STATUS}:
        return status
    if status in {"1", "ON", "ENABLED", "ACTIVE", "PUBLISHED"}:
        return active_value
    return DISABLED_STATUS


def _status_label(status: str, *, active_value: str) -> str:
    return "启用" if status == active_value else "禁用"


def _status_badge(status: str, *, active_value: str) -> str:
    return "success" if status == active_value else "neutral"


def _pagination(page: int, page_size: int, total: int) -> dict[str, int]:
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": max(1, ceil(total / page_size)) if page_size else 1,
    }


def _page_result(
    *,
    items: list[dict[str, Any]],
    page: int,
    page_size: int,
    total: int,
    filters: Optional[dict[str, Any]] = None,
    summary: Optional[dict[str, Any]] = None,
    stats: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    pagination = _pagination(page, page_size, total)
    return {
        "items": items,
        "filters": filters or {},
        "pagination": pagination,
        "summary": summary or {},
        "stats": stats or {},
        **pagination,
    }


def _column_available(db: Session, table_name: str, column_name: str) -> bool:
    bind = db.get_bind()
    try:
        dialect_name = bind.dialect.name.lower()
        if dialect_name in {"mysql", "mariadb"}:
            return db.execute(text(f"SHOW COLUMNS FROM {table_name} LIKE :column_name"), {"column_name": column_name}).first() is not None
        inspector = inspect(bind)
        return inspector.has_table(table_name) and any(
            column.get("name") == column_name for column in inspector.get_columns(table_name)
        )
    except Exception as exc:  # pragma: no cover - best-effort guard for rolling migrations
        logger.warning("[white-label] failed to check %s.%s column: %s", table_name, column_name, exc)
        return True


def _i18n_columns_available(db: Session, table_name: str, field_map: dict[str, str]) -> bool:
    return all(_column_available(db, table_name, column_name) for column_name in field_map.values())


def _localize_row_field(row: Any, field_name: str, i18n_field_name: str, locale: str, fallback: Any = "") -> Any:
    return localize_i18n_value(getattr(row, i18n_field_name, None), locale, fallback)


def _localize_payload_fields(
    data: dict[str, Any],
    row: Any,
    field_map: dict[str, str],
    locale: str,
    *,
    include_i18n: bool,
) -> dict[str, Any]:
    if not include_i18n:
        return data
    for field_name, i18n_field_name in field_map.items():
        data[field_name] = _localize_row_field(row, field_name, i18n_field_name, locale, data.get(field_name, ""))
    return data


def _i18n_form_key(field_name: str, suffix: str) -> str:
    return f"{field_name}_i18n_{suffix}"


def _normalize_i18n_value(value: Any, sanitizer=None) -> str:
    if sanitizer is not None:
        cleaned = sanitizer(value)
        return str(cleaned or "")
    return _clean(value)


def _normalize_i18n_payload(
    payload: dict[str, Any],
    field_map: dict[str, str],
    *,
    sanitizer_by_field: Optional[dict[str, Any]] = None,
) -> dict[str, dict[str, str]]:
    data: dict[str, dict[str, str]] = {}
    sanitizer_by_field = sanitizer_by_field or {}
    for field_name, i18n_field_name in field_map.items():
        translations: dict[str, str] = {}
        sanitizer = sanitizer_by_field.get(field_name)
        for locale, suffix in ADMIN_I18N_LOCALES:
            translations[locale] = _normalize_i18n_value(payload.get(_i18n_form_key(field_name, suffix)), sanitizer)
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
    base_value = getattr(row, field_name, None)
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
    label = f"{len(complete_locales)}/{len(ADMIN_I18N_LOCALES)}" if not missing_locales else f"缺 {('/'.join(missing_locales))}"
    return {
        "i18n_status_label": label,
        "i18n_complete_count": len(complete_locales),
        "i18n_total_count": len(ADMIN_I18N_LOCALES),
        "i18n_missing_locales": missing_locales,
    }


def _warn_home_banner_subtitle_missing() -> None:
    global _HOME_BANNER_SUBTITLE_WARNING_LOGGED
    if not _HOME_BANNER_SUBTITLE_WARNING_LOGGED:
        logger.warning("[white-label] home_banners.subtitle missing, migration required")
        _HOME_BANNER_SUBTITLE_WARNING_LOGGED = True


def _home_banner_subtitle_available(db: Session) -> bool:
    exists = _column_available(db, "home_banners", "subtitle")
    if not exists:
        _warn_home_banner_subtitle_missing()
    return exists


def _home_banner_i18n_available(db: Session) -> bool:
    return _i18n_columns_available(db, "home_banners", HOME_BANNER_I18N_FIELDS)


def _home_banner_query(db: Session, *, include_subtitle: bool, include_i18n: bool = False):
    query = db.query(HomeBanner)
    columns = list(_HOME_BANNER_SAFE_LOAD_COLUMNS)
    if include_subtitle:
        columns.append(HomeBanner.subtitle)
    if include_i18n:
        columns.extend(getattr(HomeBanner, column_name) for column_name in HOME_BANNER_I18N_FIELDS.values())
    if len(columns) != len(HomeBanner.__table__.columns):
        query = query.options(load_only(*columns))
    return query


def _get_home_banner_row(
    db: Session,
    banner_id: int,
    *,
    include_subtitle: bool,
    include_i18n: bool = False,
) -> Optional[HomeBanner]:
    return _home_banner_query(db, include_subtitle=include_subtitle, include_i18n=include_i18n).filter(HomeBanner.id == banner_id).first()


def _normalize_announcement_category(value: Any) -> str:
    category = _clean(value).lower()
    return category if category in ANNOUNCEMENT_CATEGORIES else ANNOUNCEMENT_CATEGORY_DEFAULT


def _announcement_category_meta(value: Any) -> dict[str, str]:
    category = _normalize_announcement_category(value)
    for item in ANNOUNCEMENT_CATEGORY_OPTIONS:
        if item["value"] == category:
            return item
    return ANNOUNCEMENT_CATEGORY_OPTIONS[0]


def _warn_announcement_category_missing() -> None:
    global _ANNOUNCEMENT_CATEGORY_WARNING_LOGGED
    if not _ANNOUNCEMENT_CATEGORY_WARNING_LOGGED:
        logger.warning("[white-label] announcements.category missing, migration required")
        _ANNOUNCEMENT_CATEGORY_WARNING_LOGGED = True


def _announcement_category_available(db: Session) -> bool:
    exists = _column_available(db, "announcements", "category")
    if not exists:
        _warn_announcement_category_missing()
    return exists


def _announcement_i18n_available(db: Session) -> bool:
    return _i18n_columns_available(db, "announcements", ANNOUNCEMENT_I18N_FIELDS)


def _announcement_query(db: Session, *, include_category: bool, include_i18n: bool = False):
    query = db.query(Announcement)
    columns = list(_ANNOUNCEMENT_SAFE_LOAD_COLUMNS)
    if include_category:
        columns.append(Announcement.category)
    if include_i18n:
        columns.extend(getattr(Announcement, column_name) for column_name in ANNOUNCEMENT_I18N_FIELDS.values())
    if len(columns) != len(Announcement.__table__.columns):
        query = query.options(load_only(*columns))
    return query


def _get_announcement_row(
    db: Session,
    announcement_id: int,
    *,
    include_category: bool,
    include_i18n: bool = False,
) -> Optional[Announcement]:
    return _announcement_query(db, include_category=include_category, include_i18n=include_i18n).filter(Announcement.id == announcement_id).first()


def _site_settings_i18n_available(db: Session) -> bool:
    return _i18n_columns_available(db, "site_settings", SITE_SETTINGS_I18N_FIELDS)


def get_site_settings_row(db: Session, *, include_i18n: bool = False) -> Optional[SiteSettings]:
    query = db.query(SiteSettings)
    if not include_i18n:
        query = query.options(load_only(*_SITE_SETTINGS_SAFE_LOAD_COLUMNS))
    return query.order_by(SiteSettings.id.asc()).first()


def get_or_create_site_settings(db: Session) -> SiteSettings:
    row = get_site_settings_row(db)
    if row is not None:
        return row

    row = SiteSettings(**{key: value for key, value in DEFAULT_SITE_CONFIG.items() if key != "locale"})
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def serialize_site_config(
    row: Optional[SiteSettings],
    *,
    locale: str = DEFAULT_CONTENT_LOCALE,
    include_i18n: bool = False,
) -> dict[str, Any]:
    data = dict(DEFAULT_SITE_CONFIG)
    data["locale"] = locale
    if row is None:
        return data

    for key in DEFAULT_SITE_CONFIG:
        if key == "locale":
            continue
        value = getattr(row, key, None)
        if value is not None:
            data[key] = value
    data["id"] = int(row.id)
    _localize_payload_fields(data, row, SITE_SETTINGS_I18N_FIELDS, locale, include_i18n=include_i18n)
    return data


def get_public_site_config(db: Session, locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    include_i18n = _site_settings_i18n_available(db)
    return serialize_site_config(get_site_settings_row(db, include_i18n=include_i18n), locale=locale, include_i18n=include_i18n)


def update_site_settings(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    row = get_or_create_site_settings(db)
    for field in (
        "site_name",
        "site_slogan",
        "logo_url",
        "support_email",
        "risk_disclaimer",
        "footer_disclaimer",
        "stock_token_locks_notice_title",
        "stock_token_locks_notice_content",
        "home_hero_title",
        "home_hero_subtitle",
        "home_hero_cta_text",
        "home_hero_cta_link",
        "home_hero_image",
        "risk_link_url",
        "terms_link_url",
        "privacy_link_url",
    ):
        value = _clean(payload.get(field))
        if field == "site_name" and not value:
            value = DEFAULT_SITE_CONFIG["site_name"]
        setattr(row, field, value)
    for field in ("show_risk_link", "show_terms_link", "show_privacy_link"):
        setattr(row, field, _parse_bool(payload.get(field)))
    if _site_settings_i18n_available(db):
        for field, value in _normalize_i18n_payload(payload, SITE_SETTINGS_I18N_FIELDS).items():
            setattr(row, field, value)
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return {"ok": True, "form": admin_site_settings_form(row)}


def admin_site_settings_form(row: Optional[SiteSettings]) -> dict[str, Any]:
    data = serialize_site_config(row)
    form: dict[str, Any] = {}
    for key in DEFAULT_SITE_CONFIG:
        if key == "locale":
            continue
        value = data.get(key)
        form[key] = bool(value) if key.startswith("show_") else str(value if value is not None else "")
    return _append_i18n_form_fields(form, row or {}, SITE_SETTINGS_I18N_FIELDS)


def serialize_banner(
    row: HomeBanner,
    *,
    include_subtitle: bool = True,
    locale: str = DEFAULT_CONTENT_LOCALE,
    include_i18n: bool = False,
    include_translation_status: bool = False,
) -> dict[str, Any]:
    data = {
        "id": int(row.id),
        "title": row.title or "",
        "subtitle": (row.subtitle or "") if include_subtitle else None,
        "image_url": row.image_url or "",
        "link_url": row.link_url or "",
        "sort_order": int(row.sort_order or 0),
        "status": row.status or DISABLED_STATUS,
        "status_label": _status_label(row.status or DISABLED_STATUS, active_value=ACTIVE_BANNER_STATUS),
        "status_badge": _status_badge(row.status or DISABLED_STATUS, active_value=ACTIVE_BANNER_STATUS),
        "start_at": _format_datetime(row.start_at),
        "end_at": _format_datetime(row.end_at),
        "start_at_admin": _format_admin_datetime(row.start_at),
        "end_at_admin": _format_admin_datetime(row.end_at),
        "start_at_input": _format_datetime_local(row.start_at),
        "end_at_input": _format_datetime_local(row.end_at),
        "created_at": _format_admin_datetime(row.created_at),
        "updated_at": _format_admin_datetime(row.updated_at),
    }
    if include_translation_status:
        data.update(_translation_status(row, HOME_BANNER_I18N_FIELDS))
    return _localize_payload_fields(data, row, HOME_BANNER_I18N_FIELDS, locale, include_i18n=include_i18n)


def get_public_home_banners(db: Session, limit: int = 6, locale: str = DEFAULT_CONTENT_LOCALE) -> list[dict[str, Any]]:
    now = _now()
    include_subtitle = _home_banner_subtitle_available(db)
    include_i18n = _home_banner_i18n_available(db)
    rows = (
        _home_banner_query(db, include_subtitle=include_subtitle, include_i18n=include_i18n)
        .filter(HomeBanner.status == ACTIVE_BANNER_STATUS)
        .filter(or_(HomeBanner.start_at.is_(None), HomeBanner.start_at <= now))
        .filter(or_(HomeBanner.end_at.is_(None), HomeBanner.end_at >= now))
        .order_by(HomeBanner.sort_order.asc(), HomeBanner.id.desc())
        .limit(max(1, min(int(limit or 6), 20)))
        .all()
    )
    return [serialize_banner(row, include_subtitle=include_subtitle, locale=locale, include_i18n=include_i18n) for row in rows]


def admin_query_home_banners(db: Session, filters: dict[str, Any]) -> dict[str, Any]:
    page = max(1, _parse_int(filters.get("page"), 1))
    page_size = min(max(1, _parse_int(filters.get("page_size"), 20)), 100)
    include_subtitle = _home_banner_subtitle_available(db)
    include_i18n = _home_banner_i18n_available(db)
    query = _home_banner_query(db, include_subtitle=include_subtitle, include_i18n=include_i18n)
    count_query = db.query(HomeBanner.id)

    status = _clean(filters.get("status")).upper()
    if status:
        query = query.filter(HomeBanner.status == status)
        count_query = count_query.filter(HomeBanner.status == status)

    keyword = _clean(filters.get("keyword"))
    if keyword:
        query = query.filter(HomeBanner.title.like(f"%{keyword}%"))
        count_query = count_query.filter(HomeBanner.title.like(f"%{keyword}%"))

    total = int(count_query.count())
    rows = (
        query.order_by(HomeBanner.sort_order.asc(), HomeBanner.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return _page_result(
        items=[serialize_banner(row, include_subtitle=include_subtitle, include_translation_status=True) for row in rows],
        page=page,
        page_size=page_size,
        total=total,
        filters={"keyword": keyword, "status": status},
    )


def admin_get_home_banner(db: Session, banner_id: int) -> Optional[dict[str, Any]]:
    include_subtitle = _home_banner_subtitle_available(db)
    include_i18n = _home_banner_i18n_available(db)
    row = _get_home_banner_row(db, banner_id, include_subtitle=include_subtitle, include_i18n=include_i18n)
    if row is None:
        return None
    return _append_i18n_form_fields(
        serialize_banner(row, include_subtitle=include_subtitle, include_translation_status=True),
        row,
        HOME_BANNER_I18N_FIELDS,
    )


def admin_delete_home_banner(db: Session, banner_id: int) -> dict[str, Any]:
    include_subtitle = _home_banner_subtitle_available(db)
    row = _get_home_banner_row(db, banner_id, include_subtitle=include_subtitle)
    if row is None:
        return {"ok": False, "message": "Banner 不存在"}

    db.delete(row)
    db.commit()
    return {"ok": True, "message": "Banner 已删除"}


def _normalize_banner_payload(payload: dict[str, Any]) -> dict[str, Any]:
    status = _normalize_status(payload.get("status"), active_value=ACTIVE_BANNER_STATUS)
    return {
        "title": _clean(payload.get("title")),
        "subtitle": _clean_optional(payload.get("subtitle")),
        "image_url": _clean(payload.get("image_url")),
        "link_url": _clean(payload.get("link_url")),
        "sort_order": _parse_int(payload.get("sort_order"), 0),
        "status": status,
        "start_at": _parse_datetime(payload.get("start_at")),
        "end_at": _parse_datetime(payload.get("end_at")),
    }


def _validate_banner_form(form: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not form["title"]:
        errors.append("标题不能为空")
    if form["start_at"] and form["end_at"] and form["start_at"] > form["end_at"]:
        errors.append("开始时间不能晚于结束时间")
    return errors


def admin_create_home_banner(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_banner_payload(payload)
    errors = _validate_banner_form(form)
    if errors:
        return {"ok": False, "errors": errors, "form": admin_banner_form_from_payload(payload)}

    include_subtitle = _home_banner_subtitle_available(db)
    include_i18n = _home_banner_i18n_available(db)
    write_form = dict(form)
    if not include_subtitle:
        write_form.pop("subtitle", None)
    if include_i18n:
        write_form.update(_normalize_i18n_payload(payload, HOME_BANNER_I18N_FIELDS))

    result = db.execute(HomeBanner.__table__.insert().values(**write_form))
    row_id = int(result.inserted_primary_key[0])
    db.commit()
    saved_row = _get_home_banner_row(db, row_id, include_subtitle=include_subtitle, include_i18n=include_i18n)
    saved_form = (
        serialize_banner(saved_row, include_subtitle=include_subtitle, include_translation_status=True)
        if saved_row
        else {**form, "id": row_id}
    )
    return {"ok": True, "id": row_id, "form": saved_form}


def admin_update_home_banner(db: Session, banner_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    include_subtitle = _home_banner_subtitle_available(db)
    include_i18n = _home_banner_i18n_available(db)
    row = _get_home_banner_row(db, banner_id, include_subtitle=include_subtitle, include_i18n=include_i18n)
    if row is None:
        return {"ok": False, "errors": ["Banner 不存在"], "not_found": True}

    form = _normalize_banner_payload(payload)
    errors = _validate_banner_form(form)
    if errors:
        return {"ok": False, "errors": errors, "form": admin_banner_form_from_payload(payload), "not_found": False}

    for key, value in form.items():
        if key == "subtitle" and not include_subtitle:
            continue
        setattr(row, key, value or None if key in {"subtitle", "image_url", "link_url"} else value)
    if include_i18n:
        for key, value in _normalize_i18n_payload(payload, HOME_BANNER_I18N_FIELDS).items():
            setattr(row, key, value)
    row.updated_at = _now()
    db.commit()
    saved_row = _get_home_banner_row(db, banner_id, include_subtitle=include_subtitle, include_i18n=include_i18n)
    saved_form = (
        serialize_banner(saved_row, include_subtitle=include_subtitle, include_translation_status=True)
        if saved_row
        else admin_banner_form_from_payload(payload)
    )
    return {"ok": True, "id": banner_id, "form": saved_form}


def admin_toggle_home_banner_status(db: Session, banner_id: int) -> dict[str, Any]:
    include_subtitle = _home_banner_subtitle_available(db)
    row = _get_home_banner_row(db, banner_id, include_subtitle=include_subtitle)
    if row is None:
        return {"ok": False, "message": "Banner 不存在"}
    new_status = DISABLED_STATUS if row.status == ACTIVE_BANNER_STATUS else ACTIVE_BANNER_STATUS
    row.status = new_status
    row.updated_at = _now()
    db.commit()
    row.status = new_status
    return {"ok": True, "message": f"Banner 已{_status_label(row.status, active_value=ACTIVE_BANNER_STATUS)}"}


def admin_banner_form_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_banner_payload(payload)
    return _append_i18n_form_fields({
        **form,
        "start_at_input": _clean(payload.get("start_at")),
        "end_at_input": _clean(payload.get("end_at")),
    }, payload, HOME_BANNER_I18N_FIELDS)


def serialize_announcement(
    row: Announcement,
    *,
    include_category: bool = True,
    locale: str = DEFAULT_CONTENT_LOCALE,
    include_i18n: bool = False,
    include_translation_status: bool = False,
) -> dict[str, Any]:
    category = _normalize_announcement_category(row.category) if include_category else None
    category_meta = _announcement_category_meta(category)
    title = _localize_row_field(row, "title", "title_i18n", locale, row.title or "") if include_i18n else row.title or ""
    summary = _localize_row_field(row, "summary", "summary_i18n", locale, row.summary or "") if include_i18n else row.summary or ""
    raw_content = _localize_row_field(row, "content", "content_i18n", locale, row.content or "") if include_i18n else row.content or ""
    content = _sanitize_announcement_content(raw_content) or ""
    data = {
        "id": int(row.id),
        "title": title,
        "slug": row.slug or "",
        "category": category,
        "category_label": category_meta["label"] if category else "",
        "category_badge": category_meta["badge"] if category else "neutral",
        "summary": summary,
        "content": content,
        "is_pinned": bool(row.is_pinned),
        "status": row.status or DISABLED_STATUS,
        "status_label": _status_label(row.status or DISABLED_STATUS, active_value=PUBLISHED_ANNOUNCEMENT_STATUS),
        "status_badge": _status_badge(row.status or DISABLED_STATUS, active_value=PUBLISHED_ANNOUNCEMENT_STATUS),
        "publish_at": _format_datetime(row.publish_at),
        "publish_at_admin": _format_admin_datetime(row.publish_at),
        "publish_at_input": _format_datetime_local(row.publish_at),
        "created_at": _format_admin_datetime(row.created_at),
        "updated_at": _format_admin_datetime(row.updated_at),
    }
    if include_translation_status:
        data.update(_translation_status(row, ANNOUNCEMENT_I18N_FIELDS))
    return data


def get_latest_announcements(db: Session, limit: int = 3, locale: str = DEFAULT_CONTENT_LOCALE) -> list[dict[str, Any]]:
    now = _now()
    include_category = _announcement_category_available(db)
    include_i18n = _announcement_i18n_available(db)
    rows = (
        _announcement_query(db, include_category=include_category, include_i18n=include_i18n)
        .filter(Announcement.status == PUBLISHED_ANNOUNCEMENT_STATUS)
        .filter(or_(Announcement.publish_at.is_(None), Announcement.publish_at <= now))
        .order_by(Announcement.is_pinned.desc(), Announcement.publish_at.desc(), Announcement.id.desc())
        .limit(max(1, min(int(limit or 3), 10)))
        .all()
    )
    return [
        serialize_announcement(row, include_category=include_category, locale=locale, include_i18n=include_i18n)
        for row in rows
    ]


def get_public_announcements(
    db: Session,
    page: int = 1,
    page_size: int = 10,
    category: Optional[str] = None,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> dict[str, Any]:
    now = _now()
    page = max(1, _parse_int(page, 1))
    page_size = min(max(1, _parse_int(page_size, 10)), 50)
    include_category = _announcement_category_available(db)
    include_i18n = _announcement_i18n_available(db)
    query = (
        _announcement_query(db, include_category=include_category, include_i18n=include_i18n)
        .filter(Announcement.status == PUBLISHED_ANNOUNCEMENT_STATUS)
        .filter(or_(Announcement.publish_at.is_(None), Announcement.publish_at <= now))
    )
    count_query = (
        db.query(Announcement.id)
        .filter(Announcement.status == PUBLISHED_ANNOUNCEMENT_STATUS)
        .filter(or_(Announcement.publish_at.is_(None), Announcement.publish_at <= now))
    )
    normalized_category = _clean(category).lower()
    if include_category and normalized_category in ANNOUNCEMENT_CATEGORIES:
        query = query.filter(Announcement.category == normalized_category)
        count_query = count_query.filter(Announcement.category == normalized_category)
    total = int(count_query.count())
    rows = (
        query.order_by(Announcement.is_pinned.desc(), Announcement.publish_at.desc(), Announcement.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return _page_result(
        items=[
            serialize_announcement(row, include_category=include_category, locale=locale, include_i18n=include_i18n)
            for row in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        filters={"category": normalized_category},
    )


def get_public_announcement(
    db: Session,
    identifier: str,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> Optional[dict[str, Any]]:
    now = _now()
    include_category = _announcement_category_available(db)
    include_i18n = _announcement_i18n_available(db)
    query = (
        _announcement_query(db, include_category=include_category, include_i18n=include_i18n)
        .filter(Announcement.status == PUBLISHED_ANNOUNCEMENT_STATUS)
        .filter(or_(Announcement.publish_at.is_(None), Announcement.publish_at <= now))
    )
    cleaned = _clean(identifier)
    if cleaned.isdigit():
        query = query.filter(Announcement.id == int(cleaned))
    else:
        query = query.filter(Announcement.slug == cleaned)
    row = query.first()
    return serialize_announcement(row, include_category=include_category, locale=locale, include_i18n=include_i18n) if row else None


def admin_query_announcements(db: Session, filters: dict[str, Any]) -> dict[str, Any]:
    page = max(1, _parse_int(filters.get("page"), 1))
    page_size = min(max(1, _parse_int(filters.get("page_size"), 20)), 100)
    include_category = _announcement_category_available(db)
    include_i18n = _announcement_i18n_available(db)
    query = _announcement_query(db, include_category=include_category, include_i18n=include_i18n)
    count_query = db.query(Announcement.id)

    status = _clean(filters.get("status")).upper()
    if status:
        query = query.filter(Announcement.status == status)
        count_query = count_query.filter(Announcement.status == status)

    category = _clean(filters.get("category")).lower()
    if include_category and category in ANNOUNCEMENT_CATEGORIES:
        query = query.filter(Announcement.category == category)
        count_query = count_query.filter(Announcement.category == category)

    keyword = _clean(filters.get("keyword"))
    if keyword:
        query = query.filter(or_(Announcement.title.like(f"%{keyword}%"), Announcement.slug.like(f"%{keyword}%")))
        count_query = count_query.filter(or_(Announcement.title.like(f"%{keyword}%"), Announcement.slug.like(f"%{keyword}%")))

    total = int(count_query.count())
    rows = (
        query.order_by(Announcement.is_pinned.desc(), Announcement.publish_at.desc(), Announcement.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return _page_result(
        items=[
            serialize_announcement(row, include_category=include_category, include_translation_status=True)
            for row in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        filters={"keyword": keyword, "status": status, "category": category},
    )


def admin_get_announcement(db: Session, announcement_id: int) -> Optional[dict[str, Any]]:
    include_category = _announcement_category_available(db)
    include_i18n = _announcement_i18n_available(db)
    row = _get_announcement_row(db, announcement_id, include_category=include_category, include_i18n=include_i18n)
    if row is None:
        return None
    return _append_i18n_form_fields(
        serialize_announcement(row, include_category=include_category, include_translation_status=True),
        row,
        ANNOUNCEMENT_I18N_FIELDS,
    )


def _normalize_slug(value: Any) -> str:
    cleaned = _clean(value).lower()
    allowed = []
    for char in cleaned:
        if char.isalnum() or char in {"-", "_"}:
            allowed.append(char)
        elif char.isspace():
            allowed.append("-")
    return "".join(allowed).strip("-_")


def _normalize_announcement_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": _clean(payload.get("title")),
        "slug": _normalize_slug(payload.get("slug")),
        "category": _normalize_announcement_category(payload.get("category")),
        "summary": _clean_optional(payload.get("summary")),
        "content": _sanitize_announcement_content(payload.get("content")),
        "is_pinned": _parse_bool(payload.get("is_pinned")),
        "status": _normalize_status(payload.get("status"), active_value=PUBLISHED_ANNOUNCEMENT_STATUS),
        "publish_at": _parse_datetime(payload.get("publish_at")),
    }


def _validate_announcement_form(db: Session, form: dict[str, Any], current_id: Optional[int] = None) -> list[str]:
    errors: list[str] = []
    if not form["title"]:
        errors.append("标题不能为空")
    if not form["slug"]:
        errors.append("slug 不能为空")
    if form["slug"]:
        query = db.query(Announcement.id).filter(Announcement.slug == form["slug"])
        if current_id:
            query = query.filter(Announcement.id != current_id)
        if query.first():
            errors.append("slug 已存在")
    return errors


def admin_announcement_form_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_announcement_payload(payload)
    return _append_i18n_form_fields(
        {**form, "publish_at_input": _clean(payload.get("publish_at"))},
        payload,
        ANNOUNCEMENT_I18N_FIELDS,
    )


def admin_create_announcement(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    form = _normalize_announcement_payload(payload)
    errors = _validate_announcement_form(db, form)
    if errors:
        return {"ok": False, "errors": errors, "form": admin_announcement_form_from_payload(payload)}

    include_category = _announcement_category_available(db)
    include_i18n = _announcement_i18n_available(db)
    write_form = dict(form)
    if not include_category:
        write_form.pop("category", None)
    if include_i18n:
        write_form.update(
            _normalize_i18n_payload(
                payload,
                ANNOUNCEMENT_I18N_FIELDS,
                sanitizer_by_field={"content": _sanitize_announcement_content},
            )
        )

    row = Announcement(**write_form)
    db.add(row)
    try:
        db.flush()
        row_id = int(row.id)
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"ok": False, "errors": ["slug 已存在"], "form": admin_announcement_form_from_payload(payload)}
    saved_row = _get_announcement_row(db, row_id, include_category=include_category, include_i18n=include_i18n)
    saved_form = serialize_announcement(saved_row, include_category=include_category) if saved_row else {**form, "id": row_id}
    return {"ok": True, "id": row_id, "form": saved_form}


def admin_update_announcement(db: Session, announcement_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    include_category = _announcement_category_available(db)
    include_i18n = _announcement_i18n_available(db)
    row = _get_announcement_row(db, announcement_id, include_category=include_category, include_i18n=include_i18n)
    if row is None:
        return {"ok": False, "errors": ["公告不存在"], "not_found": True}

    form = _normalize_announcement_payload(payload)
    errors = _validate_announcement_form(db, form, current_id=announcement_id)
    if errors:
        return {
            "ok": False,
            "errors": errors,
            "form": admin_announcement_form_from_payload(payload),
            "not_found": False,
        }

    for key, value in form.items():
        if key == "category" and not include_category:
            continue
        setattr(row, key, value)
    if include_i18n:
        for key, value in _normalize_i18n_payload(
            payload,
            ANNOUNCEMENT_I18N_FIELDS,
            sanitizer_by_field={"content": _sanitize_announcement_content},
        ).items():
            setattr(row, key, value)
    row_id = int(row.id)
    row.updated_at = _now()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"ok": False, "errors": ["slug 已存在"], "form": admin_announcement_form_from_payload(payload)}
    saved_row = _get_announcement_row(db, announcement_id, include_category=include_category, include_i18n=include_i18n)
    saved_form = serialize_announcement(saved_row, include_category=include_category) if saved_row else admin_announcement_form_from_payload(payload)
    return {"ok": True, "id": row_id, "form": saved_form}


def admin_toggle_announcement_status(db: Session, announcement_id: int) -> dict[str, Any]:
    include_category = _announcement_category_available(db)
    row = _get_announcement_row(db, announcement_id, include_category=include_category)
    if row is None:
        return {"ok": False, "message": "公告不存在"}
    new_status = DISABLED_STATUS if row.status == PUBLISHED_ANNOUNCEMENT_STATUS else PUBLISHED_ANNOUNCEMENT_STATUS
    row.status = new_status
    row.updated_at = _now()
    db.commit()
    return {
        "ok": True,
        "message": f"公告已{_status_label(new_status, active_value=PUBLISHED_ANNOUNCEMENT_STATUS)}",
    }

