from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import hashlib
from math import ceil
from pathlib import Path
import re
from threading import RLock
from time import monotonic
from typing import Any, Optional
from urllib.parse import urlsplit

from sqlalchemy import or_
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.core.content_locale import DEFAULT_CONTENT_LOCALE, localize_i18n_value
from app.db.models.contract_symbol import ContractSymbol
from app.db.models.mobile_content import MobileAnnouncement, MobileContentSettings, MobileHomeBanner
from app.db.models.trading_pair import TradingPair
from app.services.site_content_service import sanitize_announcement_html


MOBILE_CONTENT_SCHEMA_VERSION = 1
MOBILE_BANNER_VARIANT_SPECS = {
    "HERO": {
        "aspect_ratio": "16:9",
        "recommended_size": "1200x675",
        "ratio": 16 / 9,
        "min_width": 720,
        "min_height": 405,
    },
    "PROMO": {
        "aspect_ratio": "3:1",
        "recommended_size": "1200x400",
        "ratio": 3.0,
        "min_width": 720,
        "min_height": 240,
    },
}
MOBILE_BANNER_RATIO_TOLERANCE = 0.03
MOBILE_ANNOUNCEMENT_CONTENT_FORMATS = {"PLAIN_TEXT", "SANITIZED_HTML"}
MOBILE_ANNOUNCEMENT_DEFAULT_CONTENT_FORMAT = "PLAIN_TEXT"
MOBILE_APP_NAME_MAX_LENGTH = 80
MOBILE_BANNER_TITLE_MAX_LENGTH = 120
MOBILE_HERO_SUBTITLE_MAX_LENGTH = 220
MOBILE_PROMO_SUBTITLE_MAX_LENGTH = 180
MOBILE_MEDIA_URL_MAX_LENGTH = 500
MOBILE_ANNOUNCEMENT_TITLE_MAX_LENGTH = 180
MOBILE_ANNOUNCEMENT_SUMMARY_MAX_LENGTH = 280
MOBILE_ANNOUNCEMENT_CATEGORY_MAX_LENGTH = 40
MOBILE_ANNOUNCEMENT_CONTENT_MAX_LENGTH = 50_000
MOBILE_IMAGE_MAX_BYTES = 2_000_000
MOBILE_BOOTSTRAP_CACHE_TTL_SECONDS = 30
_HTML_MARKUP_RE = re.compile(
    r"<(?:!--|!doctype\b|/?[a-zA-Z][^>]*?)>",
    re.IGNORECASE,
)
_HTML_LT_ENTITY_RE = re.compile(r"&(?:lt|#0*60|#x0*3c);", re.IGNORECASE)
_HTML_GT_ENTITY_RE = re.compile(r"&(?:gt|#0*62|#x0*3e);", re.IGNORECASE)
_SLUG_RE = re.compile(r"[^0-9a-zA-Z\u3400-\u9fff]+")
MOBILE_IMAGE_MIME_TYPES = {"image/avif", "image/jpeg", "image/png", "image/webp"}
MOBILE_ACTION_ROUTES = {"LOGIN", "REGISTER", "MARKETS", "SPOT", "CONTRACT", "ASSETS"}
MOBILE_HOME_CONFIG_VERSION = 1
MOBILE_HOME_SECTION_DEFAULTS = {
    "asset_summary": True,
    "quick_entries": True,
    "market_shortcuts": True,
    "promos": True,
    "announcements": True,
}
MOBILE_HOME_QUICK_ENTRY_SPECS = {
    "DEPOSIT": {
        "title": "充值", "description": "充值资产",
        "title_i18n": {"zh": "充值", "en": "Deposit", "zh-TW": "充值", "ja": "入金"},
        "description_i18n": {"zh": "充值资产", "en": "Deposit assets", "zh-TW": "充值資產", "ja": "資産を入金"},
    },
    "WITHDRAW": {
        "title": "提现", "description": "提现资产",
        "title_i18n": {"zh": "提现", "en": "Withdraw", "zh-TW": "提現", "ja": "出金"},
        "description_i18n": {"zh": "提现资产", "en": "Withdraw assets", "zh-TW": "提現資產", "ja": "資産を出金"},
    },
    "TRANSFER": {
        "title": "划转", "description": "账户划转",
        "title_i18n": {"zh": "划转", "en": "Transfer", "zh-TW": "劃轉", "ja": "振替"},
        "description_i18n": {"zh": "账户划转", "en": "Account transfer", "zh-TW": "帳戶劃轉", "ja": "口座間で振替"},
    },
    "HISTORY": {
        "title": "资金流水", "description": "查看记录",
        "title_i18n": {"zh": "资金流水", "en": "Fund history", "zh-TW": "資金流水", "ja": "資金履歴"},
        "description_i18n": {"zh": "查看记录", "en": "View transaction records", "zh-TW": "查看記錄", "ja": "取引履歴を表示"},
    },
}
MOBILE_HOME_QUICK_TITLE_MAX_LENGTH = 12
MOBILE_HOME_QUICK_DESCRIPTION_MAX_LENGTH = 24
MOBILE_HOME_MARKET_LIMIT_RANGE = (1, 4)
MOBILE_HOME_MARKET_SHORTCUT_COUNT = 4
MOBILE_HOME_MARKET_SHORTCUT_DEFAULTS = (
    "BTCUSDT",
    "RCBUSDT",
    "ETHUSDT",
    "NVDAUSDT_PERP",
)
MOBILE_HOME_MARKET_SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{1,63}$")
MOBILE_HOME_PROMO_LIMIT_RANGE = (1, 8)
MOBILE_HOME_ANNOUNCEMENT_LIMIT_RANGE = (1, 10)
MOBILE_BANK_PORTAL_URL_MAX_LENGTH = 500
MOBILE_UPLOAD_URL_RE = re.compile(
    r"^/static/uploads/mobile/([0-9a-f]{32}\.webp)$"
)
MOBILE_UPLOAD_DIR = Path(__file__).resolve().parents[2] / "static" / "uploads" / "mobile"
_MOBILE_BOOTSTRAP_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_MOBILE_BOOTSTRAP_CACHE_LOCK = RLock()
ADMIN_I18N_LOCALES = (
    ("zh", "zh"),
    ("en", "en"),
    ("zh-TW", "zh_TW"),
    ("ja", "ja"),
)
MOBILE_SETTINGS_I18N_FIELDS = {"app_name": "app_name_i18n"}
MOBILE_BANNER_I18N_FIELDS = {"title": "title_i18n", "subtitle": "subtitle_i18n"}
MOBILE_ANNOUNCEMENT_I18N_FIELDS = {
    "title": "title_i18n",
    "summary": "summary_i18n",
    "category_label": "category_label_i18n",
    "content": "content_i18n",
}


def _now() -> datetime:
    return datetime.utcnow()


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _optional(value: Any) -> Optional[str]:
    value = _clean(value)
    return value or None


def _parse_bool(value: Any) -> bool:
    return _clean(value).lower() in {"1", "true", "yes", "on"}


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        normalized = str(value).strip()
        return int(normalized) if normalized else default
    except (TypeError, ValueError):
        return default


def _parse_datetime(value: Any) -> Optional[datetime]:
    value = _clean(value).replace("T", " ")
    if not value:
        return None
    if len(value) == 16:
        value += ":00"
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() + "Z" if value else None


def _datetime_input(value: Optional[datetime]) -> str:
    return value.strftime("%Y-%m-%dT%H:%M") if value else ""


def _slug(value: Any, title: Any) -> str:
    source = _clean(value) or _clean(title)
    return _SLUG_RE.sub("-", source.lower()).strip("-")[:191]


def _plain_text(value: Any) -> str:
    content = _clean(value)
    if _contains_html_markup(content):
        raise ValueError("移动端公告正文仅支持纯文本，不允许 HTML 标签")
    if _has_disallowed_text_control(content):
        raise ValueError("移动端公告正文包含不支持的控制字符")
    if len(content) > MOBILE_ANNOUNCEMENT_CONTENT_MAX_LENGTH:
        raise ValueError(
            f"移动端公告正文不能超过 {MOBILE_ANNOUNCEMENT_CONTENT_MAX_LENGTH} 个字符"
        )
    return content


def _announcement_content(value: Any, content_format: str) -> str:
    raw = _clean(value)
    if content_format == "PLAIN_TEXT":
        return _plain_text(raw)
    if content_format != "SANITIZED_HTML":
        raise ValueError("移动端公告正文格式无效")
    if len(raw) > MOBILE_ANNOUNCEMENT_CONTENT_MAX_LENGTH:
        raise ValueError(
            f"移动端公告正文不能超过 {MOBILE_ANNOUNCEMENT_CONTENT_MAX_LENGTH} 个字符"
        )
    if _has_disallowed_text_control(raw):
        raise ValueError("移动端公告正文包含不支持的控制字符")
    return sanitize_announcement_html(raw) or ""


def _contains_html_markup(value: str) -> bool:
    decoded_markers = _HTML_LT_ENTITY_RE.sub("<", value)
    decoded_markers = _HTML_GT_ENTITY_RE.sub(">", decoded_markers)
    return _HTML_MARKUP_RE.search(decoded_markers) is not None


def _has_disallowed_text_control(value: str) -> bool:
    return any(
        (ord(character) < 32 and character not in {"\t", "\n", "\r"})
        or ord(character) == 127
        for character in value
    )


def _localized(value: Any, translations: Any, locale: str) -> str:
    return str(localize_i18n_value(translations, locale, value or "") or "")


def _i18n_form_key(field_name: str, suffix: str) -> str:
    return f"{field_name}_i18n_{suffix}"


def _read_i18n_dict(source: Any, i18n_field_name: str) -> dict[str, Any]:
    value = source.get(i18n_field_name) if isinstance(source, dict) else getattr(source, i18n_field_name, None)
    return value if isinstance(value, dict) else {}


def _append_i18n_form_fields(
    form: dict[str, Any],
    source: Any,
    field_map: dict[str, str],
) -> dict[str, Any]:
    for field_name, i18n_field_name in field_map.items():
        translations = _read_i18n_dict(source, i18n_field_name)
        for locale, suffix in ADMIN_I18N_LOCALES:
            key = _i18n_form_key(field_name, suffix)
            if isinstance(source, dict) and key in source:
                form[key] = _clean(source.get(key))
            else:
                form[key] = str(translations.get(locale) or "")
        if not form.get(_i18n_form_key(field_name, "zh")):
            form[_i18n_form_key(field_name, "zh")] = _clean(
                source.get(field_name) if isinstance(source, dict) else getattr(source, field_name, "")
            )
    return form


def _collect_i18n_payload(
    payload: dict[str, Any],
    field_map: dict[str, str],
    *,
    existing: Any = None,
    sanitizer_by_field: Optional[dict[str, Any]] = None,
) -> tuple[dict[str, dict[str, str]], list[str]]:
    sanitizer_by_field = sanitizer_by_field or {}
    data: dict[str, dict[str, str]] = {}
    errors: list[str] = []
    for field_name, i18n_field_name in field_map.items():
        previous = _read_i18n_dict(existing, i18n_field_name)
        submitted = any(_i18n_form_key(field_name, suffix) in payload for _locale, suffix in ADMIN_I18N_LOCALES)
        translations: dict[str, str] = {}
        for locale, suffix in ADMIN_I18N_LOCALES:
            key = _i18n_form_key(field_name, suffix)
            raw = payload.get(key) if submitted else previous.get(locale)
            if locale == "zh" and not _clean(raw):
                raw = payload.get(field_name)
            sanitizer = sanitizer_by_field.get(field_name)
            try:
                translations[locale] = str(sanitizer(raw) if sanitizer else _clean(raw) or "")
            except ValueError as exc:
                translations[locale] = _clean(raw)
                errors.append(f"{field_name}（{locale}）：{exc}")
        data[i18n_field_name] = translations
    return data, errors


def _validate_i18n_plain_text(
    translations: dict[str, Any],
    *,
    label: str,
    max_length: int,
    required: bool,
) -> list[str]:
    errors: list[str] = []
    for locale, _suffix in ADMIN_I18N_LOCALES:
        value = _clean(translations.get(locale))
        if required and not value:
            errors.append(f"{label}（{locale}）不能为空")
        if len(value) > max_length:
            errors.append(f"{label}（{locale}）不能超过 {max_length} 个字符")
        if value and _contains_html_markup(value):
            errors.append(f"{label}（{locale}）仅支持纯文本，不允许 HTML 标签")
        if value and _has_disallowed_text_control(value):
            errors.append(f"{label}（{locale}）包含不支持的控制字符")
    return errors


def _default_mobile_home_config() -> dict[str, Any]:
    return {
        "version": MOBILE_HOME_CONFIG_VERSION,
        "sections": dict(MOBILE_HOME_SECTION_DEFAULTS),
        "quick_entries": [
            {
                "id": entry_id,
                "enabled": True,
                "title": spec["title"],
                "description": spec["description"],
                "title_i18n": dict(spec["title_i18n"]),
                "description_i18n": dict(spec["description_i18n"]),
                "sort_order": index,
            }
            for index, (entry_id, spec) in enumerate(
                MOBILE_HOME_QUICK_ENTRY_SPECS.items()
            )
        ],
        "market_shortcut_limit": MOBILE_HOME_MARKET_LIMIT_RANGE[1],
        "market_shortcut_symbols": list(MOBILE_HOME_MARKET_SHORTCUT_DEFAULTS),
        "promo_limit": MOBILE_HOME_PROMO_LIMIT_RANGE[1],
        "announcement_limit": 3,
        "bank_portal_url": None,
    }


def _conservative_mobile_home_config() -> dict[str, Any]:
    config = _default_mobile_home_config()
    config["sections"] = {
        "asset_summary": True,
        "quick_entries": False,
        "market_shortcuts": True,
        "promos": False,
        "announcements": False,
    }
    for entry in config["quick_entries"]:
        entry["enabled"] = False
    return config


def _bounded_home_text(
    value: Any,
    *,
    fallback: str,
    max_length: int,
) -> tuple[str, bool]:
    text = _clean(value)
    valid = bool(text) and len(text) <= max_length
    valid = valid and not _contains_html_markup(text)
    valid = valid and not _has_disallowed_text_control(text)
    return (text if valid else fallback), valid


def _mobile_bank_portal_url(value: Any) -> tuple[Optional[str], Optional[str]]:
    url = _optional(value)
    if url is None:
        return None, None
    if len(url) > MOBILE_BANK_PORTAL_URL_MAX_LENGTH:
        return None, f"银行端口链接不能超过 {MOBILE_BANK_PORTAL_URL_MAX_LENGTH} 个字符"
    if any(character.isspace() for character in url) or _has_disallowed_text_control(url):
        return None, "银行端口链接不能包含空格或控制字符"
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None, "银行端口链接格式不正确"
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        return None, "银行端口链接必须是完整的 HTTPS 地址"
    if parsed.username or parsed.password:
        return None, "银行端口链接不能包含用户名或密码"
    return url, None


def normalize_mobile_home_config(value: Any) -> dict[str, Any]:
    if value is None:
        return _default_mobile_home_config()
    if not isinstance(value, dict) or value.get("version") != MOBILE_HOME_CONFIG_VERSION:
        return _conservative_mobile_home_config()

    conservative = _conservative_mobile_home_config()
    raw_sections = value.get("sections")
    if isinstance(raw_sections, dict):
        conservative["sections"] = {
            key: raw_sections.get(key) is True
            for key in MOBILE_HOME_SECTION_DEFAULTS
        }

    raw_entries = value.get("quick_entries")
    indexed_entries = {
        _clean(item.get("id")).upper(): item
        for item in raw_entries
        if isinstance(item, dict)
        and _clean(item.get("id")).upper() in MOBILE_HOME_QUICK_ENTRY_SPECS
    } if isinstance(raw_entries, list) else {}
    normalized_entries: list[dict[str, Any]] = []
    for default_order, (entry_id, spec) in enumerate(
        MOBILE_HOME_QUICK_ENTRY_SPECS.items()
    ):
        raw = indexed_entries.get(entry_id, {})
        title, title_valid = _bounded_home_text(
            raw.get("title"),
            fallback=spec["title"],
            max_length=MOBILE_HOME_QUICK_TITLE_MAX_LENGTH,
        )
        description, description_valid = _bounded_home_text(
            raw.get("description"),
            fallback=spec["description"],
            max_length=MOBILE_HOME_QUICK_DESCRIPTION_MAX_LENGTH,
        )
        title_i18n = raw.get("title_i18n") if isinstance(raw.get("title_i18n"), dict) else {}
        description_i18n = raw.get("description_i18n") if isinstance(raw.get("description_i18n"), dict) else {}
        normalized_title_i18n: dict[str, str] = {}
        normalized_description_i18n: dict[str, str] = {}
        for locale, _suffix in ADMIN_I18N_LOCALES:
            localized_title, _ = _bounded_home_text(
                title_i18n.get(locale),
                fallback=spec["title_i18n"][locale],
                max_length=MOBILE_HOME_QUICK_TITLE_MAX_LENGTH,
            )
            localized_description, _ = _bounded_home_text(
                description_i18n.get(locale),
                fallback=spec["description_i18n"][locale],
                max_length=MOBILE_HOME_QUICK_DESCRIPTION_MAX_LENGTH,
            )
            normalized_title_i18n[locale] = localized_title
            normalized_description_i18n[locale] = localized_description
        sort_order = _parse_int(raw.get("sort_order"), default_order)
        normalized_entries.append(
            {
                "id": entry_id,
                "enabled": raw.get("enabled") is True and title_valid and description_valid,
                "title": title,
                "description": description,
                "title_i18n": normalized_title_i18n,
                "description_i18n": normalized_description_i18n,
                "sort_order": min(max(sort_order, 0), 99),
            }
        )
    conservative["quick_entries"] = normalized_entries

    def bounded_limit(name: str, value_range: tuple[int, int], fallback: int) -> int:
        parsed = _parse_int(value.get(name), fallback)
        return parsed if value_range[0] <= parsed <= value_range[1] else fallback

    conservative["market_shortcut_limit"] = bounded_limit(
        "market_shortcut_limit",
        MOBILE_HOME_MARKET_LIMIT_RANGE,
        MOBILE_HOME_MARKET_LIMIT_RANGE[1],
    )
    raw_market_symbols = value.get("market_shortcut_symbols")
    normalized_market_symbols = (
        [_clean(symbol).upper() for symbol in raw_market_symbols]
        if isinstance(raw_market_symbols, list)
        else []
    )
    if (
        len(normalized_market_symbols) == MOBILE_HOME_MARKET_SHORTCUT_COUNT
        and len(set(normalized_market_symbols)) == MOBILE_HOME_MARKET_SHORTCUT_COUNT
        and all(
            MOBILE_HOME_MARKET_SYMBOL_RE.fullmatch(symbol)
            for symbol in normalized_market_symbols
        )
    ):
        conservative["market_shortcut_symbols"] = normalized_market_symbols
    conservative["promo_limit"] = bounded_limit(
        "promo_limit",
        MOBILE_HOME_PROMO_LIMIT_RANGE,
        MOBILE_HOME_PROMO_LIMIT_RANGE[1],
    )
    conservative["announcement_limit"] = bounded_limit(
        "announcement_limit",
        MOBILE_HOME_ANNOUNCEMENT_LIMIT_RANGE,
        3,
    )
    bank_portal_url, _error = _mobile_bank_portal_url(
        value.get("bank_portal_url")
    )
    conservative["bank_portal_url"] = bank_portal_url
    return conservative


def serialize_mobile_home_config(
    row: Optional[MobileContentSettings],
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> dict[str, Any]:
    config = normalize_mobile_home_config(row.home_config if row else None)
    entries = sorted(
        (entry for entry in config["quick_entries"] if entry["enabled"]),
        key=lambda entry: (entry["sort_order"], entry["id"]),
    )
    return {
        "version": MOBILE_HOME_CONFIG_VERSION,
        "sections": dict(config["sections"]),
        "quick_entries": [
            {
                "id": entry["id"],
                "title": _localized(entry["title"], entry.get("title_i18n"), locale),
                "description": _localized(entry["description"], entry.get("description_i18n"), locale),
            }
            for entry in entries
        ],
        "market_shortcut_limit": config["market_shortcut_limit"],
        "market_shortcut_symbols": list(config["market_shortcut_symbols"]),
        "bank_portal_url": config["bank_portal_url"],
    }


def _home_config_form(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "home_sections": dict(config["sections"]),
        "home_quick_entries": sorted(
            (dict(entry) for entry in config["quick_entries"]),
            key=lambda entry: (entry["sort_order"], entry["id"]),
        ),
        "home_market_shortcut_limit": config["market_shortcut_limit"],
        "home_market_shortcut_symbols": list(config["market_shortcut_symbols"]),
        "home_promo_limit": config["promo_limit"],
        "home_announcement_limit": config["announcement_limit"],
        "home_bank_portal_url": config["bank_portal_url"] or "",
    }


def _normalize_mobile_home_config_payload(
    payload: dict[str, Any],
    current: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    has_home_fields = any(
        str(key).startswith("home_") for key in payload
    )
    if not has_home_fields:
        return deepcopy(current), []

    errors: list[str] = []
    config = _default_mobile_home_config()
    config["sections"] = {
        key: _parse_bool(payload.get(f"home_section_{key}"))
        for key in MOBILE_HOME_SECTION_DEFAULTS
    }
    if "home_bank_portal_url" in payload:
        raw_bank_portal_url = _optional(payload.get("home_bank_portal_url"))
        bank_portal_url, bank_portal_error = _mobile_bank_portal_url(
            raw_bank_portal_url
        )
        config["bank_portal_url"] = (
            raw_bank_portal_url if bank_portal_error else bank_portal_url
        )
        if bank_portal_error:
            errors.append(bank_portal_error)
    else:
        config["bank_portal_url"] = current.get("bank_portal_url")

    range_fields = (
        (
            "market_shortcut_limit",
            "home_market_shortcut_limit",
            MOBILE_HOME_MARKET_LIMIT_RANGE,
            "首页行情卡数量",
        ),
        (
            "promo_limit",
            "home_promo_limit",
            MOBILE_HOME_PROMO_LIMIT_RANGE,
            "首页活动数量",
        ),
        (
            "announcement_limit",
            "home_announcement_limit",
            MOBILE_HOME_ANNOUNCEMENT_LIMIT_RANGE,
            "首页公告数量",
        ),
    )
    for target, field, value_range, label in range_fields:
        parsed = _parse_int(payload.get(field))
        if not value_range[0] <= parsed <= value_range[1]:
            errors.append(f"{label}必须在 {value_range[0]} 到 {value_range[1]} 之间")
            parsed = current[target]
        config[target] = parsed

    market_symbol_fields = [
        f"home_market_shortcut_symbol_{index}"
        for index in range(1, MOBILE_HOME_MARKET_SHORTCUT_COUNT + 1)
    ]
    if any(field in payload for field in market_symbol_fields):
        market_symbols = [
            _clean(payload.get(field)).upper()
            for field in market_symbol_fields
        ]
        if any(not symbol for symbol in market_symbols):
            errors.append("首页行情四个位置都必须选择交易标的")
        elif any(
            MOBILE_HOME_MARKET_SYMBOL_RE.fullmatch(symbol) is None
            for symbol in market_symbols
        ):
            errors.append("首页行情交易标的格式不正确")
        elif len(set(market_symbols)) != MOBILE_HOME_MARKET_SHORTCUT_COUNT:
            errors.append("首页行情四个位置不能选择重复交易标的")
        else:
            config["market_shortcut_symbols"] = market_symbols
    else:
        config["market_shortcut_symbols"] = list(
            current["market_shortcut_symbols"]
        )

    entries: list[dict[str, Any]] = []
    current_entries = {
        str(entry.get("id") or "").upper(): entry
        for entry in current.get("quick_entries", [])
        if isinstance(entry, dict)
    }
    for default_order, (entry_id, spec) in enumerate(
        MOBILE_HOME_QUICK_ENTRY_SPECS.items()
    ):
        key = entry_id.lower()
        title = _clean(payload.get(f"home_quick_{key}_title"))
        description = _clean(payload.get(f"home_quick_{key}_description"))
        title_i18n: dict[str, str] = {}
        description_i18n: dict[str, str] = {}
        current_entry = current_entries.get(entry_id, {})
        current_title_i18n = current_entry.get("title_i18n") if isinstance(current_entry.get("title_i18n"), dict) else {}
        current_description_i18n = current_entry.get("description_i18n") if isinstance(current_entry.get("description_i18n"), dict) else {}
        entry_i18n_submitted = any(
            f"home_quick_{key}_{field}_i18n_{suffix}" in payload
            for field in ("title", "description")
            for _locale, suffix in ADMIN_I18N_LOCALES
        )
        for locale, suffix in ADMIN_I18N_LOCALES:
            title_field = f"home_quick_{key}_title_i18n_{suffix}"
            description_field = f"home_quick_{key}_description_i18n_{suffix}"
            localized_title = _clean(payload.get(title_field)) if entry_i18n_submitted else _clean(current_title_i18n.get(locale) or spec["title_i18n"][locale])
            localized_description = _clean(payload.get(description_field)) if entry_i18n_submitted else _clean(current_description_i18n.get(locale) or spec["description_i18n"][locale])
            if locale == "zh":
                localized_title = (localized_title or title) if entry_i18n_submitted else (title or localized_title)
                localized_description = (localized_description or description) if entry_i18n_submitted else (description or localized_description)
            _, localized_title_valid = _bounded_home_text(
                localized_title,
                fallback=spec["title_i18n"][locale],
                max_length=MOBILE_HOME_QUICK_TITLE_MAX_LENGTH,
            )
            _, localized_description_valid = _bounded_home_text(
                localized_description,
                fallback=spec["description_i18n"][locale],
                max_length=MOBILE_HOME_QUICK_DESCRIPTION_MAX_LENGTH,
            )
            if not localized_title_valid:
                errors.append(f"{spec['title']}入口标题（{locale}）不能为空、包含 HTML/控制字符或超过 {MOBILE_HOME_QUICK_TITLE_MAX_LENGTH} 个字符")
            if not localized_description_valid:
                errors.append(f"{spec['title']}入口说明（{locale}）不能为空、包含 HTML/控制字符或超过 {MOBILE_HOME_QUICK_DESCRIPTION_MAX_LENGTH} 个字符")
            title_i18n[locale] = localized_title or spec["title_i18n"][locale]
            description_i18n[locale] = localized_description or spec["description_i18n"][locale]
        sort_order = _parse_int(
            payload.get(f"home_quick_{key}_sort_order"),
            default_order,
        )
        _, title_valid = _bounded_home_text(
            title,
            fallback=spec["title"],
            max_length=MOBILE_HOME_QUICK_TITLE_MAX_LENGTH,
        )
        _, description_valid = _bounded_home_text(
            description,
            fallback=spec["description"],
            max_length=MOBILE_HOME_QUICK_DESCRIPTION_MAX_LENGTH,
        )
        if not title_valid:
            errors.append(
                f"{spec['title']}入口标题不能为空、包含 HTML/控制字符或超过 {MOBILE_HOME_QUICK_TITLE_MAX_LENGTH} 个字符"
            )
        if not description_valid:
            errors.append(
                f"{spec['title']}入口说明不能为空、包含 HTML/控制字符或超过 {MOBILE_HOME_QUICK_DESCRIPTION_MAX_LENGTH} 个字符"
            )
        if not 0 <= sort_order <= 99:
            errors.append(f"{spec['title']}入口排序必须在 0 到 99 之间")
            sort_order = default_order
        entries.append(
            {
                "id": entry_id,
                "enabled": _parse_bool(
                    payload.get(f"home_quick_{key}_enabled")
                ),
                "title": title or spec["title"],
                "description": description or spec["description"],
                "title_i18n": title_i18n,
                "description_i18n": description_i18n,
                "sort_order": sort_order,
            }
        )
    config["quick_entries"] = entries
    return config, errors


def _inspect_mobile_uploaded_image(url: Any) -> dict[str, Any]:
    normalized_url = _clean(url)
    match = MOBILE_UPLOAD_URL_RE.fullmatch(normalized_url)
    if match is None:
        raise ValueError("请通过手机端内容上传按钮选择图片，不支持外链或 PC 图片地址")

    root = MOBILE_UPLOAD_DIR.resolve()
    target = (root / match.group(1)).resolve()
    if target.parent != root or not target.is_file():
        raise ValueError("手机端图片文件不存在，请重新上传")
    byte_size = target.stat().st_size
    if byte_size <= 0 or byte_size > MOBILE_IMAGE_MAX_BYTES:
        raise ValueError("手机端图片压缩后不能超过 2MB")

    try:
        from PIL import Image, UnidentifiedImageError

        with Image.open(target) as image:
            width, height = image.size
            image_format = str(image.format or "").upper()
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("手机端图片文件损坏，请重新上传") from exc

    if (
        image_format != "WEBP"
        or width <= 0
        or height <= 0
        or width > 4096
        or height > 4096
        or width * height > 12_000_000
    ):
        raise ValueError("手机端图片格式或尺寸无效，请重新上传")
    return {
        "image_url": normalized_url,
        "image_width": int(width),
        "image_height": int(height),
        "image_byte_size": int(byte_size),
        "image_mime_type": "image/webp",
    }


def get_or_create_mobile_settings(db: Session) -> MobileContentSettings:
    row = db.query(MobileContentSettings).order_by(MobileContentSettings.id.asc()).first()
    if row is None:
        row = MobileContentSettings()
        db.add(row)
        db.commit()
        invalidate_mobile_content_bootstrap_cache()
        db.refresh(row)
    return row


def serialize_mobile_settings(row: Optional[MobileContentSettings], locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    if row is None:
        return {
            "display_name": "Exchange",
            "logo": None,
        }
    return {
        "display_name": _localized(row.app_name, row.app_name_i18n, locale),
        "logo": _media(
            "APP_LOGO",
            row.logo_url,
            row.logo_width,
            row.logo_height,
            row.logo_byte_size,
            row.logo_mime_type,
        ),
    }


def update_mobile_settings(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    existing_row = (
        db.query(MobileContentSettings)
        .order_by(MobileContentSettings.id.asc())
        .first()
    )
    settings_i18n, i18n_errors = _collect_i18n_payload(
        payload,
        MOBILE_SETTINGS_I18N_FIELDS,
        existing=existing_row,
    )
    errors.extend(i18n_errors)
    app_name = _clean(settings_i18n["app_name_i18n"].get("zh") or payload.get("app_name"))
    app_name_i18n_submitted = any(
        _i18n_form_key("app_name", suffix) in payload
        for _locale, suffix in ADMIN_I18N_LOCALES
    )
    if app_name_i18n_submitted:
        errors.extend(
            _validate_i18n_plain_text(
                settings_i18n["app_name_i18n"],
                label="应用名称",
                max_length=MOBILE_APP_NAME_MAX_LENGTH,
                required=True,
            )
        )
    current_home_config = normalize_mobile_home_config(
        existing_row.home_config if existing_row else None
    )
    home_config, home_errors = _normalize_mobile_home_config_payload(
        payload,
        current_home_config,
    )
    errors.extend(home_errors)
    market_symbols_submitted = any(
        f"home_market_shortcut_symbol_{index}" in payload
        for index in range(1, MOBILE_HOME_MARKET_SHORTCUT_COUNT + 1)
    )
    active_market_symbols: set[str] = set()
    if market_symbols_submitted:
        active_market_symbols = _active_mobile_market_symbols(db)
        unavailable_symbols = [
            symbol
            for symbol in home_config["market_shortcut_symbols"]
            if symbol not in active_market_symbols
        ]
        if unavailable_symbols:
            errors.append(
                "首页行情交易标的未启用或不存在："
                + ", ".join(unavailable_symbols)
            )
    if not app_name:
        errors.append("应用名称不能为空")
    if len(app_name) > MOBILE_APP_NAME_MAX_LENGTH:
        errors.append(f"应用名称不能超过 {MOBILE_APP_NAME_MAX_LENGTH} 个字符")
    if _contains_html_markup(app_name):
        errors.append("应用名称仅支持纯文本，不允许 HTML 标签")
    if _has_disallowed_text_control(app_name):
        errors.append("应用名称包含不支持的控制字符")
    logo_url = _optional(payload.get("logo_url"))
    if logo_url and len(logo_url) > MOBILE_MEDIA_URL_MAX_LENGTH:
        errors.append(f"LOGO 地址不能超过 {MOBILE_MEDIA_URL_MAX_LENGTH} 个字符")
    logo_media: Optional[dict[str, Any]] = None
    if logo_url and not errors:
        try:
            logo_media = _inspect_mobile_uploaded_image(logo_url)
        except ValueError as exc:
            errors.append(str(exc))
    if errors:
        form = dict(payload)
        _append_i18n_form_fields(form, payload, MOBILE_SETTINGS_I18N_FIELDS)
        form.update(_home_config_form(home_config))
        form["home_market_symbol_options"] = sorted(
            active_market_symbols | set(home_config["market_shortcut_symbols"])
        )
        return {"ok": False, "errors": errors, "form": form}
    row = get_or_create_mobile_settings(db)
    row.app_name = app_name
    row.app_name_i18n = settings_i18n["app_name_i18n"]
    row.logo_url = logo_url
    row.logo_width = logo_media["image_width"] if logo_media else None
    row.logo_height = logo_media["image_height"] if logo_media else None
    row.logo_byte_size = logo_media["image_byte_size"] if logo_media else None
    row.logo_mime_type = logo_media["image_mime_type"] if logo_media else None
    row.home_config = home_config
    if row.logo_url and _media(
        "APP_LOGO",
        row.logo_url,
        row.logo_width,
        row.logo_height,
        row.logo_byte_size,
        row.logo_mime_type,
    ) is None:
        return {
            "ok": False,
            "errors": ["LOGO 必须填写有效宽高、文件大小及 PNG/JPEG/WebP/AVIF MIME 类型"],
            "form": dict(payload),
        }
    db.commit()
    invalidate_mobile_content_bootstrap_cache()
    return {"ok": True, "form": mobile_settings_form(row)}


def mobile_settings_form(
    row: MobileContentSettings,
    db: Optional[Session] = None,
) -> dict[str, Any]:
    form = {
        "app_name": row.app_name,
        "logo_url": row.logo_url or "",
        "logo_width": row.logo_width or "",
        "logo_height": row.logo_height or "",
        "logo_byte_size": row.logo_byte_size or "",
        "logo_mime_type": row.logo_mime_type or "",
    }
    _append_i18n_form_fields(form, row, MOBILE_SETTINGS_I18N_FIELDS)
    config = normalize_mobile_home_config(row.home_config)
    form.update(_home_config_form(config))
    form["home_market_symbol_options"] = sorted(
        (_active_mobile_market_symbols(db) if db is not None else set())
        | set(config["market_shortcut_symbols"])
    )
    return form


def _active_mobile_market_symbols(db: Session) -> set[str]:
    spot_symbols = {
        str(symbol or "").upper().strip()
        for (symbol,) in (
            db.query(TradingPair.symbol)
            .filter(TradingPair.status == 1)
            .all()
        )
        if str(symbol or "").strip()
    }
    contract_symbols = {
        str(symbol or "").upper().strip()
        for (symbol,) in (
            db.query(ContractSymbol.symbol)
            .filter(ContractSymbol.status == 1)
            .all()
        )
        if str(symbol or "").strip()
    }
    return spot_symbols | contract_symbols


def serialize_mobile_banner(row: MobileHomeBanner, locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    variant = "HOME_HERO" if row.placement == "HERO" else "HOME_PROMO"
    action = None
    if row.action_type == "ROUTE" and row.action_route in MOBILE_ACTION_ROUTES:
        action = {"type": "ROUTE", "route": row.action_route}
    return {
        "id": int(row.id),
        "scope": "MOBILE",
        "variant": variant,
        "title": _localized(row.title, row.title_i18n, locale),
        "subtitle": _localized(row.subtitle, row.subtitle_i18n, locale),
        "image": _media(
            variant,
            row.image_url,
            row.image_width,
            row.image_height,
            row.image_byte_size,
            row.image_mime_type,
        ),
        "placement": row.placement,
        "action": action,
        "aspect_ratio": row.aspect_ratio,
        "recommended_size": row.recommended_size,
        "sort_order": int(row.sort_order),
        "status": row.status,
        "start_at": _iso(row.start_at),
        "end_at": _iso(row.end_at),
        "updated_at": _iso(row.updated_at),
    }


def get_public_mobile_banners(db: Session, limit: int = 8, locale: str = DEFAULT_CONTENT_LOCALE) -> list[dict[str, Any]]:
    now = _now()
    active = (
        db.query(MobileHomeBanner)
        .filter(
            MobileHomeBanner.status == "ACTIVE",
            or_(MobileHomeBanner.start_at.is_(None), MobileHomeBanner.start_at <= now),
            or_(MobileHomeBanner.end_at.is_(None), MobileHomeBanner.end_at >= now),
        )
    )
    hero_rows = (
        active.filter(MobileHomeBanner.placement == "HERO")
        .order_by(MobileHomeBanner.sort_order.asc(), MobileHomeBanner.id.desc())
        .all()
    )
    promo_rows = (
        active.filter(MobileHomeBanner.placement == "PROMO")
        .order_by(MobileHomeBanner.sort_order.asc(), MobileHomeBanner.id.desc())
        .limit(limit)
        .all()
    )
    hero = next(
        (
            item
            for item in (
                serialize_mobile_banner(row, locale=locale)
                for row in hero_rows
            )
            if item["image"] is not None
        ),
        None,
    )
    promos = [
        item
        for item in (
            serialize_mobile_banner(row, locale=locale)
            for row in promo_rows
        )
        if item["image"] is not None
    ]
    return ([hero] if hero else []) + promos


def _normalize_banner(payload: dict[str, Any], existing: Any = None) -> tuple[dict[str, Any], list[str]]:
    action_route = _clean(payload.get("action_route")).upper() or None
    i18n, i18n_errors = _collect_i18n_payload(
        payload,
        MOBILE_BANNER_I18N_FIELDS,
        existing=existing,
    )
    data = {
        "title": _clean(i18n["title_i18n"].get("zh") or payload.get("title")),
        "subtitle": _optional(i18n["subtitle_i18n"].get("zh") or payload.get("subtitle")),
        "image_url": _clean(payload.get("image_url")),
        "image_width": _parse_int(payload.get("image_width")),
        "image_height": _parse_int(payload.get("image_height")),
        "image_byte_size": _parse_int(payload.get("image_byte_size")),
        "image_mime_type": _clean(payload.get("image_mime_type")).lower(),
        "placement": _clean(payload.get("placement")).upper() or "PROMO",
        "action_type": "ROUTE" if action_route else None,
        "action_route": action_route,
        "sort_order": _parse_int(payload.get("sort_order")),
        "status": _clean(payload.get("status")).upper() or "ACTIVE",
        "start_at": _parse_datetime(payload.get("start_at")),
        "end_at": _parse_datetime(payload.get("end_at")),
    }
    data.update(i18n)
    return data, i18n_errors


def _validate_banner(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not data["title"]:
        errors.append("Banner 标题不能为空")
    if len(data["title"]) > MOBILE_BANNER_TITLE_MAX_LENGTH:
        errors.append(f"Banner 标题不能超过 {MOBILE_BANNER_TITLE_MAX_LENGTH} 个字符")
    if _contains_html_markup(data["title"]):
        errors.append("Banner 标题仅支持纯文本，不允许 HTML 标签")
    if _has_disallowed_text_control(data["title"]):
        errors.append("Banner 标题包含不支持的控制字符")
    subtitle_limit = (
        MOBILE_HERO_SUBTITLE_MAX_LENGTH
        if data["placement"] == "HERO"
        else MOBILE_PROMO_SUBTITLE_MAX_LENGTH
    )
    if data["subtitle"] and len(data["subtitle"]) > subtitle_limit:
        errors.append(f"Banner 副标题不能超过 {subtitle_limit} 个字符")
    if data["subtitle"] and _contains_html_markup(data["subtitle"]):
        errors.append("Banner 副标题仅支持纯文本，不允许 HTML 标签")
    if data["subtitle"] and _has_disallowed_text_control(data["subtitle"]):
        errors.append("Banner 副标题包含不支持的控制字符")
    if not data["image_url"]:
        errors.append("Banner 图片不能为空")
    if len(data["image_url"]) > MOBILE_MEDIA_URL_MAX_LENGTH:
        errors.append(f"Banner 图片地址不能超过 {MOBILE_MEDIA_URL_MAX_LENGTH} 个字符")
    if _media(
        "HOME_HERO" if data["placement"] == "HERO" else "HOME_PROMO",
        data["image_url"],
        data["image_width"],
        data["image_height"],
        data["image_byte_size"],
        data["image_mime_type"],
    ) is None:
        errors.append("Banner 必须填写有效宽高、文件大小及 PNG/JPEG/WebP/AVIF MIME 类型")
    if data["placement"] not in {"HERO", "PROMO"}:
        errors.append("Banner 位置无效")
    elif data["image_width"] > 0 and data["image_height"] > 0:
        spec = MOBILE_BANNER_VARIANT_SPECS[data["placement"]]
        actual_ratio = data["image_width"] / data["image_height"]
        expected_ratio = float(spec["ratio"])
        if abs(actual_ratio - expected_ratio) / expected_ratio > MOBILE_BANNER_RATIO_TOLERANCE:
            errors.append(
                f"{data['placement']} 图片比例须接近 {spec['aspect_ratio']}（建议 {spec['recommended_size']}）"
            )
        if (
            data["image_width"] < int(spec["min_width"])
            or data["image_height"] < int(spec["min_height"])
        ):
            errors.append(
                f"{data['placement']} 图片最低尺寸为 {spec['min_width']}x{spec['min_height']}"
            )
    if data["action_route"] and data["action_route"] not in MOBILE_ACTION_ROUTES:
        errors.append("跳转路由不在手机端白名单")
    if data["status"] not in {"ACTIVE", "DISABLED"}:
        errors.append("Banner 状态无效")
    if data["start_at"] and data["end_at"] and data["start_at"] > data["end_at"]:
        errors.append("开始时间不能晚于结束时间")
    return errors


def _windows_overlap(
    left_start: Optional[datetime],
    left_end: Optional[datetime],
    right_start: Optional[datetime],
    right_end: Optional[datetime],
) -> bool:
    return (
        left_end is None
        or right_start is None
        or left_end >= right_start
    ) and (
        right_end is None
        or left_start is None
        or right_end >= left_start
    )


def _active_hero_overlap_error(
    db: Session,
    data: dict[str, Any],
    banner_id: Optional[int],
) -> Optional[str]:
    if data["placement"] != "HERO" or data["status"] != "ACTIVE":
        return None
    # Serialize HERO schedule checks even when the banner table has no matching
    # row yet. The migration seeds this singleton, so locking it closes the
    # empty-result race that a banner-only SELECT ... FOR UPDATE cannot cover
    # under every database isolation level.
    (
        db.query(MobileContentSettings.id)
        .order_by(MobileContentSettings.id.asc())
        .with_for_update()
        .first()
    )
    rows = (
        db.query(MobileHomeBanner)
        .filter(
            MobileHomeBanner.placement == "HERO",
        )
        .with_for_update()
        .all()
    )
    for row in rows:
        if banner_id is not None and int(row.id) == int(banner_id):
            continue
        if row.status != "ACTIVE":
            continue
        if _windows_overlap(
            row.start_at,
            row.end_at,
            data["start_at"],
            data["end_at"],
        ):
            return "同一时间段只能启用一个手机端 HERO，请先调整现有 HERO 的展示时间或状态"
    return None


def mobile_banner_form(row: MobileHomeBanner) -> dict[str, Any]:
    data = serialize_mobile_banner(row)
    data.update(
        {
            "image_url": row.image_url,
            "image_width": row.image_width,
            "image_height": row.image_height,
            "image_byte_size": row.image_byte_size,
            "image_mime_type": row.image_mime_type,
            "action_route": row.action_route or "",
        }
    )
    data["start_at_input"] = _datetime_input(row.start_at)
    data["end_at_input"] = _datetime_input(row.end_at)
    return _append_i18n_form_fields(data, row, MOBILE_BANNER_I18N_FIELDS)


def admin_list_mobile_banners(db: Session, keyword: str = "", status: str = "", page: int = 1, page_size: int = 20) -> dict[str, Any]:
    query = db.query(MobileHomeBanner)
    if _clean(keyword):
        query = query.filter(MobileHomeBanner.title.ilike(f"%{_clean(keyword)}%"))
    if _clean(status):
        query = query.filter(MobileHomeBanner.status == _clean(status).upper())
    total = query.count()
    rows = query.order_by(MobileHomeBanner.sort_order.asc(), MobileHomeBanner.id.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return {"items": [mobile_banner_form(row) for row in rows], "page": page, "page_size": page_size, "total": total, "pages": max(1, ceil(total / page_size))}


def admin_get_mobile_banner(db: Session, banner_id: int) -> Optional[dict[str, Any]]:
    row = db.get(MobileHomeBanner, banner_id)
    return mobile_banner_form(row) if row else None


def admin_save_mobile_banner(db: Session, payload: dict[str, Any], banner_id: Optional[int] = None) -> dict[str, Any]:
    row = db.get(MobileHomeBanner, banner_id) if banner_id else None
    if banner_id and row is None:
        return {"ok": False, "not_found": True, "errors": ["Banner 不存在"], "form": dict(payload)}
    data, i18n_errors = _normalize_banner(payload, existing=row)
    media_error: Optional[str] = None
    if data["image_url"]:
        try:
            data.update(_inspect_mobile_uploaded_image(data["image_url"]))
        except ValueError as exc:
            media_error = str(exc)
    errors = _validate_banner(data)
    errors.extend(i18n_errors)
    i18n_submitted = any(
        _i18n_form_key(field_name, suffix) in payload
        for field_name in MOBILE_BANNER_I18N_FIELDS
        for _locale, suffix in ADMIN_I18N_LOCALES
    )
    if i18n_submitted:
        errors.extend(_validate_i18n_plain_text(data["title_i18n"], label="Banner 标题", max_length=MOBILE_BANNER_TITLE_MAX_LENGTH, required=True))
        subtitle_limit = MOBILE_HERO_SUBTITLE_MAX_LENGTH if data["placement"] == "HERO" else MOBILE_PROMO_SUBTITLE_MAX_LENGTH
        errors.extend(_validate_i18n_plain_text(data["subtitle_i18n"], label="Banner 副标题", max_length=subtitle_limit, required=False))
    if media_error:
        errors.append(media_error)
    overlap_error = (
        _active_hero_overlap_error(db, data, banner_id)
        if not errors
        else None
    )
    if overlap_error:
        errors.append(overlap_error)
    if errors:
        form = dict(payload)
        _append_i18n_form_fields(form, payload, MOBILE_BANNER_I18N_FIELDS)
        form.update({"start_at_input": _clean(payload.get("start_at")), "end_at_input": _clean(payload.get("end_at"))})
        return {"ok": False, "errors": errors, "form": form}
    row = row or MobileHomeBanner()
    for key, value in data.items():
        setattr(row, key, value)
    spec = MOBILE_BANNER_VARIANT_SPECS[data["placement"]]
    row.aspect_ratio = spec["aspect_ratio"]
    row.recommended_size = spec["recommended_size"]
    db.add(row)
    db.commit()
    invalidate_mobile_content_bootstrap_cache()
    db.refresh(row)
    return {"ok": True, "form": mobile_banner_form(row)}


def admin_toggle_mobile_banner(db: Session, banner_id: int) -> dict[str, Any]:
    row = db.get(MobileHomeBanner, banner_id)
    if row is None:
        return {"ok": False, "not_found": True, "error": "Banner 不存在"}
    next_status = "DISABLED" if row.status == "ACTIVE" else "ACTIVE"
    if next_status == "ACTIVE":
        data = {
            "placement": row.placement,
            "status": next_status,
            "start_at": row.start_at,
            "end_at": row.end_at,
        }
        overlap_error = _active_hero_overlap_error(db, data, banner_id)
        if overlap_error:
            db.rollback()
            return {"ok": False, "not_found": False, "error": overlap_error}
    row.status = next_status
    db.commit()
    invalidate_mobile_content_bootstrap_cache()
    return {"ok": True, "not_found": False, "error": ""}


def serialize_mobile_announcement(row: MobileAnnouncement, locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    return {
        "id": int(row.id),
        "scope": "MOBILE",
        "title": _localized(row.title, row.title_i18n, locale),
        "slug": row.slug,
        "summary": _localized(row.summary, row.summary_i18n, locale),
        "category_label": _localized(row.category_label, row.category_label_i18n, locale),
        "content": _localized(row.content, row.content_i18n, locale),
        "content_format": row.content_format,
        "is_pinned": bool(row.is_pinned),
        "status": row.status,
        "published_at": _iso(row.publish_at),
        "updated_at": _iso(row.updated_at),
    }


def get_public_mobile_announcements(db: Session, limit: int = 10, locale: str = DEFAULT_CONTENT_LOCALE) -> list[dict[str, Any]]:
    now = _now()
    rows = (
        db.query(MobileAnnouncement)
        .filter(
            MobileAnnouncement.status == "PUBLISHED",
            MobileAnnouncement.content_format.in_(MOBILE_ANNOUNCEMENT_CONTENT_FORMATS),
            or_(MobileAnnouncement.publish_at.is_(None), MobileAnnouncement.publish_at <= now),
        )
        .order_by(MobileAnnouncement.is_pinned.desc(), MobileAnnouncement.publish_at.desc(), MobileAnnouncement.id.desc())
        .limit(limit)
        .all()
    )
    return [serialize_mobile_announcement(row, locale=locale) for row in rows]


def get_public_mobile_announcement_page(
    db: Session,
    page: int = 1,
    page_size: int = 20,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> dict[str, Any]:
    page = max(int(page or 1), 1)
    page_size = min(max(int(page_size or 20), 1), 50)
    now = _now()
    query = db.query(MobileAnnouncement).filter(
        MobileAnnouncement.status == "PUBLISHED",
        MobileAnnouncement.content_format.in_(MOBILE_ANNOUNCEMENT_CONTENT_FORMATS),
        or_(MobileAnnouncement.publish_at.is_(None), MobileAnnouncement.publish_at <= now),
    )
    total = int(query.count())
    pages = max((total + page_size - 1) // page_size, 1)
    rows = (
        query.order_by(
            MobileAnnouncement.is_pinned.desc(),
            MobileAnnouncement.publish_at.desc(),
            MobileAnnouncement.id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [
        {
            key: value
            for key, value in serialize_mobile_announcement(row, locale=locale).items()
            if key
            in {
                "id",
                "scope",
                "title",
                "summary",
                "category_label",
                "is_pinned",
                "published_at",
            }
        }
        for row in rows
    ]
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
    }


def _normalize_announcement(payload: dict[str, Any], existing: Any = None) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    content_format = (
        _clean(payload.get("content_format")).upper()
        or MOBILE_ANNOUNCEMENT_DEFAULT_CONTENT_FORMAT
    )
    i18n, i18n_errors = _collect_i18n_payload(
        payload,
        MOBILE_ANNOUNCEMENT_I18N_FIELDS,
        existing=existing,
        sanitizer_by_field={
            "content": lambda value: _announcement_content(value, content_format),
        },
    )
    errors.extend(i18n_errors)
    title = _clean(i18n["title_i18n"].get("zh") or payload.get("title"))
    try:
        content = _announcement_content(i18n["content_i18n"].get("zh") or payload.get("content"), content_format)
    except ValueError as exc:
        content = _clean(payload.get("content"))
        errors.append(str(exc))
    data = {
        "title": title,
        "title_i18n": i18n["title_i18n"],
        "slug": _slug(payload.get("slug"), title),
        "summary": _optional(i18n["summary_i18n"].get("zh") or payload.get("summary")),
        "summary_i18n": i18n["summary_i18n"],
        "category_label": _clean(i18n["category_label_i18n"].get("zh") or payload.get("category_label")) or "公告",
        "category_label_i18n": i18n["category_label_i18n"],
        "content": content,
        "content_i18n": i18n["content_i18n"],
        "content_format": content_format,
        "is_pinned": _parse_bool(payload.get("is_pinned")),
        "status": _clean(payload.get("status")).upper() or "DRAFT",
        "publish_at": _parse_datetime(payload.get("publish_at")),
    }
    if not title:
        errors.append("公告标题不能为空")
    if len(title) > MOBILE_ANNOUNCEMENT_TITLE_MAX_LENGTH:
        errors.append(f"公告标题不能超过 {MOBILE_ANNOUNCEMENT_TITLE_MAX_LENGTH} 个字符")
    if _contains_html_markup(title):
        errors.append("公告标题仅支持纯文本，不允许 HTML 标签")
    if _has_disallowed_text_control(title):
        errors.append("公告标题包含不支持的控制字符")
    if not data["slug"]:
        errors.append("公告 slug 不能为空")
    if not content:
        errors.append("公告正文不能为空")
    if content_format not in MOBILE_ANNOUNCEMENT_CONTENT_FORMATS:
        errors.append("公告正文格式无效")
    if data["summary"] and len(data["summary"]) > MOBILE_ANNOUNCEMENT_SUMMARY_MAX_LENGTH:
        errors.append(f"公告摘要不能超过 {MOBILE_ANNOUNCEMENT_SUMMARY_MAX_LENGTH} 个字符")
    if data["summary"] and _contains_html_markup(data["summary"]):
        errors.append("公告摘要仅支持纯文本，不允许 HTML 标签")
    if data["summary"] and _has_disallowed_text_control(data["summary"]):
        errors.append("公告摘要包含不支持的控制字符")
    if len(data["category_label"]) > MOBILE_ANNOUNCEMENT_CATEGORY_MAX_LENGTH:
        errors.append(f"公告分类不能超过 {MOBILE_ANNOUNCEMENT_CATEGORY_MAX_LENGTH} 个字符")
    if _contains_html_markup(data["category_label"]):
        errors.append("公告分类仅支持纯文本，不允许 HTML 标签")
    if _has_disallowed_text_control(data["category_label"]):
        errors.append("公告分类包含不支持的控制字符")
    if data["status"] not in {"DRAFT", "PUBLISHED", "OFFLINE"}:
        errors.append("公告状态无效")
    return data, errors


def mobile_announcement_form(row: MobileAnnouncement) -> dict[str, Any]:
    data = serialize_mobile_announcement(row)
    data["publish_at_input"] = _datetime_input(row.publish_at)
    data["publish_at"] = data["published_at"]
    return _append_i18n_form_fields(data, row, MOBILE_ANNOUNCEMENT_I18N_FIELDS)


def admin_list_mobile_announcements(db: Session, keyword: str = "", status: str = "", page: int = 1, page_size: int = 20) -> dict[str, Any]:
    query = db.query(MobileAnnouncement)
    if _clean(keyword):
        term = f"%{_clean(keyword)}%"
        query = query.filter(or_(MobileAnnouncement.title.ilike(term), MobileAnnouncement.slug.ilike(term)))
    if _clean(status):
        query = query.filter(MobileAnnouncement.status == _clean(status).upper())
    total = query.count()
    rows = query.order_by(MobileAnnouncement.is_pinned.desc(), MobileAnnouncement.id.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return {"items": [mobile_announcement_form(row) for row in rows], "page": page, "page_size": page_size, "total": total, "pages": max(1, ceil(total / page_size))}


def admin_get_mobile_announcement(db: Session, announcement_id: int) -> Optional[dict[str, Any]]:
    row = db.get(MobileAnnouncement, announcement_id)
    return mobile_announcement_form(row) if row else None


def admin_save_mobile_announcement(db: Session, payload: dict[str, Any], announcement_id: Optional[int] = None) -> dict[str, Any]:
    row = db.get(MobileAnnouncement, announcement_id) if announcement_id else None
    if announcement_id and row is None:
        return {"ok": False, "not_found": True, "errors": ["公告不存在"], "form": dict(payload)}
    data, errors = _normalize_announcement(payload, existing=row)
    i18n_submitted = any(
        _i18n_form_key(field_name, suffix) in payload
        for field_name in MOBILE_ANNOUNCEMENT_I18N_FIELDS
        for _locale, suffix in ADMIN_I18N_LOCALES
    )
    if i18n_submitted:
        errors.extend(_validate_i18n_plain_text(data["title_i18n"], label="公告标题", max_length=MOBILE_ANNOUNCEMENT_TITLE_MAX_LENGTH, required=True))
        errors.extend(_validate_i18n_plain_text(data["summary_i18n"], label="公告摘要", max_length=MOBILE_ANNOUNCEMENT_SUMMARY_MAX_LENGTH, required=False))
        errors.extend(_validate_i18n_plain_text(data["category_label_i18n"], label="公告分类", max_length=MOBILE_ANNOUNCEMENT_CATEGORY_MAX_LENGTH, required=True))
        for locale, _suffix in ADMIN_I18N_LOCALES:
            if not _clean(data["content_i18n"].get(locale)):
                errors.append(f"公告正文（{locale}）不能为空")
    if errors:
        form = dict(payload)
        _append_i18n_form_fields(form, payload, MOBILE_ANNOUNCEMENT_I18N_FIELDS)
        form["publish_at_input"] = _clean(payload.get("publish_at"))
        return {"ok": False, "errors": errors, "form": form}
    row = row or MobileAnnouncement()
    for key, value in data.items():
        setattr(row, key, value)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {"ok": False, "errors": ["公告 slug 已存在"], "form": dict(payload)}
    except DataError:
        db.rollback()
        return {
            "ok": False,
            "errors": ["公告内容超出数据库安全容量，请缩短后重试"],
            "form": dict(payload),
        }
    invalidate_mobile_content_bootstrap_cache()
    db.refresh(row)
    return {"ok": True, "form": mobile_announcement_form(row)}


def preview_mobile_announcement_content(payload: dict[str, Any]) -> dict[str, Any]:
    content_format = (
        _clean(payload.get("content_format")).upper()
        or MOBILE_ANNOUNCEMENT_DEFAULT_CONTENT_FORMAT
    )
    try:
        content = _announcement_content(payload.get("content"), content_format)
    except ValueError as exc:
        return {"ok": False, "errors": [str(exc)], "content": ""}
    if not content:
        return {"ok": False, "errors": ["公告正文不能为空"], "content": ""}
    return {
        "ok": True,
        "errors": [],
        "content": content,
        "content_format": content_format,
    }


def admin_set_mobile_announcement_status(db: Session, announcement_id: int, status: str) -> bool:
    if status not in {"PUBLISHED", "OFFLINE"}:
        raise ValueError("Invalid mobile announcement status")
    row = db.get(MobileAnnouncement, announcement_id)
    if row is None:
        return False
    row.status = status
    if status == "PUBLISHED" and row.publish_at is None:
        row.publish_at = _now()
    db.commit()
    invalidate_mobile_content_bootstrap_cache()
    return True


def get_public_mobile_announcement_detail(
    db: Session,
    announcement_id: int,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> Optional[dict[str, Any]]:
    now = _now()
    row = (
        db.query(MobileAnnouncement)
        .filter(
            MobileAnnouncement.id == announcement_id,
            MobileAnnouncement.status == "PUBLISHED",
            MobileAnnouncement.content_format.in_(MOBILE_ANNOUNCEMENT_CONTENT_FORMATS),
            or_(MobileAnnouncement.publish_at.is_(None), MobileAnnouncement.publish_at <= now),
        )
        .first()
    )
    if row is None:
        return None
    item = serialize_mobile_announcement(row, locale=locale)
    content_format = str(item.get("content_format") or "").upper()
    localized_content = str(item.get("content") or "")
    try:
        public_content = _announcement_content(localized_content, content_format)
    except ValueError:
        return None
    if not public_content:
        return None
    item["content"] = public_content
    return {
        key: value
        for key, value in item.items()
        if key in {
            "id",
            "scope",
            "title",
            "summary",
            "content_format",
            "content",
            "published_at",
        }
    }


def _media(
    variant: str,
    url: Any,
    width: Any,
    height: Any,
    byte_size: Any,
    mime_type: Any,
) -> Optional[dict[str, Any]]:
    url = _clean(url)
    width = _parse_int(width)
    height = _parse_int(height)
    byte_size = _parse_int(byte_size)
    mime_type = _clean(mime_type).lower()
    if (
        not url
        or MOBILE_UPLOAD_URL_RE.fullmatch(url) is None
        or len(url) > MOBILE_MEDIA_URL_MAX_LENGTH
        or width <= 0
        or height <= 0
        or byte_size <= 0
        or mime_type not in MOBILE_IMAGE_MIME_TYPES
        or width > 4096
        or height > 4096
        or width * height > 12_000_000
        or byte_size > MOBILE_IMAGE_MAX_BYTES
    ):
        return None
    return {
        "scope": "MOBILE",
        "variant": variant,
        "url": url,
        "width": width,
        "height": height,
        "byte_size": byte_size,
        "mime_type": mime_type,
    }


def _content_revision(
    settings_row: Optional[MobileContentSettings],
    banners: list[dict[str, Any]],
    announcements: list[dict[str, Any]],
) -> str:
    seed = "|".join(
        [
            _iso(settings_row.updated_at) if settings_row else "empty",
            ",".join(f"{item['id']}:{item.get('updated_at') or ''}" for item in banners),
            ",".join(f"{item['id']}:{item.get('updated_at') or ''}" for item in announcements),
        ]
    )
    return f"mobile-{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:16]}"


def build_mobile_content_bootstrap(
    db: Session,
    locale: str = DEFAULT_CONTENT_LOCALE,
    response_locale: Optional[str] = None,
) -> dict[str, Any]:
    settings_row = db.query(MobileContentSettings).order_by(MobileContentSettings.id.asc()).first()
    stored_home_config = normalize_mobile_home_config(
        settings_row.home_config if settings_row else None
    )
    banner_rows = get_public_mobile_banners(
        db,
        limit=(
            stored_home_config["promo_limit"]
            if stored_home_config["sections"]["promos"]
            else 0
        ),
        locale=locale,
    )
    announcement_rows = get_public_mobile_announcements(
        db,
        limit=(
            stored_home_config["announcement_limit"]
            if stored_home_config["sections"]["announcements"]
            else 0
        ),
        locale=locale,
    )
    revision = _content_revision(settings_row, banner_rows, announcement_rows)
    hero = next((item for item in banner_rows if item["placement"] == "HERO" and item["image"]), None)
    promos = [item for item in banner_rows if item["placement"] == "PROMO" and item["image"]]
    for item in [hero, *promos]:
        if item:
            item.pop("placement", None)
            item.pop("status", None)
            item.pop("sort_order", None)
            item.pop("start_at", None)
            item.pop("end_at", None)
            item.pop("aspect_ratio", None)
            item.pop("recommended_size", None)
            item.pop("updated_at", None)
    summaries = [
        {
            key: value
            for key, value in item.items()
            if key in {"id", "scope", "title", "summary", "category_label", "is_pinned", "published_at"}
        }
        for item in announcement_rows
    ]
    return {
        "channel": "MOBILE",
        "schema_version": MOBILE_CONTENT_SCHEMA_VERSION,
        "revision": revision,
        "locale": response_locale or locale,
        "generated_at": _now().isoformat() + "Z",
        "site": serialize_mobile_settings(settings_row, locale=locale),
        "home": {
            "hero": hero,
            "promos": promos,
            "config": serialize_mobile_home_config(settings_row, locale=locale),
        },
        "announcements": summaries,
    }


def invalidate_mobile_content_bootstrap_cache() -> None:
    with _MOBILE_BOOTSTRAP_CACHE_LOCK:
        _MOBILE_BOOTSTRAP_CACHE.clear()


def get_cached_mobile_content_bootstrap(
    db: Session,
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> dict[str, Any]:
    cache_key = _clean(locale) or DEFAULT_CONTENT_LOCALE
    now = monotonic()
    with _MOBILE_BOOTSTRAP_CACHE_LOCK:
        cached = _MOBILE_BOOTSTRAP_CACHE.get(cache_key)
        if cached and cached[0] > now:
            return deepcopy(cached[1])
        payload = build_mobile_content_bootstrap(
            db,
            locale=cache_key,
            response_locale=cache_key,
        )
        _MOBILE_BOOTSTRAP_CACHE[cache_key] = (
            now + MOBILE_BOOTSTRAP_CACHE_TTL_SECONDS,
            deepcopy(payload),
        )
        return payload
