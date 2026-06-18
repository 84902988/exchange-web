from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import re
import sys
from typing import Any
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from sqlalchemy import inspect


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal  # noqa: E402
from app.services.site_content_service import (  # noqa: E402
    LEGAL_PAGE_DEFS,
    LEGAL_PAGES_I18N_FIELD,
    get_or_create_site_settings,
)


RISK_CONTENT_ZH = """数字资产（定义见下文）交易涉及重大风险，可能不适合部分投资者。数字资产的价值在任何一天都可能大幅波动，并可能受到金融或政治事件等外部因素的影响。价格的波动和不可预测可能导致重大亏损，包括可能在短时间内损失全部投资。您有责任根据自己的财务状况考虑自己是否适合购买、出售或持有数字资产。

在某些司法管辖区开展的数字资产活动可能不受监管或受到的监管有限。与 Royal Exchange 无关的任何有关当局的任何监管变化或行动都可能对数字资产的使用、转让、交换和价值产生不利影响。用户所在国政府可能会认定用户交易数字资产为非法行为。

请阅读我们的风险披露，了解有关访问平台和/或使用服务相关风险的更多信息。但需注意，该文件并未解释可能出现的所有风险，或这些风险与您自身情况的关系。在访问平台和/或使用服务之前，您应充分了解所涉及的风险。

Royal Exchange 与您在使用服务时进行的任何交易（定义见下文）或其他活动不存在任何信托关系或义务。我们不是您的经纪人、中介、代理或顾问，我们不提供任何形式的金融、投资或咨询建议，我们向您提供的任何通信或信息都不被视为且不应被视为任何形式的建议。

您需知悉，使用服务的风险由您自行承担，并由您根据自己的具体投资目标、财务状况、风险承受能力、投资经验、知识和需求，对服务是否适合您进行独立审视和评估。您应自行为任何亏损或债务负责。我们不建议购买、赚取、出售或持有任何数字资产。在购买、出售或持有任何数字资产之前，请自行进行尽职调查，如有必要，请咨询您的财务、税务和其他顾问。 Royal Exchange 采取合理措施确保网站信息的准确性。对于您在购买、出售或持有数字资产方面的任何损失，包括但不限于因使用或依赖我们提供的此类信息而直接或间接造成的任何损失，我们概不负责。"""

DEFAULT_DOCX_DIR = Path.home() / "Downloads" / "Telegram Desktop"
DEFAULT_TERMS_DOCX = DEFAULT_DOCX_DIR / "使用条款.docx"
DEFAULT_PRIVACY_DOCX = DEFAULT_DOCX_DIR / "Royal Exchange 隐私声明.docx"
PAGE_TITLES_ZH = {
    "risk": "风险提示",
    "terms": "服务条款",
    "privacy": "隐私政策",
}


@dataclass
class SeedStats:
    changed: bool = False
    site_settings_id: int | None = None
    pages: int = 0


def _legal_column_available() -> bool:
    with SessionLocal() as db:
        inspector = inspect(db.get_bind())
        return inspector.has_table("site_settings") and any(
            column.get("name") == LEGAL_PAGES_I18N_FIELD
            for column in inspector.get_columns("site_settings")
        )


def _extract_docx_text(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"DOCX not found: {path}")

    with ZipFile(path) as archive:
        document_xml = archive.read("word/document.xml")

    root = ET.fromstring(document_xml)
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{ns}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{ns}t")).strip()
        if text:
            paragraphs.append(text)
    return "\n\n".join(paragraphs)


def _clean_legal_text(value: str) -> str:
    text = value.replace("\xa0", " ").replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()
    text = text.replace("使用条款本《使用条款》", "使用条款\n\n本《使用条款》")
    text = text.replace("隐私声明1.", "隐私声明\n\n1.")
    text = text.replace("风险提示数字资产", "风险提示\n\n数字资产")
    text = re.sub(r"(?<!^)(?=(?:\d{1,2})[.．、]\s*)", "\n\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _build_legal_pages_zh(terms_docx: Path, privacy_docx: Path) -> dict[str, dict[str, str]]:
    return {
        "risk": {
            "title": PAGE_TITLES_ZH["risk"],
            "content": _clean_legal_text(RISK_CONTENT_ZH),
        },
        "terms": {
            "title": PAGE_TITLES_ZH["terms"],
            "content": _clean_legal_text(_extract_docx_text(terms_docx)),
        },
        "privacy": {
            "title": PAGE_TITLES_ZH["privacy"],
            "content": _clean_legal_text(_extract_docx_text(privacy_docx)),
        },
    }


def _has_page_content(value: Any) -> bool:
    return isinstance(value, dict) and (str(value.get("title") or "").strip() or str(value.get("content") or "").strip())


def seed_legal_pages_content(
    *,
    apply: bool,
    force: bool,
    terms_docx: Path,
    privacy_docx: Path,
) -> SeedStats:
    if not _legal_column_available():
        raise RuntimeError(
            "site_settings.legal_pages_i18n is missing; run Alembic migration 20260616_000100 first"
        )

    zh_payload = _build_legal_pages_zh(terms_docx, privacy_docx)
    allowed_page_keys = {page_key for page_key, _label in LEGAL_PAGE_DEFS}
    stats = SeedStats(pages=len(zh_payload))

    with SessionLocal() as db:
        row = get_or_create_site_settings(db)
        stats.site_settings_id = int(row.id)
        current = getattr(row, LEGAL_PAGES_I18N_FIELD, None)
        next_value = dict(current) if isinstance(current, dict) else {}
        zh_current = next_value.get("zh") if isinstance(next_value.get("zh"), dict) else {}
        zh_next = dict(zh_current)

        for page_key, page_value in zh_payload.items():
            if page_key not in allowed_page_keys:
                continue
            existing_page = zh_next.get(page_key)
            if force or not _has_page_content(existing_page):
                if existing_page != page_value:
                    zh_next[page_key] = page_value
                    stats.changed = True

        if stats.changed:
            next_value["zh"] = zh_next
            if apply:
                setattr(row, LEGAL_PAGES_I18N_FIELD, next_value)
                row.updated_at = datetime.utcnow()
                db.commit()
            else:
                db.rollback()
        else:
            db.rollback()

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed legal page content into site_settings CMS JSON")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Report whether content would change")
    mode.add_argument("--apply", action="store_true", help="Insert missing legal page CMS content")
    parser.add_argument("--force", action="store_true", help="Overwrite existing zh risk/terms/privacy content")
    parser.add_argument("--terms-docx", type=Path, default=DEFAULT_TERMS_DOCX)
    parser.add_argument("--privacy-docx", type=Path, default=DEFAULT_PRIVACY_DOCX)
    args = parser.parse_args()

    stats = seed_legal_pages_content(
        apply=args.apply,
        force=args.force,
        terms_docx=args.terms_docx,
        privacy_docx=args.privacy_docx,
    )
    print(f"mode={'apply' if args.apply else 'dry-run'}")
    print(f"terms_docx={args.terms_docx}")
    print(f"privacy_docx={args.privacy_docx}")
    print(f"site_settings_id={stats.site_settings_id}")
    print(f"pages={stats.pages}")
    print(f"changed={int(stats.changed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
