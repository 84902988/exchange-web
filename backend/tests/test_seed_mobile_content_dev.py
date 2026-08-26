from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models.mobile_content import (
    MobileAnnouncement,
    MobileContentSettings,
    MobileHomeBanner,
)
import app.services.mobile_content_service as mobile_content_service
from scripts.seed_mobile_content_dev import (
    ANNOUNCEMENT_SEEDS,
    BANNER_SEEDS,
    DEVELOPMENT_CONFIRMATION,
    IMAGE_SEED_BY_ROLE,
    SeedConflictError,
    SeedSafetyError,
    authorize_development_write,
    parse_args,
    prepare_images,
    run_mobile_content_seed,
)


@pytest.fixture()
def database() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    MobileContentSettings.__table__.create(engine)
    MobileHomeBanner.__table__.create(engine)
    MobileAnnouncement.__table__.create(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = factory()
    try:
        yield db
    finally:
        db.close()
        engine.dispose()


@pytest.fixture()
def upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "mobile"
    monkeypatch.setattr(mobile_content_service, "MOBILE_UPLOAD_DIR", path)
    mobile_content_service.invalidate_mobile_content_bootstrap_cache()
    yield path
    mobile_content_service.invalidate_mobile_content_bootstrap_cache()


@pytest.fixture()
def authorization():
    return authorize_development_write(
        configured_db_name="exchange_dev",
        configured_db_host="127.0.0.1",
        cookie_secure=False,
        cookie_domain=None,
        confirmed_db_name="exchange_dev",
        confirmation=DEVELOPMENT_CONFIRMATION,
    )


def test_cli_defaults_to_dry_run_and_write_modes_require_authorization(
    database: Session,
    upload_dir: Path,
) -> None:
    args = parse_args([])
    assert args.dry_run is False
    assert args.apply is False
    assert args.cleanup is False

    with pytest.raises(SeedSafetyError, match="authorization"):
        run_mobile_content_seed(database, mode="apply", upload_dir=upload_dir)
    assert database.query(MobileContentSettings).count() == 0
    assert not upload_dir.exists()


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"confirmed_db_name": "wrong"}, "does not match"),
        ({"confirmation": "YES"}, "confirmation phrase"),
        ({"configured_db_name": "exchange_prod", "confirmed_db_name": "exchange_prod"}, "production"),
        ({"configured_db_host": "db.service.example"}, "production"),
        ({"cookie_secure": True}, "production"),
        ({"cookie_domain": ".service.example"}, "production"),
    ],
)
def test_development_authorization_fails_closed_for_mismatch_or_production_signals(
    overrides: dict[str, object],
    message: str,
) -> None:
    values: dict[str, object] = {
        "configured_db_name": "exchange_dev",
        "configured_db_host": "127.0.0.1",
        "cookie_secure": False,
        "cookie_domain": None,
        "confirmed_db_name": "exchange_dev",
        "confirmation": DEVELOPMENT_CONFIRMATION,
    }
    values.update(overrides)
    with pytest.raises(SeedSafetyError, match=message):
        authorize_development_write(**values)  # type: ignore[arg-type]


def test_dry_run_reports_changes_without_writing_database_or_files(
    database: Session,
    upload_dir: Path,
) -> None:
    report = run_mobile_content_seed(
        database,
        mode="dry-run",
        upload_dir=upload_dir,
    )

    assert report.changed is True
    assert report.settings_action == "would-create"
    assert report.banners_created == len(BANNER_SEEDS)
    assert report.announcements_created == len(ANNOUNCEMENT_SEEDS)
    assert report.files_created == len(prepare_images())
    assert database.query(MobileContentSettings).count() == 0
    assert database.query(MobileHomeBanner).count() == 0
    assert database.query(MobileAnnouncement).count() == 0
    assert not upload_dir.exists()


def test_apply_is_idempotent_and_produces_the_strict_public_bootstrap(
    database: Session,
    upload_dir: Path,
    authorization,
) -> None:
    first = run_mobile_content_seed(
        database,
        mode="apply",
        upload_dir=upload_dir,
        authorization=authorization,
    )
    first_banner_ids = [
        row.id
        for row in database.query(MobileHomeBanner)
        .order_by(MobileHomeBanner.id.asc())
        .all()
    ]
    first_announcement_ids = [
        row.id
        for row in database.query(MobileAnnouncement)
        .order_by(MobileAnnouncement.id.asc())
        .all()
    ]
    first_payload = mobile_content_service.build_mobile_content_bootstrap(
        database,
        locale="zh",
        response_locale="zh-CN",
    )

    second = run_mobile_content_seed(
        database,
        mode="apply",
        upload_dir=upload_dir,
        authorization=authorization,
    )
    second_payload = mobile_content_service.build_mobile_content_bootstrap(
        database,
        locale="zh",
        response_locale="zh-CN",
    )

    assert first.changed is True
    assert first.settings_action == "created"
    assert first.banners_created == len(BANNER_SEEDS)
    assert first.announcements_created == len(ANNOUNCEMENT_SEEDS)
    assert second.changed is False
    assert second.settings_action == "unchanged"
    assert second.banners_created == 0
    assert second.announcements_created == 0
    assert [
        row.id
        for row in database.query(MobileHomeBanner)
        .order_by(MobileHomeBanner.id.asc())
        .all()
    ] == first_banner_ids
    assert [
        row.id
        for row in database.query(MobileAnnouncement)
        .order_by(MobileAnnouncement.id.asc())
        .all()
    ] == first_announcement_ids
    assert second_payload["revision"] == first_payload["revision"]
    assert first_payload["channel"] == "MOBILE"
    assert first_payload["locale"] == "zh-CN"
    assert first_payload["site"]["logo"]["variant"] == "APP_LOGO"
    assert first_payload["home"]["hero"]["variant"] == "HOME_HERO"
    assert len(first_payload["home"]["promos"]) == 3
    assert len(first_payload["announcements"]) == 3
    assert all(path.is_file() for path in upload_dir.iterdir())


def test_apply_refuses_a_non_seed_active_hero_before_creating_files_or_rows(
    database: Session,
    upload_dir: Path,
    authorization,
) -> None:
    database.add(
        MobileHomeBanner(
            title="运营主视觉",
            subtitle="不得覆盖",
            image_url="/static/uploads/mobile/ffffffffffffffffffffffffffffffff.webp",
            image_width=1200,
            image_height=675,
            image_byte_size=1000,
            image_mime_type="image/webp",
            placement="HERO",
            action_type="ROUTE",
            action_route="MARKETS",
            aspect_ratio="16:9",
            recommended_size="1200x675",
            sort_order=0,
            status="ACTIVE",
        )
    )
    database.commit()

    with pytest.raises(SeedConflictError, match="non-seed ACTIVE"):
        run_mobile_content_seed(
            database,
            mode="apply",
            upload_dir=upload_dir,
            authorization=authorization,
        )

    assert database.query(MobileHomeBanner).count() == 1
    assert database.query(MobileAnnouncement).count() == 0
    assert database.query(MobileContentSettings).count() == 0
    assert not upload_dir.exists()


def test_reapply_and_cleanup_refuse_manually_changed_seed_content(
    database: Session,
    upload_dir: Path,
    authorization,
) -> None:
    run_mobile_content_seed(
        database,
        mode="apply",
        upload_dir=upload_dir,
        authorization=authorization,
    )
    hero = database.query(MobileHomeBanner).filter_by(placement="HERO").one()
    hero.subtitle = "人工修改后的文案"
    database.commit()

    with pytest.raises(SeedConflictError, match="manually changed"):
        run_mobile_content_seed(
            database,
            mode="apply",
            upload_dir=upload_dir,
            authorization=authorization,
        )
    with pytest.raises(SeedConflictError, match="manually changed"):
        run_mobile_content_seed(
            database,
            mode="cleanup",
            upload_dir=upload_dir,
            authorization=authorization,
        )

    database.refresh(hero)
    assert hero.subtitle == "人工修改后的文案"
    assert database.query(MobileHomeBanner).count() == len(BANNER_SEEDS)
    assert database.query(MobileAnnouncement).count() == len(
        ANNOUNCEMENT_SEEDS
    )
    assert len(list(upload_dir.iterdir())) == len(prepare_images())


def test_cleanup_is_idempotent_and_preserves_non_seed_operator_content(
    database: Session,
    upload_dir: Path,
    authorization,
) -> None:
    run_mobile_content_seed(
        database,
        mode="apply",
        upload_dir=upload_dir,
        authorization=authorization,
    )
    operator_banner = MobileHomeBanner(
        title="运营保留内容",
        subtitle="cleanup 不得删除",
        image_url="/static/uploads/mobile/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp",
        image_width=1200,
        image_height=675,
        image_byte_size=1000,
        image_mime_type="image/webp",
        placement="HERO",
        action_type="ROUTE",
        action_route="MARKETS",
        aspect_ratio="16:9",
        recommended_size="1200x675",
        sort_order=50,
        status="ACTIVE",
    )
    operator_announcement = MobileAnnouncement(
        title="运营公告",
        slug="operator-announcement",
        summary="保留",
        category_label="公告",
        content="运营正文",
        content_format="PLAIN_TEXT",
        status="PUBLISHED",
        publish_at=None,
    )
    database.add_all([operator_banner, operator_announcement])
    database.commit()

    first = run_mobile_content_seed(
        database,
        mode="cleanup",
        upload_dir=upload_dir,
        authorization=authorization,
    )
    second = run_mobile_content_seed(
        database,
        mode="cleanup",
        upload_dir=upload_dir,
        authorization=authorization,
    )

    assert first.changed is True
    assert first.settings_action == "cleared"
    assert first.banners_removed == len(BANNER_SEEDS)
    assert first.announcements_removed == len(ANNOUNCEMENT_SEEDS)
    assert first.files_removed == len(prepare_images())
    assert second.changed is False
    assert database.query(MobileHomeBanner).all() == [operator_banner]
    assert database.query(MobileAnnouncement).all() == [operator_announcement]
    settings = database.query(MobileContentSettings).one()
    assert settings.logo_url is None
    assert not upload_dir.exists() or list(upload_dir.iterdir()) == []


def test_apply_refuses_a_deterministic_file_collision_without_database_write(
    database: Session,
    upload_dir: Path,
    authorization,
) -> None:
    upload_dir.mkdir()
    logo_path = upload_dir / IMAGE_SEED_BY_ROLE["logo"].filename
    logo_path.write_bytes(b"operator-owned")

    with pytest.raises(SeedConflictError, match="different content"):
        run_mobile_content_seed(
            database,
            mode="apply",
            upload_dir=upload_dir,
            authorization=authorization,
        )

    assert logo_path.read_bytes() == b"operator-owned"
    assert database.query(MobileContentSettings).count() == 0
    assert database.query(MobileHomeBanner).count() == 0
    assert database.query(MobileAnnouncement).count() == 0


def test_apply_commit_failure_rolls_back_rows_and_new_files(
    database: Session,
    upload_dir: Path,
    authorization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_commit() -> None:
        raise RuntimeError("synthetic commit failure")

    monkeypatch.setattr(database, "commit", fail_commit)
    with pytest.raises(RuntimeError, match="synthetic"):
        run_mobile_content_seed(
            database,
            mode="apply",
            upload_dir=upload_dir,
            authorization=authorization,
        )

    assert database.query(MobileContentSettings).count() == 0
    assert database.query(MobileHomeBanner).count() == 0
    assert database.query(MobileAnnouncement).count() == 0
    assert not upload_dir.exists() or list(upload_dir.iterdir()) == []


def test_cleanup_commit_failure_restores_rows_and_files(
    database: Session,
    upload_dir: Path,
    authorization,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_mobile_content_seed(
        database,
        mode="apply",
        upload_dir=upload_dir,
        authorization=authorization,
    )
    original_files = {
        path.name: path.read_bytes() for path in upload_dir.iterdir()
    }

    def fail_commit() -> None:
        raise RuntimeError("synthetic cleanup commit failure")

    monkeypatch.setattr(database, "commit", fail_commit)
    with pytest.raises(RuntimeError, match="synthetic cleanup"):
        run_mobile_content_seed(
            database,
            mode="cleanup",
            upload_dir=upload_dir,
            authorization=authorization,
        )

    settings = database.query(MobileContentSettings).one()
    assert settings.logo_url == IMAGE_SEED_BY_ROLE["logo"].url
    assert database.query(MobileHomeBanner).count() == len(BANNER_SEEDS)
    assert database.query(MobileAnnouncement).count() == len(
        ANNOUNCEMENT_SEEDS
    )
    assert {
        path.name: path.read_bytes() for path in upload_dir.iterdir()
    } == original_files
