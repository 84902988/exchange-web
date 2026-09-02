from __future__ import annotations

from decimal import Decimal

from app.services.admin_queries import (
    _admin_contract_symbol_form_row,
    _contract_symbol_form_from_payload,
    _validate_contract_symbol_form,
)


def _payload(**overrides):
    payload = {
        "symbol": "NAS100USDT_PERP",
        "display_name": "NAS100/USDT 永续",
        "category": "INDEX",
        "provider": "ITICK",
        "provider_symbol": "NAS100",
        "quote_asset": "USDT",
        "tp_sl_trigger_price_type": "MARK_PRICE",
        "closed_market_execution_mode": "DISABLED",
        "holiday_calendar_code": "US",
        "session_profile_code": "US_INDEX_EXTENDED",
        "session_timezone_override": "",
        "extended_hours_execution_mode": "DISPLAY_ONLY",
        "price_precision": "2",
        "quantity_precision": "2",
        "min_quantity": "0",
        "max_quantity": "0",
        "min_margin": "0",
        "max_leverage": "100",
        "spread_x": "0",
        "liquidation_threshold": "0",
        "warning_threshold": "0",
        "status": "1",
    }
    payload.update(overrides)
    return payload


def test_admin_accepts_explicit_us_index_session_metadata() -> None:
    form = _contract_symbol_form_from_payload(_payload())

    values, errors = _validate_contract_symbol_form(form, is_create=True)

    assert errors == []
    assert values["session_profile_code"] == "US_INDEX_EXTENDED"
    assert values["holiday_calendar_code"] == "US"
    assert values["extended_hours_execution_mode"] == "DISPLAY_ONLY"


def test_admin_rejects_missing_session_profile() -> None:
    form = _contract_symbol_form_from_payload(_payload(session_profile_code=""))

    _, errors = _validate_contract_symbol_form(form, is_create=True)

    assert "交易时段模板不能为空或无效" in errors


def test_admin_rejects_us_profile_without_us_calendar() -> None:
    form = _contract_symbol_form_from_payload(_payload(holiday_calendar_code="GB"))

    _, errors = _validate_contract_symbol_form(form, is_create=True)

    assert "美股和美国指数时段必须使用 US 假期日历" in errors


def test_admin_rejects_invalid_timezone_override() -> None:
    form = _contract_symbol_form_from_payload(
        _payload(session_timezone_override="Mars/Olympus"),
    )

    _, errors = _validate_contract_symbol_form(form, is_create=True)

    assert "时区覆盖必须是有效的 IANA 时区，例如 America/New_York" in errors


def test_admin_contract_symbol_edit_form_uses_raw_threshold_ratios() -> None:
    form = _admin_contract_symbol_form_row(
        {
            "liquidation_threshold": Decimal("0.1"),
            "warning_threshold": Decimal("0.25"),
        }
    )

    assert form["liquidation_threshold"] == "0.1"
    assert form["warning_threshold"] == "0.25"


def test_admin_rejects_malformed_or_out_of_range_risk_thresholds() -> None:
    malformed = _contract_symbol_form_from_payload(
        _payload(liquidation_threshold="10%"),
    )
    _, malformed_errors = _validate_contract_symbol_form(malformed, is_create=True)

    out_of_range = _contract_symbol_form_from_payload(
        _payload(liquidation_threshold="1.01", warning_threshold="2"),
    )
    _, out_of_range_errors = _validate_contract_symbol_form(out_of_range, is_create=True)

    assert "强平阈值格式不正确。" in malformed_errors
    assert "强平阈值必须在 0 到 1 之间（0 表示仓位权益归零时强平）" in out_of_range_errors
    assert "风险预警阈值必须在 0 到 1 之间" in out_of_range_errors
