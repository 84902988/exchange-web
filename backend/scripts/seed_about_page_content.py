from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import sys
from typing import Any

from sqlalchemy import inspect


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.site_content import SiteSettings  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.site_content_service import ABOUT_PAGE_SECTIONS_I18N_FIELD, get_or_create_site_settings  # noqa: E402


ABOUT_PAGE_ZH = {'title': '关于平台', 'subtitle': '平台介绍', 'sections': [{'id': 'who', 'title': '我们是谁', 'body': ['此处为平台介绍示例，请使用已确认的运营内容。']}, {'id': 'story', 'title': '发展历程', 'body': ['此处为平台介绍示例，请使用已确认的运营内容。']}, {'id': 'vision', 'title': '愿景', 'body': ['此处为平台介绍示例，请使用已确认的运营内容。']}, {'id': 'mission', 'title': '使命', 'body': ['此处为平台介绍示例，请使用已确认的运营内容。']}, {'id': 'values', 'title': '价值观', 'body': ['此处为平台介绍示例，请使用已确认的运营内容。']}]}


@dataclass
class SeedStats:
    changed: bool = False
    site_settings_id: int | None = None
    sections: int = 0


def _about_column_available() -> bool:
    with SessionLocal() as db:
        inspector = inspect(db.get_bind())
        return inspector.has_table("site_settings") and any(
            column.get("name") == ABOUT_PAGE_SECTIONS_I18N_FIELD
            for column in inspector.get_columns("site_settings")
        )


def seed_about_page_content(*, apply: bool) -> SeedStats:
    if not _about_column_available():
        raise RuntimeError(
            "site_settings.about_page_sections_i18n is missing; run Alembic migration 20260616_000099 first"
        )

    stats = SeedStats(sections=len(ABOUT_PAGE_ZH["sections"]))
    with SessionLocal() as db:
        row = get_or_create_site_settings(db)
        stats.site_settings_id = int(row.id)
        current = getattr(row, ABOUT_PAGE_SECTIONS_I18N_FIELD, None)
        next_value = dict(current) if isinstance(current, dict) else {}
        if next_value.get("zh") != ABOUT_PAGE_ZH:
            next_value["zh"] = ABOUT_PAGE_ZH
            stats.changed = True
            if apply:
                setattr(row, ABOUT_PAGE_SECTIONS_I18N_FIELD, next_value)
                row.updated_at = datetime.utcnow()
                db.commit()
            else:
                db.rollback()
        else:
            db.rollback()
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed /about/who-we-are content into site_settings CMS JSON")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Report whether content would change")
    mode.add_argument("--apply", action="store_true", help="Insert/update about page CMS content")
    args = parser.parse_args()

    stats = seed_about_page_content(apply=args.apply)
    print(f"mode={'apply' if args.apply else 'dry-run'}")
    print("source=who-we-are.docx")
    print(f"site_settings_id={stats.site_settings_id}")
    print(f"sections={stats.sections}")
    print(f"changed={int(stats.changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
