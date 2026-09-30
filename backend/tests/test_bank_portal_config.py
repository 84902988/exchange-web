import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.db.models.mobile_content import MobileContentSettings
from app.routers import site_content
from app.services.mobile_content_service import get_public_bank_portal_url, serialize_mobile_home_config


@pytest.mark.parametrize("value", [None, "", "https://bank.example.com/portal", "http://bank.example.com", "javascript:alert(1)", "https://user:pass@bank.example.com", "https://bank.example.com/\nportal"])
def test_web_and_mobile_share_validated_portal(value, monkeypatch):
    engine = create_engine("sqlite://")
    MobileContentSettings.__table__.create(engine)
    with Session(engine) as db:
        row = MobileContentSettings(home_config={"version": 1, "bank_portal_url": value})
        db.add(row)
        db.commit()
        expected = value if value == "https://bank.example.com/portal" else None
        assert get_public_bank_portal_url(db) == expected
        assert serialize_mobile_home_config(row)["bank_portal_url"] == expected
        monkeypatch.setattr(site_content, "get_public_site_config", lambda db, locale: {"site_name": "Exchange"})
        request = Request({"type": "http", "headers": []})
        response = site_content.site_config(request, lang="en", db=db)
        assert response["data"]["bank_portal_url"] == expected
    engine.dispose()


def test_missing_settings_hide_portal_without_creating_settings():
    engine = create_engine("sqlite://")
    MobileContentSettings.__table__.create(engine)
    with Session(engine) as db:
        assert get_public_bank_portal_url(db) is None
        assert db.query(MobileContentSettings).count() == 0
    engine.dispose()
