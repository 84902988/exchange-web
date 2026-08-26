from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
import hashlib
from io import BytesIO
import ipaddress
from functools import lru_cache
import os
from pathlib import Path
import re
import sys
from typing import Any, Literal, Optional

from sqlalchemy import inspect as sa_inspect, or_
from sqlalchemy.orm import Session


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.mobile_content import (  # noqa: E402
    MobileAnnouncement,
    MobileContentSettings,
    MobileHomeBanner,
)
import app.services.mobile_content_service as mobile_content_service  # noqa: E402


SEED_ID = "mobile-home-dev-v1"
DEVELOPMENT_CONFIRMATION = "MOBILE_CONTENT_DEVELOPMENT_ONLY"
SEED_PUBLISH_AT = datetime(2026, 7, 31, 0, 0, 0)
SEED_MIME_TYPE = "image/webp"
SeedMode = Literal["dry-run", "apply", "cleanup"]


class SeedSafetyError(RuntimeError):
    """Raised before a potentially unsafe seed operation can mutate state."""


class SeedSchemaError(RuntimeError):
    """Raised when the dedicated Mobile content migration is not available."""


class SeedConflictError(RuntimeError):
    """Raised when operator-owned or manually changed content is detected."""


@dataclass(frozen=True)
class DevelopmentWriteAuthorization:
    target_fingerprint: str


@dataclass(frozen=True)
class ImageSeed:
    role: str
    width: int
    height: int
    accent: tuple[int, int, int]

    @property
    def filename(self) -> str:
        digest = hashlib.sha256(f"{SEED_ID}:{self.role}".encode("utf-8")).hexdigest()
        return f"{digest[:32]}.webp"

    @property
    def url(self) -> str:
        return f"/static/uploads/mobile/{self.filename}"


@dataclass(frozen=True)
class BannerSeed:
    image_role: str
    title: str
    subtitle: str
    placement: str
    action_route: str
    sort_order: int


@dataclass(frozen=True)
class AnnouncementSeed:
    slug: str
    title: str
    summary: str
    category_label: str
    content: str
    is_pinned: bool


@dataclass(frozen=True)
class PreparedImage:
    seed: ImageSeed
    content: bytes

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "image_url": self.seed.url,
            "image_width": self.seed.width,
            "image_height": self.seed.height,
            "image_byte_size": len(self.content),
            "image_mime_type": SEED_MIME_TYPE,
        }


@dataclass
class SeedReport:
    mode: SeedMode
    changed: bool = False
    settings_action: str = "unchanged"
    banners_created: int = 0
    banners_removed: int = 0
    announcements_created: int = 0
    announcements_removed: int = 0
    translations_updated: int = 0
    files_created: int = 0
    files_removed: int = 0

    def safe_lines(self) -> list[str]:
        return [
            f"mode={self.mode}",
            f"seed_id={SEED_ID}",
            "target_guard=passed",
            f"changed={int(self.changed)}",
            f"settings_action={self.settings_action}",
            f"banners_created={self.banners_created}",
            f"banners_removed={self.banners_removed}",
            f"announcements_created={self.announcements_created}",
            f"announcements_removed={self.announcements_removed}",
            f"translations_updated={self.translations_updated}",
            f"files_created={self.files_created}",
            f"files_removed={self.files_removed}",
        ]


IMAGE_SEEDS = (
    ImageSeed("logo", 512, 512, (214, 168, 50)),
    ImageSeed("hero", 1200, 675, (219, 171, 55)),
    ImageSeed("promo-markets", 1200, 400, (79, 132, 255)),
    ImageSeed("promo-spot", 1200, 400, (32, 190, 145)),
    ImageSeed("promo-contract", 1200, 400, (173, 103, 255)),
)
IMAGE_SEED_BY_ROLE = {item.role: item for item in IMAGE_SEEDS}

BANNER_SEEDS = (
    BannerSeed(
        image_role="hero",
        title="全球多资产交易，一站式掌握",
        subtitle="数字资产、股票、指数与差价合约行情尽在移动端",
        placement="HERO",
        action_route="REGISTER",
        sort_order=0,
    ),
    BannerSeed(
        image_role="promo-markets",
        title="专业行情，快速发现机会",
        subtitle="聚合多市场行情，重要变化一目了然",
        placement="PROMO",
        action_route="MARKETS",
        sort_order=10,
    ),
    BannerSeed(
        image_role="promo-spot",
        title="现货交易，清晰高效",
        subtitle="真实盘口与订单状态，操作路径更直接",
        placement="PROMO",
        action_route="SPOT",
        sort_order=20,
    ),
    BannerSeed(
        image_role="promo-contract",
        title="合约工具，风险透明",
        subtitle="规则、费率与风险信息清晰呈现",
        placement="PROMO",
        action_route="CONTRACT",
        sort_order=30,
    ),
)

BANNER_TRANSLATIONS = {
    "hero": {
        "title": {
            "zh": "全球多资产交易，一站式掌握",
            "en": "Global multi-asset trading, all in one place",
            "zh-TW": "全球多資產交易，一站式掌握",
            "ja": "世界のマルチアセット取引を、ひとつのアプリで",
        },
        "subtitle": {
            "zh": "数字资产、股票、指数与差价合约行情尽在移动端",
            "en": "Digital assets, stocks, indices and CFD markets on mobile",
            "zh-TW": "數字資產、股票、指數與差價合約行情盡在移動端",
            "ja": "デジタル資産、株式、指数、CFDの市場情報をモバイルで",
        },
    },
    "promo-markets": {
        "title": {"zh": "专业行情，快速发现机会", "en": "Professional markets, opportunities at a glance", "zh-TW": "專業行情，快速發現機會", "ja": "プロ向けマーケット情報で、機会を素早く発見"},
        "subtitle": {"zh": "聚合多市场行情，重要变化一目了然", "en": "Multi-market data highlights important moves clearly", "zh-TW": "聚合多市場行情，重要變化一目了然", "ja": "複数市場の重要な変化をひと目で確認"},
    },
    "promo-spot": {
        "title": {"zh": "现货交易，清晰高效", "en": "Clear and efficient spot trading", "zh-TW": "現貨交易，清晰高效", "ja": "明快で効率的な現物取引"},
        "subtitle": {"zh": "真实盘口与订单状态，操作路径更直接", "en": "Real order books and order status with a direct workflow", "zh-TW": "真實盤口與訂單狀態，操作路徑更直接", "ja": "リアルな板情報と注文状況を、より直感的に操作"},
    },
    "promo-contract": {
        "title": {"zh": "合约工具，风险透明", "en": "Transparent futures tools and risk", "zh-TW": "合約工具，風險透明", "ja": "透明性の高い先物ツールとリスク管理"},
        "subtitle": {"zh": "规则、费率与风险信息清晰呈现", "en": "Clear rules, fees and risk information", "zh-TW": "規則、費率與風險資訊清晰呈現", "ja": "ルール、手数料、リスク情報を明確に表示"},
    },
}

ANNOUNCEMENT_SEEDS = (
    AnnouncementSeed(
        slug="dev-mobile-v1-experience",
        title="移动端功能体验说明",
        summary="当前内容用于开发环境功能与排版验收。",
        category_label="平台公告",
        content=(
            "当前页面内容用于开发环境的功能、排版与交互验收。\n\n"
            "行情、交易和账户功能仍以真实接口状态为准。本说明不构成投资建议。"
        ),
        is_pinned=True,
    ),
    AnnouncementSeed(
        slug="dev-mobile-v1-content-center",
        title="手机端内容中心已接入开发环境",
        summary="LOGO、主视觉、活动与公告均由独立手机端后台驱动。",
        category_label="功能更新",
        content=(
            "手机端内容中心已在开发环境接入。\n\n"
            "运营可分别维护手机端 LOGO、首页主视觉、活动横幅和纯文本公告，"
            "不会复用 PC 图片尺寸。"
        ),
        is_pinned=False,
    ),
    AnnouncementSeed(
        slug="dev-mobile-v1-security",
        title="账户安全使用提醒",
        summary="请妥善保管登录凭据，并在提交前核对关键信息。",
        category_label="安全提醒",
        content=(
            "请勿向他人透露密码、验证码或其他登录凭据。\n\n"
            "进行交易、划转或提现前，请再次核对币种、数量、网络和接收地址。"
        ),
        is_pinned=False,
    ),
)

ANNOUNCEMENT_TRANSLATIONS = {
    "dev-mobile-v1-experience": {
        "title": {"zh": "移动端功能体验说明", "en": "Mobile feature testing notice", "zh-TW": "移動端功能體驗說明", "ja": "モバイル機能テストのお知らせ"},
        "summary": {"zh": "当前内容用于开发环境功能与排版验收。", "en": "This content is for feature and layout verification in development.", "zh-TW": "目前內容用於開發環境功能與排版驗收。", "ja": "この内容は開発環境での機能とレイアウト確認用です。"},
        "category_label": {"zh": "平台公告", "en": "Platform", "zh-TW": "平台公告", "ja": "プラットフォーム"},
        "content": {
            "zh": "当前页面内容用于开发环境的功能、排版与交互验收。\n\n行情、交易和账户功能仍以真实接口状态为准。本说明不构成投资建议。",
            "en": "This page is for feature, layout and interaction verification in the development environment.\n\nMarket, trading and account features depend on the live API status. This notice is not investment advice.",
            "zh-TW": "目前頁面內容用於開發環境的功能、排版與互動驗收。\n\n行情、交易和帳戶功能仍以真實介面狀態為準。本說明不構成投資建議。",
            "ja": "このページは開発環境での機能、レイアウト、操作確認用です。\n\n市場、取引、口座機能は実際のAPI状態に準じます。本案内は投資助言ではありません。",
        },
    },
    "dev-mobile-v1-content-center": {
        "title": {"zh": "手机端内容中心已接入开发环境", "en": "Mobile content center is available in development", "zh-TW": "手機端內容中心已接入開發環境", "ja": "モバイルコンテンツセンターを開発環境に接続しました"},
        "summary": {"zh": "LOGO、主视觉、活动与公告均由独立手机端后台驱动。", "en": "The logo, hero, promotions and announcements are managed by the mobile admin.", "zh-TW": "LOGO、主視覺、活動與公告均由獨立手機端後台驅動。", "ja": "ロゴ、メインビジュアル、キャンペーン、お知らせはモバイル管理画面で管理されます。"},
        "category_label": {"zh": "功能更新", "en": "Update", "zh-TW": "功能更新", "ja": "機能更新"},
        "content": {
            "zh": "手机端内容中心已在开发环境接入。\n\n运营可分别维护手机端 LOGO、首页主视觉、活动横幅和纯文本公告，不会复用 PC 图片尺寸。",
            "en": "The mobile content center is now connected in the development environment.\n\nOperations can manage the mobile logo, homepage hero, promotional banners and announcements independently without reusing desktop image dimensions.",
            "zh-TW": "手機端內容中心已在開發環境接入。\n\n營運可分別維護手機端 LOGO、首頁主視覺、活動橫幅和純文字公告，不會複用 PC 圖片尺寸。",
            "ja": "モバイルコンテンツセンターを開発環境に接続しました。\n\n運用担当者はモバイル用ロゴ、ホームのメインビジュアル、バナー、お知らせを個別に管理でき、PC版の画像サイズは流用しません。",
        },
    },
    "dev-mobile-v1-security": {
        "title": {"zh": "账户安全使用提醒", "en": "Account security reminder", "zh-TW": "帳戶安全使用提醒", "ja": "アカウントセキュリティのお願い"},
        "summary": {"zh": "请妥善保管登录凭据，并在提交前核对关键信息。", "en": "Keep your login credentials safe and verify key details before submitting.", "zh-TW": "請妥善保管登入憑證，並在提交前核對關鍵資訊。", "ja": "ログイン情報を安全に保管し、送信前に重要事項をご確認ください。"},
        "category_label": {"zh": "安全提醒", "en": "Security", "zh-TW": "安全提醒", "ja": "セキュリティ"},
        "content": {
            "zh": "请勿向他人透露密码、验证码或其他登录凭据。\n\n进行交易、划转或提现前，请再次核对币种、数量、网络和接收地址。",
            "en": "Never disclose your password, verification codes or other login credentials.\n\nBefore trading, transferring or withdrawing, verify the asset, amount, network and destination address again.",
            "zh-TW": "請勿向他人透露密碼、驗證碼或其他登入憑證。\n\n進行交易、劃轉或提現前，請再次核對幣種、數量、網路和接收地址。",
            "ja": "パスワード、認証コード、その他のログイン情報を他人に開示しないでください。\n\n取引、振替、出金の前に、資産、数量、ネットワーク、受取アドレスを再度ご確認ください。",
        },
    },
}

REQUIRED_TABLES = {
    MobileContentSettings.__tablename__,
    MobileHomeBanner.__tablename__,
    MobileAnnouncement.__tablename__,
}
_PRODUCTION_MARKER_RE = re.compile(
    r"(^|[._-])(prod|production|live|mainnet|primary)([._-]|$)",
    re.IGNORECASE,
)


def authorize_development_write(
    *,
    configured_db_name: str,
    configured_db_host: str,
    cookie_secure: bool,
    cookie_domain: Optional[str],
    confirmed_db_name: str,
    confirmation: str,
) -> DevelopmentWriteAuthorization:
    db_name = str(configured_db_name or "").strip()
    db_host = str(configured_db_host or "").strip()
    domain = str(cookie_domain or "").strip()
    if not db_name or not db_host:
        raise SeedSafetyError("configured database target is incomplete")
    if confirmed_db_name != db_name:
        raise SeedSafetyError("database confirmation does not match the configured target")
    if confirmation != DEVELOPMENT_CONFIRMATION:
        raise SeedSafetyError("development-only confirmation phrase is missing or invalid")
    if _looks_like_production_target(db_name, db_host, cookie_secure, domain):
        raise SeedSafetyError("refusing a target that appears to be production")
    fingerprint = hashlib.sha256(f"{db_host}\0{db_name}".encode("utf-8")).hexdigest()
    return DevelopmentWriteAuthorization(target_fingerprint=fingerprint)


def _looks_like_production_target(
    db_name: str,
    db_host: str,
    cookie_secure: bool,
    cookie_domain: str,
) -> bool:
    if cookie_secure:
        return True
    if cookie_domain and not _is_local_hostname(cookie_domain.lstrip(".")):
        return True
    if _PRODUCTION_MARKER_RE.search(db_name) or _PRODUCTION_MARKER_RE.search(db_host):
        return True
    try:
        address = ipaddress.ip_address(db_host.strip("[]"))
    except ValueError:
        address = None
    if address is not None:
        return not (address.is_private or address.is_loopback)
    if "." in db_host and not _is_local_hostname(db_host):
        safe_remote_markers = ("dev", "test", "local", "sandbox", "preview")
        return not any(marker in db_host.lower() for marker in safe_remote_markers)
    return False


def _is_local_hostname(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"localhost", "host.docker.internal"} or normalized.endswith(
        ".localhost"
    ):
        return True
    try:
        return ipaddress.ip_address(normalized.strip("[]")).is_loopback
    except ValueError:
        return False


@lru_cache(maxsize=1)
def _prepared_image_tuple() -> tuple[PreparedImage, ...]:
    prepared: list[PreparedImage] = []
    for seed in IMAGE_SEEDS:
        content = _render_webp(seed)
        _verify_generated_image(seed, content)
        prepared.append(PreparedImage(seed=seed, content=content))
    return tuple(prepared)


def prepare_images() -> dict[str, PreparedImage]:
    return {item.seed.role: item for item in _prepared_image_tuple()}


def _render_webp(seed: ImageSeed) -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (seed.width, seed.height), (8, 10, 16))
    pixels = image.load()
    accent_r, accent_g, accent_b = seed.accent
    for y in range(seed.height):
        vertical = y / max(seed.height - 1, 1)
        for x in range(seed.width):
            horizontal = x / max(seed.width - 1, 1)
            glow = max(0.0, 1.0 - ((horizontal - 0.78) ** 2 + (vertical - 0.24) ** 2) * 3.2)
            pixels[x, y] = (
                min(255, int(8 + accent_r * glow * 0.34)),
                min(255, int(10 + accent_g * glow * 0.28)),
                min(255, int(16 + accent_b * glow * 0.30)),
            )

    draw = ImageDraw.Draw(image, "RGBA")
    unit = min(seed.width, seed.height)
    draw.ellipse(
        (
            seed.width - unit * 0.72,
            -unit * 0.22,
            seed.width + unit * 0.12,
            unit * 0.62,
        ),
        fill=(*seed.accent, 45),
        outline=(*seed.accent, 100),
        width=max(2, unit // 180),
    )
    for index in range(4):
        offset = unit * (0.13 + index * 0.10)
        draw.line(
            (
                seed.width * 0.08,
                seed.height - offset,
                seed.width * (0.42 + index * 0.10),
                seed.height * (0.32 + index * 0.03),
            ),
            fill=(*seed.accent, 55 + index * 20),
            width=max(2, unit // 150),
        )
    if seed.role == "logo":
        margin = seed.width * 0.18
        draw.rounded_rectangle(
            (margin, margin, seed.width - margin, seed.height - margin),
            radius=int(seed.width * 0.12),
            outline=(*seed.accent, 220),
            width=max(5, seed.width // 55),
        )
        draw.line(
            (
                seed.width * 0.34,
                seed.height * 0.64,
                seed.width * 0.50,
                seed.height * 0.34,
                seed.width * 0.66,
                seed.height * 0.64,
            ),
            fill=(*seed.accent, 240),
            width=max(8, seed.width // 36),
            joint="curve",
        )

    output = BytesIO()
    image.save(output, format="WEBP", quality=88, method=6)
    return output.getvalue()


def _verify_generated_image(seed: ImageSeed, content: bytes) -> None:
    from PIL import Image

    if not content or len(content) > mobile_content_service.MOBILE_IMAGE_MAX_BYTES:
        raise SeedSafetyError("generated Mobile image exceeds the safe size limit")
    with Image.open(BytesIO(content)) as image:
        if image.format != "WEBP" or image.size != (seed.width, seed.height):
            raise SeedSafetyError("generated Mobile image failed format validation")
        image.verify()


def run_mobile_content_seed(
    db: Session,
    *,
    mode: SeedMode = "dry-run",
    upload_dir: Optional[Path] = None,
    authorization: Optional[DevelopmentWriteAuthorization] = None,
) -> SeedReport:
    if mode not in {"dry-run", "apply", "cleanup"}:
        raise SeedSafetyError("unsupported seed mode")
    if mode != "dry-run" and authorization is None:
        raise SeedSafetyError("write authorization is required")

    target_upload_dir = Path(
        upload_dir or mobile_content_service.MOBILE_UPLOAD_DIR
    ).resolve()
    if target_upload_dir != Path(mobile_content_service.MOBILE_UPLOAD_DIR).resolve():
        raise SeedSafetyError("upload directory does not match the Mobile content service")

    _require_schema(db)
    images = prepare_images()
    _validate_seed_contracts(images)
    report = SeedReport(mode=mode)
    created_files: list[Path] = []
    removed_files: list[tuple[Path, bytes]] = []
    try:
        state = _inspect_seed_state(db, images, mode=mode)
        if mode == "dry-run":
            _populate_dry_run_report(report, state, images, target_upload_dir)
            db.rollback()
            return report
        if mode == "apply":
            created_files = _ensure_seed_files(images, target_upload_dir)
            report.files_created = len(created_files)
            _apply_seed_rows(db, state, images, report)
            _verify_applied_bootstrap(db, images)
            db.commit()
            report.changed = bool(
                report.settings_action == "created"
                or report.settings_action == "seeded"
                or report.banners_created
                or report.announcements_created
                or report.files_created
                or report.translations_updated
            )
            created_files = []
            mobile_content_service.invalidate_mobile_content_bootstrap_cache()
            return report

        _verify_cleanup_files(images, target_upload_dir)
        removable_paths = _cleanup_seed_rows(db, state, images, report)
        _verify_seed_rows_absent(db, images)
        removed_files = _remove_seed_files(removable_paths, images)
        report.files_removed = len(removed_files)
        db.commit()
        report.changed = bool(
            report.settings_action == "cleared"
            or report.banners_removed
            or report.announcements_removed
            or report.files_removed
        )
        removed_files = []
        mobile_content_service.invalidate_mobile_content_bootstrap_cache()
        return report
    except Exception:
        db.rollback()
        for path in created_files:
            path.unlink(missing_ok=True)
        _restore_removed_files(removed_files)
        raise


def _require_schema(db: Session) -> None:
    existing = set(sa_inspect(db.get_bind()).get_table_names())
    if not REQUIRED_TABLES.issubset(existing):
        raise SeedSchemaError(
            "Mobile content schema is missing; apply the reviewed Alembic chain first"
        )


def _validate_seed_contracts(images: dict[str, PreparedImage]) -> None:
    for seed in BANNER_SEEDS:
        prepared = images[seed.image_role]
        payload = _banner_payload(seed, prepared)
        data, i18n_errors = mobile_content_service._normalize_banner(payload)
        data.update(prepared.metadata)
        errors = [*i18n_errors, *mobile_content_service._validate_banner(data)]
        if errors:
            raise SeedSafetyError("Mobile banner seed contract is invalid")
    for seed in ANNOUNCEMENT_SEEDS:
        data, errors = mobile_content_service._normalize_announcement(
            _announcement_payload(seed)
        )
        if errors or data != _announcement_expected(seed):
            raise SeedSafetyError("Mobile announcement seed contract is invalid")


def _inspect_seed_state(
    db: Session,
    images: dict[str, PreparedImage],
    *,
    mode: SeedMode,
) -> dict[str, Any]:
    settings_rows = (
        db.query(MobileContentSettings)
        .order_by(MobileContentSettings.id.asc())
        .with_for_update()
        .limit(2)
        .all()
    )
    if len(settings_rows) > 1:
        raise SeedConflictError("multiple Mobile settings rows require operator review")
    settings_row = settings_rows[0] if settings_rows else None

    seed_urls = [images[seed.image_role].seed.url for seed in BANNER_SEEDS]
    seed_titles = [seed.title for seed in BANNER_SEEDS]
    banner_identity_filter = MobileHomeBanner.image_url.in_(seed_urls)
    if mode != "cleanup":
        banner_identity_filter = or_(
            banner_identity_filter,
            MobileHomeBanner.title.in_(seed_titles),
        )
    banner_rows = (
        db.query(MobileHomeBanner)
        .filter(banner_identity_filter)
        .with_for_update()
        .all()
    )
    banners_by_url: dict[str, MobileHomeBanner] = {}
    expected_by_url = {
        images[seed.image_role].seed.url: seed for seed in BANNER_SEEDS
    }
    for row in banner_rows:
        expected = expected_by_url.get(row.image_url)
        if expected is None or row.title != expected.title:
            raise SeedConflictError(
                "a seed title or image path is already used by operator content"
            )
        if row.image_url in banners_by_url:
            raise SeedConflictError("duplicate Mobile seed Banner rows require review")
        prepared = images[expected.image_role]
        if not _banner_row_matches(row, expected, prepared):
            raise SeedConflictError(
                "a Mobile seed Banner was manually changed; refusing to overwrite it"
            )
        banners_by_url[row.image_url] = row

    if mode != "cleanup":
        active_non_seed_hero = (
            db.query(MobileHomeBanner.id)
            .filter(
                MobileHomeBanner.placement == "HERO",
                MobileHomeBanner.status == "ACTIVE",
                ~MobileHomeBanner.image_url.in_(seed_urls),
            )
            .with_for_update()
            .first()
        )
        if active_non_seed_hero is not None:
            raise SeedConflictError(
                "a non-seed ACTIVE Mobile HERO exists; refusing to replace operator content"
            )

    slugs = [seed.slug for seed in ANNOUNCEMENT_SEEDS]
    announcement_rows = (
        db.query(MobileAnnouncement)
        .filter(MobileAnnouncement.slug.in_(slugs))
        .with_for_update()
        .all()
    )
    announcements_by_slug: dict[str, MobileAnnouncement] = {}
    announcement_by_slug = {seed.slug: seed for seed in ANNOUNCEMENT_SEEDS}
    for row in announcement_rows:
        seed = announcement_by_slug[row.slug]
        if not _announcement_row_matches(
            row,
            seed,
            preserve_operator_status=(mode != "cleanup"),
        ):
            raise SeedConflictError(
                "a Mobile seed announcement was manually changed; refusing to overwrite it"
            )
        announcements_by_slug[row.slug] = row

    _validate_settings_seed_ownership(settings_row, images["logo"])
    return {
        "settings": settings_row,
        "banners": banners_by_url,
        "announcements": announcements_by_slug,
    }


def _validate_settings_seed_ownership(
    row: Optional[MobileContentSettings],
    logo: PreparedImage,
) -> None:
    if row is None or row.logo_url != logo.seed.url:
        return
    expected = logo.metadata
    actual = {
        "image_url": row.logo_url,
        "image_width": row.logo_width,
        "image_height": row.logo_height,
        "image_byte_size": row.logo_byte_size,
        "image_mime_type": row.logo_mime_type,
    }
    if actual != expected:
        raise SeedConflictError(
            "the Mobile seed LOGO metadata was manually changed; refusing to overwrite it"
        )


def _populate_dry_run_report(
    report: SeedReport,
    state: dict[str, Any],
    images: dict[str, PreparedImage],
    upload_dir: Path,
) -> None:
    settings = state["settings"]
    logo = images["logo"]
    if settings is None:
        report.settings_action = "would-create"
    elif not settings.logo_url:
        report.settings_action = "would-seed"
    elif settings.logo_url == logo.seed.url:
        report.settings_action = "unchanged"
    else:
        report.settings_action = "operator-logo-preserved"
    report.banners_created = sum(
        images[seed.image_role].seed.url not in state["banners"]
        for seed in BANNER_SEEDS
    )
    report.announcements_created = sum(
        seed.slug not in state["announcements"] for seed in ANNOUNCEMENT_SEEDS
    )
    report.files_created = sum(
        not (upload_dir / item.seed.filename).is_file() for item in images.values()
    )
    report.translations_updated = sum(
        row.title_i18n != _banner_expected(seed, images[seed.image_role])["title_i18n"]
        or row.subtitle_i18n != _banner_expected(seed, images[seed.image_role])["subtitle_i18n"]
        for seed in BANNER_SEEDS
        if (row := state["banners"].get(images[seed.image_role].seed.url)) is not None
    ) + sum(
        row.title_i18n != _announcement_expected(seed)["title_i18n"]
        or row.summary_i18n != _announcement_expected(seed)["summary_i18n"]
        or row.category_label_i18n != _announcement_expected(seed)["category_label_i18n"]
        or row.content_i18n != _announcement_expected(seed)["content_i18n"]
        for seed in ANNOUNCEMENT_SEEDS
        if (row := state["announcements"].get(seed.slug)) is not None
    )
    report.changed = bool(
        report.settings_action in {"would-create", "would-seed"}
        or report.banners_created
        or report.announcements_created
        or report.files_created
        or report.translations_updated
    )


def _ensure_seed_files(
    images: dict[str, PreparedImage],
    upload_dir: Path,
) -> list[Path]:
    upload_dir.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []
    try:
        for item in images.values():
            target = upload_dir / item.seed.filename
            if target.exists():
                if not target.is_file() or target.read_bytes() != item.content:
                    raise SeedConflictError(
                        "a deterministic Mobile seed image path contains different content"
                    )
                continue
            temporary = upload_dir / f".{item.seed.filename}.{os.getpid()}.tmp"
            try:
                temporary.write_bytes(item.content)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            created.append(target)

        for item in images.values():
            inspected = mobile_content_service._inspect_mobile_uploaded_image(
                item.seed.url
            )
            if inspected != item.metadata:
                raise SeedSafetyError("Mobile seed image validation changed unexpectedly")
        return created
    except Exception:
        for path in created:
            path.unlink(missing_ok=True)
        raise


def _apply_seed_rows(
    db: Session,
    state: dict[str, Any],
    images: dict[str, PreparedImage],
    report: SeedReport,
) -> None:
    settings = state["settings"]
    if settings is None:
        settings = MobileContentSettings(
            app_name="Exchange",
            app_name_i18n={locale: "Exchange" for locale, _suffix in mobile_content_service.ADMIN_I18N_LOCALES},
        )
        db.add(settings)
        state["settings"] = settings
        report.settings_action = "created"
    logo = images["logo"]
    if not settings.logo_url:
        settings.logo_url = logo.seed.url
        settings.logo_width = logo.seed.width
        settings.logo_height = logo.seed.height
        settings.logo_byte_size = len(logo.content)
        settings.logo_mime_type = SEED_MIME_TYPE
        if report.settings_action != "created":
            report.settings_action = "seeded"
    elif settings.logo_url == logo.seed.url:
        report.settings_action = "unchanged"
    else:
        report.settings_action = "operator-logo-preserved"

    if settings.app_name == "Exchange" and not settings.app_name_i18n:
        settings.app_name_i18n = {
            locale: "Exchange"
            for locale, _suffix in mobile_content_service.ADMIN_I18N_LOCALES
        }
        report.translations_updated += 1

    for seed in BANNER_SEEDS:
        prepared = images[seed.image_role]
        existing_banner = state["banners"].get(prepared.seed.url)
        if existing_banner is not None:
            expected = _banner_expected(seed, prepared)
            if existing_banner.title_i18n != expected["title_i18n"] or existing_banner.subtitle_i18n != expected["subtitle_i18n"]:
                existing_banner.title_i18n = expected["title_i18n"]
                existing_banner.subtitle_i18n = expected["subtitle_i18n"]
                report.translations_updated += 1
            continue
        data, i18n_errors = mobile_content_service._normalize_banner(
            _banner_payload(seed, prepared)
        )
        data.update(
            mobile_content_service._inspect_mobile_uploaded_image(prepared.seed.url)
        )
        errors = [*i18n_errors, *mobile_content_service._validate_banner(data)]
        if errors:
            raise SeedSafetyError("Mobile Banner service validation failed")
        overlap_error = mobile_content_service._active_hero_overlap_error(
            db,
            data,
            None,
        )
        if overlap_error:
            raise SeedConflictError("Mobile HERO overlap validation failed")
        spec = mobile_content_service.MOBILE_BANNER_VARIANT_SPECS[
            seed.placement
        ]
        row = MobileHomeBanner(**data)
        row.aspect_ratio = str(spec["aspect_ratio"])
        row.recommended_size = str(spec["recommended_size"])
        db.add(row)
        report.banners_created += 1

    for seed in ANNOUNCEMENT_SEEDS:
        existing_announcement = state["announcements"].get(seed.slug)
        if existing_announcement is not None:
            expected = _announcement_expected(seed)
            changed = False
            for field_name in ("title_i18n", "summary_i18n", "category_label_i18n", "content_i18n"):
                if getattr(existing_announcement, field_name) != expected[field_name]:
                    setattr(existing_announcement, field_name, expected[field_name])
                    changed = True
            if changed:
                report.translations_updated += 1
            continue
        data, errors = mobile_content_service._normalize_announcement(
            _announcement_payload(seed)
        )
        if errors or data != _announcement_expected(seed):
            raise SeedSafetyError("Mobile announcement service validation failed")
        db.add(MobileAnnouncement(**data))
        report.announcements_created += 1
    db.flush()


def _verify_applied_bootstrap(
    db: Session,
    images: dict[str, PreparedImage],
) -> None:
    payload = mobile_content_service.build_mobile_content_bootstrap(
        db,
        locale="zh",
        response_locale="zh-CN",
    )
    hero = payload["home"]["hero"]
    promos = payload["home"]["promos"]
    announcements = payload["announcements"]
    expected_promo_urls = {
        images[seed.image_role].seed.url
        for seed in BANNER_SEEDS
        if seed.placement == "PROMO"
    }
    expected_announcement_ids = {
        int(row.id)
        for row in db.query(MobileAnnouncement.id)
        .filter(
            MobileAnnouncement.slug.in_([seed.slug for seed in ANNOUNCEMENT_SEEDS]),
            MobileAnnouncement.status == "PUBLISHED",
        )
        .all()
    }
    if (
        payload.get("channel") != "MOBILE"
        or payload.get("schema_version") != 1
        or hero is None
        or hero.get("image", {}).get("url") != images["hero"].seed.url
        or not expected_promo_urls.issubset(
            {item.get("image", {}).get("url") for item in promos}
        )
        or not expected_announcement_ids.issubset(
            {int(item.get("id")) for item in announcements}
        )
    ):
        raise SeedSafetyError("Mobile bootstrap verification failed")


def _verify_cleanup_files(
    images: dict[str, PreparedImage],
    upload_dir: Path,
) -> None:
    for item in images.values():
        target = upload_dir / item.seed.filename
        if target.exists() and (
            not target.is_file() or target.read_bytes() != item.content
        ):
            raise SeedConflictError(
                "a deterministic Mobile seed image was manually changed; refusing cleanup"
            )


def _cleanup_seed_rows(
    db: Session,
    state: dict[str, Any],
    images: dict[str, PreparedImage],
    report: SeedReport,
) -> list[Path]:
    settings = state["settings"]
    logo = images["logo"]
    if settings is not None and settings.logo_url == logo.seed.url:
        settings.logo_url = None
        settings.logo_width = None
        settings.logo_height = None
        settings.logo_byte_size = None
        settings.logo_mime_type = None
        report.settings_action = "cleared"
    elif settings is not None and settings.logo_url:
        report.settings_action = "operator-logo-preserved"

    for row in state["banners"].values():
        db.delete(row)
        report.banners_removed += 1
    for row in state["announcements"].values():
        db.delete(row)
        report.announcements_removed += 1
    db.flush()
    return [
        Path(mobile_content_service.MOBILE_UPLOAD_DIR).resolve()
        / item.seed.filename
        for item in images.values()
    ]


def _verify_seed_rows_absent(
    db: Session,
    images: dict[str, PreparedImage],
) -> None:
    seed_urls = [item.seed.url for item in images.values()]
    remaining_banners = (
        db.query(MobileHomeBanner.id)
        .filter(MobileHomeBanner.image_url.in_(seed_urls))
        .first()
    )
    remaining_announcements = (
        db.query(MobileAnnouncement.id)
        .filter(
            MobileAnnouncement.slug.in_([seed.slug for seed in ANNOUNCEMENT_SEEDS])
        )
        .first()
    )
    remaining_settings = (
        db.query(MobileContentSettings.id)
        .filter(MobileContentSettings.logo_url.in_(seed_urls))
        .first()
    )
    if remaining_banners or remaining_announcements or remaining_settings:
        raise SeedSafetyError("Mobile seed cleanup verification failed")


def _remove_seed_files(
    paths: list[Path],
    images: dict[str, PreparedImage],
) -> list[tuple[Path, bytes]]:
    expected_content = {
        item.seed.filename: item.content for item in images.values()
    }
    removed: list[tuple[Path, bytes]] = []
    try:
        for path in paths:
            if path.is_file():
                content = path.read_bytes()
                if content != expected_content.get(path.name):
                    raise SeedConflictError(
                        "a deterministic Mobile seed image changed during cleanup"
                    )
                path.unlink()
                removed.append((path, content))
        return removed
    except Exception:
        _restore_removed_files(removed)
        raise


def _restore_removed_files(files: list[tuple[Path, bytes]]) -> None:
    for path, content in files:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.parent / f".{path.name}.{os.getpid()}.restore"
        try:
            temporary.write_bytes(content)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def _banner_payload(
    seed: BannerSeed,
    image: PreparedImage,
) -> dict[str, Any]:
    translations = BANNER_TRANSLATIONS[seed.image_role]
    payload = {
        "title": seed.title,
        "subtitle": seed.subtitle,
        "image_url": image.seed.url,
        "image_width": str(image.seed.width),
        "image_height": str(image.seed.height),
        "image_byte_size": str(len(image.content)),
        "image_mime_type": SEED_MIME_TYPE,
        "placement": seed.placement,
        "action_route": seed.action_route,
        "sort_order": str(seed.sort_order),
        "status": "ACTIVE",
        "start_at": "",
        "end_at": "",
    }
    for locale, suffix in mobile_content_service.ADMIN_I18N_LOCALES:
        payload[f"title_i18n_{suffix}"] = translations["title"][locale]
        payload[f"subtitle_i18n_{suffix}"] = translations["subtitle"][locale]
    return payload


def _banner_expected(
    seed: BannerSeed,
    image: PreparedImage,
) -> dict[str, Any]:
    spec = mobile_content_service.MOBILE_BANNER_VARIANT_SPECS[seed.placement]
    return {
        "title": seed.title,
        "title_i18n": BANNER_TRANSLATIONS[seed.image_role]["title"],
        "subtitle": seed.subtitle,
        "subtitle_i18n": BANNER_TRANSLATIONS[seed.image_role]["subtitle"],
        **image.metadata,
        "placement": seed.placement,
        "action_type": "ROUTE",
        "action_route": seed.action_route,
        "aspect_ratio": spec["aspect_ratio"],
        "recommended_size": spec["recommended_size"],
        "sort_order": seed.sort_order,
        "status": "ACTIVE",
        "start_at": None,
        "end_at": None,
    }


def _banner_row_matches(
    row: MobileHomeBanner,
    seed: BannerSeed,
    image: PreparedImage,
) -> bool:
    expected = _banner_expected(seed, image)
    if all(getattr(row, key) == value for key, value in expected.items()):
        return True
    legacy = {**expected, "title_i18n": None, "subtitle_i18n": None}
    return all(getattr(row, key) == value for key, value in legacy.items())


def _announcement_payload(seed: AnnouncementSeed) -> dict[str, Any]:
    translations = ANNOUNCEMENT_TRANSLATIONS[seed.slug]
    payload = {
        "title": seed.title,
        "slug": seed.slug,
        "summary": seed.summary,
        "category_label": seed.category_label,
        "content": seed.content,
        "content_format": "PLAIN_TEXT",
        "is_pinned": "1" if seed.is_pinned else "0",
        "status": "PUBLISHED",
        "publish_at": SEED_PUBLISH_AT.isoformat(timespec="minutes"),
    }
    for locale, suffix in mobile_content_service.ADMIN_I18N_LOCALES:
        for field_name in ("title", "summary", "category_label", "content"):
            payload[f"{field_name}_i18n_{suffix}"] = translations[field_name][locale]
    return payload


def _announcement_expected(seed: AnnouncementSeed) -> dict[str, Any]:
    translations = ANNOUNCEMENT_TRANSLATIONS[seed.slug]
    return {
        "title": seed.title,
        "title_i18n": translations["title"],
        "slug": seed.slug,
        "summary": seed.summary,
        "summary_i18n": translations["summary"],
        "category_label": seed.category_label,
        "category_label_i18n": translations["category_label"],
        "content": seed.content,
        "content_i18n": translations["content"],
        "content_format": "PLAIN_TEXT",
        "is_pinned": seed.is_pinned,
        "status": "PUBLISHED",
        "publish_at": SEED_PUBLISH_AT,
    }


def _announcement_row_matches(
    row: MobileAnnouncement,
    seed: AnnouncementSeed,
    *,
    preserve_operator_status: bool = False,
) -> bool:
    expected = _announcement_expected(seed)
    if preserve_operator_status and row.status in {"PUBLISHED", "OFFLINE"}:
        expected = {**expected, "status": row.status}
    if all(getattr(row, key) == value for key, value in expected.items()):
        return True
    legacy = {
        **expected,
        "title_i18n": None,
        "summary_i18n": None,
        "category_label_i18n": None,
        "content_i18n": None,
    }
    return all(getattr(row, key) == value for key, value in legacy.items())


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed isolated Mobile homepage content into a confirmed development database"
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Preview changes (default)")
    mode.add_argument("--apply", action="store_true", help="Apply the development seed")
    mode.add_argument("--cleanup", action="store_true", help="Remove only exact seed-owned data")
    parser.add_argument("--confirm-db-name", default="")
    parser.add_argument("--confirm-development", default="")
    return parser.parse_args(argv)


def _mode_from_args(args: argparse.Namespace) -> SeedMode:
    if args.apply:
        return "apply"
    if args.cleanup:
        return "cleanup"
    return "dry-run"


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    mode = _mode_from_args(args)
    try:
        from app.core.config import settings
        from app.db.session import SessionLocal

        if _looks_like_production_target(
            settings.DB_NAME,
            settings.DB_HOST,
            settings.COOKIE_SECURE,
            settings.COOKIE_DOMAIN or "",
        ):
            raise SeedSafetyError("refusing a target that appears to be production")
        authorization = None
        if mode != "dry-run":
            authorization = authorize_development_write(
                configured_db_name=settings.DB_NAME,
                configured_db_host=settings.DB_HOST,
                cookie_secure=settings.COOKIE_SECURE,
                cookie_domain=settings.COOKIE_DOMAIN,
                confirmed_db_name=args.confirm_db_name,
                confirmation=args.confirm_development,
            )
        with SessionLocal() as db:
            report = run_mobile_content_seed(
                db,
                mode=mode,
                authorization=authorization,
            )
        for line in report.safe_lines():
            print(line)
        return 0
    except (SeedSafetyError, SeedSchemaError, SeedConflictError) as exc:
        print(f"error={exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # Avoid leaking a SQLAlchemy URL or credentials.
        print(f"error=seed operation failed ({type(exc).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
