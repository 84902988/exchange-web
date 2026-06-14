from __future__ import annotations

import json
from typing import Any, Optional


SUPPORTED_CONTENT_LOCALES = ("en", "zh", "zh-TW", "ja")
DEFAULT_CONTENT_LOCALE = "zh"


def normalize_content_locale(value: Optional[str]) -> Optional[str]:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None

    normalized = cleaned.replace("_", "-")
    lowered = normalized.lower()
    if lowered in {"zh", "zh-cn", "zh-hans", "cn"}:
        return "zh"
    if lowered in {"zh-tw", "zh-hant", "tw"}:
        return "zh-TW"
    if lowered.startswith("en"):
        return "en"
    if lowered.startswith("ja") or lowered.startswith("jp"):
        return "ja"
    return normalized if normalized in SUPPORTED_CONTENT_LOCALES else None


def resolve_content_locale(lang: Optional[str] = None, accept_language: Optional[str] = None) -> str:
    requested = normalize_content_locale(lang)
    if requested:
        return requested

    for item in str(accept_language or "").split(","):
        token = item.split(";", 1)[0].strip()
        resolved = normalize_content_locale(token)
        if resolved:
            return resolved
    return DEFAULT_CONTENT_LOCALE


def localize_i18n_value(i18n_value: Any, locale: str, fallback: Any = "") -> Any:
    translations = i18n_value
    if isinstance(translations, str):
        try:
            translations = json.loads(translations)
        except json.JSONDecodeError:
            translations = None
    if not isinstance(translations, dict):
        return fallback

    candidates = [locale]
    if locale == "zh-TW":
        candidates.extend(["zh_tw", "zh-Hant", "zh"])
    elif locale == "zh":
        candidates.extend(["zh-CN", "zh-Hans"])
    elif locale == "en":
        candidates.append("en-US")
    elif locale == "ja":
        candidates.append("ja-JP")
    candidates.extend([DEFAULT_CONTENT_LOCALE, "en"])

    for key in dict.fromkeys(candidates):
        value = translations.get(key)
        if value is not None and str(value).strip() != "":
            return value
    return fallback
