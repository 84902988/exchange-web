from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models.mobile_content import MobileAnnouncement, MobileContentSettings, MobileHomeBanner
from app.routers.mobile_content import mobile_announcement_detail, mobile_content_bootstrap
from app.services.mobile_content_service import (
    admin_save_mobile_banner,
    admin_save_mobile_announcement,
    admin_toggle_mobile_banner,
    build_mobile_content_bootstrap,
    get_cached_mobile_content_bootstrap,
    get_public_mobile_announcement_detail,
    invalidate_mobile_content_bootstrap_cache,
    preview_mobile_announcement_content,
    update_mobile_settings,
)
import app.services.mobile_content_service as mobile_content_service


def _mobile_url(token: str) -> str:
    return f"/static/uploads/mobile/{token * 32}.webp"


LOGO_URL = _mobile_url("a")
HERO_URL = _mobile_url("b")
EXPIRED_URL = _mobile_url("c")
BANNER_URL = _mobile_url("d")
PROMO_URL = _mobile_url("e")
WRONG_RATIO_URL = _mobile_url("f")
SMALL_URL = _mobile_url("0")
LARGE_URL = _mobile_url("1")


@pytest.fixture(autouse=True)
def _isolated_mobile_uploads(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    upload_dir = tmp_path / "mobile"
    upload_dir.mkdir()
    specs = {
        LOGO_URL: (512, 512),
        HERO_URL: (1200, 675),
        EXPIRED_URL: (1200, 400),
        BANNER_URL: (1200, 400),
        PROMO_URL: (1200, 400),
        WRONG_RATIO_URL: (1200, 675),
        SMALL_URL: (480, 270),
        LARGE_URL: (1200, 400),
    }
    for url, size in specs.items():
        target = upload_dir / url.rsplit("/", 1)[-1]
        Image.new("RGB", size, (24, 20, 36)).save(
            target,
            format="WEBP",
            quality=80,
        )
    large_target = upload_dir / LARGE_URL.rsplit("/", 1)[-1]
    with large_target.open("ab") as output:
        output.write(b"\0" * (2_000_001 - large_target.stat().st_size))
    monkeypatch.setattr(mobile_content_service, "MOBILE_UPLOAD_DIR", upload_dir)
    invalidate_mobile_content_bootstrap_cache()
    yield
    invalidate_mobile_content_bootstrap_cache()


def _database() -> tuple[Session, sessionmaker]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    MobileContentSettings.__table__.create(engine)
    MobileHomeBanner.__table__.create(engine)
    MobileAnnouncement.__table__.create(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return factory(), factory


def _seed(db: Session) -> None:
    now = datetime.utcnow()
    db.add(
        MobileContentSettings(
            app_name="Example Mobile",
            logo_url=LOGO_URL,
            logo_width=256,
            logo_height=256,
            logo_byte_size=42_000,
            logo_mime_type="image/webp",
        )
    )
    db.add_all(
        [
            MobileHomeBanner(
                title="手机主视觉",
                subtitle="窄屏专用",
                image_url=HERO_URL,
                image_width=1200,
                image_height=675,
                image_byte_size=480_000,
                image_mime_type="image/webp",
                placement="HERO",
                action_type="ROUTE",
                action_route="REGISTER",
                sort_order=0,
                status="ACTIVE",
            ),
            MobileHomeBanner(
                title="过期活动",
                image_url=EXPIRED_URL,
                image_width=1200,
                image_height=675,
                image_byte_size=320_000,
                image_mime_type="image/webp",
                placement="PROMO",
                sort_order=1,
                status="ACTIVE",
                end_at=now - timedelta(minutes=1),
            ),
        ]
    )
    db.add_all(
        [
            MobileAnnouncement(
                title="已发布公告",
                slug="published",
                summary="仅摘要进入 bootstrap",
                category_label="系统公告",
                content="纯文本详情\n第二行",
                content_format="PLAIN_TEXT",
                status="PUBLISHED",
                publish_at=now - timedelta(minutes=1),
            ),
            MobileAnnouncement(
                title="草稿",
                slug="draft",
                summary="不能公开",
                content="draft",
                content_format="PLAIN_TEXT",
                status="DRAFT",
            ),
        ]
    )
    db.commit()


def test_bootstrap_matches_strict_mobile_contract_and_never_creates_pc_tables() -> None:
    db, _factory = _database()
    _seed(db)

    payload = build_mobile_content_bootstrap(db, locale="zh", response_locale="zh-CN")

    assert payload["channel"] == "MOBILE"
    assert payload["schema_version"] == 1
    assert payload["revision"].startswith("mobile-")
    assert payload["locale"] == "zh-CN"
    assert payload["site"]["display_name"] == "Example Mobile"
    assert set(payload["site"]) == {"display_name", "logo"}
    assert payload["site"]["logo"] == {
        "scope": "MOBILE",
        "variant": "APP_LOGO",
        "url": LOGO_URL,
        "width": 256,
        "height": 256,
        "byte_size": 42_000,
        "mime_type": "image/webp",
    }
    assert payload["home"]["hero"]["variant"] == "HOME_HERO"
    assert payload["home"]["hero"]["action"] == {"type": "ROUTE", "route": "REGISTER"}
    assert set(payload["home"]["hero"]) == {"id", "scope", "variant", "title", "subtitle", "image", "action"}
    assert payload["home"]["promos"] == []
    assert payload["home"]["config"] == {
        "version": 1,
        "sections": {
            "asset_summary": True,
            "quick_entries": True,
            "market_shortcuts": True,
            "promos": True,
            "announcements": True,
        },
        "quick_entries": [
            {"id": "DEPOSIT", "title": "充值", "description": "充值资产"},
            {"id": "WITHDRAW", "title": "提现", "description": "提现资产"},
            {"id": "TRANSFER", "title": "划转", "description": "账户划转"},
            {"id": "HISTORY", "title": "资金流水", "description": "查看记录"},
        ],
        "market_shortcut_limit": 4,
        "market_shortcut_symbols": [
            "BTCUSDT",
            "RCBUSDT",
            "ETHUSDT",
            "NVDAUSDT_PERP",
        ],
        "bank_portal_url": None,
    }
    assert len(payload["announcements"]) == 1
    assert "content" not in payload["announcements"][0]
    assert payload["announcements"][0]["scope"] == "MOBILE"
    assert set(payload["announcements"][0]) == {
        "id",
        "scope",
        "title",
        "summary",
        "category_label",
        "is_pinned",
        "published_at",
    }

    table_names = set(inspect(db.get_bind()).get_table_names())
    assert {"mobile_content_settings", "mobile_home_banners", "mobile_announcements"} <= table_names
    assert {"site_settings", "home_banners", "announcements"}.isdisjoint(table_names)


def test_admin_four_language_content_is_returned_for_requested_locale() -> None:
    db, _factory = _database()
    _seed(db)
    settings_result = update_mobile_settings(
        db,
        {
            "app_name": "交易平台",
            "app_name_i18n_zh": "交易平台",
            "app_name_i18n_en": "Exchange",
            "app_name_i18n_zh_TW": "交易平台",
            "app_name_i18n_ja": "ロイヤル取引所",
            "logo_url": LOGO_URL,
        },
    )
    hero = db.query(MobileHomeBanner).filter_by(placement="HERO").one()
    banner_result = admin_save_mobile_banner(
        db,
        {
            "title_i18n_zh": "全球多资产交易",
            "title_i18n_en": "Global multi-asset trading",
            "title_i18n_zh_TW": "全球多資產交易",
            "title_i18n_ja": "世界のマルチアセット取引",
            "subtitle_i18n_zh": "移动端行情",
            "subtitle_i18n_en": "Markets on mobile",
            "subtitle_i18n_zh_TW": "移動端行情",
            "subtitle_i18n_ja": "モバイル市場情報",
            "image_url": HERO_URL,
            "placement": "HERO",
            "action_route": "REGISTER",
            "sort_order": "0",
            "status": "ACTIVE",
        },
        banner_id=hero.id,
    )
    announcement = db.query(MobileAnnouncement).filter_by(slug="published").one()
    announcement_result = admin_save_mobile_announcement(
        db,
        {
            "slug": "published",
            "title_i18n_zh": "平台公告",
            "title_i18n_en": "Platform announcement",
            "title_i18n_zh_TW": "平台公告",
            "title_i18n_ja": "プラットフォームのお知らせ",
            "summary_i18n_zh": "中文摘要",
            "summary_i18n_en": "English summary",
            "summary_i18n_zh_TW": "繁體摘要",
            "summary_i18n_ja": "日本語の概要",
            "category_label_i18n_zh": "公告",
            "category_label_i18n_en": "Announcement",
            "category_label_i18n_zh_TW": "公告",
            "category_label_i18n_ja": "お知らせ",
            "content_i18n_zh": "中文正文",
            "content_i18n_en": "English content",
            "content_i18n_zh_TW": "繁體正文",
            "content_i18n_ja": "日本語の本文",
            "content_format": "PLAIN_TEXT",
            "status": "PUBLISHED",
            "publish_at": announcement.publish_at.isoformat(timespec="minutes"),
        },
        announcement_id=announcement.id,
    )

    english = build_mobile_content_bootstrap(db, locale="en")
    japanese = build_mobile_content_bootstrap(db, locale="ja")

    assert settings_result["ok"] is True
    assert banner_result["ok"] is True
    assert announcement_result["ok"] is True
    assert english["site"]["display_name"] == "Exchange"
    assert english["home"]["hero"]["title"] == "Global multi-asset trading"
    assert english["home"]["config"]["quick_entries"][0] == {
        "id": "DEPOSIT",
        "title": "Deposit",
        "description": "Deposit assets",
    }
    assert english["announcements"][0]["title"] == "Platform announcement"
    assert english["announcements"][0]["category_label"] == "Announcement"
    assert japanese["home"]["hero"]["title"] == "世界のマルチアセット取引"
    assert japanese["announcements"][0]["summary"] == "日本語の概要"


def test_home_config_admin_drives_sections_limits_copy_and_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db, _factory = _database()
    _seed(db)
    monkeypatch.setattr(
        mobile_content_service,
        "_active_mobile_market_symbols",
        lambda _db: {"BTCUSDT", "RCBUSDT", "ETHUSDT", "NVDAUSDT_PERP"},
    )
    payload = {
        "app_name": "Example Mobile",
        "logo_url": LOGO_URL,
        "home_section_asset_summary": "1",
        "home_section_quick_entries": "1",
        "home_market_shortcut_limit": "2",
        "home_market_shortcut_symbol_1": "ETHUSDT",
        "home_market_shortcut_symbol_2": "BTCUSDT",
        "home_market_shortcut_symbol_3": "RCBUSDT",
        "home_market_shortcut_symbol_4": "NVDAUSDT_PERP",
        "home_promo_limit": "1",
        "home_announcement_limit": "1",
        "home_bank_portal_url": "https://bank.example.com/portal?source=mobile",
    }
    entries = {
        "deposit": ("充值资产", "链上与平台充值", "3", True),
        "withdraw": ("提现", "提取可用资产", "2", False),
        "transfer": ("划转", "账户之间划转", "1", False),
        "history": ("账变记录", "查看全部流水", "0", True),
    }
    for key, (title, description, order, enabled) in entries.items():
        payload[f"home_quick_{key}_title"] = title
        payload[f"home_quick_{key}_description"] = description
        payload[f"home_quick_{key}_sort_order"] = order
        if enabled:
            payload[f"home_quick_{key}_enabled"] = "1"

    result = update_mobile_settings(db, payload)
    bootstrap = build_mobile_content_bootstrap(
        db,
        locale="zh",
        response_locale="zh-CN",
    )

    assert result["ok"] is True
    assert result["form"]["home_bank_portal_url"] == (
        "https://bank.example.com/portal?source=mobile"
    )
    assert bootstrap["home"]["config"] == {
        "version": 1,
        "sections": {
            "asset_summary": True,
            "quick_entries": True,
            "market_shortcuts": False,
            "promos": False,
            "announcements": False,
        },
        "quick_entries": [
            {"id": "HISTORY", "title": "账变记录", "description": "查看全部流水"},
            {"id": "DEPOSIT", "title": "充值资产", "description": "链上与平台充值"},
        ],
        "market_shortcut_limit": 2,
        "market_shortcut_symbols": [
            "ETHUSDT",
            "BTCUSDT",
            "RCBUSDT",
            "NVDAUSDT_PERP",
        ],
        "bank_portal_url": "https://bank.example.com/portal?source=mobile",
    }
    assert bootstrap["home"]["promos"] == []
    assert bootstrap["announcements"] == []
    assert bootstrap["home"]["hero"] is not None


def test_home_config_rejects_unsafe_operator_copy_without_overwriting_current() -> None:
    db, _factory = _database()
    _seed(db)
    before = db.query(MobileContentSettings).one().home_config

    result = update_mobile_settings(
        db,
        {
            "app_name": "Example Mobile",
            "logo_url": LOGO_URL,
            "home_market_shortcut_limit": "8",
            "home_promo_limit": "1",
            "home_announcement_limit": "1",
            "home_bank_portal_url": "javascript:alert(1)",
            "home_quick_deposit_title": "<b>充值</b>",
            "home_quick_deposit_description": "充值资产",
            "home_quick_deposit_sort_order": "0",
            "home_quick_withdraw_title": "提现",
            "home_quick_withdraw_description": "提现资产",
            "home_quick_withdraw_sort_order": "1",
            "home_quick_transfer_title": "划转",
            "home_quick_transfer_description": "账户划转",
            "home_quick_transfer_sort_order": "2",
            "home_quick_history_title": "资金流水",
            "home_quick_history_description": "查看记录",
            "home_quick_history_sort_order": "3",
        },
    )

    assert result["ok"] is False
    assert any("行情卡数量" in error for error in result["errors"])
    assert any("HTML" in error for error in result["errors"])
    assert any("HTTPS" in error for error in result["errors"])
    assert db.query(MobileContentSettings).one().home_config == before


def test_corrupt_stored_home_config_fails_closed_without_breaking_bootstrap() -> None:
    db, _factory = _database()
    _seed(db)
    settings = db.query(MobileContentSettings).one()
    settings.home_config = {"version": 99, "quick_entries": [{"id": "URL"}]}
    db.commit()

    payload = build_mobile_content_bootstrap(db, locale="zh")

    assert payload["home"]["config"]["sections"] == {
        "asset_summary": True,
        "quick_entries": False,
        "market_shortcuts": True,
        "promos": False,
        "announcements": False,
    }
    assert payload["home"]["config"]["quick_entries"] == []
    assert payload["home"]["config"]["bank_portal_url"] is None
    assert payload["home"]["promos"] == []
    assert payload["announcements"] == []


def test_revision_changes_when_existing_mobile_content_is_edited() -> None:
    db, _factory = _database()
    _seed(db)
    before = build_mobile_content_bootstrap(db, locale="zh", response_locale="zh-CN")["revision"]
    banner = db.query(MobileHomeBanner).filter_by(placement="HERO").one()
    banner.title = "修改后的主视觉"
    banner.image_byte_size += 1
    banner.action_route = "MARKETS"
    db.commit()

    after = build_mobile_content_bootstrap(db, locale="zh", response_locale="zh-CN")["revision"]

    assert after != before
    announcement = db.query(MobileAnnouncement).filter_by(slug="published").one()
    announcement.title = "修改后的公告标题"
    announcement.content = "修改后的纯文本正文"
    db.commit()

    after_announcement_edit = build_mobile_content_bootstrap(db, locale="zh", response_locale="zh-CN")["revision"]

    assert after_announcement_edit != after


def test_plain_text_announcement_validation_rejects_html() -> None:
    db, _factory = _database()

    result = admin_save_mobile_announcement(
        db,
        {
            "title": "HTML 公告",
            "slug": "html",
            "content": "<p>not allowed</p>",
            "status": "DRAFT",
        },
    )

    assert result["ok"] is False
    assert any("纯文本" in error for error in result["errors"])
    assert db.query(MobileAnnouncement).count() == 0


def test_mobile_rich_announcement_reuses_server_sanitizer_for_save_preview_and_detail() -> None:
    db, _factory = _database()
    raw = (
        '<p onclick="steal()">安全<strong>正文</strong></p>'
        '<script>alert(1)</script>'
        '<a href="javascript:alert(2)">不可执行链接</a>'
    )

    preview = preview_mobile_announcement_content(
        {"content_format": "SANITIZED_HTML", "content": raw}
    )
    result = admin_save_mobile_announcement(
        db,
        {
            "title": "富文本公告",
            "slug": "rich-mobile",
            "content_format": "SANITIZED_HTML",
            "content": raw,
            "status": "PUBLISHED",
        },
    )

    assert preview == {
        "ok": True,
        "errors": [],
        "content": "<p>安全<strong>正文</strong></p><a>不可执行链接</a>",
        "content_format": "SANITIZED_HTML",
    }
    assert result["ok"] is True
    row = db.query(MobileAnnouncement).filter_by(slug="rich-mobile").one()
    assert row.content == preview["content"]
    assert row.content_format == "SANITIZED_HTML"
    assert get_public_mobile_announcement_detail(db, row.id)["content"] == preview["content"]


def test_all_operator_facing_mobile_text_rejects_raw_or_encoded_html() -> None:
    db, _factory = _database()

    settings = update_mobile_settings(
        db,
        {
            "app_name": "Example &lt;b&gt;Mobile&lt;/b&gt;",
            "logo_url": "",
        },
    )
    banner = admin_save_mobile_banner(
        db,
        {
            "title": "手机 <b>主视觉</b>",
            "subtitle": "安全副标题",
            "image_url": HERO_URL,
            "placement": "HERO",
            "status": "DISABLED",
        },
    )
    announcement = admin_save_mobile_announcement(
        db,
        {
            "title": "系统公告",
            "summary": "摘要 &#x3c;em&#x3e;内容&#x3c;/em&#x3e;",
            "category_label": "公告",
            "content": "纯文本正文",
            "status": "DRAFT",
        },
    )

    assert settings["ok"] is False
    assert any("纯文本" in error for error in settings["errors"])
    assert banner["ok"] is False
    assert any("纯文本" in error for error in banner["errors"])
    assert announcement["ok"] is False
    assert any("纯文本" in error for error in announcement["errors"])
    assert db.query(MobileHomeBanner).count() == 0
    assert db.query(MobileAnnouncement).count() == 0


def test_mobile_admin_rejects_oversized_or_control_character_content_before_db_write() -> None:
    db, _factory = _database()

    settings = update_mobile_settings(
        db,
        {
            "app_name": "A" * 81,
            "logo_url": "",
        },
    )
    banner = admin_save_mobile_banner(
        db,
        {
            "title": f"标题{chr(0)}",
            "image_url": BANNER_URL,
            "image_width": "1200",
            "image_height": "400",
            "image_byte_size": "123456",
            "image_mime_type": "image/webp",
            "placement": "PROMO",
        },
    )
    announcement = admin_save_mobile_announcement(
        db,
        {
            "title": "超长正文",
            "content": "A" * 50_001,
            "status": "DRAFT",
        },
    )

    assert settings["ok"] is False
    assert any("80" in error for error in settings["errors"])
    assert banner["ok"] is False
    assert any("控制字符" in error for error in banner["errors"])
    assert announcement["ok"] is False
    assert any("50000" in error for error in announcement["errors"])
    assert db.query(MobileHomeBanner).count() == 0
    assert db.query(MobileAnnouncement).count() == 0


def test_banner_save_requires_raster_metadata_and_applies_variant_specific_spec() -> None:
    db, _factory = _database()
    invalid = admin_save_mobile_banner(
        db,
        {"title": "手填 URL", "image_url": "https://cdn.example.com/banner.webp", "placement": "PROMO"},
    )
    assert invalid["ok"] is False
    assert any("有效宽高" in error for error in invalid["errors"])

    valid = admin_save_mobile_banner(
        db,
        {
            "title": "活动横幅",
            "image_url": PROMO_URL,
            "image_width": "1",
            "image_height": "1",
            "image_byte_size": "1",
            "image_mime_type": "image/png",
            "placement": "PROMO",
            "action_route": "MARKETS",
            "status": "ACTIVE",
        },
    )
    assert valid["ok"] is True
    row = db.query(MobileHomeBanner).one()
    assert (row.aspect_ratio, row.recommended_size) == ("3:1", "1200x400")
    assert (row.action_type, row.action_route) == ("ROUTE", "MARKETS")
    assert (row.image_width, row.image_height, row.image_mime_type) == (1200, 400, "image/webp")


def test_banner_save_rejects_wrong_mobile_ratio_or_undersized_media() -> None:
    db, _factory = _database()

    wrong_ratio = admin_save_mobile_banner(
        db,
        {
            "title": "桌面比例误传",
            "image_url": WRONG_RATIO_URL,
            "image_width": "1200",
            "image_height": "675",
            "image_byte_size": "123456",
            "image_mime_type": "image/webp",
            "placement": "PROMO",
        },
    )
    undersized = admin_save_mobile_banner(
        db,
        {
            "title": "低清主视觉",
            "image_url": SMALL_URL,
            "image_width": "480",
            "image_height": "270",
            "image_byte_size": "123456",
            "image_mime_type": "image/webp",
            "placement": "HERO",
        },
    )
    oversized = admin_save_mobile_banner(
        db,
        {
            "title": "体积过大的活动图",
            "image_url": LARGE_URL,
            "image_width": "1200",
            "image_height": "400",
            "image_byte_size": "2000001",
            "image_mime_type": "image/webp",
            "placement": "PROMO",
        },
    )

    assert wrong_ratio["ok"] is False
    assert any("3:1" in error for error in wrong_ratio["errors"])
    assert undersized["ok"] is False
    assert any("720x405" in error for error in undersized["errors"])
    assert oversized["ok"] is False
    assert any("有效宽高" in error for error in oversized["errors"])
    assert db.query(MobileHomeBanner).count() == 0


def test_hero_is_not_displaced_by_promos_and_overlapping_active_hero_is_rejected() -> None:
    db, _factory = _database()
    db.add(
        MobileHomeBanner(
            title="高排序主视觉",
            image_url=HERO_URL,
            image_width=1200,
            image_height=675,
            image_byte_size=480_000,
            image_mime_type="image/webp",
            placement="HERO",
            sort_order=999,
            status="ACTIVE",
        )
    )
    for index in range(8):
        db.add(
            MobileHomeBanner(
                title=f"活动 {index}",
                image_url=PROMO_URL,
                image_width=1200,
                image_height=400,
                image_byte_size=320_000,
                image_mime_type="image/webp",
                placement="PROMO",
                sort_order=index,
                status="ACTIVE",
            )
        )
    db.commit()

    payload = build_mobile_content_bootstrap(db, locale="zh", response_locale="zh-CN")
    overlapping = admin_save_mobile_banner(
        db,
        {
            "title": "重叠主视觉",
            "image_url": HERO_URL,
            "placement": "HERO",
            "status": "ACTIVE",
        },
    )

    assert payload["home"]["hero"]["title"] == "高排序主视觉"
    assert len(payload["home"]["promos"]) == 8
    assert overlapping["ok"] is False
    assert any("只能启用一个" in error for error in overlapping["errors"])
    assert db.query(MobileHomeBanner).filter_by(placement="HERO").count() == 1


def test_disabled_overlapping_hero_cannot_bypass_validation_via_toggle() -> None:
    db, _factory = _database()
    db.add_all(
        [
            MobileHomeBanner(
                title="当前主视觉",
                image_url=HERO_URL,
                image_width=1200,
                image_height=675,
                image_byte_size=480_000,
                image_mime_type="image/webp",
                placement="HERO",
                status="ACTIVE",
            ),
            MobileHomeBanner(
                title="停用主视觉",
                image_url=HERO_URL,
                image_width=1200,
                image_height=675,
                image_byte_size=480_000,
                image_mime_type="image/webp",
                placement="HERO",
                status="DISABLED",
            ),
        ]
    )
    db.commit()
    disabled = db.query(MobileHomeBanner).filter_by(title="停用主视觉").one()

    result = admin_toggle_mobile_banner(db, disabled.id)

    assert result["ok"] is False
    assert result["not_found"] is False
    assert "只能启用一个" in result["error"]
    db.refresh(disabled)
    assert disabled.status == "DISABLED"


def test_mobile_announcement_detail_only_returns_published_plain_text() -> None:
    db, _factory = _database()
    _seed(db)
    published = db.query(MobileAnnouncement).filter_by(slug="published").one()
    draft = db.query(MobileAnnouncement).filter_by(slug="draft").one()

    detail = get_public_mobile_announcement_detail(db, published.id, locale="zh")

    assert detail == {
        "id": published.id,
        "scope": "MOBILE",
        "title": "已发布公告",
        "summary": "仅摘要进入 bootstrap",
        "content": "纯文本详情\n第二行",
        "content_format": "PLAIN_TEXT",
        "published_at": published.publish_at.isoformat() + "Z",
    }
    assert get_public_mobile_announcement_detail(db, draft.id, locale="zh") is None


def test_router_accepts_and_echoes_locale_and_detail_404s_for_draft() -> None:
    db, _factory = _database()
    _seed(db)
    draft_id = db.query(MobileAnnouncement).filter_by(slug="draft").one().id
    request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})

    response = Response()
    bootstrap = mobile_content_bootstrap(
        request=request,
        response=response,
        lang=None,
        locale="zh-CN",
        db=db,
    )
    assert bootstrap["data"]["locale"] == "zh-CN"
    assert response.headers["cache-control"] == "public, max-age=30, stale-if-error=60"
    assert response.headers["etag"].startswith('"mobile-')

    conditional_request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/mobile/content/bootstrap",
            "headers": [(b"if-none-match", response.headers["etag"].encode("ascii"))],
        }
    )
    not_modified = mobile_content_bootstrap(
        request=conditional_request,
        response=Response(),
        lang=None,
        locale="zh-CN",
        db=db,
    )
    assert isinstance(not_modified, Response)
    assert not_modified.status_code == 304

    with pytest.raises(HTTPException) as exc:
        mobile_announcement_detail(
            announcement_id=draft_id,
            request=request,
            lang=None,
            locale="zh-CN",
            db=db,
        )
    assert exc.value.status_code == 404
    assert exc.value.detail["code"] == "MOBILE_ANNOUNCEMENT_NOT_FOUND"


def test_bootstrap_process_cache_single_flows_db_build_and_admin_write_invalidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db, _factory = _database()
    _seed(db)
    calls = 0
    original = mobile_content_service.build_mobile_content_bootstrap

    def counted_build(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(
        mobile_content_service,
        "build_mobile_content_bootstrap",
        counted_build,
    )

    first = get_cached_mobile_content_bootstrap(db, locale="zh")
    second = get_cached_mobile_content_bootstrap(db, locale="zh")
    assert calls == 1
    assert second == first

    result = update_mobile_settings(
        db,
        {
            "app_name": "更新后的手机站",
            "logo_url": "",
        },
    )
    assert result["ok"] is True
    refreshed = get_cached_mobile_content_bootstrap(db, locale="zh")
    assert calls == 2
    assert refreshed["site"]["display_name"] == "更新后的手机站"
