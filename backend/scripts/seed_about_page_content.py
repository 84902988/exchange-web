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


ABOUT_PAGE_ZH = {
    "title": "我们是谁",
    "subtitle": "关于 Royal Exchange",
    "sections": [
        {
            "id": "who",
            "eyebrow": "我们是谁",
            "title": "关于 Royal Exchange",
            "body": [
                "Royal Exchange 的背后是全球顶级资本力量中区块链技术的接受者，也是区块链金融的信仰者。",
                "Royal Exchange 的建立，意在重构世界数字金融新秩序，并为我们的用户提供安全、稳定、可靠的一站式数字金融服务，与我们的用户携手，在世界数字金融的浪潮中立于浪潮之巅。",
            ],
        },
        {
            "id": "story",
            "title": "我们的故事",
            "body": [
                "在区块链行业发展的早期，市场对于数字资产始终充满争议。有人将其视为短暂的投机浪潮，也有人将其视为下一代金融基础设施的雏形。而 Royal Exchange 背后的发起者们，则属于后者。",
                "多年来，我们持续关注全球金融市场与科技产业的发展，并见证了互联网、移动支付、云计算以及人工智能等技术如何一步步改变世界。当区块链技术开始进入主流视野时，我们意识到，这不仅仅是一项技术创新，更是一场关于价值传递、资产流通与金融公平的深层变革。",
                "随着行业不断发展，我们看到了区块链技术在跨境支付、数字资产管理、去中心化金融以及全球价值网络中的巨大潜力。与此同时，我们也看到了市场仍然面临着安全风险、信任缺失、服务碎片化以及用户体验不足等问题。数字金融需要的不只是更多的平台，而是真正能够连接技术、资本与用户的基础设施。",
                "正是在这样的背景下，Royal Exchange 于 2026 年正式建立。",
                "我们相信，数字金融的发展不应只是少数人的机会，而应成为全球用户共享的时代红利。我们也相信，未来世界的金融体系将更加开放、高效和全球化，而区块链技术将在其中扮演重要角色。",
                "因此，Royal Exchange 从诞生之初便坚持以安全、稳定与长期发展为核心原则，致力于打造值得全球用户信赖的一站式数字金融服务平台。我们不追逐短期的市场喧嚣，而更加关注技术能力、风险控制、产品体验以及生态建设。因为我们始终认为，真正能够穿越周期的平台，依靠的不是风口，而是长期创造价值的能力。",
                "今天，数字金融的浪潮仍在加速前进。Royal Exchange 希望与每一位用户同行，共同见证新金融时代的到来，并在全球数字经济的发展进程中，探索更多可能，创造更大的价值。",
            ],
        },
        {
            "id": "vision",
            "title": "我们的愿景",
            "body": [
                "重塑全球数字金融新秩序，成为世界领先的数字金融基础设施。",
                "我们希望通过技术创新与全球化服务能力，推动数字资产的广泛应用与价值流通，构建更加开放、透明、高效和可信赖的数字金融生态，让每个人都能够平等地参与未来金融体系的发展与创造。",
            ],
        },
        {
            "id": "mission",
            "title": "我们的使命",
            "body": [
                "为全球用户提供安全、稳定、专业的一站式数字金融服务。",
                "我们致力于连接用户、资本与技术，通过持续创新的产品体系、完善的风险控制机制以及全球化运营能力，降低数字金融参与门槛，提升资产管理效率，为用户创造长期价值，助力数字经济的发展与繁荣。",
            ],
        },
        {
            "id": "values",
            "title": "我们的价值观",
            "items": [
                {
                    "title": "用户至上",
                    "body": ["用户的信任是 Royal Exchange 持续发展的根本动力。我们始终坚持从用户需求出发，不断优化产品与服务体验，为用户创造长期价值。"],
                },
                {
                    "title": "安全为本",
                    "body": ["安全是数字金融发展的生命线。我们坚持将资产安全、数据安全与系统安全置于首位，通过严格的风险管理体系和先进的技术架构，为用户提供可靠的保障。"],
                },
                {
                    "title": "长期主义",
                    "body": ["我们相信，真正的价值来源于时间的积累。面对行业周期与市场变化，我们坚持稳健发展，以长期视角推动平台建设和生态发展。"],
                },
                {
                    "title": "创新驱动",
                    "body": ["创新是推动行业进步的重要力量。我们持续探索区块链技术与数字金融的融合应用，通过技术创新和产品创新，为用户创造更多可能。"],
                },
                {
                    "title": "开放共赢",
                    "body": ["我们尊重市场规律，拥抱全球合作，与用户、合作伙伴及行业生态共同成长，推动数字金融行业健康、有序、可持续发展。"],
                },
                {
                    "title": "追求卓越",
                    "body": ["我们坚持高标准运营，不断提升技术能力、产品品质和服务水平，以专业精神打造具有全球竞争力的数字金融平台。"],
                },
            ],
        },
    ],
}


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
