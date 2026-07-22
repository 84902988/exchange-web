from __future__ import annotations

from types import SimpleNamespace

from app.services import vip_query


def test_vip_overview_exposes_fee_pay_percent_without_changing_legacy_discount(monkeypatch) -> None:
    monkeypatch.setattr(
        vip_query,
        "load_spot_fee_settings",
        lambda _db: SimpleNamespace(rcb_fee_discount_rate="0.25"),
    )
    monkeypatch.setattr(vip_query, "_load_levels", lambda _db, _vip_type: [])
    monkeypatch.setattr(vip_query, "_load_user_summary", lambda _db, _user_id: vip_query._empty_user_summary())

    overview = vip_query.get_vip_overview(object())

    assert overview["rcb_fee_pay_percent"] == "25"
    assert overview["rcb_discount_percent"] == "75"
