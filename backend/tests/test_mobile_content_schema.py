from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect

from app.db.models.mobile_content import (
    MobileAnnouncement,
    MobileAnnouncementRead,
    MobileContentSettings,
    MobileHomeBanner,
)
from app.routers.admin_mobile_content import router as admin_mobile_content_router


def test_mobile_content_models_use_only_dedicated_tables_and_required_contract_columns() -> None:
    assert MobileContentSettings.__tablename__ == "mobile_content_settings"
    assert MobileHomeBanner.__tablename__ == "mobile_home_banners"
    assert MobileAnnouncement.__tablename__ == "mobile_announcements"
    assert MobileAnnouncementRead.__tablename__ == "mobile_announcement_reads"

    assert {
        "logo_width",
        "logo_height",
        "logo_byte_size",
        "logo_mime_type",
        "home_config",
    } <= set(MobileContentSettings.__table__.columns.keys())
    assert {
        "splash_image_url",
        "theme_color",
        "home_notice_enabled",
        "home_notice_text",
        "home_notice_text_i18n",
    }.isdisjoint(MobileContentSettings.__table__.columns.keys())
    assert {
        "placement",
        "image_width",
        "image_height",
        "image_byte_size",
        "image_mime_type",
        "action_type",
        "action_route",
    } <= set(MobileHomeBanner.__table__.columns.keys())
    assert {"content_format", "category_label", "category_label_i18n"} <= set(MobileAnnouncement.__table__.columns.keys())


def test_mobile_content_migration_is_the_single_head_and_has_reversible_permission_scope() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    script = ScriptDirectory.from_config(config)

    assert script.get_heads() == ["20260824_000136"]
    revision = script.get_revision("20260731_000127")
    assert revision is not None
    assert revision.down_revision == "20260728_000126"

    source = (backend_dir / "alembic" / "versions" / "20260731_000127_add_mobile_content_admin.py").read_text(encoding="utf-8")
    assert "mobile_content.manage" in source
    assert "r.code = 'super_admin'" in source
    assert "CURRENT_TIMESTAMP" in source
    assert "UTC_TIMESTAMP" not in source
    assert "DELETE FROM admin_role_permissions" in source
    assert 'op.drop_table("mobile_announcements")' in source
    assert 'if not _has_table(bind, "mobile_content_settings")' not in source

    home_revision = script.get_revision("20260802_000129")
    assert home_revision is not None
    assert home_revision.down_revision == "20260801_000128"

    read_revision = script.get_revision("20260802_000130")
    assert read_revision is not None
    assert read_revision.down_revision == "20260802_000129"

    email_revision = script.get_revision("20260802_000131")
    assert email_revision is not None
    assert email_revision.down_revision == "20260802_000130"

    kyc_permission_revision = script.get_revision("20260802_000132")
    assert kyc_permission_revision is not None
    assert kyc_permission_revision.down_revision == "20260802_000131"

    transfer_fingerprint_revision = script.get_revision("20260803_000133")
    assert transfer_fingerprint_revision is not None
    assert transfer_fingerprint_revision.down_revision == "20260728_000126"

    merge_revision = script.get_revision("20260803_000134")
    assert merge_revision is not None
    assert set(merge_revision.down_revision) == {
        "20260802_000132",
        "20260803_000133",
    }

    translation_revision = script.get_revision("20260809_000135")
    assert translation_revision is not None
    assert translation_revision.down_revision == "20260803_000134"


def test_mobile_content_migration_round_trips_on_sqlite() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    revision = ScriptDirectory.from_config(config).get_revision("20260731_000127")
    assert revision is not None

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            tables = set(inspect(connection).get_table_names())
            assert {
                "mobile_content_settings",
                "mobile_home_banners",
                "mobile_announcements",
            } <= tables
            assert connection.exec_driver_sql(
                "SELECT app_name FROM mobile_content_settings"
            ).scalar_one() == "Exchange"

            revision.module.downgrade()
            tables_after = set(inspect(connection).get_table_names())
            assert {
                "mobile_content_settings",
                "mobile_home_banners",
                "mobile_announcements",
            }.isdisjoint(tables_after)
        finally:
            revision.module.op = original_op


def test_mobile_category_translation_migration_round_trips_on_sqlite() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    revision = ScriptDirectory.from_config(config).get_revision("20260809_000135")
    assert revision is not None

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE mobile_announcements (id INTEGER PRIMARY KEY, category_label VARCHAR(40) NOT NULL)"
        )
        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            columns = {column["name"] for column in inspect(connection).get_columns("mobile_announcements")}
            assert "category_label_i18n" in columns

            revision.module.downgrade()
            columns_after = {column["name"] for column in inspect(connection).get_columns("mobile_announcements")}
            assert "category_label_i18n" not in columns_after
        finally:
            revision.module.op = original_op


def test_mobile_home_config_migration_round_trips_on_sqlite() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    revision = ScriptDirectory.from_config(config).get_revision("20260802_000129")
    assert revision is not None

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE mobile_content_settings (id INTEGER PRIMARY KEY, app_name VARCHAR(100) NOT NULL)"
        )
        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            columns = {
                column["name"]
                for column in inspect(connection).get_columns(
                    "mobile_content_settings"
                )
            }
            assert "home_config" in columns

            revision.module.downgrade()
            columns_after = {
                column["name"]
                for column in inspect(connection).get_columns(
                    "mobile_content_settings"
                )
            }
            assert "home_config" not in columns_after
        finally:
            revision.module.op = original_op


def test_mobile_message_read_state_migration_round_trips_on_sqlite() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    revision = ScriptDirectory.from_config(config).get_revision("20260802_000130")
    assert revision is not None

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE users (id INTEGER PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE mobile_announcements (id INTEGER PRIMARY KEY)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE support_tickets (id INTEGER PRIMARY KEY)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE support_ticket_messages ("
            "id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, "
            "sender_type VARCHAR(20) NOT NULL)"
        )
        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            inspector = inspect(connection)
            assert "mobile_announcement_reads" in inspector.get_table_names()
            ticket_columns = {
                column["name"]
                for column in inspector.get_columns("support_tickets")
            }
            assert {"user_last_read_message_id", "user_last_read_at"} <= ticket_columns
            message_indexes = {
                index["name"]
                for index in inspector.get_indexes("support_ticket_messages")
            }
            assert "ix_support_ticket_messages_ticket_sender_id" in message_indexes

            revision.module.downgrade()
            inspector = inspect(connection)
            assert "mobile_announcement_reads" not in inspector.get_table_names()
            ticket_columns_after = {
                column["name"]
                for column in inspector.get_columns("support_tickets")
            }
            assert {
                "user_last_read_message_id",
                "user_last_read_at",
            }.isdisjoint(ticket_columns_after)
        finally:
            revision.module.op = original_op


def test_account_email_security_migration_round_trips_on_sqlite() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    revision = ScriptDirectory.from_config(config).get_revision("20260802_000131")
    assert revision is not None

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE user_otps (id INTEGER PRIMARY KEY, purpose VARCHAR(32) NOT NULL)"
        )
        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            inspector = inspect(connection)
            assert "user_security_events" in inspector.get_table_names()
            event_columns = {
                column["name"]
                for column in inspector.get_columns("user_security_events")
            }
            assert {"user_id", "event_type", "ip", "user_agent", "details"} <= event_columns

            revision.module.downgrade()
            assert "user_security_events" not in inspect(connection).get_table_names()
        finally:
            revision.module.op = original_op


def test_mobile_admin_router_exposes_real_settings_banner_and_announcement_workflows() -> None:
    routes = {(route.path, method) for route in admin_mobile_content_router.routes for method in route.methods}
    assert ("/admin/mobile-content/settings", "GET") in routes
    assert ("/admin/mobile-content/settings", "POST") in routes
    assert ("/admin/mobile-content/banners/new", "POST") in routes
    assert ("/admin/mobile-content/banners/{banner_id}/toggle", "POST") in routes
    assert ("/admin/mobile-content/announcements/new", "POST") in routes
    assert ("/admin/mobile-content/announcements/{announcement_id}/publish", "POST") in routes
    assert ("/admin/mobile-content/announcements/{announcement_id}/offline", "POST") in routes
