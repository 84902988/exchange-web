from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import re
import sys
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.site_content import HelpArticle, HelpCategory  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


SOURCE_TYPE = "STATIC_IMPORT"
HELP_CONTENT_PATH = REPO_ROOT / "web" / "lib" / "help" / "helpContent.ts"


@dataclass
class ImportStats:
    categories_inserted: int = 0
    categories_updated: int = 0
    articles_inserted: int = 0
    articles_updated: int = 0
    articles_skipped_conflict: int = 0


class TSParseError(ValueError):
    pass


class HelpContentParser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.index = 0

    def parse(self) -> Any:
        value = self._parse_value()
        self._skip_ws()
        if self.index != len(self.text):
            raise TSParseError(f"Unexpected trailing content at {self.index}")
        return value

    def _peek(self) -> str:
        return self.text[self.index] if self.index < len(self.text) else ""

    def _consume(self, expected: str) -> None:
        self._skip_ws()
        if not self.text.startswith(expected, self.index):
            raise TSParseError(f"Expected {expected!r} at {self.index}")
        self.index += len(expected)

    def _skip_ws(self) -> None:
        while self.index < len(self.text):
            char = self.text[self.index]
            if char.isspace():
                self.index += 1
                continue
            if self.text.startswith("//", self.index):
                end = self.text.find("\n", self.index)
                self.index = len(self.text) if end == -1 else end + 1
                continue
            if self.text.startswith("/*", self.index):
                end = self.text.find("*/", self.index + 2)
                if end == -1:
                    raise TSParseError("Unclosed block comment")
                self.index = end + 2
                continue
            break

    def _parse_value(self) -> Any:
        self._skip_ws()
        char = self._peek()
        if char == "{":
            return self._parse_object()
        if char == "[":
            return self._parse_array()
        if char in {"'", '"', "`"}:
            return self._parse_string()
        if char.isdigit() or char == "-":
            return self._parse_number()
        ident = self._parse_identifier()
        if ident == "zh":
            self._consume("(")
            value = self._parse_string()
            self._consume(")")
            return value
        if ident == "true":
            return True
        if ident == "false":
            return False
        if ident in {"null", "undefined"}:
            return None
        raise TSParseError(f"Unsupported identifier {ident!r} at {self.index}")

    def _parse_object(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        self._consume("{")
        while True:
            self._skip_ws()
            if self._peek() == "}":
                self.index += 1
                return result
            key = self._parse_string() if self._peek() in {"'", '"', "`"} else self._parse_identifier()
            self._consume(":")
            result[key] = self._parse_value()
            self._skip_ws()
            if self._peek() == ",":
                self.index += 1
                continue
            if self._peek() == "}":
                continue
            raise TSParseError(f"Expected comma or object close at {self.index}")

    def _parse_array(self) -> list[Any]:
        result: list[Any] = []
        self._consume("[")
        while True:
            self._skip_ws()
            if self._peek() == "]":
                self.index += 1
                return result
            result.append(self._parse_value())
            self._skip_ws()
            if self._peek() == ",":
                self.index += 1
                continue
            if self._peek() == "]":
                continue
            raise TSParseError(f"Expected comma or array close at {self.index}")

    def _parse_identifier(self) -> str:
        self._skip_ws()
        match = re.match(r"[A-Za-z_$][A-Za-z0-9_$-]*", self.text[self.index :])
        if not match:
            raise TSParseError(f"Expected identifier at {self.index}")
        value = match.group(0)
        self.index += len(value)
        return value

    def _parse_string(self) -> str:
        self._skip_ws()
        quote = self._peek()
        if quote not in {"'", '"', "`"}:
            raise TSParseError(f"Expected string at {self.index}")
        self.index += 1
        start = self.index
        escaped = False
        while self.index < len(self.text):
            char = self.text[self.index]
            if escaped:
                escaped = False
                self.index += 1
                continue
            if char == "\\":
                escaped = True
                self.index += 1
                continue
            if char == quote:
                raw = self.text[start : self.index]
                self.index += 1
                return ast.literal_eval(f"{quote}{raw}{quote}") if quote != "`" else raw.replace("\\`", "`")
            self.index += 1
        raise TSParseError("Unclosed string")

    def _parse_number(self) -> int | float:
        self._skip_ws()
        match = re.match(r"-?\d+(?:\.\d+)?", self.text[self.index :])
        if not match:
            raise TSParseError(f"Expected number at {self.index}")
        raw = match.group(0)
        self.index += len(raw)
        return float(raw) if "." in raw else int(raw)


def _extract_help_categories_source(text: str) -> str:
    marker = "export const helpCategories"
    start = text.find(marker)
    if start == -1:
        raise TSParseError("helpCategories export not found")
    assignment = text.find("=", start)
    if assignment == -1:
        raise TSParseError("helpCategories assignment not found")
    start = text.find("[", assignment)
    if start == -1:
        raise TSParseError("helpCategories array start not found")

    depth = 0
    quote = ""
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in {"'", '"', "`"}:
            quote = char
            continue
        if char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    raise TSParseError("helpCategories array close not found")


def load_static_help_categories(path: Path = HELP_CONTENT_PATH) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    source = _extract_help_categories_source(text)
    parsed = HelpContentParser(source).parse()
    if not isinstance(parsed, list):
        raise TSParseError("helpCategories must be an array")
    return parsed


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _i18n(value: str) -> dict[str, str] | None:
    cleaned = _clean(value)
    if not cleaned:
        return None
    return {"zh": cleaned, "zh-TW": cleaned}


def _merge_i18n(existing: Any, value: str) -> dict[str, str] | None:
    data = dict(existing) if isinstance(existing, dict) else {}
    cleaned = _clean(value)
    if cleaned:
        data["zh"] = cleaned
        data["zh-TW"] = cleaned
    return data or None


def _content_from_sections(sections: Any) -> str:
    blocks: list[str] = []
    if not isinstance(sections, list):
        return ""
    for section in sections:
        if not isinstance(section, dict):
            continue
        lines: list[str] = []
        heading = _clean(section.get("heading"))
        if heading:
            lines.append(heading)
        for item in section.get("body") or []:
            text = _clean(item)
            if text:
                lines.append(text)
        for index, item in enumerate(section.get("steps") or [], start=1):
            text = _clean(item)
            if text:
                lines.append(f"{index}. {text}")
        for item in section.get("bullets") or []:
            text = _clean(item)
            if text:
                lines.append(f"- {text}")
        if lines:
            blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _category_payload(category: dict[str, Any], sort_order: int) -> dict[str, Any]:
    title = _clean(category.get("title"))
    description = _clean(category.get("description"))
    return {
        "category_key": _clean(category.get("id")),
        "title": title,
        "title_i18n": _i18n(title),
        "description": description or None,
        "description_i18n": _i18n(description),
        "sort_order": sort_order,
        "enabled": True,
    }


def _article_payload(article: dict[str, Any], category_id: int, sort_order: int) -> dict[str, Any]:
    title = _clean(article.get("title"))
    summary = _clean(article.get("summary"))
    content = _content_from_sections(article.get("sections"))
    tags = article.get("tags") if isinstance(article.get("tags"), list) else []
    return {
        "category_id": category_id,
        "slug": _clean(article.get("slug")),
        "title": title,
        "title_i18n": _i18n(title),
        "summary": summary or None,
        "summary_i18n": _i18n(summary),
        "content": content or None,
        "content_i18n": _i18n(content),
        "tags_json": [_clean(tag) for tag in tags if _clean(tag)],
        "is_hot": bool(article.get("hot")),
        "sort_order": sort_order,
        "enabled": True,
        "source_type": SOURCE_TYPE,
    }


def seed_help_content(*, apply: bool) -> ImportStats:
    categories = load_static_help_categories()
    stats = ImportStats()
    now = datetime.utcnow()

    with SessionLocal() as db:
        for category_index, category in enumerate(categories, start=1):
            category_data = _category_payload(category, category_index * 10)
            category_key = category_data["category_key"]
            if not category_key:
                continue

            category_row = db.query(HelpCategory).filter(HelpCategory.category_key == category_key).first()
            if category_row is None:
                stats.categories_inserted += 1
                if apply:
                    category_row = HelpCategory(**category_data, created_at=now, updated_at=now)
                    db.add(category_row)
                    db.flush()
                else:
                    category_row = HelpCategory(id=-category_index, **category_data, created_at=now, updated_at=now)
            else:
                stats.categories_updated += 1
                if apply:
                    category_row.title = category_data["title"]
                    category_row.title_i18n = _merge_i18n(category_row.title_i18n, category_data["title"])
                    category_row.description = category_data["description"]
                    category_row.description_i18n = _merge_i18n(category_row.description_i18n, category_data["description"] or "")
                    category_row.sort_order = category_data["sort_order"]
                    category_row.enabled = True
                    category_row.updated_at = now
                    db.flush()

            category_id = int(category_row.id)
            for article_index, article in enumerate(category.get("articles") or [], start=1):
                article_data = _article_payload(article, category_id, article_index * 10)
                slug = article_data["slug"]
                if not slug:
                    continue
                article_row = db.query(HelpArticle).filter(HelpArticle.slug == slug).first()
                if article_row is None:
                    stats.articles_inserted += 1
                    if apply:
                        db.add(HelpArticle(**article_data, created_at=now, updated_at=now))
                    continue
                if article_row.source_type != SOURCE_TYPE:
                    stats.articles_skipped_conflict += 1
                    continue

                stats.articles_updated += 1
                if apply:
                    article_row.category_id = category_id
                    article_row.title = article_data["title"]
                    article_row.title_i18n = _merge_i18n(article_row.title_i18n, article_data["title"])
                    article_row.summary = article_data["summary"]
                    article_row.summary_i18n = _merge_i18n(article_row.summary_i18n, article_data["summary"] or "")
                    article_row.content = article_data["content"]
                    article_row.content_i18n = _merge_i18n(article_row.content_i18n, article_data["content"] or "")
                    article_row.tags_json = article_data["tags_json"]
                    article_row.is_hot = article_data["is_hot"]
                    article_row.sort_order = article_data["sort_order"]
                    article_row.enabled = True
                    article_row.source_type = SOURCE_TYPE
                    article_row.updated_at = now

        if apply:
            db.commit()
        else:
            db.rollback()

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed help center CMS content from web/lib/help/helpContent.ts")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Parse and report changes without writing to DB")
    mode.add_argument("--apply", action="store_true", help="Insert/update STATIC_IMPORT help content")
    args = parser.parse_args()

    stats = seed_help_content(apply=args.apply)
    mode_label = "apply" if args.apply else "dry-run"
    print(f"mode={mode_label}")
    print(f"source={HELP_CONTENT_PATH}")
    print(f"categories_inserted={stats.categories_inserted}")
    print(f"categories_updated={stats.categories_updated}")
    print(f"articles_inserted={stats.articles_inserted}")
    print(f"articles_updated={stats.articles_updated}")
    print(f"articles_skipped_conflict={stats.articles_skipped_conflict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
